package routing

import (
	"context"
	"fmt"
	"sort"
	"sync/atomic"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	"github.com/maximhq/bifrost/framework/vectorstore"
	"github.com/maximhq/bifrost/plugins/routing/complexity"
)

// modelRouterRuntime is one model router as the plugin serves it: its config
// and the classifiers built from it. The default router's runtime is a view
// over the plugin's own fields, the ones it had before routers had names, so
// that router behaves exactly as the single router did; every other router
// owns its state.
type modelRouterRuntime struct {
	id             string
	name           *atomic.Pointer[string]
	config         *atomic.Pointer[complexity.AnalyzerConfig]
	sessionEnabled *atomic.Bool
	semantic       *complexity.SemanticClassifier
	llm            *complexity.LLMClassifier
}

// modelRouterState is the state a router other than the default owns.
type modelRouterState struct {
	name           atomic.Pointer[string]
	config         atomic.Pointer[complexity.AnalyzerConfig]
	sessionEnabled atomic.Bool
}

// displayName is the router's name for logs and context, its id until it has one.
func (rt *modelRouterRuntime) displayName() string {
	if rt.name != nil {
		if name := rt.name.Load(); name != nil && *name != "" {
			return *name
		}
	}
	if rt.id == configstore.DefaultModelRouterID {
		return configstore.DefaultModelRouterName
	}
	return rt.id
}

// defaultModelRouter returns the default router's view over the plugin's
// fields. It is built on each call, so a plugin assembled field by field, as
// tests do, still has one.
func (p *RoutingPlugin) defaultModelRouter() *modelRouterRuntime {
	return &modelRouterRuntime{
		id:             configstore.DefaultModelRouterID,
		name:           &p.defaultRouterName,
		config:         &p.complexityConfig,
		sessionEnabled: &p.sessionEnabled,
		semantic:       p.semanticClassifier,
		llm:            p.llmClassifier,
	}
}

// extraModelRouters returns the routers other than the default, keyed by id.
// The map is never mutated in place; writers replace it under routersMu.
func (p *RoutingPlugin) extraModelRouters() map[string]*modelRouterRuntime {
	if current := p.routers.Load(); current != nil {
		return *current
	}
	return nil
}

// modelRouter returns the router with the given id, or false if the plugin
// does not serve it.
func (p *RoutingPlugin) modelRouter(id string) (*modelRouterRuntime, bool) {
	if id == "" || id == configstore.DefaultModelRouterID {
		return p.defaultModelRouter(), true
	}
	rt, ok := p.extraModelRouters()[id]
	return rt, ok
}

