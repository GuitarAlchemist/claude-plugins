package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// pin is one file setup downloads, checked against the SHA-256 it was pinned with.
type pin struct {
	Name       string
	URL        string
	SHA256     string
	Dest       string // relative to the data folder
	Unzip      bool   // extract into Dest instead of saving the file there
	Bytes      int64
	Version    string
	License    string
	Provenance string
}

const voicesRev = "c10ece1aade47bb51c153c893d14e5bf8e5b7117"

func voicePins(id, path, onnx, json string) []pin {
	base := "https://huggingface.co/rhasspy/piper-voices/resolve/" + voicesRev + "/" + path + "/" + id
	modelBytes, configBytes := int64(63201294), int64(4875)
	license := "MIT repository; SIWIS dataset CC-BY-4.0, fine-tuned from lessac (see model card)"
	if id == "en_US-ljspeech-medium" {
		modelBytes, configBytes = 63531379, 4972
		license = "MIT repository; LJ Speech dataset public domain (see model card)"
	}
	card := "https://huggingface.co/rhasspy/piper-voices/blob/" + voicesRev + "/" + path + "/MODEL_CARD"
	return []pin{
		{Name: id + ".onnx", URL: base + ".onnx", SHA256: onnx, Dest: "voices/" + id + ".onnx", Bytes: modelBytes, Version: voicesRev, License: license, Provenance: card},
		{Name: id + ".onnx.json", URL: base + ".onnx.json", SHA256: json, Dest: "voices/" + id + ".onnx.json", Bytes: configBytes, Version: voicesRev, License: license, Provenance: card},
	}
}

