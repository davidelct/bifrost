package tables

import "time"

// TableModelRouter stores one model router: a named complexity classifier with
// its own phrases and settings, which routing rules select by ID.
//
// Every setting is its own column. Lists and maps are JSON text columns, as on
// config_client and config_mcp_clients. The optional blocks (semantic, decision,
// llm, session, suggestions) are nullable columns: a block is present exactly
// when its anchor column is non-NULL, so "semantic off" (no semantic block)
// stays distinct from a block that exists with zero values in it. The anchors
// are semantic_provider, decision_provider, llm_provider, session_enabled,
// suggestions_enabled, and suggestions_schedule_every for the schedule.
//
// No column carries a gorm default: gorm skips zero values on Create when a
// default is declared, and here zero is often a real setting (min_similarity 0
// means no floor). Defaults come from the config's normalization only.
//
// The conversion to and from the config type lives in the configstore package,
// which owns that type.
type TableModelRouter struct {
	ID          string `gorm:"primaryKey;type:varchar(64)" json:"id"`
	Name        string `gorm:"type:varchar(255);not null;uniqueIndex:idx_model_router_name" json:"name"`
	Description string `gorm:"type:text" json:"description"`
	// Classifier is "semantic" or "decision". Empty only on the placeholder row
	// a first save inserts to have something to lock; it never commits.
	Classifier string `gorm:"type:varchar(20);not null" json:"classifier"`

	// The deprecated lexical tier boundaries. Nothing routes on them, but the
	// config API and config.json still accept and return them, so they are
	// kept until the lexical analyzer is removed. Zero reads as the default.
	SimpleMediumBoundary  float64 `json:"-"`
	MediumComplexBoundary float64 `json:"-"`

	SimplePhrasesJSON  string `gorm:"column:simple_phrases_json;type:text" json:"-"`  // JSON []string
	MediumPhrasesJSON  string `gorm:"column:medium_phrases_json;type:text" json:"-"`  // JSON []string
	ComplexPhrasesJSON string `gorm:"column:complex_phrases_json;type:text" json:"-"` // JSON []string

	SemanticProvider            *string  `gorm:"type:varchar(255)" json:"-"` // anchor: NULL means no semantic block
	SemanticEmbeddingModel      *string  `gorm:"type:varchar(255)" json:"-"`
	SemanticTimeoutNS           *int64   `gorm:"column:semantic_timeout_ns" json:"-"`
	SemanticMinSimilarity       *float64 `json:"-"`
	SemanticMessageHistoryCount *int     `json:"-"`
	SemanticCountTowardBudgets  *bool    `json:"-"`
	SemanticVectorStore         *string  `gorm:"type:varchar(50)" json:"-"`
	SemanticFallback            *string  `gorm:"type:varchar(20)" json:"-"`

	DecisionProvider             *string  `gorm:"type:varchar(255)" json:"-"` // anchor: NULL means no decision block
	DecisionModel                *string  `gorm:"type:varchar(255)" json:"-"`
	DecisionPreviousMessageCount *int     `json:"-"` // NULL and 0 differ: NULL takes the default history
	DecisionTimeoutNS            *int64   `gorm:"column:decision_timeout_ns" json:"-"`
	DecisionMinConfidence        *float64 `json:"-"`
	DecisionCriteriaJSON         *string  `gorm:"column:decision_criteria_json;type:text" json:"-"` // JSON map[tier]criteria

	LLMProvider            *string `gorm:"column:llm_provider;type:varchar(255)" json:"-"` // anchor: NULL means no llm block
	LLMModel               *string `gorm:"column:llm_model;type:varchar(255)" json:"-"`
	LLMTimeoutNS           *int64  `gorm:"column:llm_timeout_ns" json:"-"`
	LLMPrompt              *string `gorm:"column:llm_prompt;type:text" json:"-"`
	LLMMessageHistoryCount *int    `gorm:"column:llm_message_history_count" json:"-"`
	LLMCountTowardBudgets  *bool   `gorm:"column:llm_count_toward_budgets" json:"-"`

	SessionEnabled *bool `json:"-"` // anchor: NULL means no session block

	SuggestionsEnabled              *bool      `json:"-"` // anchor: NULL means no suggestions block
	SuggestionsSampleRate           *float64   `json:"-"`
	SuggestionsLookbackDays         *int       `json:"-"`
	SuggestionsMaxClusteredRequests *int       `json:"-"`
	SuggestionsMinClusterRequests   *int       `json:"-"`
	SuggestionsProvider             *string    `gorm:"type:varchar(255)" json:"-"`
	SuggestionsModel                *string    `gorm:"type:varchar(255)" json:"-"`
	SuggestionsInstructions         *string    `gorm:"type:text" json:"-"`
	SuggestionsScheduleEvery        *string    `gorm:"type:varchar(16)" json:"-"` // anchor: NULL means no schedule
	SuggestionsScheduleStartAt      *time.Time `json:"-"`                         // NULL takes the default first run
	SuggestionsTierClassifier       *string    `gorm:"type:varchar(16)" json:"-"` // anchor: NULL means no tier block
	SuggestionsTierProvider         *string    `gorm:"type:varchar(255)" json:"-"`
	SuggestionsTierModel            *string    `gorm:"type:varchar(255)" json:"-"`
	SuggestionsTierInstructions     *string    `gorm:"type:text" json:"-"`
	SuggestionsTierPrompt           *string    `gorm:"type:text" json:"-"`
	SuggestionsTierCriteriaJSON     *string    `gorm:"column:suggestions_tier_criteria_json;type:text" json:"-"` // JSON map[tier]criteria

	// ConfigHashesJSON holds the per-section hashes of the config.json entry
	// last applied, so a reboot re-applies only the sections the file changed.
	ConfigHashesJSON string `gorm:"column:config_hashes_json;type:text" json:"-"`
	// ConfigHash covers the config.json entry's name and description, which the
	// section hashes do not.
	ConfigHash string `gorm:"type:varchar(255)" json:"-"`
	// EmbeddingFingerprint names the exemplar generation last embedded for this
	// router. Bookkeeping only: the classifier verifies the vector store itself.
	EmbeddingFingerprint string `gorm:"type:varchar(255)" json:"-"`

	CreatedAt time.Time `gorm:"index;not null" json:"created_at"`
	UpdatedAt time.Time `gorm:"index;not null" json:"updated_at"`
}

// TableName pins the physical table name.
func (TableModelRouter) TableName() string { return "model_routers" }
