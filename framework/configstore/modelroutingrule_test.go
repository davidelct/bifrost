package configstore

import (
	"context"
	"errors"
	"testing"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testModelRoutingRule returns a valid global rule on routerID that sends
// SIMPLE to a small model and splits COMPLEX between two large ones.
func testModelRoutingRule(id, name, routerID string, priority int) *tables.TableModelRoutingRule {
	return &tables.TableModelRoutingRule{
		ID:            id,
		Name:          name,
		ModelRouterID: routerID,
		Scope:         "global",
		Priority:      priority,
		Targets: []tables.TableModelRoutingTarget{
			{Tier: tables.ModelRoutingTierSimple, Provider: bifrost.Ptr("openai"), Model: bifrost.Ptr("gpt-4o-mini"), Weight: 1},
			{Tier: tables.ModelRoutingTierComplex, Provider: bifrost.Ptr("anthropic"), Model: bifrost.Ptr("claude-opus"), Weight: 0.7,
				ParsedFallbacks: []tables.RoutingFallback{{Fallback: schemas.Fallback{Provider: "openai", Model: "gpt-4o"}}}},
			{Tier: tables.ModelRoutingTierComplex, Provider: bifrost.Ptr("anthropic"), Model: bifrost.Ptr("claude-sonnet"), Weight: 0.3},
		},
	}
}

// TestModelRoutingRuleStoreCRUD covers a rule's life: created with its
// targets, fallbacks and builder state, read back in a fixed order, updated with its targets
// replaced, and deleted with them.
func TestModelRoutingRuleStoreCRUD(t *testing.T) {
	store := setupRDBTestStore(t)
	ctx := context.Background()

	rule := testModelRoutingRule("rule-1", " Support desk ", DefaultModelRouterID, 0)
	rule.ParsedQuery = map[string]any{"combinator": "and", "rules": []any{}}
	require.NoError(t, store.CreateModelRoutingRule(ctx, rule))

	got, err := store.GetModelRoutingRule(ctx, "rule-1")
	require.NoError(t, err)
	assert.Equal(t, "Support desk", got.Name)
	assert.Equal(t, map[string]any{"combinator": "and", "rules": []any{}}, got.ParsedQuery, "the builder state round-trips")
	assert.True(t, got.EnabledValue())
	require.Len(t, got.Targets, 3)
	// Written SIMPLE first, read back grouped by tier and heaviest first, as
	// routing rule targets are.
	assert.Equal(t, []string{"claude-opus", "claude-sonnet", "gpt-4o-mini"},
		[]string{derefStr(got.Targets[0].Model), derefStr(got.Targets[1].Model), derefStr(got.Targets[2].Model)})
	var withFallback *tables.TableModelRoutingTarget
	for i := range got.Targets {
		if derefStr(got.Targets[i].Model) == "claude-opus" {
			withFallback = &got.Targets[i]
		}
	}
	require.NotNil(t, withFallback)
	require.Len(t, withFallback.ParsedFallbacks, 1)
	assert.Equal(t, "gpt-4o", withFallback.ParsedFallbacks[0].Model)

	update := testModelRoutingRule("rule-1", "Support desk", DefaultModelRouterID, 0)
	update.Enabled = bifrost.Ptr(false)
	update.Targets = []tables.TableModelRoutingTarget{{Tier: tables.ModelRoutingTierMedium, Model: bifrost.Ptr("gpt-4o"), Weight: 1}}
	require.NoError(t, store.UpdateModelRoutingRule(ctx, update))
	got, err = store.GetModelRoutingRule(ctx, "rule-1")
	require.NoError(t, err)
	assert.False(t, got.EnabledValue())
	require.Len(t, got.Targets, 1)
	assert.Equal(t, tables.ModelRoutingTierMedium, got.Targets[0].Tier)
	created := got.CreatedAt

	// An omitted enabled keeps the stored value, and created_at never moves.
	update.Enabled = nil
	require.NoError(t, store.UpdateModelRoutingRule(ctx, update))
	got, err = store.GetModelRoutingRule(ctx, "rule-1")
	require.NoError(t, err)
	assert.False(t, got.EnabledValue())
	assert.True(t, created.Equal(got.CreatedAt))

	require.NoError(t, store.DeleteModelRoutingRule(ctx, "rule-1"))
	_, err = store.GetModelRoutingRule(ctx, "rule-1")
	require.ErrorIs(t, err, ErrNotFound)
	var targets int64
	require.NoError(t, store.DB().Model(&tables.TableModelRoutingTarget{}).Count(&targets).Error)
	assert.Zero(t, targets, "a rule's targets go with it")
	require.ErrorIs(t, store.DeleteModelRoutingRule(ctx, "rule-1"), ErrNotFound)
	require.ErrorIs(t, store.UpdateModelRoutingRule(ctx, update), ErrNotFound)
}

// TestModelRoutingRuleValidation pins what a rule is checked for before it is
// stored.
func TestModelRoutingRuleValidation(t *testing.T) {
	store := setupRDBTestStore(t)
	ctx := context.Background()

	cases := map[string]func(r *tables.TableModelRoutingRule){
		"missing name":           func(r *tables.TableModelRoutingRule) { r.Name = " " },
		"unknown scope":          func(r *tables.TableModelRoutingRule) { r.Scope = "org" },
		"scope without scope_id": func(r *tables.TableModelRoutingRule) { r.Scope = "team" },
		"missing router":         func(r *tables.TableModelRoutingRule) { r.ModelRouterID = "" },
		"no targets":             func(r *tables.TableModelRoutingRule) { r.Targets = nil },
		"unknown tier":           func(r *tables.TableModelRoutingRule) { r.Targets[0].Tier = "HARD" },
		"target changes nothing": func(r *tables.TableModelRoutingRule) { r.Targets[0].Provider, r.Targets[0].Model = nil, nil },
		"key without provider": func(r *tables.TableModelRoutingRule) {
			r.Targets[0].Provider, r.Targets[0].KeyID = nil, bifrost.Ptr("key-1")
		},
		"zero weight":                func(r *tables.TableModelRoutingRule) { r.Targets[0].Weight = 0 },
		"tier weights do not sum":    func(r *tables.TableModelRoutingRule) { r.Targets[2].Weight = 0.5 },
		"duplicate target in a tier": func(r *tables.TableModelRoutingRule) { r.Targets[2].Model = bifrost.Ptr("claude-opus") },
		"unknown fallback provider": func(r *tables.TableModelRoutingRule) {
			r.Targets[0].ParsedFallbacks = []tables.RoutingFallback{{Fallback: schemas.Fallback{Provider: "nowhere", Model: "x"}}}
		},
		"ttft out of range": func(r *tables.TableModelRoutingRule) { r.Targets[0].TTFTTimeoutMs = bifrost.Ptr(300001) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			rule := testModelRoutingRule("rule-1", "Support desk", DefaultModelRouterID, 0)
			mutate(rule)
			require.Error(t, store.CreateModelRoutingRule(ctx, rule))
		})
	}

	t.Run("lower-case tier and global scope_id are normalized", func(t *testing.T) {
		rule := testModelRoutingRule("rule-2", "Normalized", DefaultModelRouterID, 1)
		rule.Targets = []tables.TableModelRoutingTarget{{Tier: "simple", Model: bifrost.Ptr("gpt-4o-mini"), Weight: 1}}
		rule.ScopeID = bifrost.Ptr("ignored")
		require.NoError(t, store.CreateModelRoutingRule(ctx, rule))
		got, err := store.GetModelRoutingRule(ctx, "rule-2")
		require.NoError(t, err)
		assert.Equal(t, tables.ModelRoutingTierSimple, got.Targets[0].Tier)
		assert.Nil(t, got.ScopeID)
	})
}

