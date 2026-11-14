//go:build nooto

package main

import "errors"

// Built with -tags nooto (for CI on a machine without audio headers), the service cannot play.
func newPlayer(int) (Player, error) {
	return nil, errors.New("this build has no audio output (built with -tags nooto)")
}
