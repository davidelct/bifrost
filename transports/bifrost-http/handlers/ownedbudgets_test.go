package handlers

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/maximhq/bifrost/framework/configstore"
	configstoreTables "github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// newOwnedBudgetsStore opens a sqlite store holding one team for the budgets to belong to.
func newOwnedBudgetsStore(t *testing.T) configstore.ConfigStore {
	t.Helper()
	ctx := context.Background()
	store, err := configstore.NewConfigStore(ctx, &configstore.Config{
		Enabled: true,
		Type:    configstore.ConfigStoreTypeSQLite,
		Config:  &configstore.SQLiteConfig{Path: filepath.Join(t.TempDir(), "owned-budgets.db")},
	}, &mockLogger{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close(ctx) })
	require.NoError(t, store.CreateTeam(ctx, &configstoreTables.TableTeam{ID: "team-1", Name: "Team"}))
	return store
}

// ownedByTeam stamps the team as the owner of a new row.
func ownedByTeam(b *configstoreTables.TableBudget) {
	teamID := "team-1"
	b.TeamID = &teamID
}

// reconcileOwned runs one reconcile pass in its own transaction.
func reconcileOwned(t *testing.T, store configstore.ConfigStore, existing []configstoreTables.TableBudget, requests []CreateBudgetRequest, usageReset *BudgetUsageReset) ([]configstoreTables.TableBudget, error) {
	t.Helper()
	var out []configstoreTables.TableBudget
	err := store.ExecuteTransaction(context.Background(), func(tx *gorm.DB) error {
		var err error
		out, err = ReconcileOwnedBudgets(context.Background(), store, tx, existing, requests, false, ownedByTeam, usageReset)
		return err
	})
	return out, err
}

// TestReconcileOwnedBudgets pins the one reconcile path every owner shares: a new row per declared
// window, a row matched by window edited in place with its spend kept, a row matched by id renamed
// onto another window, a row the request leaves out deleted, and the operator's reset zeroing the
// matched rows and reporting them.
func TestReconcileOwnedBudgets(t *testing.T) {
	store := newOwnedBudgetsStore(t)
	ctx := context.Background()

	first, err := reconcileOwned(t, store, nil, []CreateBudgetRequest{{MaxLimit: 100, ResetDuration: "1M"}, {MaxLimit: 1000, ResetDuration: "1Y"}}, nil)
	require.NoError(t, err)
	require.Len(t, first, 2)
	for _, b := range first {
		require.NotNil(t, b.TeamID, "a new row carries the owner setOwner stamped")
		assert.Equal(t, "team-1", *b.TeamID)
	}
	var monthly, yearly configstoreTables.TableBudget
	for _, b := range first {
		if b.ResetDuration == "1M" {
			monthly = b
		} else {
			yearly = b
		}
	}
	require.NoError(t, store.UpdateBudgetUsage(ctx, monthly.ID, 42))
	stored, err := store.GetBudget(ctx, monthly.ID)
	require.NoError(t, err)
	first = []configstoreTables.TableBudget{*stored, yearly}

	// Matched by window: the same row, a new limit, the spend it had.
	second, err := reconcileOwned(t, store, first, []CreateBudgetRequest{{MaxLimit: 200, ResetDuration: "1M"}, {ID: yearly.ID, MaxLimit: 1000, ResetDuration: "2Y"}}, nil)
	require.NoError(t, err)
	require.Len(t, second, 2)
	assert.Equal(t, monthly.ID, second[0].ID, "matched by window")
	assert.Equal(t, 200.0, second[0].MaxLimit)
	assert.Equal(t, 42.0, second[0].CurrentUsage, "usage survives an edit")
	assert.Equal(t, yearly.ID, second[1].ID, "matched by id")
	assert.Equal(t, "2Y", second[1].ResetDuration, "and moved onto the window the request names")

	// Left out: deleted. Reset: zeroed and reported.
	reset := NewBudgetUsageReset(true)
	third, err := reconcileOwned(t, store, second, []CreateBudgetRequest{{ID: monthly.ID, MaxLimit: 300, ResetDuration: "1M"}}, reset)
	require.NoError(t, err)
	require.Len(t, third, 1)
	assert.Zero(t, third[0].CurrentUsage)
	assert.Equal(t, []string{monthly.ID}, reset.BudgetIDs(), "the in-memory pass is told which rows were zeroed")
	persisted, err := store.GetBudget(ctx, monthly.ID)
	require.NoError(t, err)
	assert.Zero(t, persisted.CurrentUsage, "the reset reached the column the store owns")
	_, err = store.GetBudget(ctx, yearly.ID)
	assert.ErrorIs(t, err, configstore.ErrNotFound, "a row the request leaves out is deleted")

	// Nothing reset when nothing was asked for.
	quiet := NewBudgetUsageReset(false)
	_, err = reconcileOwned(t, store, third, []CreateBudgetRequest{{ID: monthly.ID, MaxLimit: 300, ResetDuration: "1M"}}, quiet)
	require.NoError(t, err)
	assert.Empty(t, quiet.BudgetIDs())
}

