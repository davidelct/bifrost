package handlers

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/valyala/fasthttp"

	"github.com/maximhq/bifrost/framework/configstore"
	"github.com/maximhq/bifrost/plugins/routing/complexity"
	"github.com/maximhq/bifrost/plugins/routing/complexity/suggest"
)

// modelRouterManagerFake records what the model router endpoints serve.
type modelRouterManagerFake struct {
	mockRoutingManager
	reloadedRouters []string
	removedRouters  []string
	reloadedRules   []string
	removedRules    []string
}

// ReloadModelRouter records a router reload.
func (m *modelRouterManagerFake) ReloadModelRouter(_ context.Context, id string) error {
	m.reloadedRouters = append(m.reloadedRouters, id)
	return nil
}

// RemoveModelRouter records a router removal.
func (m *modelRouterManagerFake) RemoveModelRouter(_ context.Context, id string) error {
	m.removedRouters = append(m.removedRouters, id)
	return nil
}

// ReloadModelRoutingRule records a rule reload.
func (m *modelRouterManagerFake) ReloadModelRoutingRule(_ context.Context, id string) error {
	m.reloadedRules = append(m.reloadedRules, id)
	return nil
}

// RemoveModelRoutingRule records a rule removal.
func (m *modelRouterManagerFake) RemoveModelRoutingRule(_ context.Context, id string) error {
	m.removedRules = append(m.removedRules, id)
	return nil
}

// GetModelRouterStatus reports every known router as disabled.
func (m *modelRouterManagerFake) GetModelRouterStatus(_ context.Context, id string) (complexity.SemanticStatusInfo, complexity.LLMStatusInfo, error) {
	if id == "missing" {
		return complexity.SemanticStatusInfo{}, complexity.LLMStatusInfo{}, configstore.ErrNotFound
	}
	return complexity.SemanticStatusInfo{State: complexity.SemanticStatusDisabled}, complexity.LLMStatusInfo{State: complexity.LLMStatusDisabled}, nil
}

// modelRouterHandler builds a routing handler over a real SQLite store.
func modelRouterHandler(t *testing.T) (*RoutingHandler, *modelRouterManagerFake, configstore.ConfigStore) {
	t.Helper()
	SetLogger(&mockLogger{})
	store := setupPricingOverrideHandlerStore(t)
	manager := &modelRouterManagerFake{}
	return &RoutingHandler{configStore: store, routingManager: manager}, manager, store
}

// call runs a handler with a body and path parameters and returns the status
// and decoded JSON body.
func call(t *testing.T, handler fasthttp.RequestHandler, body string, params map[string]string) (int, map[string]any) {
	t.Helper()
	ctx := newTestRequestCtx(body)
	for key, value := range params {
		ctx.SetUserValue(key, value)
	}
	handler(ctx)
	var decoded map[string]any
	_ = json.Unmarshal(ctx.Response.Body(), &decoded)
	return ctx.Response.StatusCode(), decoded
}

// routerBody is a router payload with one phrase per tier.
func routerBody(id, name string) string {
	return `{"id":"` + id + `","name":"` + name + `","keywords":{"simple_keywords":["s"],"medium_keywords":["m"],"complex_keywords":["c"]}}`
}

