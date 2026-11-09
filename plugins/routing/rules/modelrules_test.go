package rules

import (
	"context"
	"testing"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
	configstoreTables "github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// modelRule builds an enabled model routing rule with one SIMPLE target.
func modelRule(id, scope, scopeID string, priority int, cel string) *configstoreTables.TableModelRoutingRule {
	rule := &configstoreTables.TableModelRoutingRule{
		ID:            id,
		Name:          id,
		ModelRouterID: "default",
		Scope:         scope,
		Priority:      priority,
		CelExpression: cel,
		Targets: []configstoreTables.TableModelRoutingTarget{
			{Tier: configstoreTables.ModelRoutingTierSimple, Model: bifrost.Ptr("gpt-4o-mini"), Weight: 1},
		},
	}
	if scopeID != "" {
		rule.ScopeID = bifrost.Ptr(scopeID)
	}
	return rule
}

// newTestModelRuleStore builds an empty model rule store.
func newTestModelRuleStore(t *testing.T) *ModelRuleStore {
	t.Helper()
	store, err := NewModelRuleStore(context.Background(), NewMockLogger(), nil)
	require.NoError(t, err)
	return store
}

// matchID returns the id of the rule that matches, or "".
func matchID(t *testing.T, store *ModelRuleStore, evaluation *EvaluationContext) string {
	t.Helper()
	ctx := schemas.NewBifrostContext(context.Background(), schemas.NoDeadline)
	rule, err := store.Match(ctx, evaluation)
	require.NoError(t, err)
	if rule == nil {
		return ""
	}
	return rule.ID
}

// TestModelRuleStoreMatchOrder pins that model routing rules are walked in the
// routing rules' order: narrowest scope first, then priority, the first match
// only.
func TestModelRuleStoreMatchOrder(t *testing.T) {
	store := newTestModelRuleStore(t)
	require.NoError(t, store.Upsert(modelRule("global-late", "global", "", 5, "")))
	require.NoError(t, store.Upsert(modelRule("global-early", "global", "", 1, "")))
	require.NoError(t, store.Upsert(modelRule("team", "team", "team-1", 9, "")))
	require.NoError(t, store.Upsert(modelRule("vk", "virtual_key", "vk-1", 9, `model == "never"`)))

	assert.Equal(t, "global-early", matchID(t, store, &EvaluationContext{Model: "gpt-4o"}), "priority orders a scope")
	assert.Equal(t, "team", matchID(t, store, &EvaluationContext{Model: "gpt-4o", Scope: GovernanceScope{TeamID: "team-1"}}),
		"a narrower scope wins whatever its priority")
	assert.Equal(t, "team", matchID(t, store, &EvaluationContext{Model: "gpt-4o", Scope: GovernanceScope{VirtualKeyID: "vk-1", TeamID: "team-1"}}),
		"a narrower rule whose condition fails passes to the next scope")
	assert.Equal(t, "global-early", matchID(t, store, &EvaluationContext{Model: "gpt-4o", Scope: GovernanceScope{TeamID: "team-2"}}),
		"another team's rule never matches")
}

// TestModelRuleStoreConditions pins how conditions are read: an empty one
// matches everything in scope, a condition sees the model the routing rules
// settled on, and a disabled rule never matches.
func TestModelRuleStoreConditions(t *testing.T) {
	store := newTestModelRuleStore(t)
	require.NoError(t, store.Upsert(modelRule("mini-only", "global", "", 0, `model == "gpt-4o-mini"`)))
	disabled := modelRule("disabled", "global", "", 1, "")
	disabled.Enabled = bifrost.Ptr(false)
	require.NoError(t, store.Upsert(disabled))
	require.NoError(t, store.Upsert(modelRule("header", "global", "", 2, `headers["x-app"] == "helpdesk"`)))

	assert.Equal(t, "mini-only", matchID(t, store, &EvaluationContext{Model: "gpt-4o-mini"}))
	assert.Equal(t, "", matchID(t, store, &EvaluationContext{Model: "gpt-4o"}), "a missing header is a non-match, not an error")
	assert.Equal(t, "header", matchID(t, store, &EvaluationContext{Model: "gpt-4o", Headers: map[string]string{"x-app": "helpdesk"}}))
}

// TestModelRuleStoreUpsertAndDelete pins that a rule moves with its scope, a
// bad condition leaves the cached rule as it was, and HasRules follows the
// cache.
func TestModelRuleStoreUpsertAndDelete(t *testing.T) {
	store := newTestModelRuleStore(t)
	assert.False(t, store.HasRules())
	var nilStore *ModelRuleStore
	assert.False(t, nilStore.HasRules(), "a plugin built without the store skips the step")

	require.NoError(t, store.Upsert(modelRule("rule", "team", "team-1", 0, "")))
	assert.True(t, store.HasRules())
	require.NoError(t, store.Upsert(modelRule("rule", "global", "", 0, "")))
	assert.Equal(t, "rule", matchID(t, store, &EvaluationContext{Model: "m"}), "the rule moved to global")
	_, inTeam := store.rules.Load(scopeKey("team", "team-1"))
	assert.False(t, inTeam, "and left the team's scope")

	require.Error(t, store.Upsert(modelRule("rule", "global", "", 0, `model ==`)))
	assert.Equal(t, "rule", matchID(t, store, &EvaluationContext{Model: "m"}), "a failed update keeps the served rule")

	store.Delete("rule")
	assert.False(t, store.HasRules())
	assert.Equal(t, "", matchID(t, store, &EvaluationContext{Model: "m"}))
	store.Delete("rule")
}

// TestValidateModelRuleCEL pins that a model routing rule's condition compiles
// like a routing rule's but cannot use complexity_tier.
func TestValidateModelRuleCEL(t *testing.T) {
	assert.NoError(t, ValidateModelRuleCEL(""))
	assert.NoError(t, ValidateModelRuleCEL(`model == "gpt-4o" && headers["x-app"] == "helpdesk"`))
	assert.Error(t, ValidateModelRuleCEL(`model ==`))
	assert.ErrorContains(t, ValidateModelRuleCEL(`complexity_tier == "COMPLEX"`), "complexity_tier")

	store := newTestModelRuleStore(t)
	require.Error(t, store.Upsert(modelRule("tier", "global", "", 0, `complexity_tier == "SIMPLE"`)))
	assert.False(t, store.HasRules())
}

// TestSelectModelRoutingTarget pins target selection: only the tier's targets
// are candidates, a single one always wins, and weights split the rest.
func TestSelectModelRoutingTarget(t *testing.T) {
	targets := []configstoreTables.TableModelRoutingTarget{
		{Tier: configstoreTables.ModelRoutingTierSimple, Model: bifrost.Ptr("mini"), Weight: 1},
		{Tier: configstoreTables.ModelRoutingTierComplex, Model: bifrost.Ptr("opus"), Weight: 0.5},
		{Tier: configstoreTables.ModelRoutingTierComplex, Model: bifrost.Ptr("sonnet"), Weight: 0.5},
	}
	got, ok := SelectModelRoutingTarget(targets, configstoreTables.ModelRoutingTierSimple)
	require.True(t, ok)
	assert.Equal(t, "mini", *got.Model)

	_, ok = SelectModelRoutingTarget(targets, configstoreTables.ModelRoutingTierMedium)
	assert.False(t, ok, "a tier without targets keeps the request's model")

	seen := map[string]bool{}
	for range 200 {
		got, ok := SelectModelRoutingTarget(targets, configstoreTables.ModelRoutingTierComplex)
		require.True(t, ok)
		seen[*got.Model] = true
	}
	assert.Equal(t, map[string]bool{"opus": true, "sonnet": true}, seen, "both weighted targets are used and no other tier's")
}
