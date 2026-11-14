package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeRunKey map[string]string

func (k fakeRunKey) Get(name string) (string, bool, error) { v, ok := k[name]; return v, ok, nil }
func (k fakeRunKey) Set(name, value string) error          { k[name] = value; return nil }
func (k fakeRunKey) Delete(name string) error              { delete(k, name); return nil }

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestInstallRegistersTheWindowlessBuildAtLogon(t *testing.T) {
	bin, home := filepath.Join(t.TempDir(), "my bin"), t.TempDir()
	key := fakeRunKey{}
	var out strings.Builder
	err := installCmd(nil, key, bin, home, &out)
	if err == nil || !strings.Contains(err.Error(), "-H windowsgui") {
		t.Fatalf("without the windowless build: %v", err)
	}
	touch(t, filepath.Join(bin, guiExe))
	if err := installCmd(nil, key, bin, home, &out); err == nil || !strings.Contains(err.Error(), "setup") {
		t.Fatalf("without the engine: %v", err)
	}
	touch(t, filepath.Join(home, "engine", "piper", "piper.exe"))
	if err := installCmd([]string{"--print"}, key, bin, home, &out); err != nil || len(key) != 0 {
		t.Fatalf("--print changed the key: %v %v", err, key)
	}
	if err := installCmd(nil, key, bin, home, &out); err != nil {
		t.Fatal(err)
	}
	want := `"` + filepath.Join(bin, guiExe) + `" serve --log "` + filepath.Join(home, "logs", "service.log") + `"`
	if key[runValue] != want {
		t.Fatalf("registered %q, want %q", key[runValue], want)
	}
	if !strings.Contains(out.String(), "piper-voice uninstall") {
		t.Fatalf("output: %s", out.String())
	}
}

func TestUninstallRemovesOnlyItsValue(t *testing.T) {
	key := fakeRunKey{runValue: `"x" serve`, "OneDrive": "keep"}
	var out strings.Builder
	if err := uninstallCmd(key, &out); err != nil || len(key) != 1 || key["OneDrive"] != "keep" {
		t.Fatalf("%v %v", err, key)
	}
	out.Reset()
	if err := uninstallCmd(key, &out); err != nil || !strings.Contains(out.String(), "nothing to remove") {
		t.Fatalf("second uninstall: %v %q", err, out.String())
	}
}
