#!/bin/sh
# Paneful Manager installer for WSL2, Linux (systemd) and macOS (launchd). Windows: install.ps1 runs it inside WSL.
#   curl -fsSL https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.sh | sh
# Private repository: GITHUB_TOKEN=<token> sh install.sh (or log in with gh), see docs/install.md
# Run with -h for all options. Docs: docs/install.md
set -eu

PANEFUL_MANAGER_REPO=${PANEFUL_MANAGER_REPO:-Dev-Sebi/Paneful-Manager}
DEFAULT_PORT=7337
MIN_NODE_MAJOR=22
MIN_TMUX_VERSION=3.2
# Reads headers from stdin (7.55) and keeps a custom Authorization header off redirect hosts (7.58).
MIN_CURL_TOKEN_VERSION=7.58
TMUX_UNIT=paneful-manager-tmux.service
SERVER_UNIT=paneful-manager.service
SOCKET_UNIT=paneful-manager.socket
SERVER_AGENT=dev.paneful-manager
TMUX_AGENT=dev.paneful-manager.tmux
HEALTH_TIMEOUT_SEC=20
# Overridable for scripts/test-install.sh only.
WSL_CONF=${PANEFUL_MANAGER_WSL_CONF:-/etc/wsl.conf}
PROC_VERSION=${PANEFUL_MANAGER_PROC_VERSION:-/proc/version}
IF_INET6=${PANEFUL_MANAGER_IF_INET6:-/proc/net/if_inet6}

VERSION=latest
PREFIX=""
PORT=""
FROM_SOURCE=""
ACTION=install
NO_SERVICE=0
NO_WSL_CONF=0
NO_WINDOWS_TASK=0
DRY_RUN=0
YES=0
FORCE=0
PURGE=0
NO_VERIFY=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Installs Paneful Manager as systemd user services (Linux, WSL2) or launchd user agents (macOS).

Options:
  --version <tag|latest>  Release to install (default: latest)
  --from-source <path>    Install from a local release tarball or a built source checkout
  --prefix <dir>          Install directory (default: ~/.local/share/paneful-manager)
  --port <port>           Server port (default: 7337, or the port already installed); saved in config.yaml
  --no-service            Do not install or start the systemd units or launchd agents (alias: --no-systemd)
  --no-wsl-conf           Never offer to enable systemd in /etc/wsl.conf
  --no-windows-task       Never offer the Windows logon task that boots the distro
  --force                 Reinstall the same version; allow a prefix outside HOME or without install marker
  --no-verify             Install a downloaded release without a published .sha256 file
  --login-url             Print a one-time login URL for a browser, then exit
  --enable-wsl-systemd    Only enable systemd in /etc/wsl.conf (WSL; used by install.ps1), then exit
  --rollback              Switch back to the previously installed release
  --uninstall             Remove services (units or agents) and the install directory
  --purge                 With --uninstall: also remove config and state without asking
  --dry-run               Print every step without changing anything
  -y, --yes               Answer yes to all questions (needed without a terminal)
  -h, --help              Show this help

Environment:
  PANEFUL_MANAGER_REPO          GitHub <owner>/<repo> to download releases from
  GITHUB_TOKEN, GH_TOKEN  Token for a private repository (read-only Contents access); without one,
                          'gh auth token' is used when gh is logged in, otherwise downloads are anonymous
EOF
}

# ---------- output helpers ----------

say() { printf '%s\n' "$*"; }
info() { printf '==> %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Prints a command, then runs it unless --dry-run.
run() {
  printf '  +'
  printf ' %s' "$@"
  printf '\n'
  [ "$DRY_RUN" -eq 1 ] || "$@"
}

has_tty() { (exec </dev/tty) 2>/dev/null; }

# confirm <question> <default y|n>: --yes answers yes, --dry-run assumes yes, without a terminal the answer is no.
confirm() {
  if [ "$YES" -eq 1 ]; then return 0; fi
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  (dry run) would ask: $1 -> assuming yes"
    return 0
  fi
  if ! has_tty; then
    say "  $1 -> no (no terminal to ask). Run from a terminal, or pass --yes to accept every question."
    return 1
  fi
  if [ "$2" = y ]; then hint='[Y/n]'; else hint='[y/N]'; fi
  printf '%s %s ' "$1" "$hint" >/dev/tty
  read -r answer </dev/tty || answer=""
  case "$answer" in
    [Yy]*) return 0 ;;
    [Nn]*) return 1 ;;
    *) [ "$2" = y ] ;;
  esac
}

# ---------- small utilities ----------

# version_ge <a> <b>: true when dotted version a >= b (numeric, up to 3 parts).
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, x, "."); nb = split(b, y, ".")
    for (i = 1; i <= 3; i++) {
      if ((x[i] + 0) > (y[i] + 0)) exit 0
      if ((x[i] + 0) < (y[i] + 0)) exit 1
    }
    exit 0
  }'
}

