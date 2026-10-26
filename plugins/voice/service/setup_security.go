package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxSetupDownload int64 = 256 << 20
const maxSetupExpanded int64 = 1 << 30
const maxSetupEntries = 4096

func setupRatioExceeded(expanded, compressed uint64) bool {
	return expanded > 0 && (compressed == 0 || (compressed <= ^uint64(0)/200 && expanded > compressed*200))
}

// These are explicit publisher/CDN destinations, not a suffix allowlist. A new
// publisher redirect must be reviewed, not silently accepted by the installer.
func setupURLAllowed(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return false
	}
	switch u.Hostname() {
	case "github.com", "release-assets.githubusercontent.com", "huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.hf.co", "cas-bridge.xethub.hf.co":
		return true
	}
	return false
}

type setupHTTPTransport struct{ base http.RoundTripper }

func (t setupHTTPTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if !setupURLAllowed(r.URL) {
		return nil, errors.New("setup URL is not an approved HTTPS destination")
	}
	return t.base.RoundTrip(r)
}
func newSetupClient() *http.Client {
	return &http.Client{Timeout: 10 * time.Minute, Transport: setupHTTPTransport{http.DefaultTransport}, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 || !setupURLAllowed(r.URL) {
			return errors.New("setup redirect is not approved")
		}
		return nil
	}}
}

func setupRelative(name string) bool {
	if name == "" || len(name) > 240 || strings.Count(name, "/") > 16 || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") {
		return false
	}
	for _, part := range strings.Split(strings.TrimSuffix(name, "/"), "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return false
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || (len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9') {
			return false
		}
	}
	return true
}

func checkSetupPath(path string) error {
	if !filepath.IsAbs(path) || strings.HasPrefix(path, `\\`) {
		return errors.New("setup requires an absolute local data path")
	}
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err == nil {
			if info.Mode()&os.ModeSymlink != 0 || setupReparse(info) {
				return fmt.Errorf("setup refuses link/reparse path %s", p)
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	return nil
}