var (
	enginePin = pin{Name: "piper 2023.11.14-2 (windows amd64)",
		URL:    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
		SHA256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea", Dest: "engine", Unzip: true, Bytes: 22477236, Version: "2023.11.14-2", License: "Piper MIT; bundled espeak-ng GPL-3.0", Provenance: "https://github.com/rhasspy/piper/releases/tag/2023.11.14-2"}
	frenchPins = voicePins("fr_FR-siwis-medium", "fr/fr_FR/siwis/medium",
		"641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99",
		"39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959")
	englishPins = voicePins("en_US-ljspeech-medium", "en/en_US/ljspeech/medium",
		"6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22",
		"141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860")
)

func printSetupPlan(w io.Writer, pins []pin) error {
	var total int64
	for _, p := range pins {
		total += p.Bytes
	}
	return json.NewEncoder(w).Encode(struct {
		Schema         int    `json:"schema"`
		ProductVersion string `json:"productVersion"`
		ServiceVersion string `json:"serviceVersion"`
		Platform       string `json:"platform"`
		Source         string `json:"manifestSource"`
		DownloadBytes  int64  `json:"downloadBytes"`
		Artifacts      []pin  `json:"artifacts"`
		Apply          string `json:"apply"`
		ManifestID     string `json:"manifestId"`
	}{1, "voice-0.3.0", version, "windows-x64", "Built-in reviewed pins; trust comes from the verified release/source, not SHA alone", total, pins, "No network or writes in plan mode. Explicit --apply is required; release hardening acceptance is pending.", setupManifestID(pins)})
}

// install fetches each pin into home unless it is already there with the right hash. It
// reports each file on report.
func install(home string, pins []pin, client *http.Client, report func(string)) error {
	return installUsingCache(home, pins, client, report, filepath.Join(home, ".downloads"))
}

func installUsingCache(home string, pins []pin, client *http.Client, report func(string), cache string) error {
	if err := checkSetupPath(home); err != nil {
		return err
	}
	if len(pins) > 32 {
		return fmt.Errorf("too many setup artifacts")
	}
	budget := setupArchiveBudget{maxSetupExpanded, maxSetupEntries}
	for _, p := range pins {
		if !setupRelative(p.Dest) {
			return fmt.Errorf("invalid artifact destination %q", p.Dest)
		}
		dest := filepath.Join(home, filepath.FromSlash(p.Dest))
		if err := checkSetupPath(dest); err != nil {
			return err
		}
		if !p.Unzip {
			if sum, err := fileSHA256(dest); err == nil && sum == p.SHA256 {
				if err := consumeSetupFileBudget(dest, p.Bytes, &budget); err != nil {
					return err
				}
				report(p.Name + ": already installed")
				continue
			}
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := checkSetupPath(cache); err != nil {
			return err
		}
		if err := os.MkdirAll(cache, 0755); err != nil {
			return err
		}
		if decoded, err := hex.DecodeString(p.SHA256); err != nil || len(decoded) != 32 || len(p.SHA256) != 64 {
			return fmt.Errorf("invalid pinned digest")
		}
		part := filepath.Join(cache, p.SHA256+".part")
		if err := checkSetupPath(part); err != nil {
			return err
		}
		cached := false
		if got, err := fileSHA256(part); err == nil && got == p.SHA256 {
			cached = true
		} else {
			report(p.Name + ": downloading " + p.URL)
			if err := download(client, p, part); err != nil {
				return fmt.Errorf("%s: %w", p.Name, err)
			}
		}
		if !p.Unzip {
			if err := consumeSetupFileBudget(part, p.Bytes, &budget); err != nil {
				return err
			}
			if err := copySetupArtifact(part, dest, p.SHA256); err != nil {
				return err
			}
			if cached {
				report(p.Name + ": already installed (verified cache)")
			} else {
				report(p.Name + ": ok")
			}
			continue
		}
		err := unzipWithBudget(part, dest, &budget)
		if err != nil {
			return fmt.Errorf("%s: %w", p.Name, err)
		}
		if cached {
			report(p.Name + ": already installed (verified archive re-extracted)")
		} else {
			report(p.Name + ": ok")
		}
	}
	return nil
}

func consumeSetupFileBudget(path string, expected int64, budget *setupArchiveBudget) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() > budget.bytes || budget.entries < 1 {
		return fmt.Errorf("bundle expansion exceeds budget")
	}
	if expected > 0 && info.Size() != expected {
		return fmt.Errorf("cached artifact size disagrees with manifest")
	}
	budget.bytes -= info.Size()
	budget.entries--
	return nil
}

func copySetupArtifact(from, to, want string) error {
	f, err := os.Open(from)
	if err != nil {
		return err
	}
	defer f.Close()
	g, err := os.OpenFile(to, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(g, h), io.LimitReader(f, maxSetupDownload+1))
	if e := g.Close(); err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	if n > maxSetupDownload || hex.EncodeToString(h.Sum(nil)) != want {
		return fmt.Errorf("cached artifact changed during copy")
	}
	return nil
}

func download(client *http.Client, p pin, to string) error {
	return downloadAttempt(client, p, to, true)
}

type downloadIdentity struct {
	URL, Version, SHA256, ETag string
	Bytes                      int64
}

func downloadAttempt(client *http.Client, p pin, to string, mayResume bool) error {
	if err := checkSetupPath(to); err != nil {
		return err
	}
	if err := checkSetupPath(to + ".identity"); err != nil {
		return err
	}
	limit := p.Bytes
	if limit == 0 {
		limit = maxSetupDownload
	}
	if limit < 0 || limit > maxSetupDownload {
		return fmt.Errorf("artifact exceeds download budget")
	}
	id := downloadIdentity{URL: p.URL, Version: p.Version, SHA256: p.SHA256, Bytes: p.Bytes}
	var offset int64
	var saved downloadIdentity
	if mayResume && p.Bytes > 0 {
		if b, err := readSetupSmallFile(to+".identity", 8192); err == nil && json.Unmarshal(b, &saved) == nil && saved.URL == id.URL && saved.Version == id.Version && saved.SHA256 == id.SHA256 && saved.Bytes == id.Bytes && strongETag(saved.ETag) {
			if st, err := os.Stat(to); err == nil && st.Size() > 0 && st.Size() < p.Bytes {
				offset = st.Size()
				id.ETag = saved.ETag
			}
		}
	}
	req, err := http.NewRequest(http.MethodGet, p.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept-Encoding", "identity")
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		req.Header.Set("If-Match", id.ETag)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if enc := resp.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
		return fmt.Errorf("encoded artifact response refused")
	}
	if offset > 0 && resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		os.Remove(to)
		os.Remove(to + ".identity")
		_ = resp.Body.Close()
		return downloadAttempt(client, p, to, false)
	}
	if offset > 0 && resp.StatusCode == http.StatusPartialContent {
		if resp.Header.Get("ETag") != id.ETag || resp.Header.Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", offset, p.Bytes-1, p.Bytes) {
			return fmt.Errorf("resume identity or Content-Range changed")
		}
	} else if resp.StatusCode == http.StatusOK {
		offset = 0
		id.ETag = resp.Header.Get("ETag")
	} else {
		return fmt.Errorf("download returned %s", resp.Status)
	}
	if resp.ContentLength > limit-offset {
		return fmt.Errorf("artifact exceeds download budget")
	}
	if strongETag(id.ETag) && p.Bytes > 0 {
		b, _ := json.Marshal(id)
		if err := os.WriteFile(to+".identity", b, 0600); err != nil {
			return err
		}
	} else {
		os.Remove(to + ".identity")
	}
	flags := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flags |= os.O_TRUNC
	} else {
		flags |= os.O_APPEND
	}
	f, err := os.OpenFile(to, flags, 0600)
	if err != nil {
		return err
	}
	h := sha256.New()
	if offset > 0 {
		old, err := os.Open(to)
		if err != nil {
			f.Close()
			return err
		}
		n, err := io.Copy(h, io.LimitReader(old, offset+1))
		old.Close()
		if err != nil || n != offset {
			f.Close()
			return fmt.Errorf("resume prefix changed")
		}
	}
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, limit-offset+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n+offset > limit || (p.Bytes > 0 && n+offset != p.Bytes) {
		return fmt.Errorf("artifact size mismatch")
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != p.SHA256 {
		os.Remove(to)
		os.Remove(to + ".identity")
		return fmt.Errorf("SHA-256 is %s, pinned %s; nothing was installed", got, p.SHA256)
	}
	return nil
}

