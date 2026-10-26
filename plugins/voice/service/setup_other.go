//go:build !windows

package main

import "os"

func setupReparse(info os.FileInfo) bool { return info.Mode()&os.ModeSymlink != 0 }

func replaceSetupPointer(from, to string) error { return os.Rename(from, to) }
