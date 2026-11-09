package evals

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/encrypt"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

// withEncryption turns encryption on for one test and off again after it.
func withEncryption(t *testing.T) {
	t.Helper()
	logger := bifrost.NewDefaultLogger(schemas.LogLevelError)
	encrypt.Init("evals-test-encryption-passphrase", logger)
	t.Cleanup(func() { encrypt.Init("", logger) })
}

const apiConfigWithSecrets = `{
	"method": "post",
	"url": "https://scorer.example.com/score",
	"headers": [
		{"key": "Authorization", "value": "Bearer super-secret-token"},
		{"key": "X-Team", "value": "env.SCORER_TEAM"},
		{"key": "X-Vault", "value": {"ref": "vault.kv/scorer", "type": "vault", "value": "resolved-vault-value"}}
	],
	"output_mapping": {"score": "score"}
}`

func headerValue(t *testing.T, config []byte, index int) string {
	t.Helper()
	return gjson.GetBytes(config, "headers."+string(rune('0'+index))+".value").String()
}

func TestNormalizeConfig_SealsPlainHeaderValues(t *testing.T) {
	withEncryption(t)

	stored, err := NormalizeConfig(EvaluatorTypeAPI, []byte(apiConfigWithSecrets))
	require.NoError(t, err)

	assert.NotContains(t, string(stored), "super-secret-token", "the secret never reaches the database in the clear")
	assert.NotContains(t, string(stored), "resolved-vault-value", "a resolved reference is never written; only the reference is")
	assert.True(t, isSealed(headerValue(t, stored, 0)))
	assert.Equal(t, "env.SCORER_TEAM", headerValue(t, stored, 1), "an environment reference is kept as a reference")
	assert.Equal(t, "vault.kv/scorer", headerValue(t, stored, 2))
	assert.Equal(t, "POST", gjson.GetBytes(stored, "method").String(), "the rest of the config is normalised as usual")
	assert.Equal(t, float64(1), gjson.GetBytes(stored, "concurrency").Float(), "and defaults are filled in")

	again, err := NormalizeConfig(EvaluatorTypeAPI, stored)
	require.NoError(t, err)
	assert.Equal(t, headerValue(t, stored, 0), headerValue(t, again, 0), "a sealed value is not sealed twice")
}

func TestNormalizeConfig_WithoutEncryptionStoresAsGiven(t *testing.T) {
	stored, err := NormalizeConfig(EvaluatorTypeAPI, []byte(apiConfigWithSecrets))
	require.NoError(t, err)
	assert.Equal(t, "Bearer super-secret-token", headerValue(t, stored, 0), "with no encryption key the gateway stores secrets as the rest of its config does")
}

func TestNormalizeConfig_ValidatesAndLeavesOtherTypesAlone(t *testing.T) {
	_, err := NormalizeConfig(EvaluatorTypeAPI, []byte(`{"method":"POST","output_mapping":{"score":"s"}}`))
	require.Error(t, err)

	ai, err := NormalizeConfig(EvaluatorTypeAI, []byte(`{"instructions":"x","grading_style":"yes_no","provider":"openai","model":"m"}`))
	require.NoError(t, err)
	assert.Equal(t, "Yes", gjson.GetBytes(ai, "pass_criteria.entry_level.value").String(), "defaults are stored so the config reads the same everywhere")
}

func TestRedactConfig_HidesSecretsButShowsReferences(t *testing.T) {
	withEncryption(t)
	stored, err := NormalizeConfig(EvaluatorTypeAPI, []byte(apiConfigWithSecrets))
	require.NoError(t, err)

	shown := RedactConfig(EvaluatorTypeAPI, stored)
	assert.Equal(t, RedactedSecret, headerValue(t, shown, 0))
	assert.Equal(t, "env.SCORER_TEAM", headerValue(t, shown, 1))
	assert.Equal(t, "vault.kv/scorer", headerValue(t, shown, 2))
	assert.Equal(t, "Authorization", gjson.GetBytes(shown, "headers.0.key").String())

	// Also when nothing is encrypted: a plain value is still a secret.
	plain := []byte(`{"method":"GET","url":"https://x.example.com","headers":[{"key":"K","value":"plain"}],"output_mapping":{"score":"s"}}`)
	assert.Equal(t, RedactedSecret, headerValue(t, RedactConfig(EvaluatorTypeAPI, plain), 0))

	ai := []byte(`{"instructions":"x"}`)
	assert.Equal(t, string(ai), string(RedactConfig(EvaluatorTypeAI, ai)), "other types have nothing to hide")
}