// TestModelRouterEndpoints walks a router through the API: the default router
// is listed before it is saved, a router is created, renamed and reset, and
// deleting is refused for the default router and for a router a rule names.
func TestModelRouterEndpoints(t *testing.T) {
	h, manager, _ := modelRouterHandler(t)

	status, body := call(t, h.listModelRouters, "", nil)
	require.Equal(t, fasthttp.StatusOK, status)
	routers := body["routers"].([]any)
	require.Len(t, routers, 1)
	assert.Equal(t, "default", routers[0].(map[string]any)["id"], "the default router exists before it is saved")

	status, body = call(t, h.createModelRouter, routerBody("support", "Support"), nil)
	require.Equal(t, fasthttp.StatusOK, status, "%v", body)
	assert.Equal(t, "Support", body["name"])
	assert.Equal(t, []string{"support"}, manager.reloadedRouters)

	status, _ = call(t, h.createModelRouter, routerBody("support", "Again"), nil)
	assert.Equal(t, fasthttp.StatusConflict, status)
	status, _ = call(t, h.createModelRouter, `{"name":"Default","keywords":{"simple_keywords":["s"],"medium_keywords":["m"],"complex_keywords":["c"]}}`, nil)
	assert.Equal(t, fasthttp.StatusBadRequest, status, "the default router's name is reserved")
	status, _ = call(t, h.createModelRouter, `{"name":"Typo","keywords":{"simple_keywords":["s"],"medium_keywords":["m"],"complex_keywords":["c"]},"semantik":{}}`, nil)
	assert.Equal(t, fasthttp.StatusBadRequest, status, "a misspelled setting is rejected, not dropped")

	status, body = call(t, h.createModelRouter, `{"name":"Generated","keywords":{"simple_keywords":["s"],"medium_keywords":["m"],"complex_keywords":["c"]}}`, nil)
	require.Equal(t, fasthttp.StatusOK, status)
	assert.NotEmpty(t, body["id"], "an omitted id is generated")

	status, body = call(t, h.updateModelRouter, routerBody("ignored", "Customer support"), map[string]string{"router_id": "support"})
	require.Equal(t, fasthttp.StatusOK, status, "%v", body)
	assert.Equal(t, "support", body["id"], "the path names the router")
	assert.Equal(t, "Customer support", body["name"])

	status, _ = call(t, h.updateModelRouter, routerBody("", "Nobody"), map[string]string{"router_id": "missing"})
	assert.Equal(t, fasthttp.StatusNotFound, status)

	status, body = call(t, h.resetModelRouter, "", map[string]string{"router_id": "support"})
	require.Equal(t, fasthttp.StatusOK, status, "%v", body)
	assert.Equal(t, "Customer support", body["name"], "a reset keeps the name")

	status, body = call(t, h.createModelRoutingRule, `{"name":"Support desk","model_router_id":"support","targets":[{"tier":"COMPLEX","provider":"anthropic","model":"claude-opus","weight":1}]}`, nil)
	require.Equal(t, fasthttp.StatusOK, status, "%v", body)

	status, body = call(t, h.deleteModelRouter, "", map[string]string{"router_id": "support"})
	assert.Equal(t, fasthttp.StatusConflict, status)
	errBody, _ := body["error"].(map[string]any)
	assert.Contains(t, errBody["message"], "Support desk", "the refusal names the rule in the way")
	status, _ = call(t, h.deleteModelRouter, "", map[string]string{"router_id": "default"})
	assert.Equal(t, fasthttp.StatusBadRequest, status)
	assert.Empty(t, manager.removedRouters)

	status, _ = call(t, h.getModelRouterStatus, "", map[string]string{"router_id": "missing"})
	assert.Equal(t, fasthttp.StatusNotFound, status)
	status, body = call(t, h.getModelRouterStatus, "", map[string]string{"router_id": "support"})
	assert.Equal(t, fasthttp.StatusOK, status)
	assert.Equal(t, suggest.DefaultInstructions(), body["suggestion_default_instructions"])
	assert.Equal(t, suggest.DefaultTierInstructions(), body["suggestion_default_tier_instructions"],
		"the decision tier step's question editor is seeded from the shipped instructions")
	// A router back on the shipped phrases has no examples to send.
	routerDefaults, _ := body["suggestion_default_tier_prompt"].(string)
	assert.NotContains(t, routerDefaults, "administrator assigned")

	// The suggestions tier block round-trips with its models filled in, and a
	// misspelled tier setting is refused.
	tiered := `{"id":"tiered","name":"Tiered","keywords":{"simple_keywords":["s"],"medium_keywords":["m"],"complex_keywords":["c"]},` +
		`"semantic":{"provider":"openai","embedding_model":"text-embedding-3-small"},` +
		`"suggestions":{"enabled":true,"provider":"openai","model":"gpt-4.1-mini","tier":{"classifier":"decision","instructions":"judge the work",` +
		`"prompt":"Refunds are SIMPLE.","criteria":{"SIMPLE":{"definition":"One short answer.","examples":["where is my refund"]}}}}}`
	status, body = call(t, h.createModelRouter, tiered, nil)
	require.Equal(t, fasthttp.StatusOK, status, "%v", body)
	suggestions, _ := body["suggestions"].(map[string]any)
	assert.Equal(t, map[string]any{"classifier": "decision", "provider": string(configstore.DefaultComplexityDecisionProvider),
		"model": configstore.DefaultComplexityDecisionModel, "instructions": "judge the work", "prompt": "Refunds are SIMPLE.",
		"criteria": map[string]any{"SIMPLE": map[string]any{"definition": "One short answer.", "examples": []any{"where is my refund"}}}}, suggestions["tier"])
	status, body = call(t, h.getModelRouter, "", map[string]string{"router_id": "tiered"})
	require.Equal(t, fasthttp.StatusOK, status, "%v", body)
	suggestions, _ = body["suggestions"].(map[string]any)
	tierBack, _ := suggestions["tier"].(map[string]any)
	assert.Equal(t, "Refunds are SIMPLE.", tierBack["prompt"], "the edited text is persisted, not only echoed")
	assert.NotNil(t, tierBack["criteria"])

	// The generated tier text is rendered from this router: its own phrases
	// (s, m, c) are the examples, in the prompt and in each tier's criteria.
	status, body = call(t, h.getModelRouterStatus, "", map[string]string{"router_id": "tiered"})
	require.Equal(t, fasthttp.StatusOK, status, "%v", body)
	tierPrompt, _ := body["suggestion_default_tier_prompt"].(string)
	assert.True(t, strings.HasPrefix(tierPrompt, suggest.DefaultTierInstructions()), tierPrompt)
	assert.True(t, strings.HasSuffix(tierPrompt, "SIMPLE:\n- s\nMEDIUM:\n- m\nCOMPLEX:\n- c"), tierPrompt)
	criteria, _ := body["suggestion_default_tier_criteria"].(map[string]any)
	require.Len(t, criteria, 3)
	medium, _ := criteria["MEDIUM"].(map[string]any)
	assert.Equal(t, []any{"m"}, medium["examples"])
	assert.NotEmpty(t, medium["definition"])
	status, _ = call(t, h.createModelRouter, strings.Replace(tiered, `"classifier"`, `"mode"`, 1), nil)
	assert.Equal(t, fasthttp.StatusBadRequest, status)
}

