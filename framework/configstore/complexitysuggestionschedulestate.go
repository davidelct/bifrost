package configstore

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/maximhq/bifrost/framework/configstore/tables"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GetComplexitySuggestionSchedule returns a router's schedule state, or nil
// when it has none yet.
func (s *RDBConfigStore) GetComplexitySuggestionSchedule(ctx context.Context, routerID string) (*tables.TableComplexitySuggestionSchedule, error) {
	var row tables.TableComplexitySuggestionSchedule
	err := s.DB().WithContext(ctx).Where("router_id = ?", routerID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read suggestion schedule: %w", err)
	}
	return &row, nil
}

// SetComplexitySuggestionSchedule records the next run of a router's
// schedule, computed from the settings scheduleHash names. It is called when
// a router has no state yet or its schedule settings changed; nodes that do
// it at the same time compute the same values.
func (s *RDBConfigStore) SetComplexitySuggestionSchedule(ctx context.Context, routerID, scheduleHash string, nextRunAt time.Time) error {
	row := tables.TableComplexitySuggestionSchedule{
		RouterID: routerID, ScheduleHash: scheduleHash, NextRunAt: nextRunAt.UTC(), UpdatedAt: time.Now().UTC(),
	}
	err := s.DB().WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "router_id"}},
		DoUpdates: clause.Assignments(map[string]any{
			"schedule_hash": row.ScheduleHash,
			"next_run_at":   row.NextRunAt,
			"updated_at":    row.UpdatedAt,
			"version":       gorm.Expr("complexity_suggestion_schedules.version + 1"),
		}),
	}).Create(&row).Error
	if err != nil {
		return fmt.Errorf("set suggestion schedule: %w", err)
	}
	return nil
}

// ClaimComplexitySuggestionRun takes the run a router's schedule had due at
// dueAt: it moves the next run to nextRunAt and records runID as the slot's
// run, but only if the row is still at version, the one dueAt was read from.
// It reports whether this call took the run; of nodes that read the same row,
// exactly one does.
func (s *RDBConfigStore) ClaimComplexitySuggestionRun(ctx context.Context, routerID string, version int64, dueAt, nextRunAt time.Time, runID string) (bool, error) {
	due := dueAt.UTC()
	result := s.DB().WithContext(ctx).Model(&tables.TableComplexitySuggestionSchedule{}).
		Where("router_id = ? AND version = ?", routerID, version).
		Updates(map[string]any{
			"next_run_at": nextRunAt.UTC(),
			"last_run_at": &due,
			"last_run_id": runID,
			"updated_at":  time.Now().UTC(),
			"version":     gorm.Expr("version + 1"),
		})
	if result.Error != nil {
		return false, fmt.Errorf("claim suggestion run: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}