// TestReconcileOwnedBudgetsRefusesBadDeclarations pins the failures that come back as bad requests
// rather than store errors: two budgets on one window, a non-positive limit, an unparsable window,
// and an id the owner does not hold.
func TestReconcileOwnedBudgetsRefusesBadDeclarations(t *testing.T) {
	store := newOwnedBudgetsStore(t)
	for name, requests := range map[string][]CreateBudgetRequest{
		"shared window":  {{MaxLimit: 1, ResetDuration: "1M"}, {MaxLimit: 2, ResetDuration: "1M"}},
		"negative limit": {{MaxLimit: -1, ResetDuration: "1M"}},
		"bad window":     {{MaxLimit: 1, ResetDuration: "fortnight"}},
		"foreign id":     {{ID: "someone-elses", MaxLimit: 1, ResetDuration: "1M"}},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := reconcileOwned(t, store, nil, requests, nil)
			require.Error(t, err)
			assert.True(t, IsBadRequestError(err), "%v should answer 400", err)
		})
	}
}

// TestReconcileOwnedBudgetsRefusesANilTransaction pins that a call without a transaction is an error,
// not a crash: the store reads an explicit nil as a transaction it was given.
func TestReconcileOwnedBudgetsRefusesANilTransaction(t *testing.T) {
	store := newOwnedBudgetsStore(t)
	_, err := ReconcileOwnedBudgets(context.Background(), store, nil, nil, []CreateBudgetRequest{{MaxLimit: 1, ResetDuration: "1M"}}, false, nil, nil)
	require.Error(t, err)
	assert.False(t, IsBadRequestError(err), "a missing transaction is the caller's bug, not a bad request")
}

// TestApplyRateLimitUpdate pins what a team's or customer's update does to its stored rate limit: a
// maximum left out is cleared with its window, a maximum sent with a window takes it, and a maximum
// sent without one keeps the window already stored instead of failing validation.
func TestApplyRateLimitUpdate(t *testing.T) {
	hour, day := "1h", "1d"
	tokens, requests := int64(100), int64(10)
	stored := func() *configstoreTables.TableRateLimit {
		return &configstoreTables.TableRateLimit{TokenMaxLimit: &tokens, TokenResetDuration: &hour, RequestMaxLimit: &requests, RequestResetDuration: &hour}
	}

	keepWindow := stored()
	newTokens := int64(200)
	applyRateLimitUpdate(keepWindow, &UpdateRateLimitRequest{TokenMaxLimit: &newTokens, RequestMaxLimit: &requests})
	assert.Equal(t, int64(200), *keepWindow.TokenMaxLimit)
	require.NotNil(t, keepWindow.TokenResetDuration)
	assert.Equal(t, "1h", *keepWindow.TokenResetDuration, "a maximum sent alone keeps the stored window")
	require.NoError(t, validateRateLimit(keepWindow))

	newWindow := stored()
	applyRateLimitUpdate(newWindow, &UpdateRateLimitRequest{TokenMaxLimit: &tokens, TokenResetDuration: &day})
	assert.Equal(t, "1d", *newWindow.TokenResetDuration)
	assert.Nil(t, newWindow.RequestMaxLimit, "a maximum left out is cleared")
	assert.Nil(t, newWindow.RequestResetDuration, "with its window")
}

// TestReconcileOwnedBudgetsNewWindowFollowsTheResetChoice pins how a budget added on an edit starts:
// with the spend already counted in the closest shorter window when the operator keeps usage, and at
// zero when they reset it - the same choice the edited budgets follow.
func TestReconcileOwnedBudgetsNewWindowFollowsTheResetChoice(t *testing.T) {
	for _, tc := range []struct {
		name  string
		reset bool
		want  float64
	}{
		{name: "keep carries the spend over", reset: false, want: 5},
		{name: "reset starts it at zero", reset: true, want: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newOwnedBudgetsStore(t)
			ctx := context.Background()
			first, err := reconcileOwned(t, store, nil, []CreateBudgetRequest{{MaxLimit: 10, ResetDuration: "1d"}}, nil)
			require.NoError(t, err)
			require.NoError(t, store.UpdateBudgetUsage(ctx, first[0].ID, 5))
			daily, err := store.GetBudget(ctx, first[0].ID)
			require.NoError(t, err)

			out, err := reconcileOwned(t, store, []configstoreTables.TableBudget{*daily},
				[]CreateBudgetRequest{{ID: daily.ID, MaxLimit: 10, ResetDuration: "1d"}, {MaxLimit: 100, ResetDuration: "1M"}},
				NewBudgetUsageReset(tc.reset))
			require.NoError(t, err)
			require.Len(t, out, 2)
			for _, b := range out {
				if b.ResetDuration == "1M" {
					assert.Equal(t, tc.want, b.CurrentUsage)
				}
			}
		})
	}
}