// TestModelRoutingRuleReferences pins the cross-checks a write makes: the
// router must exist (the default always does), and the priority must be free
// within the rule's scope among model routing rules only.
func TestModelRoutingRuleReferences(t *testing.T) {
	ctx := context.Background()

	t.Run("router must exist", func(t *testing.T) {
		store := setupRDBTestStore(t)
		require.ErrorIs(t, store.CreateModelRoutingRule(ctx, testModelRoutingRule("rule-1", "One", "support", 0)), ErrUnknownModelRouter)
		require.NoError(t, store.CreateModelRoutingRule(ctx, testModelRoutingRule("rule-2", "Two", DefaultModelRouterID, 1)),
			"the default router exists before it is ever saved")
		require.NoError(t, store.CreateModelRouter(ctx, testModelRouter("support", "Support")))
		require.NoError(t, store.CreateModelRoutingRule(ctx, testModelRoutingRule("rule-1", "One", "support", 0)))
	})

	t.Run("priority is unique per scope", func(t *testing.T) {
		store := setupRDBTestStore(t)
		require.NoError(t, store.CreateModelRoutingRule(ctx, testModelRoutingRule("rule-1", "One", DefaultModelRouterID, 0)))
		err := store.CreateModelRoutingRule(ctx, testModelRoutingRule("rule-2", "Two", DefaultModelRouterID, 0))
		require.ErrorIs(t, err, ErrModelRoutingRulePriorityTaken)
		require.ErrorIs(t, err, ErrAlreadyExists)

		team := testModelRoutingRule("rule-3", "Team", DefaultModelRouterID, 0)
		team.Scope, team.ScopeID = "team", bifrost.Ptr("team-1")
		require.NoError(t, store.CreateModelRoutingRule(ctx, team), "another scope has its own priorities")
	})

	t.Run("priorities are separate from routing rules", func(t *testing.T) {
		store := setupRDBTestStore(t)
		require.NoError(t, store.CreateRoutingRule(ctx, &tables.TableRoutingRule{
			ID: "routing-1", Name: "Routing", Scope: "global", Priority: 0, CelExpression: "true",
			Targets: []tables.TableRoutingTarget{{Model: bifrost.Ptr("gpt-4o"), Weight: 1}},
		}))
		require.NoError(t, store.CreateModelRoutingRule(ctx, testModelRoutingRule("rule-1", "Routing", DefaultModelRouterID, 0)),
			"a routing rule and a model routing rule may share a scope, a name and a priority")
	})
}