# xdg_dir <value> <fallback>: absolute XDG value or the fallback (relative values are ignored, as in the server).
xdg_dir() {
  case "${1:-}" in
    /*) printf '%s' "${1%/}" ;;
    *) printf '%s' "$2" ;;
  esac
}

# normalize_path <path>: absolute path with symlinks of the existing part resolved, like GNU 'realpath -m' (missing on macOS).
normalize_path() {
  if realpath -m / >/dev/null 2>&1; then
    realpath -m -- "$1"
  elif command -v node >/dev/null 2>&1; then
    # shellcheck disable=SC2016
    node -e '
      const fs = require("fs"), path = require("path")
      let rest = "", dir = path.resolve(process.argv[1])
      while (!fs.existsSync(dir) && path.dirname(dir) !== dir) { rest = path.join(path.basename(dir), rest); dir = path.dirname(dir) }
      console.log(path.join(fs.realpathSync(dir), rest).replace(/(.)\/$/, "$1"))
    ' "$1"
  else
    die "Node.js $MIN_NODE_MAJOR or later is required (macOS: brew install node, or https://nodejs.org)"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{ print $1 }'
}

# replace_link <target> <link>: points <link> at <target> atomically (rename over the old link; 'mv -T' is GNU only).
replace_link() {
  ln -sfn "$1" "$2.tmp"
  node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$2.tmp" "$2"
}

is_macos() { [ "$OS_NAME" = Darwin ]; }

# Paths go into unit files unquoted, so they must not need escaping.
require_plain_path() {
  case "$1" in
    *[!A-Za-z0-9_./+@:,-]*) die "$2 contains characters that cannot be used in a systemd unit: $1" ;;
  esac
}

is_wsl() { [ "$OS_NAME" = Linux ] && grep -qi microsoft "$PROC_VERSION" 2>/dev/null; }

systemd_user_available() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

release_tag_of() {
  [ -L "$1" ] || return 1
  basename "$(readlink "$1")"
}

# ---------- argument parsing ----------

need_value() { [ "$2" -ge 2 ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) need_value "$1" $#; VERSION=$2; shift ;;
    --version=*) VERSION=${1#*=} ;;
    --prefix) need_value "$1" $#; PREFIX=$2; shift ;;
    --prefix=*) PREFIX=${1#*=} ;;
    --port) need_value "$1" $#; PORT=$2; shift ;;
    --port=*) PORT=${1#*=} ;;
    --from-source) need_value "$1" $#; FROM_SOURCE=$2; shift ;;
    --from-source=*) FROM_SOURCE=${1#*=} ;;
    --no-service|--no-systemd) NO_SERVICE=1 ;;
    --enable-wsl-systemd) ACTION=enable_wsl_systemd ;;
    --no-wsl-conf) NO_WSL_CONF=1 ;;
    --no-windows-task) NO_WINDOWS_TASK=1 ;;
    --force) FORCE=1 ;;
    --login-url) ACTION=login_url ;;
    --rollback) ACTION=rollback ;;
    --uninstall) ACTION=uninstall ;;
    --purge) PURGE=1 ;;
    --no-verify) NO_VERIFY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

# Read once and unset, so no child process (curl, pnpm, node, systemctl) inherits the token.
# API_TOKEN is unset first: one imported from the environment would stay exported.
unset API_TOKEN TOKEN_SOURCE
API_TOKEN=${GITHUB_TOKEN:-${GH_TOKEN:-}}
if [ -n "${GITHUB_TOKEN:-}" ]; then TOKEN_SOURCE=GITHUB_TOKEN; else TOKEN_SOURCE=GH_TOKEN; fi
unset GITHUB_TOKEN GH_TOKEN

OS_NAME=$(uname -s)
case "$OS_NAME" in
  Linux|Darwin) ;;
  *) die "Unsupported system '$OS_NAME': Paneful Manager runs on Linux, WSL2 and macOS (on Windows use install.ps1)" ;;
esac

[ -n "${HOME:-}" ] || die "HOME is not set"
case "$HOME" in /*) ;; *) die "HOME must be an absolute path" ;; esac
USER_NAME=${USER:-$(id -un)}

CONFIG_HOME=$(xdg_dir "${XDG_CONFIG_HOME:-}" "$HOME/.config")
STATE_HOME=$(xdg_dir "${XDG_STATE_HOME:-}" "$HOME/.local/state")
DATA_HOME=$(xdg_dir "${XDG_DATA_HOME:-}" "$HOME/.local/share")
PREFIX=${PREFIX:-$DATA_HOME/paneful-manager}
case "$PREFIX" in /*) ;; *) PREFIX=$(pwd)/$PREFIX ;; esac
PREFIX=$(normalize_path "$PREFIX")
HOME_REAL=$(normalize_path "$HOME")
CONFIG_DIR=$CONFIG_HOME/paneful-manager
CONFIG_FILE=$CONFIG_DIR/config.yaml
STATE_DIR=$STATE_HOME/paneful-manager
UNIT_DIR=$CONFIG_HOME/systemd/user
AGENT_DIR=$HOME/Library/LaunchAgents
LOG_DIR=$STATE_DIR/logs
RELEASES_DIR=$PREFIX/releases
CURRENT_LINK=$PREFIX/current
PREVIOUS_LINK=$PREFIX/previous
MARKER=$PREFIX/.paneful-manager-install

case "$PREFIX" in
  /|"$HOME_REAL"|/usr|/usr/*|/etc|/etc/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/var|/boot|/System|/System/*|/Library|/Library/*|/Applications|/private|/private/etc|/private/etc/*|/private/var) die "Refusing to use $PREFIX as install prefix" ;;
  "$HOME_REAL"/*) ;;
  *) [ "$FORCE" -eq 1 ] || die "Refusing to use $PREFIX as install prefix: it is outside $HOME_REAL (pass --force to allow)" ;;
esac
case "$PANEFUL_MANAGER_REPO" in
  */*/*|*[!A-Za-z0-9._/-]*|/*|*/) die "PANEFUL_MANAGER_REPO must look like <owner>/<repo>" ;;
  */*) ;;
  *) die "PANEFUL_MANAGER_REPO must look like <owner>/<repo>" ;;
esac
if [ -n "$PORT" ]; then
  case "$PORT" in *[!0-9]*|'') die "--port must be a number" ;; esac
  if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "--port must be between 1 and 65535"; fi
fi
[ "$DRY_RUN" -eq 0 ] || info "Dry run: nothing will be changed"

# ---------- Windows logon task (WSL only) ----------

distro_name() {
  name=${WSL_DISTRO_NAME:-}
  case "$name" in
    ''|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  printf '%s' "$name"
}

windows_task_name() { printf 'paneful-manager-%s' "$1"; }

# True when %UserProfile%\.wslconfig sets instanceIdleTimeout=-1 (best effort, false when unknown).
wslconfig_keeps_distro() {
  command -v wslpath >/dev/null 2>&1 || return 1
  # shellcheck disable=SC2016
  profile=$(powershell.exe -NoProfile -NonInteractive -Command '$env:USERPROFILE' 2>/dev/null | tr -d '\r') || return 1
  [ -n "$profile" ] || return 1
  file="$(wslpath -u "$profile" 2>/dev/null)/.wslconfig" || return 1
  grep -Eiq '^[[:space:]]*instanceIdleTimeout[[:space:]]*=[[:space:]]*-1[[:space:]]*$' "$file" 2>/dev/null
}

windows_task_exists() {
  command -v powershell.exe >/dev/null 2>&1 || return 1
  powershell.exe -NoProfile -NonInteractive -Command \
    "if (Get-ScheduledTask -TaskName '$1' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >/dev/null 2>&1
}

install_windows_task() {
  if [ "$NO_WINDOWS_TASK" -eq 1 ] || ! is_wsl; then return 0; fi
  if ! distro=$(distro_name); then
    warn "WSL_DISTRO_NAME is missing or unusual; skipping the Windows logon task"
    return 0
  fi
  if ! command -v powershell.exe >/dev/null 2>&1; then
    warn "powershell.exe not found (Windows interop off?); skipping the Windows logon task"
    return 0
  fi
  task=$(windows_task_name "$distro")
  if [ "$DRY_RUN" -eq 0 ] && windows_task_exists "$task"; then
    say "  Windows logon task $task already exists"
    return 0
  fi
  info "Windows logon task"
  say "  WSL does not start on its own after Windows boots. A scheduled task can run"
  say "  'wsl.exe -d $distro --exec true' at your Windows logon, which boots the distro so"
  say "  systemd starts Paneful Manager. It runs as your Windows user, no admin rights needed."
  say "  The task only boots the distro: WSL stops an idle distro again after instanceIdleTimeout"
  say "  (default 15 s, [general] in %UserProfile%\\.wslconfig) and the VM after vmIdleTimeout ([wsl2])."
  if wslconfig_keeps_distro; then
    say "  Your .wslconfig already sets instanceIdleTimeout=-1, so the distro stays up after the task ran."
  else
    say "  For the task to be useful, add 'instanceIdleTimeout=-1' under [general] in %UserProfile%\\.wslconfig"
    say "  (applies to all distros, needs 'wsl.exe --shutdown' once). The installer does not edit that file."
  fi
  if ! confirm "Create the Windows logon task $task?" n; then
    say "  Skipped. Add it later by re-running the installer."
    return 0
  fi
  ps="\$a = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument '-d $distro --exec true';"
  ps="$ps \$t = New-ScheduledTaskTrigger -AtLogOn -User \"\$env:USERDOMAIN\\\$env:USERNAME\";"
  ps="$ps \$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5);"
  ps="$ps Register-ScheduledTask -TaskName '$task' -Description 'Boots the WSL distro $distro for Paneful Manager' -Action \$a -Trigger \$t -Settings \$s -Force | Out-Null"
  if ! run powershell.exe -NoProfile -NonInteractive -Command "$ps"; then
    warn "Registering the task failed. See docs/install.md (Windows logon task) for the manual steps."
  fi
}

# remove_windows_task [name-prefix]: the current task, or the one named <name-prefix><distro>.
remove_windows_task() {
  if [ "$NO_WINDOWS_TASK" -eq 1 ] || ! is_wsl; then return 0; fi
  distro=$(distro_name) || return 0
  command -v powershell.exe >/dev/null 2>&1 || return 0
  task=${1:+$1$distro}
  task=${task:-$(windows_task_name "$distro")}
  if [ "$DRY_RUN" -eq 0 ] && ! windows_task_exists "$task"; then
    return 0
  fi
  if confirm "Remove the Windows logon task $task?" y; then
    run powershell.exe -NoProfile -NonInteractive -Command "Unregister-ScheduledTask -TaskName '$task' -Confirm:\$false" ||
      warn "Removing the Windows task failed; remove '$task' in the Task Scheduler"
  fi
}

# ---------- WSL systemd ----------

wsl_conf_has_systemd() {
  [ -f "$WSL_CONF" ] || return 1
  awk '
    /^[[:space:]]*\[/ { boot = tolower($0) ~ /^[[:space:]]*\[boot\][[:space:]]*([#;].*)?$/ ; next }
    boot && tolower($0) ~ /^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true[[:space:]]*([#;].*)?$/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$WSL_CONF"
}

# Prints wsl.conf with systemd=true in [boot], keeping every other line.
merged_wsl_conf() {
  if [ -f "$WSL_CONF" ]; then
    awk '
      /^[[:space:]]*\[/ {
        if (boot && !done) { print "systemd=true"; done = 1 }
        boot = tolower($0) ~ /^[[:space:]]*\[boot\][[:space:]]*([#;].*)?$/
        print; next
      }
      boot && tolower($0) ~ /^[[:space:]]*systemd[[:space:]]*=/ { if (!done) { print "systemd=true"; done = 1 } ; next }
      { print }
      END {
        if (boot && !done) { print "systemd=true"; done = 1 }
        if (!done) { if (NR > 0) print ""; print "[boot]"; print "systemd=true" }
      }
    ' "$WSL_CONF"
  else
    printf '[boot]\nsystemd=true\n'
  fi
}

# Merges [boot] systemd=true into wsl.conf (sudo unless root, a backup is written); asks first.
enable_wsl_systemd() {
  if wsl_conf_has_systemd; then
    say "  $WSL_CONF already enables systemd."
    return 0
  fi
  say "  Paneful Manager runs as systemd user services. WSL enables systemd with"
  say "  '[boot]' + 'systemd=true' in $WSL_CONF (needs root; other settings are kept, a backup is written)."
  if ! confirm "Enable systemd in $WSL_CONF now?" y; then
    say "  Skipped."
    return 1
  fi
  if [ "$(id -u)" -eq 0 ]; then as_root=""; else as_root=sudo; fi
  tmp=$(mktemp)
  merged_wsl_conf >"$tmp"
  if [ -f "$WSL_CONF" ] && command -v diff >/dev/null 2>&1; then
    say "  Changes to $WSL_CONF:"
    diff -u "$WSL_CONF" "$tmp" | sed 's/^/    /' || true
  else
    say "  New $WSL_CONF:"
    sed 's/^/    | /' "$tmp"
  fi
  if [ -f "$WSL_CONF" ]; then
    run ${as_root:+"$as_root"} cp -p "$WSL_CONF" "$WSL_CONF.paneful-manager.bak"
  fi
  run ${as_root:+"$as_root"} install -m 0644 "$tmp" "$WSL_CONF"
  rm -f "$tmp"
}

do_enable_wsl_systemd() {
  is_wsl || die "--enable-wsl-systemd only applies to WSL"
  info "systemd in WSL"
  enable_wsl_systemd || exit 1
  say "  systemd starts after the distro restarts: run 'wsl.exe --shutdown' in Windows."
}

handle_missing_systemd() {
  if ! is_wsl; then
    warn "The systemd user manager is not reachable (systemctl --user failed)."
    say "  Start the server manually: $(command -v node) $CURRENT_LINK/apps/server/dist/index.js"
    say "  and the tmux server: tmux -L paneful-manager -f $STATE_DIR/tmux.conf start-server"
    return 0
  fi
  info "systemd is not running in this WSL distro"
  if wsl_conf_has_systemd; then
    say "  $WSL_CONF already enables systemd, but WSL has not been restarted since."
  elif [ "$NO_WSL_CONF" -eq 1 ]; then
    say "  Enable it yourself: add '[boot]' and 'systemd=true' to $WSL_CONF."
  else
    enable_wsl_systemd || true
  fi
  say ""
  say "Next steps:"
  say "  1. In Windows PowerShell run:  wsl.exe --shutdown"
  say "  2. Open the distro again and re-run this installer (same options)."
  exit 0
}

# ---------- preflight ----------

check_requirements() {
  info "Checking requirements"
  if is_macos; then
    say "  macOS detected"
    hint_node="brew install node, or https://nodejs.org"
    hint_tmux="brew install tmux"
  else
    if is_wsl; then
      say "  WSL detected"
    else
      say "  Linux detected (not WSL)"
    fi
    hint_node="https://nodejs.org (or your distribution's nodejs $MIN_NODE_MAJOR package)"
    hint_tmux="sudo apt-get install -y tmux"
  fi
  command -v node >/dev/null 2>&1 || die "Node.js $MIN_NODE_MAJOR or later is required: $hint_node"
  NODE_BIN=$(command -v node)
  TARGET=$(release_target)
  node_version=$(node -p 'process.versions.node')
  version_ge "$node_version" "$MIN_NODE_MAJOR" || die "Node.js $MIN_NODE_MAJOR or later is required, found $node_version: $hint_node"
  say "  node $node_version ($NODE_BIN), release target ${TARGET:-none (node-pty is compiled on install)}"

  command -v tmux >/dev/null 2>&1 || die "tmux $MIN_TMUX_VERSION or later is required: $hint_tmux"
  TMUX_BIN=$(command -v tmux)
  tmux_raw=$(tmux -V 2>/dev/null || true)
  tmux_version=$(printf '%s' "$tmux_raw" | sed 's/^[^0-9]*\([0-9][0-9.]*\).*/\1/')
  case "$tmux_version" in
    ''|*[!0-9.]*) die "Cannot read the tmux version from 'tmux -V' (got '$tmux_raw'); tmux $MIN_TMUX_VERSION or later is required" ;;
  esac
  version_ge "$tmux_version" "$MIN_TMUX_VERSION" ||
    die "tmux $MIN_TMUX_VERSION or later is required, found $tmux_version: $hint_tmux (Ubuntu 22.04+ ships a recent enough tmux)"
  say "  tmux $tmux_version"

  if command -v git >/dev/null 2>&1; then
    say "  git found"
  elif is_macos; then
    warn "git not found: worktree scopes will not be discovered (xcode-select --install, or brew install git)"
  else
    warn "git not found: worktree scopes will not be discovered"
  fi
  if command -v claude >/dev/null 2>&1; then
    say "  claude found"
  else
    warn "Claude Code CLI (claude) not found: sessions will fail to start until it is installed (https://docs.claude.com/en/docs/claude-code)"
  fi
  for tool in tar gzip; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
}

