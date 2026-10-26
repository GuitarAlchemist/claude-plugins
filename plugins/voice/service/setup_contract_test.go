package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// All transports in this file are in-memory fixtures: no sockets or downloads.
type fixtureTransport func(*http.Request) (*http.Response, error)

func (f fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fixtureResponse(code int, body io.Reader) *http.Response {
	return &http.Response{StatusCode: code, Status: http.StatusText(code), Header: make(http.Header), Body: io.NopCloser(body), ContentLength: -1}
}
func fixturePin(body string) pin {
	return pin{Name: "synthetic", URL: "https://fixtures.example.invalid/artifact", SHA256: sum([]byte(body)), Dest: "voices/synthetic.bin", Bytes: int64(len(body)), Version: "fixture-1", License: "CC0 synthetic fixture", Provenance: "authored by the test"}
}

func TestSetupPlanHasExactPinnedMetadataAndDoesNotCreateHome(t *testing.T) {
	var out bytes.Buffer
	pins := append([]pin{enginePin}, frenchPins...)
	if err := printSetupPlan(&out, pins); err != nil {
		t.Fatal(err)
	}
	var plan struct {
		DownloadBytes int64
		Artifacts     []pin
	}
	if err := json.Unmarshal(out.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	if plan.DownloadBytes != 85683405 || len(plan.Artifacts) != 3 {
		t.Fatal(out.String())
	}
	for _, p := range plan.Artifacts {
		if p.Bytes <= 0 || p.License == "" || p.Version == "" || p.Provenance == "" || len(p.SHA256) != 64 {
			t.Fatalf("incomplete %+v", p)
		}
	}
	home := filepath.Join(t.TempDir(), "must-not-exist")
	t.Setenv("PIPER_VOICE_HOME", home)
	if err := setupCmd(nil); err != nil && runtime.GOOS == "windows" && runtime.GOARCH == "amd64" {
		t.Fatal(err)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("plan wrote home: %v", err)
	}
}

func TestSetupArchiveBudgetIsSharedAcrossArtifacts(t *testing.T) {
	data := zipOf(t, map[string]string{"entry": "12345"})
	dir := t.TempDir()
	archive := filepath.Join(dir, "fixture.zip")
	if err := os.WriteFile(archive, data, 0600); err != nil {
		t.Fatal(err)
	}
	budget := setupArchiveBudget{bytes: 9, entries: 2}
	if err := unzipWithBudget(archive, filepath.Join(dir, "first"), &budget); err != nil {
		t.Fatal(err)
	}
	if err := unzipWithBudget(archive, filepath.Join(dir, "second"), &budget); err == nil {
		t.Fatal("second archive exceeded aggregate bytes")
	}
	if _, err := os.Stat(filepath.Join(dir, "second", "entry")); !os.IsNotExist(err) {
		t.Fatal("over-budget archive wrote output")
	}
}

func TestSetupRatioAndPathLimitBoundaries(t *testing.T) {
	for _, v := range []struct {
		expanded, compressed uint64
		bad                  bool
	}{{2000, 10, false}, {2001, 10, true}, {0, 0, false}, {1, 0, true}, {^uint64(0), ^uint64(0), false}} {
		if got := setupRatioExceeded(v.expanded, v.compressed); got != v.bad {
			t.Fatalf("ratio %d/%d: %v", v.expanded, v.compressed, got)
		}
	}
	if !setupRelative(strings.Repeat("a", 240)) || setupRelative(strings.Repeat("a", 241)) {
		t.Fatal("path length boundary")
	}
	if !setupRelative(strings.Repeat("a/", 16)+"a") || setupRelative(strings.Repeat("a/", 17)+"a") {
		t.Fatal("path depth boundary")
	}
}

func TestSetupRejectsWindowsUnsafeNames(t *testing.T) {
	for _, s := range []string{"../x", "/x", "C:/x", `..\x`, `a\x`, "a//x", "a/./x", "a/../x", "CON", "aux.txt", "COM1.bin", "a.", "a ", "a:b", "a\x00b", ""} {
		t.Run(s, func(t *testing.T) {
			if setupRelative(s) {
				t.Fatal("unsafe name accepted")
			}
		})
	}
	if !setupRelative("engine/piper/piper.exe") {
		t.Fatal("normal path rejected")
	}
}

func TestSetupHTTPPolicyRejectsUnexpectedOrigins(t *testing.T) {
	for _, raw := range []string{"http://github.com/x", "https://github.com.evil.invalid/x", "https://u:p@github.com/x", "https://github.com:443/x", "https://127.0.0.1/x", "https://github.com/x#fragment"} {
		u, _ := url.Parse(raw)
		if setupURLAllowed(u) {
			t.Fatal(raw)
		}
	}
	u, _ := url.Parse("https://github.com/rhasspy/piper/releases/download/pinned/file.zip")
	if !setupURLAllowed(u) {
		t.Fatal("official URL refused")
	}
	c := newSetupClient()
	c.Transport = fixtureTransport(func(r *http.Request) (*http.Response, error) {
		v := fixtureResponse(302, strings.NewReader(""))
		v.Header.Set("Location", "https://evil.invalid/stolen")
		return v, nil
	})
	if _, err := c.Get(u.String()); err == nil {
		t.Fatal("unapproved redirect accepted")
	}
}

func TestSetupDownloadBoundAndHashAreCheckedBeforeActivation(t *testing.T) {
	for _, body := range []string{"wrong", "toolong"} {
		t.Run(body, func(t *testing.T) {
			p := fixturePin("right")
			c := &http.Client{Transport: fixtureTransport(func(*http.Request) (*http.Response, error) { return fixtureResponse(200, strings.NewReader(body)), nil })}
			h := t.TempDir()
			if err := installBundle(h, []pin{p}, c, func(string) {}, nil); err == nil {
				t.Fatal("bad fixture installed")
			}
			if _, err := os.Stat(filepath.Join(h, "active.json")); !os.IsNotExist(err) {
				t.Fatal("bad fixture activated")
			}
		})
	}
}

type brokenFixtureBody struct{}

func (brokenFixtureBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestSetupResumesOnlyTheVerifiedFixtureIdentity(t *testing.T) {
	p := fixturePin("abcXYZ")
	h := t.TempDir()
	part := filepath.Join(h, "part")
	calls := 0
	c := &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			v := fixtureResponse(200, io.MultiReader(strings.NewReader("abc"), brokenFixtureBody{}))
			v.Header.Set("ETag", `"stable"`)
			return v, nil
		}
		if r.Header.Get("Range") != "bytes=3-" || r.Header.Get("If-Match") != `"stable"` {
			t.Fatalf("bad resume %+v", r.Header)
		}
		v := fixtureResponse(206, strings.NewReader("XYZ"))
		v.Header.Set("ETag", `"stable"`)
		v.Header.Set("Content-Range", "bytes 3-5/6")
		return v, nil
	})}
	if err := download(c, p, part); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("first result %v", err)
	}
	if err := download(c, p, part); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(part)
	if string(b) != "abcXYZ" || calls != 2 {
		t.Fatal(string(b), calls)
	}
}

