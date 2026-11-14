//go:build windows

package main

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

const runKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`

type winRunKey struct{}

func openRunKey() (runKey, error) { return winRunKey{}, nil }

func (winRunKey) open() (registry.Key, error) {
	return registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE|registry.SET_VALUE)
}

func (k winRunKey) Get(name string) (string, bool, error) {
	key, err := k.open()
	if err != nil {
		return "", false, err
	}
	defer key.Close()
	v, _, err := key.GetStringValue(name)
	if errors.Is(err, registry.ErrNotExist) {
		return "", false, nil
	}
	return v, err == nil, err
}

func (k winRunKey) Set(name, value string) error {
	key, err := k.open()
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetStringValue(name, value)
}

func (k winRunKey) Delete(name string) error {
	key, err := k.open()
	if err != nil {
		return err
	}
	defer key.Close()
	return key.DeleteValue(name)
}