# Prints the release target (linux-x64, linux-arm64, darwin-x64, darwin-arm64): uname -s for the system, the arch of the
# installed node for the CPU (the bundled node-pty must match node, which differs from uname -m under Rosetta).
# Prints nothing when no release asset is built for it; the generic tarball is then compiled on install.
release_target() {
  case "$OS_NAME" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
  esac
  arch=$(node -p 'process.arch' 2>/dev/null || uname -m)
  case "$arch" in
    x64|x86_64|amd64) printf '%s-x64' "$os" ;;
    arm64|aarch64) printf '%s-arm64' "$os" ;;
  esac
}

# Only needed when the release's prebuilt node-pty does not load on this machine.
ensure_build_tools() {
  if is_macos; then
    missing=""
    for tool in make c++ python3; do
      command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
    done
    [ -z "$missing" ] || die "Missing build tools for node-pty:$missing. Install the Xcode Command Line Tools first: xcode-select --install"
    say "  build tools found (make, c++, python3)"
    return 0
  fi
  missing=""
  for tool in make g++ python3; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  if [ -n "$missing" ]; then
    say "  Missing build tools for node-pty:$missing"
    apt_cmd="sudo apt-get update && sudo apt-get install -y build-essential python3"
    if { [ "$YES" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; } && command -v apt-get >/dev/null 2>&1; then
      run sudo apt-get update
      run sudo apt-get install -y build-essential python3
    else
      die "Install them first: $apt_cmd (or re-run with --yes)"
    fi
  else
    say "  build tools found (make, g++, python3)"
  fi
}

# Makes pnpm available, via corepack with the version pinned in <release>/package.json.
ensure_pnpm() {
  pinned=$(node -p 'const p = require(process.argv[1]).packageManager || ""; p.startsWith("pnpm@") ? p.slice(5) : ""' "$1/package.json")
  if command -v pnpm >/dev/null 2>&1; then
    have=$(pnpm --version 2>/dev/null || echo 0)
    if [ -z "$pinned" ] || version_ge "$have" "${pinned%%.*}"; then
      say "  pnpm $have found"
      return 0
    fi
    say "  pnpm $have is older than the required major version ${pinned%%.*}"
  fi
  [ -n "$pinned" ] || die "pnpm not found and package.json pins no pnpm version"
  command -v corepack >/dev/null 2>&1 || die "pnpm $pinned is required and corepack is missing: npm install -g pnpm@$pinned"
  say "  corepack can install pnpm@$pinned into ~/.local/bin"
  confirm "Install pnpm@$pinned with corepack?" y || die "pnpm is required"
  run mkdir -p "$HOME/.local/bin"
  run corepack enable --install-directory "$HOME/.local/bin" pnpm
  run corepack prepare "pnpm@$pinned" --activate
  PATH=$HOME/.local/bin:$PATH
  export PATH
}

# ---------- release fetching ----------

# Falls back to 'gh auth token' when no token came from the environment; true when a token is available.
load_token() {
  if [ -z "$API_TOKEN" ] && command -v gh >/dev/null 2>&1; then
    API_TOKEN=$(gh auth token --hostname github.com 2>/dev/null) || API_TOKEN=""
    TOKEN_SOURCE="gh auth token"
  fi
  [ -n "$API_TOKEN" ] || return 1
  case "$API_TOKEN" in
    *[!A-Za-z0-9_.-]*) die "The token from $TOKEN_SOURCE contains unexpected characters" ;;
  esac
  curl_version=$(curl --version 2>/dev/null | sed -n '1s/^curl \([0-9][0-9.]*\).*/\1/p')
  if [ -z "$curl_version" ] || ! version_ge "$curl_version" "$MIN_CURL_TOKEN_VERSION"; then
    die "curl $MIN_CURL_TOKEN_VERSION or later is required to download with a token (found '${curl_version:-unknown}'); without a token: see 'Private repository' in docs/install.md"
  fi
}

