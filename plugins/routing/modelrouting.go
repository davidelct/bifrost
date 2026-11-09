package routing

import (
	"fmt"
	"strings"
	"time"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
	configstoreTables "github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/maximhq/bifrost/plugins/routing/complexity"
	"github.com/maximhq/bifrost/plugins/routing/rules"
)

// modelRouterTiersKey keys the per-request record of each model router's
// answer, so a router asked twice in one request classifies once.
type modelRouterTiersKey struct{}

// routerTier is one router's answer for a request, as it was published.
type routerTier struct {
	result    *complexity.ComplexityResult
	mechanism string
	score     *float64
}

// cachedRouterTier returns the router's earlier answer for this request.
func cachedRouterTier(ctx *schemas.BifrostContext, routerID string) (routerTier, bool) {
	tiers, _ := ctx.Value(modelRouterTiersKey{}).(map[string]routerTier)
	entry, ok := tiers[routerID]
	return entry, ok
}

// cacheRouterTier records the router's answer, reading the mechanism and score
// it published alongside the result.
func cacheRouterTier(ctx *schemas.BifrostContext, routerID string, result *complexity.ComplexityResult) {
	entry := routerTier{result: result}
	entry.mechanism, _ = ctx.Value(schemas.BifrostContextKeyGovernanceComplexityMechanism).(string)
	if score, ok := ctx.Value(schemas.BifrostContextKeyGovernanceComplexityScore).(float64); ok {
		entry.score = &score
	}
	tiers, _ := ctx.Value(modelRouterTiersKey{}).(map[string]routerTier)
	if tiers == nil {
		tiers = make(map[string]routerTier, 1)
		ctx.SetValue(modelRouterTiersKey{}, tiers)
	}
	tiers[routerID] = entry
}

// publishModelRouter records the router being asked for the request's tier.
// The last router asked is the one whose tier the request carries.
func publishModelRouter(ctx *schemas.BifrostContext, rt *modelRouterRuntime) {
	ctx.SetValue(schemas.BifrostContextKeyModelRouterID, rt.id)
	ctx.SetValue(schemas.BifrostContextKeyModelRouterName, rt.displayName())
}

// applyModelRoutingRules is the model routing step, after the routing rules.
// The first model routing rule that matches names a router; the router
// classifies the request; the rule's target for that tier replaces the
// provider and model. A request no rule matches, one the router cannot
// classify, and one whose tier has no target keep what the routing rules
// chose.
//
// Applying a target follows the agreed rules: a provider change clears a key
// the routing rules pinned, since it names a key of the old provider, unless
// the target pins its own; the target's fallbacks replace the chain only when
// it has some; and the first match is the only one, with no chaining.
func (p *RoutingPlugin) applyModelRoutingRules(ctx *schemas.BifrostContext, req *schemas.BifrostRequest, scope rules.GovernanceScope) {
	if !p.modelRules.HasRules() {
		return
	}
	provider, model, _ := req.GetRequestFields()
	if model == "" {
		return
	}
	headers, _ := ctx.Value(schemas.BifrostContextKeyRequestHeaders).(map[string]string)
	queryParams, _ := ctx.Value(schemas.BifrostContextKeyRequestQuery).(map[string]string)
	evaluation := &rules.EvaluationContext{
		Scope:                    scope,
		Provider:                 provider,
		Model:                    model,
		RequestType:              string(req.RequestType),
		Headers:                  headers,
		QueryParams:              queryParams,
		BudgetAndRateLimitStatus: p.governance.GetBudgetAndRateLimitStatus(ctx, provider, model, nil, nil, nil),
	}
	rule, err := p.modelRules.Match(ctx, evaluation)
	if err != nil {
		p.logger.Error("failed to evaluate model routing rules: %v", err)
		ctx.AppendRoutingEngineLog(schemas.RoutingEngineModelRouter, schemas.LogLevelError, fmt.Sprintf("Model routing rule evaluation error: %v", err))
		return
	}
	if rule == nil {
		return
	}
	ctx.SetValue(schemas.BifrostContextKeyModelRoutingRuleID, rule.ID)
	ctx.SetValue(schemas.BifrostContextKeyModelRoutingRuleName, rule.Name)
	schemas.AppendToContextList(ctx, schemas.BifrostContextKeyRoutingEnginesUsed, schemas.RoutingEngineModelRouter)

	rt, ok := p.modelRouter(rule.ModelRouterID)
	if !ok {
		ctx.AppendRoutingEngineLog(schemas.RoutingEngineModelRouter, schemas.LogLevelWarn,
			fmt.Sprintf("Model routing rule '%s' names model router %q, which is not loaded; keeping provider=%s, model=%s", rule.Name, rule.ModelRouterID, provider, model))
		return
	}
	result := p.computeRouterComplexity(ctx, req, rt)
	if result == nil {
		ctx.AppendRoutingEngineLog(schemas.RoutingEngineModelRouter, schemas.LogLevelInfo,
			fmt.Sprintf("Model routing rule '%s': model router '%s' produced no tier; keeping provider=%s, model=%s", rule.Name, rt.displayName(), provider, model))
		return
	}
	target, ok := rules.SelectModelRoutingTarget(rule.Targets, result.Tier)
	if !ok {
		ctx.AppendRoutingEngineLog(schemas.RoutingEngineModelRouter, schemas.LogLevelInfo,
			fmt.Sprintf("Model routing rule '%s': model router '%s' tier=%s has no target; keeping provider=%s, model=%s", rule.Name, rt.displayName(), result.Tier, provider, model))
		return
	}
	p.applyModelRoutingTarget(ctx, req, rule, target, provider, model)
	routedProvider, routedModel, _ := req.GetRequestFields()
	ctx.AppendRoutingEngineLog(schemas.RoutingEngineModelRouter, schemas.LogLevelInfo,
		fmt.Sprintf("Model routing rule '%s' → model router '%s' tier=%s → provider=%s, model=%s", rule.Name, rt.displayName(), result.Tier, routedProvider, routedModel))
}

