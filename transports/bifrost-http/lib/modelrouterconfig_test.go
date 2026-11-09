package lib

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/maximhq/bifrost/framework/configstore"
	"github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// bootFromJSON runs the governance and model router loaders against store in
// boot order, parsing raw so section presence comes from the file itself.
func bootFromJSON(t *testing.T, store configstore.ConfigStore, raw string) *Config {
	t.Helper()
	var configData ConfigData
	require.NoError(t, json.Unmarshal([]byte(raw), &configData))
	config := &Config{ConfigStore: store}
	loadGovernanceConfig(context.Background(), config, &configData)
	loadModelRoutersConfig(context.Background(), config, &configData)
	return config
}

// routerJSON renders one model_routers entry with a phrase per tier.
func routerJSON(id, name, extra string, simple, medium, complex string) string {
	entry := fmt.Sprintf(`{"id":%q,"name":%q,"keywords":{"simple_keywords":[%q],"medium_keywords":[%q],"complex_keywords":[%q]}`, id, name, simple, medium, complex)
	if extra != "" {
		entry += "," + extra
	}
	return entry + "}"
}

// storedModelRouterRow reads a router's raw row, for timestamps the store type does not expose.
func storedModelRouterRow(t *testing.T, store configstore.ConfigStore, id string) tables.TableModelRouter {
	t.Helper()
	var row tables.TableModelRouter
	require.NoError(t, store.ExecuteTransaction(context.Background(), func(tx *gorm.DB) error {
		return tx.First(&row, "id = ?", id).Error
	}))
	return row
}

// requireModelRouterAbsent asserts no router is stored under id.
func requireModelRouterAbsent(t *testing.T, store configstore.ConfigStore, id string) {
	t.Helper()
	_, err := store.GetModelRouter(context.Background(), id)
	require.ErrorIs(t, err, configstore.ErrNotFound)
}

// TestModelRouterConfigLegacyKeyStillConfiguresDefault pins that a config.json
// written before model routers keeps working unchanged: the deprecated key
// configures the default router exactly as it configured the single router.
func TestModelRouterConfigLegacyKeyStillConfiguresDefault(t *testing.T) {
	initTestLogger()
	store := createTestSQLiteConfigStore(t, t.TempDir())

	bootFromJSON(t, store, `{"governance":{"complexity_analyzer_config":{"keywords":{
		"simple_keywords":["legacy-simple"],"medium_keywords":["legacy-medium"],"complex_keywords":["legacy-complex"]}}}}`)

	router, err := store.GetModelRouter(context.Background(), configstore.DefaultModelRouterID)
	require.NoError(t, err)
	assert.Equal(t, configstore.DefaultModelRouterName, router.Name)
	assert.Contains(t, router.Keywords.SimpleKeywords, "legacy-simple")
	assert.Greater(t, len(router.Keywords.SimpleKeywords), 1, "the split-mode merge still seeds the built-in phrases")

	routers, err := store.GetModelRouters(context.Background())
	require.NoError(t, err)
	assert.Len(t, routers, 1)
}

// TestModelRouterConfigDeclaresRouters covers the new shape: the default entry
// configures the default router, and every other entry becomes its own router
// holding exactly the phrases the file gives it.
func TestModelRouterConfigDeclaresRouters(t *testing.T) {
	initTestLogger()
	store := createTestSQLiteConfigStore(t, t.TempDir())
	ctx := context.Background()

	config := bootFromJSON(t, store, `{"model_routers":[`+
		routerJSON("default", "General", "", "general-simple", "general-medium", "general-complex")+","+
		routerJSON("support", "Support", `"description":"Support desk traffic","semantic":{"provider":"openai","embedding_model":"text-embedding-3-small"}`,
			"reset my password", "summarize this ticket thread", "draft an escalation plan")+
		`]}`)

	defaultRouter, err := store.GetModelRouter(ctx, configstore.DefaultModelRouterID)
	require.NoError(t, err)
	assert.Equal(t, "General", defaultRouter.Name)
	assert.Contains(t, defaultRouter.Keywords.SimpleKeywords, "general-simple")

	support, err := store.GetModelRouter(ctx, "support")
	require.NoError(t, err)
	assert.Equal(t, "Support", support.Name)
	assert.Equal(t, "Support desk traffic", support.Description)
	assert.Equal(t, []string{"reset my password"}, support.Keywords.SimpleKeywords, "a new router is not seeded with the default router's phrases")
	require.NotNil(t, support.Semantic)
	assert.Equal(t, "text-embedding-3-small", support.Semantic.EmbeddingModel)
	assert.False(t, support.ConfigHashes.Empty())

	assert.Empty(t, config.ModelRouters, "with a config store, the store is the source of truth")
}

