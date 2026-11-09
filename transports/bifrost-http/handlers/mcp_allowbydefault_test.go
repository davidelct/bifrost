package handlers

import (
	"encoding/json"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMCPClientRequestReadsAllowByDefaultUnderBothKeys pins the create request's compatibility rule:
// allow_by_default decides when present, allow_on_all_virtual_keys is read in its absence, and the
// alias decode leaves the rest of the request intact.
func TestMCPClientRequestReadsAllowByDefaultUnderBothKeys(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"current key only", `{"name":"demo","allow_by_default":true}`, true},
		{"earlier key only", `{"name":"demo","allow_on_all_virtual_keys":true}`, true},
		{"both sent, current wins", `{"name":"demo","allow_by_default":false,"allow_on_all_virtual_keys":true}`, false},
		{"neither sent", `{"name":"demo"}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var req MCPClientRequest
			require.NoError(t, json.Unmarshal([]byte(tc.raw), &req))
			assert.Equal(t, tc.want, req.AllowByDefault)
			assert.Equal(t, "demo", req.Name, "fields outside the alias must still decode")
		})
	}

	t.Run("fields of the outer request still decode", func(t *testing.T) {
		var req MCPClientRequest
		require.NoError(t, json.Unmarshal([]byte(`{"name":"demo","client_id":"c1","allow_on_all_virtual_keys":true,"user_headers":{"x-team":"a"}}`), &req))
		assert.True(t, req.AllowByDefault)
		assert.Equal(t, "c1", req.ClientID)
		assert.Equal(t, map[string]string{"x-team": "a"}, req.UserHeaders)
	})
}

// TestMCPClientUpdateRequestResolvedAllowByDefault pins PATCH semantics for the flag under both wire
// names: untouched when neither is sent, the current name deciding when both are.
func TestMCPClientUpdateRequestResolvedAllowByDefault(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		existing bool
		want     bool
	}{
		{"neither sent keeps existing true", `{"name":"demo"}`, true, true},
		{"neither sent keeps existing false", `{"name":"demo"}`, false, false},
		{"current key only", `{"allow_by_default":false}`, true, false},
		{"earlier key only", `{"allow_on_all_virtual_keys":true}`, false, true},
		{"both sent, current wins", `{"allow_by_default":true,"allow_on_all_virtual_keys":false}`, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var req MCPClientUpdateRequest
			require.NoError(t, json.Unmarshal([]byte(tc.raw), &req))
			assert.Equal(t, tc.want, req.resolvedAllowByDefault(tc.existing))
		})
	}
}

// TestMCPClientRequestReadsSlugCodeMode pins the create request's slug_code_mode decode: the wire
// value lands on the embedded table as *bool, absent inherits, and an unknown value refuses the request.
func TestMCPClientRequestReadsSlugCodeMode(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want *bool
	}{
		{"absent inherits", `{"name":"demo"}`, nil},
		{"inherit", `{"name":"demo","slug_code_mode":"inherit"}`, nil},
		{"enabled", `{"name":"demo","slug_code_mode":"enabled"}`, schemas.Ptr(true)},
		{"disabled", `{"name":"demo","is_code_mode_client":true,"slug_code_mode":"disabled"}`, schemas.Ptr(false)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var req MCPClientRequest
			require.NoError(t, json.Unmarshal([]byte(tc.raw), &req))
			assert.Equal(t, tc.want, req.SlugCodeMode)
			assert.Equal(t, "demo", req.Name)
		})
	}

	var req MCPClientRequest
	assert.Error(t, json.Unmarshal([]byte(`{"name":"demo","slug_code_mode":"on"}`), &req))
}

// TestMCPClientUpdateRequestResolvedSlugCodeMode pins PATCH semantics: omitted keeps the stored value,
// "inherit" clears an override, and an unknown value is refused.
func TestMCPClientUpdateRequestResolvedSlugCodeMode(t *testing.T) {
	decode := func(raw string) MCPClientUpdateRequest {
		var req MCPClientUpdateRequest
		require.NoError(t, json.Unmarshal([]byte(raw), &req))
		return req
	}
	cases := []struct {
		name     string
		raw      string
		existing *bool
		want     *bool
	}{
		{"omitted keeps an override", `{}`, schemas.Ptr(false), schemas.Ptr(false)},
		{"omitted keeps inherit", `{}`, nil, nil},
		{"inherit clears an override", `{"slug_code_mode":"inherit"}`, schemas.Ptr(true), nil},
		{"enabled sets", `{"slug_code_mode":"enabled"}`, nil, schemas.Ptr(true)},
		{"disabled replaces", `{"slug_code_mode":"disabled"}`, schemas.Ptr(true), schemas.Ptr(false)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := decode(tc.raw)
			got, err := req.resolvedSlugCodeMode(tc.existing)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}

	req := decode(`{"slug_code_mode":"true"}`)
	_, err := req.resolvedSlugCodeMode(nil)
	assert.ErrorContains(t, err, "slug_code_mode")
}