func seedResumeFixture(t *testing.T, p pin, etag string) (string, *http.Client) {
	t.Helper()
	part := filepath.Join(t.TempDir(), "partial")
	if err := os.WriteFile(part, []byte("abc"), 0600); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(downloadIdentity{p.URL, p.Version, p.SHA256, etag, p.Bytes})
	if err := os.WriteFile(part+".identity", b, 0600); err != nil {
		t.Fatal(err)
	}
	return part, &http.Client{}
}

func TestSetupRejectsChangedResumeETagAndContentRange(t *testing.T) {
	for _, change := range []string{"etag", "range"} {
		t.Run(change, func(t *testing.T) {
			p := fixturePin("abcXYZ")
			part, c := seedResumeFixture(t, p, `"ABC"`)
			c.Transport = fixtureTransport(func(*http.Request) (*http.Response, error) {
				v := fixtureResponse(206, strings.NewReader("XYZ"))
				v.Header.Set("ETag", `"ABC"`)
				v.Header.Set("Content-Range", "bytes 3-5/6")
				if change == "etag" {
					v.Header.Set("ETag", `"abc"`)
				} else {
					v.Header.Set("Content-Range", "bytes 2-4/6")
				}
				return v, nil
			})
			if err := download(c, p, part); err == nil {
				t.Fatal("changed identity accepted")
			}
		})
	}
}

func TestSetupResumeIdentityComparisonIsOrdinal(t *testing.T) {
	p := fixturePin("abcXYZ")
	part, c := seedResumeFixture(t, p, `"stable"`)
	b, _ := json.Marshal(downloadIdentity{strings.ToUpper(p.URL), p.Version, p.SHA256, `"stable"`, p.Bytes})
	os.WriteFile(part+".identity", b, 0600)
	c.Transport = fixtureTransport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Range") != "" {
			t.Fatal("case-changed URL resumed")
		}
		return fixtureResponse(200, strings.NewReader("abcXYZ")), nil
	})
	if err := download(c, p, part); err != nil {
		t.Fatal(err)
	}
}

func TestSetupRange416RestartsOnce(t *testing.T) {
	p := fixturePin("abcXYZ")
	part, c := seedResumeFixture(t, p, `"stable"`)
	calls := 0
	c.Transport = fixtureTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return fixtureResponse(416, strings.NewReader("")), nil
		}
		if r.Header.Get("Range") != "" {
			t.Fatal("range retried")
		}
		return fixtureResponse(200, strings.NewReader("abcXYZ")), nil
	})
	if err := download(c, p, part); err != nil || calls != 2 {
		t.Fatal(err, calls)
	}
}

