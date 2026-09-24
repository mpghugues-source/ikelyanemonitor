//go:build windows

package remediation

import "os/exec"

// killProcessGroupOnCancel: on Windows, exec.CommandContext's default (killing the process) is used;
// child processes may survive a timeout (job objects are not wired up yet).
func killProcessGroupOnCancel(cmd *exec.Cmd) {}