// allModelRouters returns every router, the default first and the rest by id.
func (p *RoutingPlugin) allModelRouters() []*modelRouterRuntime {
	extras := p.extraModelRouters()
	ids := make([]string, 0, len(extras))
	for id := range extras {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	routers := make([]*modelRouterRuntime, 0, len(extras)+1)
	routers = append(routers, p.defaultModelRouter())
	for _, id := range ids {
		routers = append(routers, extras[id])
	}
	return routers
}

// resolveRouterConfig validates a router's config for serving. An invalid
// one falls back to the defaults with a warning, as the single router always
// did, but session routing without a KV store is an error, since no fallback
// can serve it.
func (p *RoutingPlugin) resolveRouterConfig(config *complexity.AnalyzerConfig) (*complexity.AnalyzerConfig, error) {
	resolved, err := complexity.ValidateAndNormalize(config)
	if err != nil {
		if p.logger != nil {
			p.logger.Warn("invalid complexity analyzer config, using defaults: %v", err)
		}
		defaults := complexity.DefaultAnalyzerConfig()
		resolved = &defaults
	}
	if resolved.SessionRoutingEnabled() && p.sessionStore == nil {
		return nil, fmt.Errorf("complexity session routing requires a KV store")
	}
	return resolved, nil
}

// applyRouterConfig installs a resolved config on a router: its settings and
// its classifiers. A decision-model router keeps no semantic block, so its
// semantic classifier stays idle.
func applyRouterConfig(rt *modelRouterRuntime, resolved *complexity.AnalyzerConfig) {
	rt.config.Store(resolved)
	rt.sessionEnabled.Store(resolved.SessionRoutingEnabled())
	if rt.semantic != nil {
		semanticConfig := resolved
		if resolved.Classifier == complexity.ClassifierDecision {
			copyConfig := *resolved
			copyConfig.Semantic = nil
			semanticConfig = &copyConfig
		}
		rt.semantic.Configure(semanticConfig)
	}
	if rt.llm != nil {
		rt.llm.Configure(resolved)
	}
}

// newModelRouterRuntime builds a router's classifiers with the collaborators
// the plugin's own classifier was given: the warm coordinator, the embedding
// width store, the generation registry, and whatever embedding and chat
// executors are wired. Request capture is not wired: phrase suggestions read
// the default router's traffic until they can select a router's own requests.
func (p *RoutingPlugin) newModelRouterRuntime(id string) *modelRouterRuntime {
	ctx := p.runtimeCtx
	if ctx == nil {
		ctx = context.Background()
	}
	state := &modelRouterState{}
	semantic := complexity.NewSemanticClassifier(ctx, p.logger)
	if p.warmCoordinator != nil {
		semantic.SetWarmCoordinator(p.warmCoordinator)
	}
	if p.dimensionStore != nil {
		semantic.SetEmbeddingDimensionStore(p.dimensionStore)
	}
	if p.generations != nil {
		semantic.SetGenerationClaimer(p.generations)
	}
	var store vectorstore.VectorStore
	if ptr := p.complexityVectorStore.Load(); ptr != nil {
		store = *ptr
	}
	if p.embeddingExecutor() != nil {
		semantic.SetWarmupDependencies(store, p.embedComplexityText, p.embedComplexityTexts)
	} else if store != nil {
		semantic.SetConfiguredStore(store)
	}
	llm := complexity.NewLLMClassifier(p.logger)
	if p.chatExecutor() != nil {
		llm.SetChatFunc(p.classifyComplexityTextViaLLM)
	}
	return &modelRouterRuntime{
		id:             id,
		name:           &state.name,
		config:         &state.config,
		sessionEnabled: &state.sessionEnabled,
		semantic:       semantic,
		llm:            llm,
	}
}

// close stops a router's classifiers. The default router's are the plugin's
// and are closed by Cleanup.
func (rt *modelRouterRuntime) close(logger schemas.Logger) {
	if rt.id == configstore.DefaultModelRouterID || rt.semantic == nil {
		return
	}
	if err := rt.semantic.Close(); err != nil && logger != nil {
		logger.Warn("[Routing] failed to close model router %q semantic classifier: %v", rt.id, err)
	}
}

// ReloadModelRouter serves a saved router. The default router goes through
// the same path as ReloadComplexityAnalyzerConfig; any other router is built
// the first time it is seen and reconfigured after. A config that cannot be
// served leaves the router as it was.
func (p *RoutingPlugin) ReloadModelRouter(router *configstore.ModelRouter) error {
	if router == nil {
		return fmt.Errorf("model router is nil")
	}
	if router.ID == configstore.DefaultModelRouterID {
		if err := p.storeComplexityAnalyzerConfig(&router.ComplexityAnalyzerConfig); err != nil {
			return err
		}
		name := router.Name
		p.defaultRouterName.Store(&name)
		return nil
	}
	resolved, err := p.resolveRouterConfig(&router.ComplexityAnalyzerConfig)
	if err != nil {
		return err
	}

	p.routersMu.Lock()
	defer p.routersMu.Unlock()
	current := p.extraModelRouters()
	rt, exists := current[router.ID]
	if !exists {
		rt = p.newModelRouterRuntime(router.ID)
	}
	applyRouterConfig(rt, resolved)
	name := router.Name
	rt.name.Store(&name)
	if !exists {
		next := make(map[string]*modelRouterRuntime, len(current)+1)
		for id, existing := range current {
			next[id] = existing
		}
		next[router.ID] = rt
		p.routers.Store(&next)
	}
	return nil
}

// RemoveModelRouter stops serving a router and closes its classifiers. The
// default router cannot be removed; removing one not served is a no-op.
func (p *RoutingPlugin) RemoveModelRouter(id string) error {
	if id == configstore.DefaultModelRouterID {
		return configstore.ErrDefaultModelRouter
	}
	p.routersMu.Lock()
	current := p.extraModelRouters()
	rt, exists := current[id]
	if exists {
		next := make(map[string]*modelRouterRuntime, len(current))
		for routerID, existing := range current {
			if routerID != id {
				next[routerID] = existing
			}
		}
		p.routers.Store(&next)
	}
	p.routersMu.Unlock()
	if exists {
		rt.close(p.logger)
	}
	return nil
}

// loadModelRouters serves the default router's name and every other router
// stored, at startup. A router that cannot be served is logged and skipped,
// so one bad router cannot keep the gateway from starting.
func (p *RoutingPlugin) loadModelRouters(ctx context.Context, configStore configstore.ConfigStore) {
	if configStore == nil {
		return
	}
	routers, err := configStore.GetModelRouters(ctx)
	if err != nil {
		if p.logger != nil {
			p.logger.Warn("[Routing] failed to load model routers: %v", err)
		}
		return
	}
	for i := range routers {
		router := &routers[i]
		if router.ID == configstore.DefaultModelRouterID {
			name := router.Name
			p.defaultRouterName.Store(&name)
			continue
		}
		if err := p.ReloadModelRouter(router); err != nil && p.logger != nil {
			p.logger.Warn("[Routing] failed to serve model router %q: %v", router.ID, err)
		}
	}
}

// closeModelRouters closes every router other than the default.
func (p *RoutingPlugin) closeModelRouters() {
	p.routersMu.Lock()
	current := p.extraModelRouters()
	empty := map[string]*modelRouterRuntime{}
	p.routers.Store(&empty)
	p.routersMu.Unlock()
	for _, rt := range current {
		rt.close(p.logger)
	}
}

// forEachExtraModelRouter applies a collaborator change to every router
// other than the default, whose classifiers the caller has already updated.
func (p *RoutingPlugin) forEachExtraModelRouter(fn func(rt *modelRouterRuntime)) {
	for _, rt := range p.extraModelRouters() {
		fn(rt)
	}
}

// ModelRouterSemanticStatus reports one router's semantic classifier
// readiness, and false for a router the plugin does not serve.
func (p *RoutingPlugin) ModelRouterSemanticStatus(id string) (complexity.SemanticStatusInfo, bool) {
	rt, ok := p.modelRouter(id)
	if !ok {
		return complexity.SemanticStatusInfo{}, false
	}
	if rt.semantic == nil {
		return complexity.SemanticStatusInfo{State: complexity.SemanticStatusDisabled}, true
	}
	return rt.semantic.Status(), true
}

// ModelRouterLLMStatus reports one router's llm classifier readiness, and
// false for a router the plugin does not serve.
func (p *RoutingPlugin) ModelRouterLLMStatus(id string) (complexity.LLMStatusInfo, bool) {
	rt, ok := p.modelRouter(id)
	if !ok {
		return complexity.LLMStatusInfo{}, false
	}
	if rt.llm == nil {
		return complexity.LLMStatusInfo{State: complexity.LLMStatusDisabled}, true
	}
	return rt.llm.Status(), true
}

// RetryModelRouterWarmup restarts one router's failed semantic warmup. It
// reports the status, whether a retry started, and false for a router the
// plugin does not serve.
func (p *RoutingPlugin) RetryModelRouterWarmup(id string) (status complexity.SemanticStatusInfo, started bool, ok bool) {
	rt, ok := p.modelRouter(id)
	if !ok {
		return complexity.SemanticStatusInfo{}, false, false
	}
	if rt.semantic == nil {
		return complexity.SemanticStatusInfo{State: complexity.SemanticStatusDisabled}, false, true
	}
	status, started = rt.semantic.RetryWarmup()
	return status, started, true
}