func strongETag(s string) bool {
	return len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' && !strings.ContainsAny(s, "\r\n")
}

func readSetupSmallFile(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("setup metadata exceeds budget")
	}
	return b, nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if n, err := io.Copy(h, io.LimitReader(f, maxSetupDownload+1)); err != nil {
		return "", err
	} else if n > maxSetupDownload {
		return "", fmt.Errorf("cached file exceeds budget")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// unzip extracts archive into dest and refuses an entry that would land outside it.
func unzip(archive, dest string) error {
	budget := setupArchiveBudget{maxSetupExpanded, maxSetupEntries}
	return unzipWithBudget(archive, dest, &budget)
}

type setupArchiveBudget struct {
	bytes   int64
	entries int
}

func unzipWithBudget(archive, dest string, budget *setupArchiveBudget) error {
	if err := checkSetupPath(dest); err != nil {
		return err
	}
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	if len(r.File) > budget.entries {
		return fmt.Errorf("archive contains too many entries")
	}
	var expanded uint64
	seen := map[string]bool{}
	for _, f := range r.File {
		if !setupRelative(f.Name) || (!f.Mode().IsRegular() && !f.FileInfo().IsDir()) {
			return fmt.Errorf("archive entry %q is a link or would land outside the permitted names", f.Name)
		}
		key := strings.ToUpper(strings.TrimSuffix(f.Name, "/"))
		if seen[key] {
			return fmt.Errorf("duplicate Windows archive path %q", f.Name)
		}
		seen[key] = true
		if f.UncompressedSize64 > uint64(budget.bytes)-expanded {
			return fmt.Errorf("archive expansion exceeds budget")
		}
		expanded += f.UncompressedSize64
		if setupRatioExceeded(f.UncompressedSize64, f.CompressedSize64) {
			return fmt.Errorf("archive expansion ratio exceeds budget")
		}
	}
	budget.bytes -= int64(expanded)
	budget.entries -= len(r.File)
	root := filepath.Clean(dest) + string(os.PathSeparator)
	for _, f := range r.File {
		target := filepath.Join(dest, filepath.FromSlash(f.Name))
		if err := checkSetupPath(target); err != nil {
			return err
		}
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
	n, err := io.Copy(out, io.LimitReader(rc, int64(f.UncompressedSize64)+1))
	if err == nil && uint64(n) != f.UncompressedSize64 {
		err = fmt.Errorf("archive expanded size disagrees with metadata")
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}
