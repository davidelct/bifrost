package rules

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/google/cel-go/cel"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	configstoreTables "github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/maximhq/bifrost/framework/routing"
)

// ModelRuleStore caches the model routing rules the way LocalStore caches
// routing rules: grouped by scope, priority ascending, in a sync.Map read
// without a lock, where a write swaps in a new slice rather than changing one
// requests may be reading. A rule's compiled condition is kept beside it, so
// the two always change together. It is a separate cache because model
// routing rules are their own table, matched in their own step.
type ModelRuleStore struct {
	rules   sync.Map   // scopeKey(scope, scopeID) -> []modelRuleEntry, priority ASC
	writeMu sync.Mutex // serializes writes, so two saves cannot drop each other's rule

	celEnv *cel.Env
	logger schemas.Logger
}

// modelRuleEntry is a cached rule and its compiled condition, nil when it has
// none.
type modelRuleEntry struct {
	rule    *configstoreTables.TableModelRoutingRule
	program cel.Program
}

// NewModelRuleStore builds the cache, loading every rule from configStore when
// there is one. A rule whose condition no longer compiles is logged and left
// out, so one bad row cannot keep the gateway from starting.
func NewModelRuleStore(ctx context.Context, logger schemas.Logger, configStore configstore.ConfigStore) (*ModelRuleStore, error) {
	env, err := createCELEnvironment()
	if err != nil {
		return nil, fmt.Errorf("failed to create CEL environment: %w", err)
	}
	store := &ModelRuleStore{celEnv: env, logger: logger}
	if configStore == nil {
		return store, nil
	}
	stored, err := configStore.GetModelRoutingRules(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to load model routing rules: %w", err)
	}
	for i := range stored {
		if err := store.Upsert(&stored[i]); err != nil && logger != nil {
			logger.Warn("skipping model routing rule %q: %v", stored[i].Name, err)
		}
	}
	return store, nil
}

// ValidateModelRuleCEL checks a model routing rule's condition: it must
// compile like a routing rule's, and it must not use complexity_tier, which
// the rule's router decides only after the rule has matched. Empty is valid
// and matches every request in the rule's scope.
func ValidateModelRuleCEL(expr string) error {
	if strings.TrimSpace(expr) == "" {
		return nil
	}
	if err := ValidateCELExpression(expr); err != nil {
		return err
	}
	if celExpressionReferencesIdentifier(expr, "complexity_tier") {
		return fmt.Errorf("a model routing rule's condition cannot use complexity_tier: the rule's router decides the tier after the rule matches")
	}
	return nil
}

// compile builds a rule's condition program, or nil for no condition.
func (s *ModelRuleStore) compile(rule *configstoreTables.TableModelRoutingRule) (cel.Program, error) {
	if strings.TrimSpace(rule.CelExpression) == "" {
		return nil, nil
	}
	if err := ValidateModelRuleCEL(rule.CelExpression); err != nil {
		return nil, err
	}
	ast, issues := s.celEnv.Compile(routing.NormalizeMapKeysInCEL(rule.CelExpression))
	if issues != nil && issues.Err() != nil {
		return nil, fmt.Errorf("CEL compile error: %s", issues.Err().Error())
	}
	program, err := s.celEnv.Program(ast)
	if err != nil {
		return nil, fmt.Errorf("CEL program creation error: %w", err)
	}
	return program, nil
}

// Upsert adds or replaces a rule, moving it between scopes if its scope
// changed. A condition that does not compile is an error and leaves the cache
// as it was.
func (s *ModelRuleStore) Upsert(rule *configstoreTables.TableModelRoutingRule) error {
	if rule == nil {
		return fmt.Errorf("model routing rule cannot be nil")
	}
	program, err := s.compile(rule)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	key := scopeKey(rule.Scope, valueOrEmpty(rule.ScopeID))
	updated := append(s.groupWithout(key, rule.ID), modelRuleEntry{rule: rule, program: program})
	sort.SliceStable(updated, func(i, j int) bool { return updated[i].rule.Priority < updated[j].rule.Priority })
	s.rules.Store(key, updated)
	s.removeFromScopes(rule.ID, key)
	return nil
}