// TestModelRouterConfigNewKeyWinsOverLegacy pins the both-keys rule: when
// model_routers is present the deprecated key is ignored entirely, never
// merged field by field with the default entry.
func TestModelRouterConfigNewKeyWinsOverLegacy(t *testing.T) {
	initTestLogger()
	ctx := context.Background()
	legacy := `"complexity_analyzer_config":{"keywords":{"simple_keywords":["legacy-only"],"medium_keywords":["legacy-medium"],"complex_keywords":["legacy-complex"]}}`

	t.Run("default entry present", func(t *testing.T) {
		store := createTestSQLiteConfigStore(t, t.TempDir())
		bootFromJSON(t, store, `{"governance":{`+legacy+`},"model_routers":[`+
			routerJSON("default", "Default", "", "entry-simple", "entry-medium", "entry-complex")+`]}`)

		router, err := store.GetModelRouter(ctx, configstore.DefaultModelRouterID)
		require.NoError(t, err)
		assert.Contains(t, router.Keywords.SimpleKeywords, "entry-simple")
		assert.NotContains(t, router.Keywords.SimpleKeywords, "legacy-only")
	})

	t.Run("no default entry leaves the default router alone", func(t *testing.T) {
		store := createTestSQLiteConfigStore(t, t.TempDir())
		bootFromJSON(t, store, `{"governance":{`+legacy+`},"model_routers":[`+
			routerJSON("support", "Support", "", "support-simple", "support-medium", "support-complex")+`]}`)

		requireModelRouterAbsent(t, store, configstore.DefaultModelRouterID)
		_, err := store.GetModelRouter(ctx, "support")
		require.NoError(t, err)
	})
}

// TestModelRouterConfigMovingLegacyKeyIsNoOp pins that rewriting the deprecated
// key as the default model_routers entry, same content, changes nothing: the
// section hashes match, so a phrase added in the dashboard is not touched.
func TestModelRouterConfigMovingLegacyKeyIsNoOp(t *testing.T) {
	initTestLogger()
	store := createTestSQLiteConfigStore(t, t.TempDir())
	ctx := context.Background()
	keywords := `"keywords":{"simple_keywords":["file-simple"],"medium_keywords":["file-medium"],"complex_keywords":["file-complex"]}`

	bootFromJSON(t, store, `{"governance":{"complexity_analyzer_config":{`+keywords+`}}}`)
	stored, err := store.GetComplexityAnalyzerConfig(ctx)
	require.NoError(t, err)
	edited := *stored
	edited.Keywords.SimpleKeywords = append(append([]string{}, stored.Keywords.SimpleKeywords...), "dashboard-simple")
	edited.ConfigHashes = configstore.ComplexityAnalyzerConfigHashes{}
	require.NoError(t, store.UpdateComplexityAnalyzerConfig(ctx, &edited))

	bootFromJSON(t, store, `{"model_routers":[{"id":"default","name":"Default",`+keywords+`}]}`)

	after, err := store.GetComplexityAnalyzerConfig(ctx)
	require.NoError(t, err)
	assert.Contains(t, after.Keywords.SimpleKeywords, "dashboard-simple")
	assert.Equal(t, stored.ConfigHashes, after.ConfigHashes)
}