func TestSetupFailedActivationPreservesOldBundleAndConcurrentLock(t *testing.T) {
	h := t.TempDir()
	p := fixturePin("abcXYZ")
	c := &http.Client{Transport: fixtureTransport(func(*http.Request) (*http.Response, error) {
		return fixtureResponse(200, strings.NewReader("abcXYZ")), nil
	})}
	if err := installBundle(h, []pin{p}, c, func(string) {}, nil); err != nil {
		t.Fatal(err)
	}
	old, _ := os.ReadFile(filepath.Join(h, "active.json"))
	oldRoot, err := setupRuntimeHome(h)
	if err != nil {
		t.Fatal(err)
	}
	p.Version = "fixture-2"
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- installBundle(h, []pin{p}, c, func(string) {}, func() error { close(entered); <-release; return errors.New("fixture activation failure") })
	}()
	<-entered
	if err := installBundle(h, []pin{p}, c, func(string) {}, nil); err == nil {
		t.Fatal("concurrent installer accepted")
	}
	close(release)
	if err := <-done; err == nil {
		t.Fatal("failure hidden")
	}
	after, _ := os.ReadFile(filepath.Join(h, "active.json"))
	if !bytes.Equal(old, after) {
		t.Fatal("active version changed on failure")
	}
	if _, err := os.Stat(filepath.Join(oldRoot, "voices", "synthetic.bin")); err != nil {
		t.Fatal("old bundle damaged", err)
	}
}

func TestSetupZipRejectsLinksDuplicateNamesAndExpansion(t *testing.T) {
	for _, kind := range []string{"link", "duplicate", "expansion"} {
		t.Run(kind, func(t *testing.T) {
			var b bytes.Buffer
			w := zip.NewWriter(&b)
			h := &zip.FileHeader{Name: "safe.bin", Method: zip.Store}
			if kind == "link" {
				h.SetMode(os.ModeSymlink | 0777)
			}
			f, _ := w.CreateHeader(h)
			f.Write([]byte("fixture"))
			if kind == "duplicate" {
				f, _ = w.Create("SAFE.bin")
				f.Write([]byte("fixture"))
			}
			w.Close()
			data := b.Bytes()
			if kind == "expansion" {
				i := bytes.Index(data, []byte{'P', 'K', 1, 2})
				binary.LittleEndian.PutUint32(data[i+24:i+28], uint32(maxSetupExpanded+1))
			}
			dir := t.TempDir()
			archive := filepath.Join(dir, "fixture.zip")
			os.WriteFile(archive, data, 0600)
			if err := unzip(archive, filepath.Join(dir, "stage")); err == nil {
				t.Fatal("unsafe ZIP accepted")
			}
			if _, err := os.Stat(filepath.Join(dir, "stage", "safe.bin")); !os.IsNotExist(err) {
				t.Fatal("rejected ZIP wrote a file")
			}
		})
	}
}

func TestSetupRefusesToReactivateATruncatedPreparedBundle(t *testing.T) {
	h := t.TempDir()
	p := fixturePin("abcXYZ")
	c := &http.Client{Transport: fixtureTransport(func(*http.Request) (*http.Response, error) {
		return fixtureResponse(200, strings.NewReader("abcXYZ")), nil
	})}
	if err := installBundle(h, []pin{p}, c, func(string) {}, nil); err != nil {
		t.Fatal(err)
	}
	old, _ := os.ReadFile(filepath.Join(h, "active.json"))
	p.Version = "fixture-2"
	if err := installBundle(h, []pin{p}, c, func(string) {}, func() error { return errors.New("fixture before activation") }); err == nil {
		t.Fatal("fixture did not fail")
	}
	newFile := filepath.Join(h, "versions", setupManifestID([]pin{p}), "voices", "synthetic.bin")
	if err := os.WriteFile(newFile, []byte("truncated"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installBundle(h, []pin{p}, c, func(string) {}, nil); err == nil {
		t.Fatal("corrupt prepared bundle activated")
	}
	after, _ := os.ReadFile(filepath.Join(h, "active.json"))
	if !bytes.Equal(old, after) {
		t.Fatal("old pointer changed")
	}
}

func TestSetupNeverTrustsAnExtractedZipStamp(t *testing.T) {
	body := zipOf(t, map[string]string{"piper/piper.exe": "synthetic executable bytes"})
	h := t.TempDir()
	p := pin{Name: "fixture archive", URL: "https://fixtures.example.invalid/zip", SHA256: sum(body), Dest: "engine", Unzip: true, Bytes: int64(len(body)), Version: "fixture"}
	c := &http.Client{Transport: fixtureTransport(func(*http.Request) (*http.Response, error) { return fixtureResponse(200, bytes.NewReader(body)), nil })}
	if err := install(h, []pin{p}, c, func(string) {}); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(h, "engine", "piper", "piper.exe")
	os.Remove(exe)
	os.WriteFile(filepath.Join(h, "engine", ".sha256"), []byte(p.SHA256), 0600)
	if err := install(h, []pin{p}, c, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(exe); err != nil || string(b) != "synthetic executable bytes" {
		t.Fatal("stamp skipped extraction", err)
	}
}

func TestSetupZipRatioAppliesToSmallEntries(t *testing.T) {
	data := zipOf(t, map[string]string{"small.bin": strings.Repeat("\x00", 64<<10)})
	dir := t.TempDir()
	archive := filepath.Join(dir, "small.zip")
	os.WriteFile(archive, data, 0600)
	if err := unzip(archive, filepath.Join(dir, "stage")); err == nil {
		t.Fatal("small compression bomb accepted")
	}
}