// Delete removes a rule; removing one that is not cached is a no-op.
func (s *ModelRuleStore) Delete(id string) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.removeFromScopes(id, "")
}

// groupWithout returns a new copy of a scope's group without the rule id, so
// the slice requests may be reading is never written to.
func (s *ModelRuleStore) groupWithout(key, id string) []modelRuleEntry {
	value, _ := s.rules.Load(key)
	group, _ := value.([]modelRuleEntry)
	kept := make([]modelRuleEntry, 0, len(group)+1)
	for _, entry := range group {
		if entry.rule.ID != id {
			kept = append(kept, entry)
		}
	}
	return kept
}

// removeFromScopes drops a rule from every scope but keep, deleting a group
// once it is empty so HasRules stays accurate. writeMu must be held.
func (s *ModelRuleStore) removeFromScopes(id, keep string) {
	s.rules.Range(func(key, value any) bool {
		group, _ := value.([]modelRuleEntry)
		if key == keep || !slices.ContainsFunc(group, func(entry modelRuleEntry) bool { return entry.rule.ID == id }) {
			return true
		}
		if kept := s.groupWithout(key.(string), id); len(kept) > 0 {
			s.rules.Store(key, kept)
		} else {
			s.rules.Delete(key)
		}
		return true
	})
}

// HasRules reports whether any rule is cached: the per-request gate that lets
// a gateway with none skip the step, as LocalStore.HasRules does.
func (s *ModelRuleStore) HasRules() bool {
	if s == nil {
		return false
	}
	hasAny := false
	s.rules.Range(func(_, _ any) bool {
		hasAny = true
		return false
	})
	return hasAny
}

// Match returns the first enabled rule whose condition holds, walking the
// routing rules' scope order (virtual key, user, team, customer, global) and
// priority within a scope. Only the first match counts; there is no chaining.
// A condition that fails to evaluate is logged on the request and skipped.
func (s *ModelRuleStore) Match(ctx *schemas.BifrostContext, evaluation *EvaluationContext) (*configstoreTables.TableModelRoutingRule, error) {
	if s == nil || evaluation == nil {
		return nil, nil
	}
	variables, err := extractRoutingVariables(evaluation)
	if err != nil {
		return nil, fmt.Errorf("failed to extract routing variables: %w", err)
	}
	for _, level := range buildScopeChain(evaluation.Scope) {
		value, _ := s.rules.Load(scopeKey(level.ScopeName, level.ScopeID))
		group, _ := value.([]modelRuleEntry)
		for _, entry := range group {
			if !entry.rule.EnabledValue() {
				continue
			}
			if entry.program == nil {
				return entry.rule, nil
			}
			matched, err := evaluateCELExpression(entry.program, variables)
			if err != nil {
				if ctx != nil {
					ctx.AppendRoutingEngineLog(schemas.RoutingEngineModelRouter, schemas.LogLevelWarn,
						fmt.Sprintf("Model routing rule '%s' skipped: %v", entry.rule.Name, err))
				}
				continue
			}
			if matched {
				return entry.rule, nil
			}
		}
	}
	return nil, nil
}

// SelectModelRoutingTarget picks the target for tier, splitting by weight when
// the tier has several. ok is false when the rule has no target for the tier.
func SelectModelRoutingTarget(targets []configstoreTables.TableModelRoutingTarget, tier string) (configstoreTables.TableModelRoutingTarget, bool) {
	candidates := make([]configstoreTables.TableModelRoutingTarget, 0, len(targets))
	for _, t := range targets {
		if t.Tier == tier {
			candidates = append(candidates, t)
		}
	}
	return pickWeighted(candidates, func(t configstoreTables.TableModelRoutingTarget) float64 { return t.Weight })
}

// valueOrEmpty dereferences an optional scope ID.
func valueOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