// TestModelRouterConfigSplitModeKeepsDashboardEdits walks one router through
// reboots: an unchanged file writes nothing, a changed section is merged in
// without undoing dashboard edits to other sections or to the name, and a
// changed name is applied.
func TestModelRouterConfigSplitModeKeepsDashboardEdits(t *testing.T) {
	initTestLogger()
	store := createTestSQLiteConfigStore(t, t.TempDir())
	ctx := context.Background()
	semantic := `"semantic":{"provider":"openai","embedding_model":"text-embedding-3-small"}`
	boot := func(name, medium string) {
		bootFromJSON(t, store, `{"model_routers":[`+
			routerJSON("support", name, semantic, "support-simple", medium, "support-complex")+`]}`)
	}

	boot("Support", "support-medium")
	router, err := store.GetModelRouter(ctx, "support")
	require.NoError(t, err)
	router.Name = "Support desk"
	router.Semantic.EmbeddingModel = "text-embedding-3-large"
	router.ConfigHashes = configstore.ComplexityAnalyzerConfigHashes{}
	router.ConfigHash = ""
	require.NoError(t, store.UpdateModelRouter(ctx, router))
	edited := storedModelRouterRow(t, store, "support")

	boot("Support", "support-medium")
	assert.Equal(t, edited.UpdatedAt, storedModelRouterRow(t, store, "support").UpdatedAt, "an unchanged file writes nothing")

	boot("Support", "support-medium-2")
	router, err = store.GetModelRouter(ctx, "support")
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"support-medium", "support-medium-2"}, router.Keywords.MediumKeywords, "a changed phrase list merges in")
	assert.Equal(t, "text-embedding-3-large", router.Semantic.EmbeddingModel, "an unchanged section keeps its dashboard edit")
	assert.Equal(t, "Support desk", router.Name, "an unchanged name keeps its dashboard edit")

	boot("Customer support", "support-medium-2")
	router, err = store.GetModelRouter(ctx, "support")
	require.NoError(t, err)
	assert.Equal(t, "Customer support", router.Name)
	assert.Equal(t, "text-embedding-3-large", router.Semantic.EmbeddingModel)
}

// TestModelRouterConfigSourceOfTruth pins config.json as the source of truth:
// dashboard drift is reverted, undeclared routers are deleted, the default
// router is never deleted, and an invalid entry does not delete the router it
// was meant to configure.
func TestModelRouterConfigSourceOfTruth(t *testing.T) {
	initTestLogger()
	ctx := context.Background()
	keywords := func(prefix string) *configstore.ModelRouter {
		return &configstore.ModelRouter{ComplexityAnalyzerConfig: configstore.ComplexityAnalyzerConfig{
			Keywords: configstore.ComplexityEditableKeywordConfig{
				SimpleKeywords:  []string{prefix + "-simple"},
				MediumKeywords:  []string{prefix + "-medium"},
				ComplexKeywords: []string{prefix + "-complex"},
			},
		}}
	}
	seed := func(t *testing.T, store configstore.ConfigStore, id, name string) {
		router := keywords(id)
		router.ID, router.Name = id, name
		require.NoError(t, store.CreateModelRouter(ctx, router))
	}

	t.Run("reverts drift and prunes", func(t *testing.T) {
		store := createTestSQLiteConfigStore(t, t.TempDir())
		require.NoError(t, store.UpdateComplexityAnalyzerConfig(ctx, &keywords("default").ComplexityAnalyzerConfig))
		seed(t, store, "support", "Support desk")
		seed(t, store, "retired", "Retired")
		seed(t, store, "typo", "Typo")

		bootFromJSON(t, store, `{"source_of_truth":"config.json","model_routers":[`+
			routerJSON("support", "Support", "", "file-simple", "file-medium", "file-complex")+","+
			`{"id":"typo","name":"Typo","keywords":{"simple_keywords":["only-one-tier"]}}`+
			`]}`)

		support, err := store.GetModelRouter(ctx, "support")
		require.NoError(t, err)
		assert.Equal(t, "Support", support.Name)
		assert.Equal(t, []string{"file-simple"}, support.Keywords.SimpleKeywords)
		requireModelRouterAbsent(t, store, "retired")
		_, err = store.GetModelRouter(ctx, "typo")
		require.NoError(t, err, "an invalid entry must not delete the router it names")
		_, err = store.GetModelRouter(ctx, configstore.DefaultModelRouterID)
		require.NoError(t, err, "the default router is never pruned")
	})

	t.Run("a declared router can take the name of a pruned one", func(t *testing.T) {
		store := createTestSQLiteConfigStore(t, t.TempDir())
		seed(t, store, "retired", "Support")

		bootFromJSON(t, store, `{"source_of_truth":"config.json","model_routers":[`+
			routerJSON("support", "Support", "", "file-simple", "file-medium", "file-complex")+`]}`)

		requireModelRouterAbsent(t, store, "retired")
		support, err := store.GetModelRouter(ctx, "support")
		require.NoError(t, err)
		assert.Equal(t, "Support", support.Name)
	})

	t.Run("an empty list keeps only the default router", func(t *testing.T) {
		store := createTestSQLiteConfigStore(t, t.TempDir())
		require.NoError(t, store.UpdateComplexityAnalyzerConfig(ctx, &keywords("default").ComplexityAnalyzerConfig))
		seed(t, store, "support", "Support")

		bootFromJSON(t, store, `{"source_of_truth":"config.json","model_routers":[]}`)

		requireModelRouterAbsent(t, store, "support")
		_, err := store.GetModelRouter(ctx, configstore.DefaultModelRouterID)
		require.NoError(t, err)
	})

	t.Run("no model_routers section prunes nothing", func(t *testing.T) {
		store := createTestSQLiteConfigStore(t, t.TempDir())
		seed(t, store, "support", "Support")

		bootFromJSON(t, store, `{"source_of_truth":"config.json","governance":{"budgets":[]}}`)

		_, err := store.GetModelRouter(ctx, "support")
		require.NoError(t, err)
	})
}

