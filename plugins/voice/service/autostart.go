package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// runValue names the service in the per-user Run key.
const runValue = "piper-voice"

// runKey is the per-user list of programs Windows starts at logon,
// HKCU\Software\Microsoft\Windows\CurrentVersion\Run. Writing it needs no administrator rights,
// unlike a logon task (schtasks /SC ONLOGON) or a Windows service, and a service would run in
// session 0, which cannot reach the user's speakers.
type runKey interface {
	Get(name string) (value string, ok bool, err error)
	Set(name, value string) error
	Delete(name string) error
}

// guiExe is the windowless build installed for logon: the same program linked with
// -H windowsgui, so Windows opens no console window for it.
const guiExe = "piper-voiced.exe"

// autostartCommand is what Windows runs at logon. The windowless build has no console, so its
// log goes to a file.
func autostartCommand(gui, logFile string) string {
	return fmt.Sprintf(`"%s" serve --log "%s"`, gui, logFile)
}

func installCmd(args []string, key runKey, exeDir, home string, out io.Writer) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	dry := fs.Bool("print", false, "show what would be registered, and change nothing")
	if err := fs.Parse(args); err != nil {
		return err
	}
	gui := filepath.Join(exeDir, guiExe)
	if _, err := os.Stat(gui); err != nil {
		return fmt.Errorf("no windowless build at %s; in plugins/voice/service run:\n  go build -ldflags \"-H windowsgui\" -o \"%s\" .", gui, gui)
	}
	engine := filepath.Join(home, "engine", "piper", "piper.exe")
	if _, err := os.Stat(engine); err != nil {
		return fmt.Errorf("no Piper engine at %s: run piper-voice setup first", engine)
	}
	cmd := autostartCommand(gui, filepath.Join(home, "logs", "service.log"))
	if *dry {
		fmt.Fprintf(out, "would register at logon (HKCU Run, %q):\n  %s\n", runValue, cmd)
		return nil
	}
	if err := key.Set(runValue, cmd); err != nil {
		return err
	}
	fmt.Fprintf(out, "registered at logon (HKCU Run, %q):\n  %s\nIt starts at the next logon. To start it now:\n  Start-Process \"%s\" -ArgumentList 'serve','--log','%s'\nTo undo: piper-voice uninstall\n",
		runValue, cmd, gui, filepath.Join(home, "logs", "service.log"))
	return nil
}

func uninstallCmd(key runKey, out io.Writer) error {
	value, ok, err := key.Get(runValue)
	if err != nil {
		return err
	}
	if !ok {
		fmt.Fprintln(out, "nothing to remove: piper-voice is not registered at logon")
		return nil
	}
	if err := key.Delete(runValue); err != nil {
		return err
	}
	fmt.Fprintf(out, "removed from logon: %s\nA service already running keeps running until it is stopped or the session ends.\n", value)
	return nil
}

var errNoRunKey = errors.New("install and uninstall manage the Windows per-user Run key; on this system, use its own autostart (systemd --user, launchd)")
