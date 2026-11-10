package soniox

import (
	"net/url"
	"strings"
	"time"
)

const (
	defaultBaseURL = "https://api.soniox.com"

	// Soniox serves its REST API from api.<region> and text-to-speech from tts-rt.<region>.
	apiHostPrefix = "api."
	ttsHostPrefix = "tts-rt."

	transcriptionPollInitial = 500 * time.Millisecond
	transcriptionPollMax     = 3 * time.Second
	transcriptionMaxWait     = 10 * time.Minute
	cleanupTimeout           = 10 * time.Second
)

// bifrostToSonioxSpeechFormat maps OpenAI response formats to Soniox audio_format values.
// Soniox requires audio_format, so an empty format resolves to the OpenAI default (mp3).
var bifrostToSonioxSpeechFormat = map[string]string{
	"":     "mp3",
	"mp3":  "mp3",
	"opus": "opus",
	"aac":  "aac",
	"flac": "flac",
	"wav":  "wav",
	"pcm":  "pcm_s16le",
}

// convertBifrostSpeechFormatToSoniox maps a Bifrost response format to a Soniox audio_format;
// native Soniox formats such as pcm_mulaw pass through unchanged.
func convertBifrostSpeechFormatToSoniox(format string) string {
	if sonioxFormat, ok := bifrostToSonioxSpeechFormat[format]; ok {
		return sonioxFormat
	}
	return format
}

// deriveTTSBaseURL returns the text-to-speech base URL for a REST base URL by swapping the
// leading api. host label for tts-rt., so a regional base URL (api.<region>.soniox.com) reaches
// the same region's TTS host. A host without that label, such as a proxy, is used as is.
func deriveTTSBaseURL(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(parsed.Host, apiHostPrefix) {
		parsed.Host = ttsHostPrefix + strings.TrimPrefix(parsed.Host, apiHostPrefix)
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}
