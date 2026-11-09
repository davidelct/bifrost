package evals

import (
	"errors"
	"fmt"
	"strings"

	"github.com/maximhq/bifrost/framework/encrypt"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

const (
	// RedactedSecret stands in for a stored secret in API responses. Sent back unchanged
	// on an update, it means "keep the stored value".
	RedactedSecret = "<REDACTED>"
	// sealedPrefix marks a header value that is encrypted at rest.
	sealedPrefix = "enc:v1:"
)

// isSealed reports whether a stored header value is encrypted.
func isSealed(value string) bool { return strings.HasPrefix(value, sealedPrefix) }

// isSecretReference reports whether a header value names a secret held elsewhere
// rather than holding one.
func isSecretReference(value string) bool {
	return strings.HasPrefix(value, "env.") || strings.HasPrefix(value, "vault.")
}

// NormalizeConfig validates a config and returns the form that is stored: defaults
// filled in, keys sorted, and for an API evaluator every plain header value encrypted.
// A reference to an environment variable or a vault entry is stored as the reference.
func NormalizeConfig(evaluatorType EvaluatorType, raw []byte) ([]byte, error) {
	cfg, err := ParseConfig(evaluatorType, raw)
	if err != nil {
		return nil, err
	}
	normalized, err := MarshalConfig(cfg)
	if err != nil {
		return nil, err
	}
	if evaluatorType != EvaluatorTypeAPI {
		return normalized, nil
	}
	// The typed config holds resolved secrets, so the headers are rebuilt from the
	// request instead of being taken from it.
	headers := gjson.GetBytes(raw, "headers")
	if !headers.IsArray() {
		return sjson.DeleteBytes(normalized, "headers")
	}
	out := normalized
	if out, err = sjson.SetRawBytes(out, "headers", []byte("[]")); err != nil {
		return nil, err
	}
	for _, header := range headers.Array() {
		key := header.Get("key").String()
		stored, err := sealHeaderValue(header.Get("value"))
		if err != nil {
			return nil, fmt.Errorf("header %q: %w", key, err)
		}
		entry, err := sjson.Set(`{}`, "key", key)
		if err != nil {
			return nil, err
		}
		if entry, err = sjson.Set(entry, "value", stored); err != nil {
			return nil, err
		}
		if out, err = sjson.SetRawBytes(out, "headers.-1", []byte(entry)); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// sealHeaderValue returns the stored form of one header value.
func sealHeaderValue(value gjson.Result) (string, error) {
	text := value.String()
	if value.IsObject() {
		// The SecretVar object form: keep a reference, never its resolved value.
		if ref := value.Get("ref").String(); ref != "" {
			return ref, nil
		}
		text = value.Get("value").String()
	}
	switch {
	case text == RedactedSecret:
		return "", errors.New("the redacted placeholder has no stored value to stand for")
	case text == "" || isSecretReference(text) || isSealed(text) || !encrypt.IsEnabled():
		return text, nil
	}
	sealed, err := encrypt.Encrypt(text)
	if err != nil {
		return "", err
	}
	return sealedPrefix + sealed, nil
}

// unsealHeaderValue returns the value to send for a stored header value.
func unsealHeaderValue(stored string) (string, error) {
	if !isSealed(stored) {
		return stored, nil
	}
	return encrypt.Decrypt(strings.TrimPrefix(stored, sealedPrefix))
}

// RedactConfig returns a config that is safe to show: each API header value is replaced
// by a placeholder unless it is a reference.
func RedactConfig(evaluatorType EvaluatorType, raw []byte) []byte {
	if evaluatorType != EvaluatorTypeAPI {
		return raw
	}
	out := raw
	for i, header := range gjson.GetBytes(raw, "headers").Array() {
		value := header.Get("value").String()
		if value == "" || isSecretReference(value) {
			continue
		}
		redacted, err := sjson.SetBytes(out, fmt.Sprintf("headers.%d.value", i), RedactedSecret)
		if err != nil {
			continue
		}
		out = redacted
	}
	return out
}

// RestoreRedactedSecrets puts stored header values back where an incoming config
// carries the redacted placeholder, matching headers by name. This is what lets a
// client read a config, change something else and save it without retyping secrets.
func RestoreRedactedSecrets(evaluatorType EvaluatorType, incoming, stored []byte) ([]byte, error) {
	if evaluatorType != EvaluatorTypeAPI {
		return incoming, nil
	}
	storedByKey := make(map[string]string)
	for _, header := range gjson.GetBytes(stored, "headers").Array() {
		key := strings.ToLower(header.Get("key").String())
		if _, seen := storedByKey[key]; !seen {
			storedByKey[key] = header.Get("value").String()
		}
	}
	out := incoming
	for i, header := range gjson.GetBytes(incoming, "headers").Array() {
		if header.Get("value").String() != RedactedSecret {
			continue
		}
		key := header.Get("key").String()
		value, ok := storedByKey[strings.ToLower(key)]
		if !ok {
			return nil, fmt.Errorf("header %q has no stored value to keep; enter its value", key)
		}
		restored, err := sjson.SetBytes(out, fmt.Sprintf("headers.%d.value", i), value)
		if err != nil {
			return nil, err
		}
		out = restored
	}
	return out, nil
}
