package routing

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	configstoreTables "github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/maximhq/bifrost/framework/kvstore"
	"github.com/maximhq/bifrost/plugins/routing/complexity"
	"github.com/maximhq/bifrost/plugins/routing/rules"
)

// TestComplexityStateKeysScopeModelRouters pins that each model router keeps
// its own session and continuation state, while the default router keeps the
// keys written before routers had names, so state in flight survives the
// upgrade.
func TestComplexityStateKeysScopeModelRouters(t *testing.T) {
	ctx := schemas.NewBifrostContext(context.Background(), schemas.NoDeadline)
	ctx.SetValue(schemas.BifrostContextKeySessionID, "session-1")

	require.Equal(t, bifrost.SessionStateKey(ctx, complexitySessionKind), complexitySessionKeyFor(ctx, configstore.DefaultModelRouterID))
	require.Equal(t, bifrost.SessionStateKey(ctx, complexityTurnTierKind), complexityTurnTierKeyFor(ctx, configstore.DefaultModelRouterID))
	require.Equal(t, complexitySessionKey(ctx), complexitySessionKeyFor(ctx, ""), "an unnamed router is the default")

	support, billing := complexitySessionKeyFor(ctx, "support"), complexitySessionKeyFor(ctx, "billing")
	assert.NotEqual(t, complexitySessionKey(ctx), support)
	assert.NotEqual(t, support, billing)
	assert.NotEqual(t, complexityTurnTierKey(ctx), complexityTurnTierKeyFor(ctx, "support"))
}

// TestRoutingPluginServesStoredModelRouters pins the boot path: a plugin
// built over a config store serves the routers and model routing rules it
// holds, and takes the default router's name from it.
func TestRoutingPluginServesStoredModelRouters(t *testing.T) {
	ctx := context.Background()
	logger := rules.NewMockLogger()
	store, err := configstore.NewConfigStore(ctx, &configstore.Config{
		Enabled: true,
		Type:    configstore.ConfigStoreTypeSQLite,
		Config:  &configstore.SQLiteConfig{Path: t.TempDir() + "/config.db"},
	}, logger)
	require.NoError(t, err)
	t.Cleanup(func() { store.Close(ctx) })

	keywords := complexity.EditableKeywordConfig{
		SimpleKeywords: []string{"papaya amber"}, MediumKeywords: []string{"cedar cobalt"}, ComplexKeywords: []string{"obsidian comet"},
	}
	require.NoError(t, store.UpdateModelRouter(ctx, &configstore.ModelRouter{
		ID: configstore.DefaultModelRouterID, Name: "General",
		ComplexityAnalyzerConfig: complexity.AnalyzerConfig{Classifier: complexity.ClassifierDecision, Keywords: keywords},
	}))
	require.NoError(t, store.CreateModelRouter(ctx, &configstore.ModelRouter{
		ID: "support", Name: "Support",
		ComplexityAnalyzerConfig: complexity.AnalyzerConfig{Classifier: complexity.ClassifierDecision, Keywords: keywords},
	}))
	require.NoError(t, store.CreateModelRoutingRule(ctx, &configstoreTables.TableModelRoutingRule{
		ID: "support-desk", Name: "Support desk", ModelRouterID: "support", Scope: "global",
		Targets: []configstoreTables.TableModelRoutingTarget{{Tier: complexity.TierSimple, Model: bifrost.Ptr("gpt-4o-mini"), Weight: 1}},
	}))

	ruleStore, err := rules.NewLocalStore(ctx, logger, store)
	require.NoError(t, err)
	plugin, err := InitFromStore(ctx, nil, logger, store, ruleStore, NewMockGovernance())
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, plugin.Cleanup()) })

	rt, ok := plugin.modelRouter("support")
	require.True(t, ok)
	assert.Equal(t, "Support", rt.displayName())
	assert.Equal(t, complexity.ClassifierDecision, rt.config.Load().Classifier)
	assert.Equal(t, "General", plugin.defaultModelRouter().displayName())
	assert.True(t, plugin.modelRules.HasRules())
}

// TestPersistComplexityTurnTierKeepsEveryRouter pins that a turn in which a
// routing rule asked the default router and a model routing rule asked
// another saves both tiers, so a tool continuation resumes each router on the
// tier it gave, not on the last router's.
func TestPersistComplexityTurnTierKeepsEveryRouter(t *testing.T) {
	store, err := kvstore.New(kvstore.Config{CleanupInterval: time.Hour})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	plugin := &RoutingPlugin{turnTierStore: &complexityTurnTierStore{store: store}, logger: rules.NewMockLogger()}

	ctx := schemas.NewBifrostContext(context.Background(), schemas.NoDeadline)
	ctx.SetValue(schemas.BifrostContextKeySessionID, "session-1")
	cacheRouterTier(ctx, configstore.DefaultModelRouterID, &complexity.ComplexityResult{Tier: complexity.TierComplex})
	cacheRouterTier(ctx, "support", &complexity.ComplexityResult{Tier: complexity.TierSimple})
	cacheRouterTier(ctx, "billing", nil)

	plugin.persistComplexityTurnTier(ctx)

	for routerID, want := range map[string]string{configstore.DefaultModelRouterID: complexity.TierComplex, "support": complexity.TierSimple} {
		tier, found, err := plugin.turnTierStore.load(complexityTurnTierKeyFor(ctx, routerID))
		require.NoError(t, err)
		require.True(t, found, routerID)
		assert.Equal(t, want, tier, routerID)
	}
	_, found, err := plugin.turnTierStore.load(complexityTurnTierKeyFor(ctx, "billing"))
	require.NoError(t, err)
	assert.False(t, found, "a router that produced no tier saves nothing")
}
