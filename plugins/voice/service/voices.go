package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Voice is one Piper model on disk: <id>.onnx with its <id>.onnx.json.
type Voice struct {
	ID         string `json:"id"`
	Language   string `json:"language"`
	Quality    string `json:"quality"`
	SampleRate int    `json:"sample_rate"`
	License    string `json:"license"`
	Model      string `json:"-"`
}

// licenses are those of the datasets the voices were trained on, from each voice's MODEL_CARD
// in rhasspy/piper-voices.
var licenses = map[string]string{
	"fr_FR-siwis-medium":    "CC-BY-4.0 (SIWIS French Speech Synthesis Database)",
	"en_US-ljspeech-medium": "public domain (LJ Speech)",
}

func scanVoices(dir string) ([]Voice, error) {
	models, err := filepath.Glob(filepath.Join(dir, "*.onnx"))
	if err != nil {
		return nil, err
	}
	var voices []Voice
	for _, m := range models {
		b, err := os.ReadFile(m + ".json")
		if err != nil {
			return nil, fmt.Errorf("voice %s has no config: %w", filepath.Base(m), err)
		}
		var cfg struct {
			Audio struct {
				SampleRate int    `json:"sample_rate"`
				Quality    string `json:"quality"`
			} `json:"audio"`
			Language struct {
				Code string `json:"code"`
			} `json:"language"`
		}
		if err := json.Unmarshal(b, &cfg); err != nil {
			return nil, fmt.Errorf("voice %s: %w", filepath.Base(m), err)
		}
		id := strings.TrimSuffix(filepath.Base(m), ".onnx")
		license := licenses[id]
		if license == "" {
			license = "see the voice's MODEL_CARD in rhasspy/piper-voices"
		}
		voices = append(voices, Voice{ID: id, Language: cfg.Language.Code, Quality: cfg.Audio.Quality,
			SampleRate: cfg.Audio.SampleRate, License: license, Model: m})
	}
	sort.Slice(voices, func(i, j int) bool { return voices[i].ID < voices[j].ID })
	return voices, nil
}

func findVoice(voices []Voice, id string) (Voice, bool) {
	for _, v := range voices {
		if v.ID == id {
			return v, true
		}
	}
	return Voice{}, false
}

func voiceIDs(voices []Voice) string {
	ids := make([]string, len(voices))
	for i, v := range voices {
		ids[i] = v.ID
	}
	return strings.Join(ids, ", ")
}