# gh_curl <curl args...>: the token header goes in on stdin, so it never shows up in a process list.
# curl sends a custom Authorization header only to the original host, not to the asset redirect target.
gh_curl() {
  printf 'Authorization: Bearer %s\n' "$API_TOKEN" |
    curl -H @- --proto '=https' --proto-redir '=https' --tlsv1.2 "$@"
}

die_private_hint() {
  printf '%s\n' "Error: $1 (HTTP 404)" \
    "  $PANEFUL_MANAGER_REPO may be private: GitHub answers 404 to anonymous requests for private repositories." \
    "  Set GITHUB_TOKEN to a fine-grained token with read-only Contents access to $PANEFUL_MANAGER_REPO," \
    "  or log in with 'gh auth login', then re-run the installer. Without a token: download the release" \
    "  with 'gh release download' and pass the tarball to --from-source (see docs/install.md)." >&2
  exit 1
}

# Looks the release up through the GitHub API; sets TAG, ASSET (the target's tarball, else the generic one),
# TARBALL_URL and SHA_URL (asset API URLs).
resolve_release_api() {
  if [ "$VERSION" = latest ]; then
    path=releases/latest
  else
    case "$VERSION" in
      ''|*[!A-Za-z0-9._-]*) die "Invalid release tag: '$VERSION'" ;;
    esac
    path=releases/tags/$VERSION
  fi
  info "Looking up the release through the GitHub API (token from $TOKEN_SOURCE)"
  json=$(mktemp)
  code=$(gh_curl -sSL -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
    -o "$json" -w '%{http_code}' "https://api.github.com/repos/$PANEFUL_MANAGER_REPO/$path") || code=000
  case "$code" in
    200) ;;
    401) rm -f "$json"; die "GitHub rejected the token from $TOKEN_SOURCE (HTTP 401): it is invalid or expired" ;;
    403|404)
      rm -f "$json"
      die "No release '$VERSION' found in $PANEFUL_MANAGER_REPO (HTTP $code). The token from $TOKEN_SOURCE needs read access to it (fine-grained: Contents read-only)"
      ;;
    *) rm -f "$json"; die "GitHub API request for $PANEFUL_MANAGER_REPO failed (HTTP $code)" ;;
  esac
  # shellcheck disable=SC2016
  parsed=$(node -e '
    const release = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const tag = String(release.tag_name || "")
    const url = name => String(((release.assets || []).find(a => a.name === name) || {}).url || "")
    const names = (process.argv[2] ? [`paneful-manager-${tag}-${process.argv[2]}.tar.gz`] : []).concat(`paneful-manager-${tag}.tar.gz`)
    const name = names.find(n => url(n)) || names[names.length - 1]
    console.log([tag, name, url(name), url(`${name}.sha256`)].join("\n"))
  ' "$json" "$TARGET") || { rm -f "$json"; die "Cannot read the GitHub API answer for $PANEFUL_MANAGER_REPO"; }
  rm -f "$json"
  TAG=$(printf '%s\n' "$parsed" | sed -n 1p)
  ASSET=$(printf '%s\n' "$parsed" | sed -n 2p)
  TARBALL_URL=$(printf '%s\n' "$parsed" | sed -n 3p)
  SHA_URL=$(printf '%s\n' "$parsed" | sed -n 4p)
  case "$TAG" in
    ''|*[!A-Za-z0-9._-]*) die "Invalid release tag in the GitHub API answer: '$TAG'" ;;
  esac
  case "$ASSET" in
    "paneful-manager-$TAG.tar.gz"|"paneful-manager-$TAG-$TARGET.tar.gz") ;;
    *) die "Unexpected asset name in the GitHub API answer: $ASSET" ;;
  esac
  [ -n "$TARBALL_URL" ] || die "Release '$TAG' of $PANEFUL_MANAGER_REPO has no asset paneful-manager-$TAG.tar.gz"
  for asset_url in "$TARBALL_URL" "$SHA_URL"; do
    case "$asset_url" in
      ''|https://api.github.com/repos/*/*/releases/assets/[0-9]*) ;;
      *) die "Unexpected asset URL in the GitHub API answer: $asset_url" ;;
    esac
    case "${asset_url##*/}" in *[!0-9]*) die "Unexpected asset URL in the GitHub API answer: $asset_url" ;; esac
  done
}

