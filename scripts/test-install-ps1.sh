#!/bin/sh
# Runs scripts/test-install-ps1.ps1 with Windows PowerShell (from WSL) or pwsh. The test stubs wsl.exe and the
# ScheduledTasks cmdlets, so it never changes WSL, a distro or the Task Scheduler.
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
TEST=$ROOT/scripts/test-install-ps1.ps1
if command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
  exec powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(wslpath -w "$TEST")"
elif command -v pwsh >/dev/null 2>&1; then
  exec pwsh -NoProfile -NonInteractive -File "$TEST"
else
  echo "Neither powershell.exe (WSL) nor pwsh found" >&2
  exit 1
fi
