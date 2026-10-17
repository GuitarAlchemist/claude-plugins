package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// pin is one file setup downloads, checked against the SHA-256 it was pinned with.
type pin struct {
	Name   string
	URL    string
	SHA256 string
	Dest   string // relative to the data folder
	Unzip  bool   // extract into Dest instead of saving the file there
}

const voicesRev = "c10ece1aade47bb51c153c893d14e5bf8e5b7117"

func voicePins(id, path, onnx, json string) []pin {
	base := "https://huggingface.co/rhasspy/piper-voices/resolve/" + voicesRev + "/" + path + "/" + id
	return []pin{
		{Name: id + ".onnx", URL: base + ".onnx", SHA256: onnx, Dest: "voices/" + id + ".onnx"},
		{Name: id + ".onnx.json", URL: base + ".onnx.json", SHA256: json, Dest: "voices/" + id + ".onnx.json"},
	}
}

var (
	enginePin = pin{Name: "piper 2023.11.14-2 (windows amd64)",
		URL:    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
		SHA256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea", Dest: "engine", Unzip: true}
	frenchPins = voicePins("fr_FR-siwis-medium", "fr/fr_FR/siwis/medium",
		"641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99",
		"39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959")
	englishPins = voicePins("en_US-ljspeech-medium", "en/en_US/ljspeech/medium",
		"6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22",
		"141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860")
)

// install fetches each pin into home unless it is already there with the right hash. It
// reports each file on report.
func install(home string, pins []pin, client *http.Client, report func(string)) error {
	for _, p := range pins {
		dest := filepath.Join(home, filepath.FromSlash(p.Dest))
		stamp := dest
		if p.Unzip {
			stamp = filepath.Join(dest, ".sha256")
			if b, err := os.ReadFile(stamp); err == nil && strings.TrimSpace(string(b)) == p.SHA256 {
				report(p.Name + ": already installed")
				continue
			}
		} else if sum, err := fileSHA256(dest); err == nil && sum == p.SHA256 {
			report(p.Name + ": already installed")
			continue
		}
		if err := os.MkdirAll(filepath.Dir(stamp), 0o755); err != nil {
			return err
		}
		part := stamp + ".part"
		if p.Unzip {
			part = dest + ".zip.part"
		}
		report(p.Name + ": downloading " + p.URL)
		if err := download(client, p.URL, part, p.SHA256); err != nil {
			os.Remove(part)
			return fmt.Errorf("%s: %w", p.Name, err)
		}
		if !p.Unzip {
			if err := os.Rename(part, dest); err != nil {
				return err
			}
			report(p.Name + ": ok")
			continue
		}
		err := unzip(part, dest)
		os.Remove(part)
		if err != nil {
			return fmt.Errorf("%s: %w", p.Name, err)
		}
		if err := os.WriteFile(stamp, []byte(p.SHA256+"\n"), 0o644); err != nil {
			return err
		}
		report(p.Name + ": ok")
	}
	return nil
}

func download(client *http.Client, url, to, want string) error {
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	f, err := os.Create(to)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), resp.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("SHA-256 is %s, pinned %s; nothing was installed", got, want)
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// unzip extracts archive into dest and refuses an entry that would land outside it.
func unzip(archive, dest string) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	root := filepath.Clean(dest) + string(os.PathSeparator)
	for _, f := range r.File {
		target := filepath.Join(dest, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(target+string(os.PathSeparator), root) {
			return fmt.Errorf("archive entry %q would land outside %s", f.Name, dest)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := extract(f, target); err != nil {
			return err
		}
	}
	return nil
}

func extract(f *zip.File, target string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.Create(target)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, rc)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}
