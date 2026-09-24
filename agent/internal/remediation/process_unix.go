//go:build !windows

package remediation

import (
	"os/exec"
	"syscall"
)

// killProcessGroupOnCancel starts the script in its own process group and, on timeout, kills the
// whole group: a script that spawned children (a service restart, `sleep` in a loop) must not leave
// them running after its time is up.
func killProcessGroupOnCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
