package logstore

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestModelRoutingColumnsFilter pins that a log records the model router and
// model routing rule that routed it, and that both filter the log list from
// the raw table rather than the hourly view, which does not carry them.
func TestModelRoutingColumnsFilter(t *testing.T) {
	store, _ := newFanoutTestStore(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	row := func(id, router, routerName, rule, ruleName string) {
		opt := func(v string) *string {
			if v == "" {
				return nil
			}
			return &v
		}
		cost := 1.0
		require.NoError(t, store.Create(ctx, &Log{
			ID: id, Timestamp: base, CreatedAt: base, Object: "chat_completion", Provider: "openai", Model: "m",
			Status: "success", Cost: &cost, TotalTokens: 10,
			ModelRouterID: opt(router), ModelRouterName: opt(routerName),
			ModelRoutingRuleID: opt(rule), ModelRoutingRuleName: opt(ruleName),
		}))
	}
	row("a", "support", "Support", "rule-desk", "Support desk")
	row("b", "support", "Support", "rule-desk", "Support desk")
	// A routing rule's complexity_tier is classified by the default router
	// with no model routing rule involved.
	row("c", "default", "Default", "", "")
	row("d", "", "", "", "")

	start, end := base.Add(-time.Hour), base.Add(time.Hour)
	filters := SearchFilters{StartTime: &start, EndTime: &end}
	search := func(f SearchFilters) []string {
		res, err := store.SearchLogs(ctx, f, PaginationOptions{Limit: 10})
		require.NoError(t, err)
		ids := make([]string, 0, len(res.Logs))
		for _, l := range res.Logs {
			ids = append(ids, l.ID)
		}
		return ids
	}

	byRouter := filters
	byRouter.ModelRouterIDs = []string{"support"}
	assert.ElementsMatch(t, []string{"a", "b"}, search(byRouter))
	byRule := filters
	byRule.ModelRoutingRuleIDs = []string{"rule-desk"}
	assert.ElementsMatch(t, []string{"a", "b"}, search(byRule))

	res, err := store.SearchLogs(ctx, byRouter, PaginationOptions{Limit: 1})
	require.NoError(t, err)
	require.Len(t, res.Logs, 1)
	got := res.Logs[0]
	require.NotNil(t, got.ModelRouterName)
	assert.Equal(t, "Support", *got.ModelRouterName)
	require.NotNil(t, got.ModelRoutingRuleName)
	assert.Equal(t, "Support desk", *got.ModelRoutingRuleName)

	assert.False(t, canUseMatViewFilters(byRouter), "a router filter must not be served from the hourly view")
	assert.False(t, canUseMatViewFilters(byRule), "a rule filter must not be served from the hourly view")
}
