package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(body))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func serve(t *testing.T, files map[string][]byte) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		b, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(ts.Close)
	return ts, &hits
}

func TestInstallChecksHashesAndSkipsWhatIsThere(t *testing.T) {
	engine := zipOf(t, map[string]string{"piper/piper.exe": "exe", "piper/espeak-ng-data/fr": "data"})
	voice := []byte("onnx")
	ts, hits := serve(t, map[string][]byte{"/engine.zip": engine, "/v.onnx": voice})
	pins := []pin{
		{Name: "engine", URL: ts.URL + "/engine.zip", SHA256: sum(engine), Dest: "engine", Unzip: true},
		{Name: "voice", URL: ts.URL + "/v.onnx", SHA256: sum(voice), Dest: "voices/v.onnx"},
	}
	home := t.TempDir()
	if err := install(home, pins, ts.Client(), func(string) {}); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"engine/piper/piper.exe", "engine/piper/espeak-ng-data/fr", "voices/v.onnx"} {
		if _, err := os.Stat(filepath.Join(home, f)); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
	var lines []string
	if err := install(home, pins, ts.Client(), func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 2 || len(lines) != 2 || !strings.Contains(lines[0], "already installed") {
		t.Fatalf("second run: %d downloads, %q", hits.Load(), lines)
	}
}

func TestInstallRefusesAWrongHash(t *testing.T) {
	ts, _ := serve(t, map[string][]byte{"/v.onnx": []byte("tampered")})
	home := t.TempDir()
	err := install(home, []pin{{Name: "voice", URL: ts.URL + "/v.onnx", SHA256: sum([]byte("onnx")), Dest: "voices/v.onnx"}},
		ts.Client(), func(string) {})
	if err == nil || !strings.Contains(err.Error(), "pinned") {
		t.Fatalf("got %v", err)
	}
	left, _ := filepath.Glob(filepath.Join(home, "voices", "*"))
	if len(left) != 0 {
		t.Fatalf("left behind: %q", left)
	}
}

func TestUnzipRefusesEntriesOutsideTheFolder(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "evil.zip")
	if err := os.WriteFile(archive, zipOf(t, map[string]string{"../escaped.txt": "x"}), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := unzip(archive, filepath.Join(dir, "engine")); err == nil || !strings.Contains(err.Error(), "outside") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "escaped.txt")); err == nil {
		t.Fatal("the entry escaped")
	}
}
