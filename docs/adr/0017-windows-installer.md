# ADR 0017: Windows installer that drives WSL

- Status: accepted
- Date: 2026-10-28

## Context

Paneful Manager runs inside WSL2 on Windows. Before this, a Windows user had to install WSL and a distro, enable systemd in `/etc/wsl.conf`, restart WSL, open the distro and run `install.sh`, which then offered the Windows logon task through `powershell.exe` interop. The public one-liner for Windows is `irm .../install.ps1 | iex`.

## Decision

- **`install.ps1` orchestrates, `install.sh` installs.** The PowerShell script only does what needs Windows: check WSL (`wsl.exe --status`), choose or install a distro, enable systemd, restart WSL, register the logon task. The install itself is `install.sh` of the same release, downloaded and run inside the distro with `--yes --no-wsl-conf --no-windows-task`, so there is one installer to maintain and test.
- **Safe for `irm | iex`.** No `param()` block (options are `PANEFUL_MANAGER_*` environment variables; switches like `-Uninstall` work when the file is run directly), never `exit` unless it runs as a file, plain ASCII (`irm` decodes a release asset without a charset), Windows PowerShell 5.1 compatible.
- **No loops, no silent admin.** Without WSL it prints the exact steps (`wsl --install` as administrator, restart, create the Linux user, run again); only in an administrator PowerShell does it offer `wsl --install --no-distribution` itself, then stops. Without a distro it offers `wsl --install -d Ubuntu` and stops. A WSL 1 distro is refused; a root default user needs consent.
- **systemd from Windows.** When PID 1 is not systemd it asks once (the prompt says that `wsl --shutdown` stops all distros), runs `install.sh --enable-wsl-systemd` as root in the distro (`wsl -u root`, no sudo password; the same wsl.conf merge with backup as the in-distro path), runs `wsl --shutdown` and checks again.
- **Values cross into WSL through `WSLENV`**, not on wsl.exe's command line: the script given to `sh -c` has no double quotes, because Windows PowerShell 5.1 does not escape them for native commands. It downloads `install.sh` to a temp file before running it, so a failed download fails the step instead of running an empty script.
- **One logon task.** `install.ps1` registers `paneful-manager-<distro>` itself and passes `--no-windows-task`, which now also keeps `install.sh --uninstall` from removing it; `install.ps1 -Uninstall` removes it and the pre-rename `AgentHub-<distro>` task. `install.sh` run directly in WSL keeps offering the task as before; both use the same name, so they never create two.
- **Native commands keep the console.** Steps that run wsl.exe interactively are never captured in a variable, so `install.sh` keeps a terminal for prompts such as a sudo password; results travel in a script variable.
- **Tests without side effects.** `scripts/test-install-ps1.ps1` runs the script the way `iex` does, with `wsl.exe` and the ScheduledTasks cmdlets replaced by functions (a function wins over an application or cmdlet of the same name); it refuses to start unless every one of them is stubbed. CI runs it under PowerShell 7 on Linux and Windows PowerShell 5.1 on `windows-latest`; `scripts/test-install-ps1.sh` runs it from WSL through `powershell.exe`.

## Consequences

- A fresh Windows needs up to three runs of the one-liner (WSL install and restart, distro user creation, install); each stop says what comes next.
- The install runs as the distro's default user; a distro that logs in as root should get a normal user first.
- The login URL comes from `install.sh`'s output in the same console; a new one needs `wsl -- ~/.local/share/paneful-manager/current/install.sh --login-url`.
- `install.ps1` does not edit `%UserProfile%\.wslconfig`; it reports whether `instanceIdleTimeout=-1` is set, as `install.sh` does.

## Alternatives considered

- **A full Windows-native installer (MSI, winget):** Paneful Manager still runs in WSL, so it would only wrap the same steps with more packaging.
- **`curl | sh` inside WSL from PowerShell:** a failed `curl` ends as a successful run of an empty script.
- **Passing options on the wsl.exe command line:** quoting breaks with Windows PowerShell 5.1 for arguments containing double quotes.
