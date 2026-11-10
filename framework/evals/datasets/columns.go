// Package datasets holds the rules of an evals dataset: its column types, how a row
// becomes evaluator variables, CSV and JSONL conversion, and how request logs and
// sessions become rows. Storage lives in the config store; this package decides what
// is valid and what a row means.
package datasets

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/maximhq/bifrost/framework/evals"
)

// ColumnType says what a column's cells mean to an evaluator.
type ColumnType string

// Column types. A dataset has at most one column of each type, except ColumnVariable.
const (
	ColumnInput               ColumnType = "input"
	ColumnExpectedOutput      ColumnType = "expected_output"
	ColumnExpectedToolCalls   ColumnType = "expected_tool_calls"
	ColumnExpectedSteps       ColumnType = "expected_steps"
	ColumnConversationHistory ColumnType = "conversation_history"
	ColumnScenario            ColumnType = "scenario"
	ColumnOutput              ColumnType = "output"
	ColumnVariable            ColumnType = "variable"
	ColumnTags                ColumnType = "tags"
)

// MaxColumns is the most columns a dataset can have.
const MaxColumns = 100

// maxNameLength bounds dataset, column, split and version names.
const maxNameLength = 255

// SessionColumnName is the variable column that holds a whole session.
const SessionColumnName = evals.VariableSession

// typedVariables maps each typed column to the evaluator variable it fills. Variable
// columns fill a variable with their own name, and tags fill none.
var typedVariables = map[ColumnType]string{
	ColumnInput:               evals.VariableInput,
	ColumnExpectedOutput:      "expected_output",
	ColumnExpectedToolCalls:   "expected_tool_calls",
	ColumnExpectedSteps:       evals.VariableExpectedSteps,
	ColumnConversationHistory: evals.VariableHistory,
	ColumnScenario:            "scenario",
	ColumnOutput:              "output",
}

// reservedVariables are the names a variable column cannot take, because a typed
// column owns them. This keeps a row from having two sources for one variable.
var reservedVariables = func() map[string]ColumnType {
	out := make(map[string]ColumnType, len(typedVariables))
	for columnType, name := range typedVariables {
		out[name] = columnType
	}
	return out
}()

// Valid reports whether t is a known column type.
func (t ColumnType) Valid() bool {
	if t == ColumnVariable || t == ColumnTags {
		return true
	}
	_, ok := typedVariables[t]
	return ok
}

// Structured reports whether cells of this type hold JSON text.
func (t ColumnType) Structured() bool {
	return t == ColumnExpectedToolCalls || t == ColumnConversationHistory || t == ColumnTags
}

// Column is a dataset column as this package reads it.
type Column struct {
	ID   string     `json:"id"`
	Name string     `json:"name"`
	Type ColumnType `json:"type"`
}

func invalid(format string, args ...any) error {
	return &evals.InvalidError{Message: fmt.Sprintf(format, args...)}
}

// ValidateName checks a dataset, column, split or version name.
func ValidateName(kind, name string) error {
	if strings.TrimSpace(name) == "" {
		return invalid("%s name is required", kind)
	}
	if utf8.RuneCountInString(name) > maxNameLength {
		return invalid("%s name is longer than %d characters", kind, maxNameLength)
	}
	return nil
}

// ValidateColumns checks a dataset's whole column set: known types, unique names, one
// column per type except variable, and no variable column named like a typed variable.
func ValidateColumns(columns []Column) error {
	if len(columns) > MaxColumns {
		return invalid("a dataset can have at most %d columns", MaxColumns)
	}
	names := make(map[string]struct{}, len(columns))
	types := make(map[ColumnType]string, len(columns))
	for _, column := range columns {
		if err := ValidateName("column", column.Name); err != nil {
			return err
		}
		if !column.Type.Valid() {
			return invalid("column %q has unknown type %q", column.Name, column.Type)
		}
		if _, dup := names[column.Name]; dup {
			return invalid("two columns are named %q", column.Name)
		}
		names[column.Name] = struct{}{}
		if column.Type == ColumnVariable {
			if owner, reserved := reservedVariables[column.Name]; reserved {
				return invalid("a variable column cannot be named %q: that variable comes from the %s column", column.Name, owner)
			}
			continue
		}
		if other, dup := types[column.Type]; dup {
			return invalid("columns %q and %q are both of type %s; a dataset has one", other, column.Name, column.Type)
		}
		types[column.Type] = column.Name
	}
	return nil
}

// ValidateCell checks one cell value against its column type. Structured columns must
// hold valid JSON; an empty cell is always fine.
func ValidateCell(column Column, value string) error {
	if value == "" || !column.Type.Structured() {
		return nil
	}
	if !json.Valid([]byte(value)) {
		return invalid("column %q holds JSON, and this value is not valid JSON", column.Name)
	}
	return nil
}

// RowVariables turns a row into the variables an evaluator reads. It is the one place
// this rule lives: the evaluator test panel and test runs both call it.
//
// An empty cell produces no variable, so an evaluator that needs it answers "not
// applicable" instead of scoring an empty string.
func RowVariables(columns []Column, cells map[string]string) map[string]string {
	variables := make(map[string]string, len(columns))
	for _, column := range columns {
		value := cells[column.ID]
		if value == "" {
			continue
		}
		switch column.Type {
		case ColumnTags:
		case ColumnVariable:
			variables[column.Name] = value
		default:
			if name, ok := typedVariables[column.Type]; ok {
				variables[name] = value
			}
		}
	}
	return variables
}

// Templates are the starting column sets a new dataset can be created from.
var Templates = map[string][]Column{
	"qa": {
		{Name: "input", Type: ColumnInput},
		{Name: "expected_output", Type: ColumnExpectedOutput},
	},
	"retrieval": {
		{Name: "input", Type: ColumnInput},
		{Name: "context", Type: ColumnVariable},
		{Name: "expected_output", Type: ColumnExpectedOutput},
	},
	"agent": {
		{Name: "input", Type: ColumnInput},
		{Name: "expected_tool_calls", Type: ColumnExpectedToolCalls},
		{Name: "expected_steps", Type: ColumnExpectedSteps},
	},
}
