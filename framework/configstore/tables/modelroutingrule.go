package tables

import (
	"strings"
	"time"

	"github.com/bytedance/sonic"
	bifrost "github.com/maximhq/bifrost/core"
	"gorm.io/gorm"
)

// Complexity tiers a model routing target applies to. They are the values a
// model router classifies a request into.
const (
	ModelRoutingTierSimple  = "SIMPLE"
	ModelRoutingTierMedium  = "MEDIUM"
	ModelRoutingTierComplex = "COMPLEX"
)

// IsModelRoutingTier reports whether tier is one a model router produces.
func IsModelRoutingTier(tier string) bool {
	switch tier {
	case ModelRoutingTierSimple, ModelRoutingTierMedium, ModelRoutingTierComplex:
		return true
	}
	return false
}

// TableModelRoutingRule decides when a model router classifies a request and
// which model each tier then gets. It runs after the routing rules, in its own
// step, and mirrors TableRoutingRule: a scope, an optional CEL condition and a
// priority unique within the scope. Its priorities are a separate space from
// routing rules', so the two never collide.
type TableModelRoutingRule struct {
	ID          string `gorm:"primaryKey;type:varchar(255)" json:"id"`
	ConfigHash  string `gorm:"type:varchar(255)" json:"config_hash"` // Hash of the config.json entry last applied, used for change detection
	Name        string `gorm:"type:varchar(255);not null;uniqueIndex:idx_model_routing_rule_scope_name" json:"name"`
	Description string `gorm:"type:text" json:"description"`
	Enabled     *bool  `gorm:"not null;default:true" json:"enabled,omitempty"` // nil = DB default (true); use EnabledValue() to read
	// CelExpression narrows which requests in the scope the rule takes; empty
	// takes all of them. It cannot use complexity_tier: the tier is what the
	// rule's router decides once the rule has matched.
	CelExpression string `gorm:"type:text" json:"cel_expression"`
	// Query is the dashboard's visual condition builder state, kept so an edit
	// reopens in the builder, as for routing rules. It is never evaluated;
	// CelExpression is.
	Query       *string        `gorm:"type:text" json:"-"`
	ParsedQuery map[string]any `gorm:"-" json:"query,omitempty"`
	// ModelRouterID names the router that classifies the request. Indexed so a
	// router still in use can be refused deletion.
	ModelRouterID string `gorm:"type:varchar(64);not null;index" json:"model_router_id"`

	// Targets say which model each tier gets. A tier with no target keeps the
	// request's model; one with several splits by weight.
	Targets []TableModelRoutingTarget `gorm:"foreignKey:RuleID;constraint:OnDelete:CASCADE" json:"targets"`

	Scope    string  `gorm:"type:varchar(50);not null;uniqueIndex:idx_model_routing_rule_scope_name" json:"scope"` // "global" | "team" | "customer" | "virtual_key" | "user"
	ScopeID  *string `gorm:"type:varchar(255);uniqueIndex:idx_model_routing_rule_scope_name" json:"scope_id"`      // nil for global, otherwise entity ID
	Priority int     `gorm:"type:int;not null;default:0;index" json:"priority"`                                    // Lower = evaluated first within scope

	CreatedAt time.Time `gorm:"index;not null" json:"created_at"`
	UpdatedAt time.Time `gorm:"index;not null" json:"updated_at"`
}

// TableName pins the physical table name.
func (TableModelRoutingRule) TableName() string { return "model_routing_rules" }

// BeforeSave serializes the condition builder state.
func (r *TableModelRoutingRule) BeforeSave(tx *gorm.DB) error {
	if r.ParsedQuery == nil {
		r.Query = nil
		return nil
	}
	data, err := sonic.Marshal(r.ParsedQuery)
	if err != nil {
		return err
	}
	r.Query = bifrost.Ptr(string(data))
	return nil
}

// AfterFind restores the condition builder state.
func (r *TableModelRoutingRule) AfterFind(tx *gorm.DB) error {
	if r.Query == nil || strings.TrimSpace(*r.Query) == "" {
		return nil
	}
	return sonic.Unmarshal([]byte(*r.Query), &r.ParsedQuery)
}

// EnabledValue returns the effective Enabled bool, treating nil as true (DB default).
func (r *TableModelRoutingRule) EnabledValue() bool {
	if r == nil {
		return false
	}
	if r.Enabled == nil {
		return true
	}
	return *r.Enabled
}

// TableModelRoutingTarget is one model for one tier of a model routing rule.
// Weights split a tier between its targets and sum to 1 within the tier.
type TableModelRoutingTarget struct {
	RuleID        string  `gorm:"type:varchar(255);not null;index;uniqueIndex:idx_model_routing_target_config" json:"-"`
	Tier          string  `gorm:"type:varchar(20);not null;uniqueIndex:idx_model_routing_target_config" json:"tier"`
	Provider      *string `gorm:"type:varchar(255);uniqueIndex:idx_model_routing_target_config" json:"provider,omitempty"` // nil = keep the request's provider
	Model         *string `gorm:"type:varchar(255);uniqueIndex:idx_model_routing_target_config" json:"model,omitempty"`    // nil = keep the request's model
	KeyID         *string `gorm:"type:varchar(255);uniqueIndex:idx_model_routing_target_config" json:"key_id,omitempty"`   // persisted key pin
	Weight        float64 `gorm:"not null;default:1" json:"weight"`
	TTFTTimeoutMs *int    `gorm:"column:ttft_timeout_ms" json:"ttft_timeout_ms,omitempty"` // streaming first-token deadline; nil = off

	// Fallbacks replace the request's fallback chain when the target is chosen;
	// with none, the chain the routing rules set is kept.
	Fallbacks       *string           `gorm:"type:text" json:"-"`
	ParsedFallbacks []RoutingFallback `gorm:"-" json:"fallbacks,omitempty"`
}

// TableName pins the physical table name.
func (TableModelRoutingTarget) TableName() string { return "model_routing_targets" }

// BeforeSave serializes the fallback chain into its JSON column.
func (t *TableModelRoutingTarget) BeforeSave(tx *gorm.DB) error {
	if len(t.ParsedFallbacks) == 0 {
		t.Fallbacks = nil
		return nil
	}
	data, err := sonic.Marshal(t.ParsedFallbacks)
	if err != nil {
		return err
	}
	t.Fallbacks = bifrost.Ptr(string(data))
	return nil
}

// AfterFind parses the fallback chain from its JSON column.
func (t *TableModelRoutingTarget) AfterFind(tx *gorm.DB) error {
	if t.Fallbacks == nil || strings.TrimSpace(*t.Fallbacks) == "" {
		return nil
	}
	return sonic.Unmarshal([]byte(*t.Fallbacks), &t.ParsedFallbacks)
}