// TestModelRouterConfigSkipsBadEntries pins that one bad entry is skipped
// without holding back the rest: a repeated id keeps its first declaration,
// and an entry that fails validation is dropped on its own.
func TestModelRouterConfigSkipsBadEntries(t *testing.T) {
	initTestLogger()
	store := createTestSQLiteConfigStore(t, t.TempDir())
	ctx := context.Background()

	bootFromJSON(t, store, `{"model_routers":[`+
		routerJSON("support", "Support", `"description":"first"`, "a-simple", "a-medium", "a-complex")+","+
		routerJSON("support", "Support again", `"description":"second"`, "b-simple", "b-medium", "b-complex")+","+
		routerJSON("bad id!", "Bad", "", "c-simple", "c-medium", "c-complex")+","+
		routerJSON("shadow", "default", "", "d-simple", "d-medium", "d-complex")+","+
		routerJSON("billing", "Billing", "", "e-simple", "e-medium", "e-complex")+
		`]}`)

	support, err := store.GetModelRouter(ctx, "support")
	require.NoError(t, err)
	assert.Equal(t, "first", support.Description)
	requireModelRouterAbsent(t, store, "bad id!")
	requireModelRouterAbsent(t, store, "shadow")
	_, err = store.GetModelRouter(ctx, "billing")
	require.NoError(t, err)
}

// TestModelRouterConfigReplacesUnreadableRouter pins that a router whose stored
// row this version cannot read is replaced by its config.json declaration.
func TestModelRouterConfigReplacesUnreadableRouter(t *testing.T) {
	initTestLogger()
	store := createTestSQLiteConfigStore(t, t.TempDir())
	ctx := context.Background()
	declare := `{"model_routers":[` + routerJSON("support", "Support", "", "s", "m", "c") + `]}`

	bootFromJSON(t, store, declare)
	require.NoError(t, store.ExecuteTransaction(ctx, func(tx *gorm.DB) error {
		return tx.Model(&tables.TableModelRouter{}).Where("id = ?", "support").Update("simple_phrases_json", `["broken`).Error
	}))
	_, err := store.GetModelRouter(ctx, "support")
	require.ErrorIs(t, err, configstore.ErrConfigUnreadable)

	bootFromJSON(t, store, declare)
	router, err := store.GetModelRouter(ctx, "support")
	require.NoError(t, err)
	assert.Equal(t, []string{"s"}, router.Keywords.SimpleKeywords)
}

// TestModelRouterConfigWithoutStore pins that a gateway with no config store
// still gets its declared routers, in memory.
func TestModelRouterConfigWithoutStore(t *testing.T) {
	initTestLogger()
	var configData ConfigData
	require.NoError(t, json.Unmarshal([]byte(`{"model_routers":[`+
		routerJSON("support", "Support", "", "Simple One", "medium-one", "complex-one")+`]}`), &configData))
	config := &Config{}

	loadModelRoutersConfig(context.Background(), config, &configData)

	require.Len(t, config.ModelRouters, 1)
	router := config.ModelRouters[0]
	assert.Equal(t, "support", router.ID)
	assert.Equal(t, []string{"simple one"}, router.Keywords.SimpleKeywords, "in-memory routers are normalized like stored ones")
}

