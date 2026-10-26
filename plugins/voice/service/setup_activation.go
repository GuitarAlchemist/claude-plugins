package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
)

type setupActivation struct {
	Manifest string `json:"manifest"`
}

// Pins are compiled with the reviewed source/release. This digest binds the
// complete pin set; it is an identity, not a signature or publisher attestation.
func setupManifestID(pins []pin) string {
	b, _ := json.Marshal(struct {
		Product, Service, Platform string
		Pins                       []pin
	}{productVersion, version, "windows-x64", pins})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func readSetupActivation(home string) (setupActivation, error) {
	var a setupActivation
	p := filepath.Join(home, "active.json")
	if err := checkSetupPath(p); err != nil {
		return a, err
	}
	f, err := os.Open(p)
	if err != nil {
		return a, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return a, err
	}
	if len(b) > 4096 || json.Unmarshal(b, &a) != nil {
		return a, fmt.Errorf("invalid active setup pointer")
	}
	decoded, err := hex.DecodeString(a.Manifest)
	if err != nil || len(decoded) != 32 || len(a.Manifest) != 64 {
		return a, fmt.Errorf("invalid active manifest identity")
	}
	return a, nil
}

func setupRuntimeHome(home string) (string, error) {
	a, err := readSetupActivation(home)
	if os.IsNotExist(err) {
		return home, nil
	} // existing users keep the legacy layout
	if err != nil {
		return "", err
	}
	p := filepath.Join(home, "versions", a.Manifest)
	if err := checkSetupPath(p); err != nil {
		return "", err
	}
	st, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if !st.IsDir() {
		return "", fmt.Errorf("active bundle is not a directory")
	}
	return p, nil
}

// beforeActivate is a pure test seam, never a command/configuration supplied by
// a manifest. Failures before the pointer replacement preserve active.json.
func installBundle(home string, pins []pin, client *http.Client, report func(string), beforeActivate func() error) error {
	if err := checkSetupPath(home); err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0755); err != nil {
		return err
	}
	lockPath := filepath.Join(home, "setup.lock")
	if err := checkSetupPath(lockPath); err != nil {
		return err
	}
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("setup is locked (verify no installer is running before removing a stale lock): %w", err)
	}
	defer func() { lock.Close(); os.Remove(lockPath) }()
	id := setupManifestID(pins)
	stageParent := filepath.Join(home, "staging")
	if err := checkSetupPath(stageParent); err != nil {
		return err
	}
	if err := os.MkdirAll(stageParent, 0755); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(stageParent, "bundle-")
	if err != nil {
		return err
	}
	defer func() {
		if rel, err := filepath.Rel(stageParent, stage); err == nil && filepath.Dir(rel) == "." && checkSetupPath(stage) == nil {
			os.RemoveAll(stage)
		}
	}()
	final := filepath.Join(home, "versions", id)
	if err := checkSetupPath(stage); err != nil {
		return err
	}
	if err := checkSetupPath(final); err != nil {
		return err
	}
	if err := installUsingCache(stage, pins, client, report, filepath.Join(home, "downloads", id)); err != nil {
		return err
	}
	expected, err := setupTreeIdentity(stage)
	if err != nil {
		return err
	}
	if info, err := os.Stat(final); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(final), 0755); err != nil {
			return err
		}
		if err := os.Rename(stage, final); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else {
		if !info.IsDir() {
			return fmt.Errorf("prepared bundle is not a directory")
		}
		actual, err := setupTreeIdentity(final)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(expected, actual) {
			return fmt.Errorf("prepared bundle differs from verified artifacts; active version preserved")
		}
	}
	if beforeActivate != nil {
		if err := beforeActivate(); err != nil {
			return err
		}
	}
	pointer := filepath.Join(home, "active.json")
	if err := checkSetupPath(pointer); err != nil {
		return err
	}
	f, err := os.CreateTemp(home, "active-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	err = json.NewEncoder(f).Encode(setupActivation{id})
	if err == nil {
		err = f.Sync()
	}
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	if err := replaceSetupPointer(tmp, pointer); err != nil {
		return err
	}
	report("activated manifest " + id)
	return nil
}

func setupTreeIdentity(root string) (map[string]string, error) {
	entries := map[string]string{}
	var total int64
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := checkSetupPath(path); err != nil {
			return err
		}
		if path == root {
			return nil
		}
		if len(entries) >= maxSetupEntries {
			return fmt.Errorf("prepared bundle has too many entries")
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if d.IsDir() {
			entries[rel] = "directory"
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("prepared bundle contains a link or special file")
		}
		if info.Size() > maxSetupExpanded-total {
			return fmt.Errorf("prepared bundle exceeds budget")
		}
		total += info.Size()
		digest, err := fileSHA256(path)
		if err != nil {
			return err
		}
		entries[rel] = digest
		return nil
	})
	return entries, err
}