// TestDeleteModelRouterInUse pins that a router model routing rules name
// cannot be deleted, and that the error names those rules.
func TestDeleteModelRouterInUse(t *testing.T) {
	store := setupRDBTestStore(t)
	ctx := context.Background()
	require.NoError(t, store.CreateModelRouter(ctx, testModelRouter("support", "Support")))
	require.NoError(t, store.CreateModelRoutingRule(ctx, testModelRoutingRule("rule-1", "Support desk", "support", 0)))
	require.NoError(t, store.CreateModelRoutingRule(ctx, testModelRoutingRule("rule-2", "After hours", "support", 1)))

	err := store.DeleteModelRouter(ctx, "support")
	require.ErrorIs(t, err, ErrModelRouterInUse)
	var inUse *ModelRouterInUseError
	require.True(t, errors.As(err, &inUse))
	assert.Equal(t, []string{"After hours", "Support desk"}, inUse.RuleNames)
	_, err = store.GetModelRouter(ctx, "support")
	require.NoError(t, err, "a refused delete leaves the router in place")

	require.NoError(t, store.DeleteModelRoutingRule(ctx, "rule-1"))
	require.NoError(t, store.DeleteModelRoutingRule(ctx, "rule-2"))
	require.NoError(t, store.DeleteModelRouter(ctx, "support"))
}

// TestGenerateModelRoutingRuleHash pins that a rule's hash ignores target
// order and moves with any field the file can change.
func TestGenerateModelRoutingRuleHash(t *testing.T) {
	base := testModelRoutingRule("rule-1", "Support desk", DefaultModelRouterID, 0)
	hash, err := GenerateModelRoutingRuleHash(*base)
	require.NoError(t, err)

	reordered := testModelRoutingRule("rule-1", "Support desk", DefaultModelRouterID, 0)
	reordered.Targets[0], reordered.Targets[2] = reordered.Targets[2], reordered.Targets[0]
	same, err := GenerateModelRoutingRuleHash(*reordered)
	require.NoError(t, err)
	assert.Equal(t, hash, same)

	changes := map[string]func(r *tables.TableModelRoutingRule){
		"router":    func(r *tables.TableModelRoutingRule) { r.ModelRouterID = "support" },
		"condition": func(r *tables.TableModelRoutingRule) { r.CelExpression = `model == "gpt-4o"` },
		"priority":  func(r *tables.TableModelRoutingRule) { r.Priority = 5 },
		"enabled":   func(r *tables.TableModelRoutingRule) { r.Enabled = bifrost.Ptr(false) },
		"weight":    func(r *tables.TableModelRoutingRule) { r.Targets[1].Weight, r.Targets[2].Weight = 0.5, 0.5 },
		"fallback":  func(r *tables.TableModelRoutingRule) { r.Targets[1].ParsedFallbacks = nil },
	}
	for name, mutate := range changes {
		t.Run(name, func(t *testing.T) {
			rule := testModelRoutingRule("rule-1", "Support desk", DefaultModelRouterID, 0)
			mutate(rule)
			changed, err := GenerateModelRoutingRuleHash(*rule)
			require.NoError(t, err)
			assert.NotEqual(t, hash, changed)
		})
	}
}

// TestMigrationAddModelRoutingRulesTables pins that the migration creates both
// tables and runs once.
func TestMigrationAddModelRoutingRulesTables(t *testing.T) {
	ctx := context.Background()
	db := setupModelRouterMigrationDB(t)
	require.NoError(t, migrationAddModelRoutingRulesTables(ctx, db, testMigrationLogger))
	require.True(t, db.Migrator().HasTable(&tables.TableModelRoutingRule{}))
	require.True(t, db.Migrator().HasTable(&tables.TableModelRoutingTarget{}))
	require.NoError(t, migrationAddModelRoutingRulesTables(ctx, db, testMigrationLogger))
}

// TestMigrationAddModelRoutingRuleQueryColumn pins that a table created
// before the query column existed gets it, and that a table that already has
// it is left as it is.
func TestMigrationAddModelRoutingRuleQueryColumn(t *testing.T) {
	ctx := context.Background()
	db := setupModelRouterMigrationDB(t)
	require.NoError(t, migrationAddModelRoutingRulesTables(ctx, db, testMigrationLogger))
	require.NoError(t, db.Migrator().DropColumn(&tables.TableModelRoutingRule{}, "Query"))

	require.NoError(t, migrationAddModelRoutingRuleQueryColumn(ctx, db, testMigrationLogger))
	assert.True(t, db.Migrator().HasColumn(&tables.TableModelRoutingRule{}, "Query"))
	require.NoError(t, migrationAddModelRoutingRuleQueryColumn(ctx, db, testMigrationLogger))
}