resolve_tag() {
  if [ -n "$FROM_SOURCE" ]; then
    if [ -d "$FROM_SOURCE" ]; then
      [ -f "$FROM_SOURCE/package.json" ] || die "$FROM_SOURCE has no package.json"
      TAG="v$(node -p 'require(process.argv[1]).version' "$FROM_SOURCE/package.json")"
    elif [ -f "$FROM_SOURCE" ]; then
      base=$(basename "$FROM_SOURCE")
      TAG=${base#paneful-manager-}
      TAG=${TAG%.tar.gz}
      [ "$TAG" != "$base" ] || die "Tarball name must be paneful-manager-<tag>[-<target>].tar.gz"
      for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
        TAG=${TAG%-"$target"}
      done
    else
      die "--from-source path not found: $FROM_SOURCE"
    fi
  elif ! command -v curl >/dev/null 2>&1; then
    die "curl is required"
  elif load_token; then
    resolve_release_api
  elif [ "$VERSION" = latest ]; then
    out=$(curl -sSLI --proto '=https' --tlsv1.2 -o /dev/null -w '%{http_code} %{url_effective}' "https://github.com/$PANEFUL_MANAGER_REPO/releases/latest") ||
      die "Cannot resolve the latest release of $PANEFUL_MANAGER_REPO"
    code=${out%% *}
    [ "$code" != 404 ] || die_private_hint "Cannot resolve the latest release of $PANEFUL_MANAGER_REPO"
    [ "$code" = 200 ] || die "Cannot resolve the latest release of $PANEFUL_MANAGER_REPO (HTTP $code)"
    url=${out#* }
    TAG=${url##*/}
  else
    TAG=$VERSION
  fi
  case "$TAG" in
    ''|latest|releases|*[!A-Za-z0-9._-]*) die "Invalid release tag: '$TAG' (does $PANEFUL_MANAGER_REPO have a published release?)" ;;
  esac
}

# anonymous_download <url> <file>: prints the HTTP status.
anonymous_download() {
  curl -SL --proto '=https' --tlsv1.2 -o "$2" -w '%{http_code}' "$1" || die "Download failed: $1"
}

# fetch_tarball <dir>: leaves the release tarball in <dir> and names it in ASSET; downloads need a .sha256 unless --no-verify.
# Downloads take the target's tarball (prebuilt node-pty) and fall back to the generic one, which compiles node-pty.
fetch_tarball() {
  if [ -d "$FROM_SOURCE" ]; then
    [ -f "$FROM_SOURCE/scripts/release-pack.sh" ] || die "$FROM_SOURCE is not a Paneful Manager source checkout"
    if [ ! -f "$FROM_SOURCE/apps/server/dist/index.js" ] || [ ! -f "$FROM_SOURCE/apps/web/dist/index.html" ]; then
      die "$FROM_SOURCE is not built: run 'pnpm install && pnpm build' there first"
    fi
    sh "$FROM_SOURCE/scripts/release-pack.sh" --skip-build --tag "$TAG" --out "$1" >/dev/null
    for packed in "$1"/paneful-manager-*.tar.gz; do ASSET=$(basename "$packed"); done
  elif [ -n "$FROM_SOURCE" ]; then
    ASSET=$(basename "$FROM_SOURCE")
    cp "$FROM_SOURCE" "$1/$ASSET"
    [ ! -f "$FROM_SOURCE.sha256" ] || cp "$FROM_SOURCE.sha256" "$1/$ASSET.sha256"
  elif [ -n "$API_TOKEN" ]; then
    say "  Downloading $ASSET through the GitHub API"
    gh_curl -fSL -H 'Accept: application/octet-stream' -o "$1/$ASSET" "$TARBALL_URL" || die "Download failed: $ASSET"
    if [ -n "$SHA_URL" ]; then
      gh_curl -fsSL -H 'Accept: application/octet-stream' -o "$1/$ASSET.sha256" "$SHA_URL" 2>/dev/null || rm -f "$1/$ASSET.sha256"
    fi
  else
    base="https://github.com/$PANEFUL_MANAGER_REPO/releases/download/$TAG"
    code=404
    if [ -n "$TARGET" ]; then
      ASSET="paneful-manager-$TAG-$TARGET.tar.gz"
      say "  Downloading $base/$ASSET"
      code=$(anonymous_download "$base/$ASSET" "$1/$ASSET")
      [ "$code" != 404 ] || say "  No $TARGET build in $TAG; using the generic tarball (node-pty is compiled)"
    fi
    if [ "$code" = 404 ]; then
      ASSET="paneful-manager-$TAG.tar.gz"
      say "  Downloading $base/$ASSET"
      code=$(anonymous_download "$base/$ASSET" "$1/$ASSET")
    fi
    [ "$code" != 404 ] || die_private_hint "Download failed: $base/$ASSET"
    [ "$code" = 200 ] || die "Download failed: $base/$ASSET (HTTP $code)"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$1/$ASSET.sha256" "$base/$ASSET.sha256" 2>/dev/null || rm -f "$1/$ASSET.sha256"
  fi
  if [ -f "$1/$ASSET.sha256" ]; then
    expected=$(awk '{ print $1; exit }' "$1/$ASSET.sha256")
    actual=$(sha256_of "$1/$ASSET")
    [ "$expected" = "$actual" ] || die "Checksum mismatch for $ASSET (expected $expected, got $actual)"
    say "  sha256 verified"
  elif [ -z "$FROM_SOURCE" ] && [ "$NO_VERIFY" -eq 0 ]; then
    die "The release publishes no $ASSET.sha256; refusing to install unverified (pass --no-verify to override)"
  else
    warn "No .sha256 file for $ASSET; skipping checksum verification"
  fi
}

# ---------- rendering ----------

# True when the kernel has the IPv6 loopback address; without it nobody can bind [::1] and the socket unit skips it.
ipv6_loopback_available() {
  grep -q '^00000000000000000000000000000001 ' "$IF_INET6" 2>/dev/null
}

# render_unit <template> <out> [plist]: replaces @KEY@ placeholders. In units PATH and LANG are escaped for quoted
# Environment= lines; in a launchd plist every value is XML-escaped.
render_unit() {
  if ipv6_loopback_available; then
    listen_ipv6="ListenStream=[::1]:$EFFECTIVE_PORT"
  else
    listen_ipv6="# [::1] is not available on this machine, so nobody can listen there"
  fi
  R_REPO=$PANEFUL_MANAGER_REPO R_PORT=$EFFECTIVE_PORT R_PREFIX=$PREFIX R_NODE=$NODE_BIN R_TMUX=$TMUX_BIN \
    R_STATE_DIR=$STATE_DIR R_CONFIG_HOME=$CONFIG_HOME R_STATE_HOME=$STATE_HOME R_LOG_DIR=$LOG_DIR \
    R_PATH=$PATH R_LANG=${LANG:-C.UTF-8} R_LISTEN_IPV6=$listen_ipv6 \
    node -e '
      const fs = require("fs")
      const plist = process.argv[3] === "plist"
      const quoted = v => v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")
      const xml = v => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      const keys = ["REPO", "PORT", "PREFIX", "NODE", "TMUX", "STATE_DIR", "CONFIG_HOME", "STATE_HOME", "LOG_DIR", "PATH", "LANG", "LISTEN_IPV6"]
      let text = fs.readFileSync(process.argv[1], "utf8")
      for (const key of keys) {
        const value = process.env["R_" + key]
        if (/[\r\n]/.test(value)) {
          console.error("Error: " + key + " contains a line break and cannot be written to a unit file")
          process.exit(1)
        }
        const escaped = plist ? xml(value) : key === "PATH" || key === "LANG" ? quoted(value) : value
        text = text.split("@" + key + "@").join(escaped)
      }
      fs.writeFileSync(process.argv[2], text)
    ' "$1" "$2" "${3:-unit}"
}

# ---------- install steps ----------

unit_port() {
  if is_macos; then
    [ -f "$AGENT_DIR/$SERVER_AGENT.plist" ] || return 1
    awk '/<key>PANEFUL_MANAGER_PORT<\/key>/ { getline; gsub(/[^0-9]/, ""); print; exit }' "$AGENT_DIR/$SERVER_AGENT.plist"
    return 0
  fi
  [ -f "$UNIT_DIR/$SERVER_UNIT" ] || return 1
  sed -n 's/^Environment=PANEFUL_MANAGER_PORT=\([0-9][0-9]*\)$/\1/p' "$UNIT_DIR/$SERVER_UNIT" | head -n 1
}

configured_port() {
  [ -f "$CONFIG_FILE" ] || return 1
  sed -n 's/^port:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*\(#.*\)\{0,1\}$/\1/p' "$CONFIG_FILE" | head -n 1
}

install_release() {
  run mkdir -p "$RELEASES_DIR"
  [ "$DRY_RUN" -eq 0 ] || { say "  (dry run) would fetch, extract and install $TAG into $RELEASES_DIR/$TAG"; return 0; }
  [ -f "$MARKER" ] || write_marker "(installing $TAG)"
  work=$(mktemp -d "$RELEASES_DIR/.staging-XXXXXX")
  trap 'rm -rf "$work"' EXIT
  trap 'exit 130' INT TERM
  fetch_tarball "$work"
  mkdir "$work/release"
  tar -xzf "$work/$ASSET" -C "$work/release" --strip-components=1 --no-same-owner
  [ -f "$work/release/apps/server/dist/index.js" ] || die "Release $TAG is missing apps/server/dist/index.js"
  if [ -d "$work/release/node_modules" ] && (cd "$work/release/apps/server" && node -e "require('node-pty')") >/dev/null 2>&1; then
    info "Using the prebuilt production dependencies"
  else
    rm -rf "$work/release/node_modules" "$work/release/apps/server/node_modules" "$work/release/packages/shared/node_modules"
    ensure_build_tools
    ensure_pnpm "$work/release"
    info "Installing production dependencies (compiles node-pty)"
    (cd "$work/release" && CI=true pnpm install --prod --frozen-lockfile --filter '@paneful-manager/server...') ||
      die "pnpm install failed. If node-pty failed to build, see 'node-pty build failure' in docs/install.md"
  fi
  # node-pty 1.1.0 ships its macOS spawn-helper without the executable bit, so every pty spawn would fail.
  find "$work/release/node_modules" -type f -name spawn-helper -path '*node-pty*' -exec chmod 0755 {} + 2>/dev/null || true
  if [ -e "$RELEASES_DIR/$TAG" ]; then
    mv "$RELEASES_DIR/$TAG" "$work/replaced"
  fi
  mv "$work/release" "$RELEASES_DIR/$TAG"
  rm -rf "$work"
  trap - EXIT INT TERM
}

flip_current() {
  old=$(release_tag_of "$CURRENT_LINK" || true)
  if [ -n "$old" ] && [ "$old" != "$TAG" ]; then
    run replace_link "releases/$old" "$PREVIOUS_LINK"
  fi
  run replace_link "releases/$TAG" "$CURRENT_LINK"
}

prune_releases() {
  [ -d "$RELEASES_DIR" ] || return 0
  keep_current=$(release_tag_of "$CURRENT_LINK" || true)
  keep_previous=$(release_tag_of "$PREVIOUS_LINK" || true)
  for dir in "$RELEASES_DIR"/*; do
    [ -d "$dir" ] || continue
    tag=$(basename "$dir")
    [ "$tag" = "$keep_current" ] || [ "$tag" = "$keep_previous" ] || [ "$tag" = "$TAG" ] || run rm -rf "$dir"
  done
  for dir in "$RELEASES_DIR"/.staging-*; do
    [ ! -d "$dir" ] || run rm -rf "$dir"
  done
}

write_marker() {
  [ "$DRY_RUN" -eq 1 ] || printf 'paneful-manager %s\n' "$1" >"$MARKER"
}

write_config() {
  if [ -f "$CONFIG_FILE" ]; then
    if [ -z "$PORT" ] || [ "$(configured_port || true)" = "$PORT" ]; then
      say "  $CONFIG_FILE exists, left unchanged"
      return 0
    fi
    say "  setting port: $PORT in $CONFIG_FILE"
    [ "$DRY_RUN" -eq 0 ] || return 0
    tmp=$(mktemp "$CONFIG_DIR/.config.XXXXXX")
    awk -v port="$PORT" '
      /^port:/ && !done { print "port: " port; done = 1; next }
      { print }
      END { if (!done) print "port: " port }
    ' "$CONFIG_FILE" >"$tmp"
    chmod --reference="$CONFIG_FILE" "$tmp" 2>/dev/null || true
    mv "$tmp" "$CONFIG_FILE"
    CHANGED=1
    return 0
  fi
  run mkdir -p "$CONFIG_DIR"
  say "  writing $CONFIG_FILE (port: $EFFECTIVE_PORT)"
  [ "$DRY_RUN" -eq 1 ] || printf '# Paneful Manager config, see docs/install.md\nport: %s\n' "$EFFECTIVE_PORT" >"$CONFIG_FILE"
  CHANGED=1
}

write_state() {
  if [ ! -d "$STATE_DIR" ]; then
    run mkdir -p "$STATE_DIR"
    CHANGED=1
  fi
  run chmod 0700 "$STATE_DIR"
  if is_macos && [ "$NO_SERVICE" -eq 0 ] && [ ! -d "$LOG_DIR" ]; then run mkdir -p "$LOG_DIR"; fi
  src=$CURRENT_LINK/packaging/tmux.conf
  [ "$DRY_RUN" -eq 0 ] || { say "  (dry run) would write $STATE_DIR/tmux.conf"; return 0; }
  if [ -f "$STATE_DIR/tmux.conf" ] && cmp -s "$src" "$STATE_DIR/tmux.conf"; then
    return 0
  fi
  [ ! -f "$STATE_DIR/tmux.conf" ] || TMUX_CONF_CHANGED=1
  run cp "$src" "$STATE_DIR/tmux.conf"
  CHANGED=1
}

# install_rendered <template> <dest> [plist]: renders and replaces <dest> when it differs; true when it was written.
install_rendered() {
  rendered=$(mktemp)
  render_unit "$1" "$rendered" "${3:-unit}"
  if [ -f "$2" ] && cmp -s "$rendered" "$2"; then
    rm -f "$rendered"
    return 1
  fi
  say "  writing $2"
  tmp=$(mktemp "$(dirname "$2")/.paneful-manager-unit.XXXXXX")
  cat "$rendered" >"$tmp"
  rm -f "$rendered"
  mv "$tmp" "$2"
  chmod 0644 "$2"
}

# Writes the units; sets UNITS_CHANGED when a file differs from what is installed, SOCKET_CHANGED for the socket unit.
write_units() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  (dry run) would write $UNIT_DIR/$TMUX_UNIT, $UNIT_DIR/$SOCKET_UNIT and $UNIT_DIR/$SERVER_UNIT"
    UNITS_CHANGED=1
    SOCKET_CHANGED=1
    return 0
  fi
  mkdir -p "$UNIT_DIR"
  for unit in "$TMUX_UNIT" "$SERVER_UNIT"; do
    if install_rendered "$CURRENT_LINK/packaging/systemd/$unit" "$UNIT_DIR/$unit"; then UNITS_CHANGED=1; fi
  done
  if install_rendered "$CURRENT_LINK/packaging/systemd/$SOCKET_UNIT" "$UNIT_DIR/$SOCKET_UNIT"; then
    UNITS_CHANGED=1
    SOCKET_CHANGED=1
  fi
}

enable_linger() {
  linger=$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null || true)
  [ "$linger" != yes ] || return 0
  say "  Enabling lingering so the user services start at boot and keep running without a login session."
  if ! run loginctl enable-linger "$USER_NAME"; then
    warn "loginctl enable-linger failed; run: sudo loginctl enable-linger $USER_NAME"
  fi
}

start_systemd_services() {
  info "systemd user units"
  SERVICES=1
  SOCKET_CHANGED=0
  write_units
  if [ "$UNITS_CHANGED" -eq 1 ] || [ "$CHANGED" -eq 1 ]; then
    run systemctl --user daemon-reload
    run systemctl --user enable "$TMUX_UNIT" "$SOCKET_UNIT" "$SERVER_UNIT"
    run systemctl --user start "$TMUX_UNIT"
    if [ "$SOCKET_CHANGED" -eq 1 ]; then
      # A new port, or an install from before socket activation: the server lets go of the port before the socket binds it.
      run systemctl --user stop "$SERVER_UNIT"
      run systemctl --user restart "$SOCKET_UNIT"
      run systemctl --user start "$SERVER_UNIT"
    else
      # The socket unit keeps the port bound while the server restarts.
      run systemctl --user restart "$SERVER_UNIT"
    fi
    CHANGED=1
  fi
  enable_linger
  if [ "$TMUX_CONF_CHANGED" -eq 1 ]; then
    say "  tmux.conf changed. It applies after 'systemctl --user restart $TMUX_UNIT' (this ends all running sessions)."
  fi
}

# ---------- launchd (macOS) ----------

launchd_domain() { printf 'gui/%s' "$(id -u)"; }

launchd_loaded() { launchctl print "$(launchd_domain)/$1" >/dev/null 2>&1; }

# launchd_load <label>: (re)loads an agent; bootstrap right after bootout can fail while launchd still tears the job down.
launchd_load() {
  domain=$(launchd_domain)
  if [ "$DRY_RUN" -eq 1 ] || launchd_loaded "$1"; then
    run launchctl bootout "$domain/$1" || true
  fi
  run launchctl enable "$domain/$1" || true
  tries=0
  until run launchctl bootstrap "$domain" "$AGENT_DIR/$1.plist"; do
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] || { warn "launchctl bootstrap $AGENT_DIR/$1.plist failed"; return 1; }
    sleep 1
  done
}

start_launchd_agents() {
  info "launchd user agents"
  SERVICES=1
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  (dry run) would write $AGENT_DIR/$TMUX_AGENT.plist and $AGENT_DIR/$SERVER_AGENT.plist"
    tmux_changed=1
    server_changed=1
  else
    mkdir -p "$AGENT_DIR"
    tmux_changed=0
    server_changed=0
    if install_rendered "$CURRENT_LINK/packaging/launchd/$TMUX_AGENT.plist" "$AGENT_DIR/$TMUX_AGENT.plist" plist; then tmux_changed=1; fi
    if install_rendered "$CURRENT_LINK/packaging/launchd/$SERVER_AGENT.plist" "$AGENT_DIR/$SERVER_AGENT.plist" plist; then server_changed=1; fi
    if ! launchctl print "$(launchd_domain)" >/dev/null 2>&1; then
      warn "No launchd GUI session for this user (an SSH login without a desktop login?): the agents load at your next login."
      SERVICES=0
      return 0
    fi
  fi
  # The tmux agent only starts the daemonized tmux server, so reloading it never ends sessions.
  if [ "$tmux_changed" -eq 1 ] || ! launchd_loaded "$TMUX_AGENT"; then
    launchd_load "$TMUX_AGENT" || true
  fi
  if [ "$server_changed" -eq 1 ] || ! launchd_loaded "$SERVER_AGENT"; then
    launchd_load "$SERVER_AGENT" || true
    CHANGED=1
  elif [ "$CHANGED" -eq 1 ]; then
    run launchctl kickstart -k "$(launchd_domain)/$SERVER_AGENT"
  fi
  if [ "$TMUX_CONF_CHANGED" -eq 1 ]; then
    say "  tmux.conf changed. It applies after 'tmux -L paneful-manager kill-server' and"
    say "  'launchctl kickstart $(launchd_domain)/$TMUX_AGENT' (this ends all running sessions)."
  fi
}

start_services() {
  if is_macos; then start_launchd_agents; else start_systemd_services; fi
}

restart_server() {
  if is_macos; then
    run launchctl kickstart -k "$(launchd_domain)/$SERVER_AGENT"
  else
    run systemctl --user restart "$SERVER_UNIT"
  fi
}

health_check() {
  [ "$DRY_RUN" -eq 0 ] || { say "  (dry run) would check http://127.0.0.1:$EFFECTIVE_PORT/api/health"; return 0; }
  command -v curl >/dev/null 2>&1 || { warn "curl not found, skipping the health check"; return 0; }
  info "Health check"
  waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT_SEC" ]; do
    if curl -fsS --max-time 5 "http://127.0.0.1:$EFFECTIVE_PORT/api/health" >/dev/null 2>&1; then
      say "  Paneful Manager is up: http://127.0.0.1:$EFFECTIVE_PORT/"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  warn "No answer on http://127.0.0.1:$EFFECTIVE_PORT/api/health after ${HEALTH_TIMEOUT_SEC}s"
  if is_macos; then
    say "  Check: launchctl print $(launchd_domain)/$SERVER_AGENT; tail -n 50 $LOG_DIR/server.log"
  else
    say "  Check: systemctl --user status $SERVER_UNIT; journalctl --user -u $SERVER_UNIT -n 50"
  fi
  return 1
}

# print_login_url <port>: writes a one-time login code (10 minutes) to the owner-only state dir; the URL carries it in its fragment.
print_login_url() {
  code=$(od -An -vtx1 -N32 /dev/urandom | tr -d ' \n')
  tmp="$STATE_DIR/.login-code.$$.tmp"
  if ! (umask 077 && mkdir -p "$STATE_DIR" && printf '%s %s\n' "$code" "$(($(date +%s) + 600))" >"$tmp" && mv -f "$tmp" "$STATE_DIR/login-code"); then
    rm -f "$tmp"
    warn "Could not write $STATE_DIR/login-code"
    return 1
  fi
  say "  Open this login URL in the browser you use for Paneful Manager (it works once, within 10 minutes):"
  say "  http://127.0.0.1:$1/#login=$code"
  say "  For another browser, or later, print a new one with: $CURRENT_LINK/install.sh --login-url"
}

do_login_url() {
  port=${PORT:-$(unit_port || configured_port || true)}
  print_login_url "${port:-$DEFAULT_PORT}"
}

do_install() {
  check_requirements
  resolve_tag
  require_plain_path "$PREFIX" "Install prefix"
  require_plain_path "$STATE_DIR" "State directory"
  require_plain_path "$CONFIG_HOME" "XDG_CONFIG_HOME"
  require_plain_path "$NODE_BIN" "node path"
  require_plain_path "$TMUX_BIN" "tmux path"

  if [ -d "$PREFIX" ] && [ ! -f "$MARKER" ] && [ -n "$(ls -A "$PREFIX")" ] && [ "$FORCE" -eq 0 ]; then
    die "$PREFIX is not empty and has no Paneful Manager install marker; choose another --prefix (or pass --force)"
  fi
  existing_port=$(unit_port || configured_port || true)
  EFFECTIVE_PORT=${PORT:-${existing_port:-$DEFAULT_PORT}}

  installed=$(release_tag_of "$CURRENT_LINK" || true)
  NEED_RELEASE=1
  if [ "$installed" = "$TAG" ] && [ -f "$CURRENT_LINK/apps/server/dist/index.js" ] && [ "$FORCE" -eq 0 ]; then
    NEED_RELEASE=0
  fi

  info "Plan"
  if [ "$NEED_RELEASE" -eq 1 ]; then
    if [ -n "$installed" ]; then say "  - upgrade $installed -> $TAG in $PREFIX (keeps $installed for --rollback)"; else say "  - install $TAG into $PREFIX"; fi
  else
    say "  - $TAG is already installed in $PREFIX (use --force to reinstall)"
  fi
  say "  - config $CONFIG_FILE (created if missing; port set when --port is given), state dir $STATE_DIR (0700) with tmux.conf"
  if [ "$NO_SERVICE" -eq 1 ]; then :
  elif is_macos; then
    say "  - launchd agents $TMUX_AGENT + $SERVER_AGENT in $AGENT_DIR, loaded (start at login); logs in $LOG_DIR"
  else
    say "  - user units $TMUX_UNIT + $SOCKET_UNIT + $SERVER_UNIT in $UNIT_DIR, enabled and started; lingering enabled"
  fi
  say "  - port $EFFECTIVE_PORT"
  if legacy=$(legacy_install_dir); then say "  - stop and remove the pre-rename install in $legacy (it may hold the port)"; fi
  if [ "$NEED_RELEASE" -eq 1 ] && [ -z "$FROM_SOURCE" ]; then say "  - source: https://github.com/$PANEFUL_MANAGER_REPO/releases/tag/$TAG"; fi
  if [ "$NEED_RELEASE" -eq 1 ] || [ ! -f "$CONFIG_FILE" ]; then
    confirm "Continue?" y || die "Aborted"
  fi

  CHANGED=0
  SERVICES=0
  UNITS_CHANGED=0
  SOCKET_CHANGED=0
  TMUX_CONF_CHANGED=0
  if [ "$NEED_RELEASE" -eq 1 ]; then
    info "Installing $TAG"
    install_release
    flip_current
    write_marker "$TAG"
    prune_releases
    CHANGED=1
  fi
  info "Config and state"
  write_config
  write_state
  if legacy=$(legacy_install_dir) && confirm "Stop and remove the pre-rename install in $legacy (ends its sessions)?" y; then
    remove_legacy_install
  fi

  if [ "$NO_SERVICE" -eq 0 ]; then
    if [ "$DRY_RUN" -eq 1 ] || is_macos || systemd_user_available; then
      start_services
    else
      handle_missing_systemd
    fi
  fi
  install_windows_task

  if [ "$DRY_RUN" -eq 1 ]; then
    say "Dry run finished: would install Paneful Manager $TAG. Nothing was changed."
  elif [ "$CHANGED" -eq 0 ]; then
    say "Paneful Manager $TAG is already installed and up to date."
  else
    say "Paneful Manager $TAG installed."
  fi
  if [ "$SERVICES" -eq 1 ]; then health_check || exit 1; fi
  if [ "$DRY_RUN" -eq 1 ]; then :
  elif [ "$CHANGED" -eq 1 ]; then print_login_url "$EFFECTIVE_PORT" || true
  else say "  Log a browser in with the URL from: $CURRENT_LINK/install.sh --login-url"
  fi
  if is_wsl; then
    say "Note: WSL stops an idle distro, which ends all sessions. See 'Keeping WSL running' in docs/install.md."
  fi
}

# ---------- rollback ----------

do_rollback() {
  [ -f "$MARKER" ] || die "No Paneful Manager install found in $PREFIX"
  current=$(release_tag_of "$CURRENT_LINK" || true)
  previous=$(release_tag_of "$PREVIOUS_LINK" || true)
  if [ -z "$previous" ] || [ ! -d "$RELEASES_DIR/$previous" ]; then die "No previous release to roll back to"; fi
  info "Rolling back $current -> $previous"
  confirm "Switch to $previous and restart the server?" y || die "Aborted"
  command -v node >/dev/null 2>&1 || die "Node.js is required"
  run replace_link "releases/$previous" "$CURRENT_LINK"
  if [ -n "$current" ]; then
    run replace_link "releases/$current" "$PREVIOUS_LINK"
  fi
  write_marker "$previous"
  if [ "$NO_SERVICE" -eq 0 ] && { [ "$DRY_RUN" -eq 1 ] || is_macos || systemd_user_available; }; then
    restart_server
  fi
  say "Now running $previous."
}

# ---------- uninstall ----------

# Prints the pre-rename agent-hub prefix: a real directory (never a symlink) that holds its install marker.
legacy_install_dir() {
  legacy_dir=$DATA_HOME/agent-hub
  [ -d "$legacy_dir" ] && [ ! -L "$legacy_dir" ] && [ -f "$legacy_dir/.agent-hub-install" ] || return 1
  printf '%s' "$legacy_dir"
}

# Removes a pre-rename agent-hub install (units, logon task and prefix); only when its install marker exists.
remove_legacy_install() {
  legacy_prefix=$(legacy_install_dir) || return 0
  info "Leftover agent-hub install in $legacy_prefix"
  if [ "$DRY_RUN" -eq 1 ] || systemd_user_available; then
    run systemctl --user disable --now agent-hub.service agent-hub-tmux.service || warn "Disabling the old units failed"
  fi
  run rm -f "$UNIT_DIR/agent-hub.service" "$UNIT_DIR/agent-hub-tmux.service"
  if [ "$DRY_RUN" -eq 1 ] || systemd_user_available; then
    run systemctl --user daemon-reload || true
  fi
  run rm -rf "$legacy_prefix/releases"
  run rm -f "$legacy_prefix/current" "$legacy_prefix/previous" "$legacy_prefix/current.tmp" "$legacy_prefix/previous.tmp" \
    "$legacy_prefix/.agent-hub-install"
  remove_windows_task AgentHub-
  [ "$DRY_RUN" -eq 1 ] || rmdir "$legacy_prefix" 2>/dev/null || say "  kept $legacy_prefix (it contains other files)"
}

remove_systemd_units() {
  if [ "$DRY_RUN" -eq 1 ] || systemd_user_available; then
    run systemctl --user disable --now "$SERVER_UNIT" "$SOCKET_UNIT" "$TMUX_UNIT" || warn "Disabling the units failed"
  fi
  for unit in "$SERVER_UNIT" "$SOCKET_UNIT" "$TMUX_UNIT"; do
    if [ -f "$UNIT_DIR/$unit" ] || [ "$DRY_RUN" -eq 1 ]; then run rm -f "$UNIT_DIR/$unit"; fi
  done
  if [ "$DRY_RUN" -eq 1 ] || systemd_user_available; then
    run systemctl --user daemon-reload || true
  fi
}

# The tmux agent abandons its daemonized server, so unloading it does not stop tmux; kill-server does.
remove_launchd_agents() {
  domain=$(launchd_domain)
  for label in "$SERVER_AGENT" "$TMUX_AGENT"; do
    if [ "$DRY_RUN" -eq 1 ] || launchd_loaded "$label"; then
      run launchctl bootout "$domain/$label" || warn "Unloading $label failed"
    fi
  done
  if command -v tmux >/dev/null 2>&1; then
    run tmux -L paneful-manager kill-server 2>/dev/null || true
  fi
  for label in "$SERVER_AGENT" "$TMUX_AGENT"; do
    if [ -f "$AGENT_DIR/$label.plist" ] || [ "$DRY_RUN" -eq 1 ]; then run rm -f "$AGENT_DIR/$label.plist"; fi
  done
}

do_uninstall() {
  if [ -d "$PREFIX" ] && [ ! -f "$MARKER" ] && [ -n "$(ls -A "$PREFIX")" ]; then
    die "$PREFIX has no Paneful Manager install marker ($MARKER); refusing to delete anything"
  fi
  info "Plan"
  if is_macos; then
    say "  - unload the launchd agents $SERVER_AGENT and $TMUX_AGENT, stop the tmux server (ends all running sessions)"
    say "  - remove $AGENT_DIR/$SERVER_AGENT.plist and $AGENT_DIR/$TMUX_AGENT.plist"
  else
    say "  - stop and disable $SERVER_UNIT, $SOCKET_UNIT and $TMUX_UNIT (ends all running Paneful Manager sessions)"
    say "  - remove $UNIT_DIR/$SERVER_UNIT, $UNIT_DIR/$SOCKET_UNIT and $UNIT_DIR/$TMUX_UNIT"
  fi
  say "  - remove releases/, current, previous and the install marker from $PREFIX (and $PREFIX if then empty)"
  say "  - ask whether to remove config ($CONFIG_DIR) and state ($STATE_DIR)"
  if is_wsl && [ "$NO_WINDOWS_TASK" -eq 0 ]; then say "  - remove the Windows logon task if present"; fi
  if legacy=$(legacy_install_dir); then say "  - remove the pre-rename install in $legacy (its units, logon task and releases)"; fi
  confirm "Uninstall Paneful Manager?" n || die "Aborted"

  if is_macos; then
    remove_launchd_agents
  else
    remove_systemd_units
  fi
  if [ -d "$PREFIX" ] && [ ! -f "$MARKER" ]; then
    run rmdir "$PREFIX"
  elif [ -f "$MARKER" ]; then
    run rm -rf "$RELEASES_DIR"
    run rm -f "$CURRENT_LINK" "$PREVIOUS_LINK" "$PREFIX/current.tmp" "$PREFIX/previous.tmp" "$MARKER"
    if [ "$DRY_RUN" -eq 1 ] || rmdir "$PREFIX" 2>/dev/null; then
      say "  removed $PREFIX"
    else
      say "  kept $PREFIX (it contains files Paneful Manager did not install)"
    fi
  fi

  for dir in "$CONFIG_DIR" "$STATE_DIR"; do
    [ -d "$dir" ] || [ "$DRY_RUN" -eq 1 ] || continue
    if [ "$PURGE" -eq 1 ]; then
      run rm -rf "$dir"
    elif [ "$YES" -eq 0 ] && confirm "Remove $dir (config, presets, session state)?" n; then
      run rm -rf "$dir"
    else
      say "  kept $dir"
    fi
  done
  remove_windows_task
  remove_legacy_install

  say "Paneful Manager uninstalled."
  is_macos || say "  Lingering stays enabled (other user services may need it): loginctl disable-linger $USER_NAME"
  if is_wsl && wsl_conf_has_systemd; then
    say "  $WSL_CONF still enables systemd. To revert, remove 'systemd=true' from [boot]"
    say "  (a backup may exist at $WSL_CONF.paneful-manager.bak), then run 'wsl.exe --shutdown' in Windows."
  fi
}

case "$ACTION" in
  install) do_install ;;
  login_url) do_login_url ;;
  rollback) do_rollback ;;
  uninstall) do_uninstall ;;
  enable_wsl_systemd) do_enable_wsl_systemd ;;
esac