// The UI gets a redacted config and sends it back on save. The stored secret must
// survive that round trip.
func TestRestoreRedactedSecrets(t *testing.T) {
	withEncryption(t)
	stored, err := NormalizeConfig(EvaluatorTypeAPI, []byte(apiConfigWithSecrets))
	require.NoError(t, err)

	edited := []byte(`{
		"method": "POST", "url": "https://scorer.example.com/v2/score",
		"headers": [
			{"key": "X-New", "value": "brand-new-secret"},
			{"key": "Authorization", "value": "` + RedactedSecret + `"}
		],
		"output_mapping": {"score": "score"}
	}`)
	restored, err := RestoreRedactedSecrets(EvaluatorTypeAPI, edited, stored)
	require.NoError(t, err)
	assert.Equal(t, "brand-new-secret", headerValue(t, restored, 0), "a newly typed value is taken as typed")
	assert.Equal(t, headerValue(t, stored, 0), headerValue(t, restored, 1), "the placeholder is swapped for the stored value, matched by header name")
	assert.Equal(t, "https://scorer.example.com/v2/score", gjson.GetBytes(restored, "url").String())

	orphan := []byte(`{"method":"POST","url":"https://x.example.com","headers":[{"key":"X-Unknown","value":"` + RedactedSecret + `"}],"output_mapping":{"score":"s"}}`)
	_, err = RestoreRedactedSecrets(EvaluatorTypeAPI, orphan, stored)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "X-Unknown")

	_, err = NormalizeConfig(EvaluatorTypeAPI, orphan)
	require.Error(t, err, "a placeholder can never be stored as if it were the secret")
}

// The sealed value is what is stored; the real value is what is sent.
func TestAPIEvaluator_SendsTheUnsealedHeader(t *testing.T) {
	withEncryption(t)
	server, captured, _ := scorerServer(t, http.StatusOK, `{"score": 1}`, 0)

	var config map[string]any
	require.NoError(t, json.Unmarshal([]byte(apiConfigWithSecrets), &config))
	config["url"] = server.URL
	config["headers"] = []map[string]any{{"key": "Authorization", "value": "Bearer super-secret-token"}}
	raw, err := json.Marshal(config)
	require.NoError(t, err)
	stored, err := NormalizeConfig(EvaluatorTypeAPI, raw)
	require.NoError(t, err)
	require.NotContains(t, string(stored), "super-secret-token")

	engine := newAPIEngine(APIOptions{Client: server.Client()})
	result := engine.Run(context.Background(), Definition{ID: "api-sealed", Type: EvaluatorTypeAPI, Version: 1, Config: stored}, Input{})
	require.Equal(t, ScoreStatusOK, result.Score.Status, result.Reasoning)
	require.Len(t, *captured, 1)
	assert.Equal(t, "Bearer super-secret-token", (*captured)[0].header.Get("Authorization"))
}

func TestAPIEvaluator_UnreadableSealedHeaderIsAnError(t *testing.T) {
	withEncryption(t)
	server, captured, _ := scorerServer(t, http.StatusOK, `{"score": 1}`, 0)
	config := `{"method":"GET","url":"` + server.URL + `","headers":[{"key":"Authorization","value":"` + sealedPrefix + `not-a-real-ciphertext"}],"output_mapping":{"score":"score"}}`

	result := newAPIEngine(APIOptions{Client: server.Client()}).Run(context.Background(),
		Definition{Type: EvaluatorTypeAPI, Config: []byte(config)}, Input{})
	assert.Equal(t, ScoreStatusError, result.Score.Status)
	assert.Contains(t, result.Reasoning, "Authorization")
	assert.Empty(t, *captured, "the call is not made with a garbage credential")
}
