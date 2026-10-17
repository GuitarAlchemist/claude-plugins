//go:build !windows

package main

func openRunKey() (runKey, error) { return nil, errNoRunKey }