// TestModelRouterConfigSchema pins where model routers live in config.json: a
// top-level list, accepted beside the deprecated governance key, whose ids are
// ones the store accepts. The schema rejects the list anywhere else.
func TestModelRouterConfigSchema(t *testing.T) {
	schema := loadLocalSchema(t)
	semantic := `"semantic":{"provider":"openai","embedding_model":"text-embedding-3-small"}`

	valid := `{"governance":{"complexity_analyzer_config":{"keywords":{"simple_keywords":["a"],"medium_keywords":["b"],"complex_keywords":["c"]}}},` +
		`"model_routers":[` +
		routerJSON("default", "General", "", "s", "m", "c") + "," +
		routerJSON("support-desk_2", "Support", `"description":"Support desk traffic",`+semantic+`,"session":{"enabled":true}`, "s", "m", "c") +
		`]}`
	require.NoError(t, ValidateConfigSchema([]byte(valid), schema))

	invalid := map[string]string{
		"list under governance":    `{"governance":{"model_routers":[` + routerJSON("support", "Support", "", "s", "m", "c") + `]}}`,
		"id with a space":          `{"model_routers":[` + routerJSON("support desk", "Support", "", "s", "m", "c") + `]}`,
		"missing name":             `{"model_routers":[{"id":"support","keywords":{"simple_keywords":["s"],"medium_keywords":["m"],"complex_keywords":["c"]}}]}`,
		"unknown field":            `{"model_routers":[` + routerJSON("support", "Support", `"phrases":["s"]`, "s", "m", "c") + `]}`,
		"session without semantic": `{"model_routers":[` + routerJSON("support", "Support", `"session":{"enabled":true}`, "s", "m", "c") + `]}`,
	}
	for name, config := range invalid {
		t.Run(name, func(t *testing.T) {
			require.Error(t, ValidateConfigSchema([]byte(config), schema))
		})
	}
}

// TestModelRouterConfigLoadConfigEndToEnd boots a real config.json through
// LoadConfig, schema validation included, and checks that the routers it
// declares reach the store.
func TestModelRouterConfigLoadConfigEndToEnd(t *testing.T) {
	initTestLogger()
	tempDir := createTempDir(t)
	keywords := func(prefix string) configstore.ComplexityAnalyzerConfig {
		return configstore.ComplexityAnalyzerConfig{
			TierBoundaries: configstore.DefaultComplexityTierBoundaries(),
			Keywords: configstore.ComplexityEditableKeywordConfig{
				SimpleKeywords:  []string{prefix + "-simple"},
				MediumKeywords:  []string{prefix + "-medium"},
				ComplexKeywords: []string{prefix + "-complex"},
			},
		}
	}
	configData := makeConfigDataWithProvidersAndDir(map[string]configstore.ProviderConfig{
		"openai": makeProviderConfigWithNetwork("openai-key-1", "sk-test-123", "https://api.openai.com"),
	}, tempDir)
	configData.ModelRouters = []configstore.ModelRouter{
		{ID: configstore.DefaultModelRouterID, Name: "General", ComplexityAnalyzerConfig: keywords("general")},
		{ID: "support", Name: "Support", Description: "Support desk traffic", ComplexityAnalyzerConfig: keywords("support")},
	}
	createConfigFile(t, tempDir, configData)

	ctx := context.Background()
	config, err := LoadConfig(ctx, tempDir)
	require.NoError(t, err)
	defer config.Close(ctx)

	defaultRouter, err := config.ConfigStore.GetModelRouter(ctx, configstore.DefaultModelRouterID)
	require.NoError(t, err)
	assert.Equal(t, "General", defaultRouter.Name)
	assert.Contains(t, defaultRouter.Keywords.SimpleKeywords, "general-simple")
	support, err := config.ConfigStore.GetModelRouter(ctx, "support")
	require.NoError(t, err)
	assert.Equal(t, "Support desk traffic", support.Description)
	assert.Equal(t, []string{"support-simple"}, support.Keywords.SimpleKeywords)
}