// applyModelRoutingTarget writes a tier target onto the request. provider and
// model are what the routing rules settled on; a target field left unset keeps
// them.
func (p *RoutingPlugin) applyModelRoutingTarget(
	ctx *schemas.BifrostContext,
	req *schemas.BifrostRequest,
	rule *configstoreTables.TableModelRoutingRule,
	target configstoreTables.TableModelRoutingTarget,
	provider schemas.ModelProvider,
	model string,
) {
	if target.Provider != nil && strings.TrimSpace(*target.Provider) != "" {
		if next := schemas.ModelProvider(strings.TrimSpace(*target.Provider)); next != provider {
			// A key the routing rules pinned belongs to their provider.
			ctx.ClearValue(schemas.BifrostContextKeyRoutingPinnedAPIKeyID)
			req.SetProvider(next)
		}
	}
	if target.Model != nil && strings.TrimSpace(*target.Model) != "" {
		if next := strings.TrimSpace(*target.Model); next != model {
			req.SetModel(next)
		}
	}
	if target.KeyID != nil && strings.TrimSpace(*target.KeyID) != "" {
		ctx.SetValue(schemas.BifrostContextKeyRoutingPinnedAPIKeyID, strings.TrimSpace(*target.KeyID))
	}
	if len(target.ParsedFallbacks) > 0 {
		req.SetFallbacks(resolveRuleFallbacks(ctx, schemas.RoutingEngineModelRouter, "Model routing rule '"+rule.Name+"'", target.ParsedFallbacks, model))
	}
	if target.TTFTTimeoutMs != nil && *target.TTFTTimeoutMs > 0 && bifrost.IsStreamRequestType(req.RequestType) {
		ctx.SetValue(schemas.BifrostContextKeyStreamFirstTokenTimeout, time.Duration(*target.TTFTTimeoutMs)*time.Millisecond)
	}
}

// resolveRuleFallbacks turns a rule's fallback chain into the request's. A
// fallback that omits its model keeps model, the one the step received, as
// "provider/" documents; one that names no provider is skipped and logged
// under engine with the rule's label.
func resolveRuleFallbacks(ctx *schemas.BifrostContext, engine, label string, fallbacks []configstoreTables.RoutingFallback, model string) []schemas.Fallback {
	resolved := make([]schemas.Fallback, 0, len(fallbacks))
	for _, fb := range fallbacks {
		fallback := fb.Resolved()
		fallback.Provider = schemas.ModelProvider(strings.TrimSpace(string(fallback.Provider)))
		fallback.Model = strings.TrimSpace(fallback.Model)
		fallback.KeyID = strings.TrimSpace(fallback.KeyID)
		if fallback.Provider == "" {
			ctx.AppendRoutingEngineLog(engine, schemas.LogLevelWarn, fmt.Sprintf("%s: fallback %q skipped: it does not name a known provider", label, fb.String()))
			continue
		}
		if fallback.Model == "" {
			fallback.Model = model
		}
		resolved = append(resolved, fallback)
	}
	return resolved
}

// ReloadModelRoutingRule serves a saved model routing rule. A condition that
// does not compile is an error and leaves the served rule as it was.
func (p *RoutingPlugin) ReloadModelRoutingRule(rule *configstoreTables.TableModelRoutingRule) error {
	if p.modelRules == nil {
		return fmt.Errorf("model routing rules are not available")
	}
	return p.modelRules.Upsert(rule)
}

// RemoveModelRoutingRule stops serving a model routing rule.
func (p *RoutingPlugin) RemoveModelRoutingRule(id string) {
	if p.modelRules != nil {
		p.modelRules.Delete(id)
	}
}