// TestModelRoutingRuleEndpoints walks a model routing rule through the API
// and pins the checks a write makes beyond the store's.
func TestModelRoutingRuleEndpoints(t *testing.T) {
	h, manager, _ := modelRouterHandler(t)

	rule := `{"name":"Support desk","model_router_id":"default","cel_expression":"model == \"gpt-4o\"","targets":[{"tier":"SIMPLE","model":"gpt-4o-mini","weight":1}]}`
	status, body := call(t, h.createModelRoutingRule, rule, nil)
	require.Equal(t, fasthttp.StatusOK, status, "%v", body)
	id := body["id"].(string)
	assert.Equal(t, "global", body["scope"])
	assert.Equal(t, []string{id}, manager.reloadedRules)

	invalid := map[string]string{
		"complexity_tier in the condition": `{"name":"x","model_router_id":"default","cel_expression":"complexity_tier == \"SIMPLE\"","targets":[{"tier":"SIMPLE","model":"m","weight":1}]}`,
		"unknown router":                   `{"name":"x","model_router_id":"ghost","targets":[{"tier":"SIMPLE","model":"m","weight":1}]}`,
		"no targets":                       `{"name":"x","model_router_id":"default","targets":[]}`,
		"config-only fallback field":       `{"name":"x","model_router_id":"default","targets":[{"tier":"SIMPLE","model":"m","weight":1,"fallbacks":[{"provider":"openai","model":"gpt-4o","provider_key_name":"k"}]}]}`,
		"team without a team":              `{"name":"x","model_router_id":"default","scope":"team","scope_id":"no-such-team","targets":[{"tier":"SIMPLE","model":"m","weight":1}]}`,
	}
	for name, payload := range invalid {
		t.Run(name, func(t *testing.T) {
			status, _ := call(t, h.createModelRoutingRule, payload, nil)
			assert.Equal(t, fasthttp.StatusBadRequest, status)
		})
	}

	status, _ = call(t, h.createModelRoutingRule, `{"name":"Second","model_router_id":"default","targets":[{"tier":"SIMPLE","model":"m","weight":1}]}`, nil)
	assert.Equal(t, fasthttp.StatusConflict, status, "priority 0 in global is taken")

	status, body = call(t, h.updateModelRoutingRule, `{"name":"Support desk","model_router_id":"default","enabled":false,"targets":[{"tier":"MEDIUM","model":"gpt-4o","weight":1}]}`, map[string]string{"rule_id": id})
	require.Equal(t, fasthttp.StatusOK, status, "%v", body)
	assert.Equal(t, false, body["enabled"])

	status, body = call(t, h.listModelRoutingRules, "", nil)
	require.Equal(t, fasthttp.StatusOK, status)
	assert.Equal(t, float64(1), body["count"])

	status, _ = call(t, h.deleteModelRoutingRule, "", map[string]string{"rule_id": id})
	require.Equal(t, fasthttp.StatusOK, status)
	assert.Equal(t, []string{id}, manager.removedRules)
	status, _ = call(t, h.getModelRoutingRule, "", map[string]string{"rule_id": id})
	assert.Equal(t, fasthttp.StatusNotFound, status)
}
