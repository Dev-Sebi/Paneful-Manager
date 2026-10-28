#!/bin/sh
# Agent Hub installer for WSL2 (Linux works too, without the WSL steps).
#   curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | sh
# Run with -h for all options. Docs: docs/install.md
set -eu

AGENT_HUB_REPO=${AGENT_HUB_REPO:-Dev-Sebi/Paneful-Manager}
DEFAULT_PORT=7337
MIN_NODE_MAJOR=22
MIN_TMUX_VERSION=3.2
TMUX_UNIT=agent-hub-tmux.service
SERVER_UNIT=agent-hub.service
HEALTH_TIMEOUT_SEC=20
# Overridable for scripts/test-install.sh only.
WSL_CONF=${AGENT_HUB_WSL_CONF:-/etc/wsl.conf}
PROC_VERSION=${AGENT_HUB_PROC_VERSION:-/proc/version}

VERSION=latest
PREFIX=""
PORT=""
FROM_SOURCE=""
ACTION=install
NO_SYSTEMD=0
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

Installs Agent Hub as systemd user services (agent-hub-tmux.service, agent-hub.service).

Options:
  --version <tag|latest>  Release to install (default: latest)
  --from-source <path>    Install from a local release tarball or a built source checkout
  --prefix <dir>          Install directory (default: ~/.local/share/agent-hub)
  --port <port>           Server port (default: 7337, or the port already installed); saved in config.yaml
  --no-systemd            Do not install or start the systemd user units
  --no-wsl-conf           Never offer to enable systemd in /etc/wsl.conf
  --no-windows-task       Never offer the Windows logon task that boots the distro
  --force                 Reinstall the same version; allow a prefix outside HOME or without install marker
  --no-verify             Install a downloaded release without a published .sha256 file
  --login-url             Print the login URL to open once per browser, then exit
  --rollback              Switch back to the previously installed release
  --uninstall             Remove services, units and the install directory
  --purge                 With --uninstall: also remove config and state without asking
  --dry-run               Print every step without changing anything
  -y, --yes               Answer yes to all questions (needed without a terminal)
  -h, --help              Show this help

Environment:
  AGENT_HUB_REPO          GitHub <owner>/<repo> to download releases from
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

# Paths go into unit files unquoted, so they must not need escaping.
require_plain_path() {
  case "$1" in
    *[!A-Za-z0-9_./+@:,-]*) die "$2 contains characters that cannot be used in a systemd unit: $1" ;;
  esac
}

is_wsl() { grep -qi microsoft "$PROC_VERSION" 2>/dev/null; }

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
    --no-systemd) NO_SYSTEMD=1 ;;
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

[ -n "${HOME:-}" ] || die "HOME is not set"
case "$HOME" in /*) ;; *) die "HOME must be an absolute path" ;; esac
USER_NAME=${USER:-$(id -un)}

CONFIG_HOME=$(xdg_dir "${XDG_CONFIG_HOME:-}" "$HOME/.config")
STATE_HOME=$(xdg_dir "${XDG_STATE_HOME:-}" "$HOME/.local/state")
DATA_HOME=$(xdg_dir "${XDG_DATA_HOME:-}" "$HOME/.local/share")
PREFIX=${PREFIX:-$DATA_HOME/agent-hub}
case "$PREFIX" in /*) ;; *) PREFIX=$(pwd)/$PREFIX ;; esac
command -v realpath >/dev/null 2>&1 || die "realpath (coreutils) is required"
PREFIX=$(realpath -m -- "$PREFIX")
HOME_REAL=$(realpath -m -- "$HOME")
CONFIG_DIR=$CONFIG_HOME/agent-hub
CONFIG_FILE=$CONFIG_DIR/config.yaml
STATE_DIR=$STATE_HOME/agent-hub
UNIT_DIR=$CONFIG_HOME/systemd/user
RELEASES_DIR=$PREFIX/releases
CURRENT_LINK=$PREFIX/current
PREVIOUS_LINK=$PREFIX/previous
MARKER=$PREFIX/.agent-hub-install

case "$PREFIX" in
  /|"$HOME_REAL"|/usr|/usr/*|/etc|/etc/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/var|/boot) die "Refusing to use $PREFIX as install prefix" ;;
  "$HOME_REAL"/*) ;;
  *) [ "$FORCE" -eq 1 ] || die "Refusing to use $PREFIX as install prefix: it is outside $HOME_REAL (pass --force to allow)" ;;
esac
case "$AGENT_HUB_REPO" in
  */*/*|*[!A-Za-z0-9._/-]*|/*|*/) die "AGENT_HUB_REPO must look like <owner>/<repo>" ;;
  */*) ;;
  *) die "AGENT_HUB_REPO must look like <owner>/<repo>" ;;
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

windows_task_name() { printf 'AgentHub-%s' "$1"; }

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
  say "  systemd starts Agent Hub. It runs as your Windows user, no admin rights needed."
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
  ps="$ps Register-ScheduledTask -TaskName '$task' -Description 'Boots the WSL distro $distro for Agent Hub' -Action \$a -Trigger \$t -Settings \$s -Force | Out-Null"
  if ! run powershell.exe -NoProfile -NonInteractive -Command "$ps"; then
    warn "Registering the task failed. See docs/install.md (Windows logon task) for the manual steps."
  fi
}

remove_windows_task() {
  is_wsl || return 0
  distro=$(distro_name) || return 0
  command -v powershell.exe >/dev/null 2>&1 || return 0
  task=$(windows_task_name "$distro")
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

handle_missing_systemd() {
  if ! is_wsl; then
    warn "The systemd user manager is not reachable (systemctl --user failed)."
    say "  Start the server manually: $(command -v node) $CURRENT_LINK/apps/server/dist/index.js"
    say "  and the tmux server: tmux -L agent-hub -f $STATE_DIR/tmux.conf start-server"
    return 0
  fi
  info "systemd is not running in this WSL distro"
  if wsl_conf_has_systemd; then
    say "  $WSL_CONF already enables systemd, but WSL has not been restarted since."
  elif [ "$NO_WSL_CONF" -eq 1 ]; then
    say "  Enable it yourself: add '[boot]' and 'systemd=true' to $WSL_CONF."
  else
    say "  Agent Hub runs as systemd user services. WSL enables systemd with"
    say "  '[boot]' + 'systemd=true' in $WSL_CONF (needs sudo; other settings are kept, a backup is written)."
    if confirm "Enable systemd in $WSL_CONF now?" y; then
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
        run sudo cp -p "$WSL_CONF" "$WSL_CONF.agent-hub.bak"
      fi
      run sudo install -m 0644 "$tmp" "$WSL_CONF"
      rm -f "$tmp"
    else
      say "  Skipped."
    fi
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
  if is_wsl; then
    say "  WSL detected"
  else
    warn "This does not look like WSL. Agent Hub targets WSL2; continuing on plain Linux."
  fi
  command -v node >/dev/null 2>&1 || die "Node.js $MIN_NODE_MAJOR or later is required (https://nodejs.org)"
  NODE_BIN=$(command -v node)
  node_version=$(node -p 'process.versions.node')
  version_ge "$node_version" "$MIN_NODE_MAJOR" || die "Node.js $MIN_NODE_MAJOR or later is required, found $node_version"
  say "  node $node_version ($NODE_BIN)"

  command -v tmux >/dev/null 2>&1 || die "tmux $MIN_TMUX_VERSION or later is required: sudo apt-get install -y tmux"
  TMUX_BIN=$(command -v tmux)
  tmux_raw=$(tmux -V 2>/dev/null || true)
  tmux_version=$(printf '%s' "$tmux_raw" | sed 's/^[^0-9]*\([0-9][0-9.]*\).*/\1/')
  case "$tmux_version" in
    ''|*[!0-9.]*) die "Cannot read the tmux version from 'tmux -V' (got '$tmux_raw'); tmux $MIN_TMUX_VERSION or later is required" ;;
  esac
  version_ge "$tmux_version" "$MIN_TMUX_VERSION" ||
    die "tmux $MIN_TMUX_VERSION or later is required, found $tmux_version (Ubuntu 22.04+ ships a recent enough tmux)"
  say "  tmux $tmux_version"

  if command -v git >/dev/null 2>&1; then say "  git found"; else warn "git not found: worktree scopes will not be discovered"; fi
  if command -v claude >/dev/null 2>&1; then
    say "  claude found"
  else
    warn "Claude Code CLI (claude) not found: sessions will fail to start until it is installed"
  fi
  for tool in tar gzip; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
}

# Only needed when the release's prebuilt node-pty does not load on this machine.
ensure_build_tools() {
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

resolve_tag() {
  if [ -n "$FROM_SOURCE" ]; then
    if [ -d "$FROM_SOURCE" ]; then
      [ -f "$FROM_SOURCE/package.json" ] || die "$FROM_SOURCE has no package.json"
      TAG="v$(node -p 'require(process.argv[1]).version' "$FROM_SOURCE/package.json")"
    elif [ -f "$FROM_SOURCE" ]; then
      base=$(basename "$FROM_SOURCE")
      TAG=${base#agent-hub-}
      TAG=${TAG%.tar.gz}
      [ "$TAG" != "$base" ] || die "Tarball name must be agent-hub-<tag>.tar.gz"
    else
      die "--from-source path not found: $FROM_SOURCE"
    fi
  elif [ "$VERSION" = latest ]; then
    command -v curl >/dev/null 2>&1 || die "curl is required"
    url=$(curl -fsSLI --proto '=https' --tlsv1.2 -o /dev/null -w '%{url_effective}' "https://github.com/$AGENT_HUB_REPO/releases/latest") ||
      die "Cannot resolve the latest release of $AGENT_HUB_REPO"
    TAG=${url##*/}
  else
    TAG=$VERSION
  fi
  case "$TAG" in
    ''|latest|releases|*[!A-Za-z0-9._-]*) die "Invalid release tag: '$TAG' (does $AGENT_HUB_REPO have a published release?)" ;;
  esac
}

# fetch_tarball <dir>: leaves agent-hub-<tag>.tar.gz in <dir>; downloads need a .sha256 unless --no-verify.
fetch_tarball() {
  name="agent-hub-$TAG.tar.gz"
  if [ -d "$FROM_SOURCE" ]; then
    [ -f "$FROM_SOURCE/scripts/release-pack.sh" ] || die "$FROM_SOURCE is not an Agent Hub source checkout"
    if [ ! -f "$FROM_SOURCE/apps/server/dist/index.js" ] || [ ! -f "$FROM_SOURCE/apps/web/dist/index.html" ]; then
      die "$FROM_SOURCE is not built: run 'pnpm install && pnpm build' there first"
    fi
    sh "$FROM_SOURCE/scripts/release-pack.sh" --skip-build --tag "$TAG" --out "$1" >/dev/null
  elif [ -n "$FROM_SOURCE" ]; then
    cp "$FROM_SOURCE" "$1/$name"
    [ ! -f "$FROM_SOURCE.sha256" ] || cp "$FROM_SOURCE.sha256" "$1/$name.sha256"
  else
    base="https://github.com/$AGENT_HUB_REPO/releases/download/$TAG"
    say "  Downloading $base/$name"
    curl -fSL --proto '=https' --tlsv1.2 -o "$1/$name" "$base/$name" || die "Download failed: $base/$name"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$1/$name.sha256" "$base/$name.sha256" 2>/dev/null || rm -f "$1/$name.sha256"
  fi
  if [ -f "$1/$name.sha256" ]; then
    expected=$(awk '{ print $1; exit }' "$1/$name.sha256")
    actual=$(sha256sum "$1/$name" | awk '{ print $1 }')
    [ "$expected" = "$actual" ] || die "Checksum mismatch for $name (expected $expected, got $actual)"
    say "  sha256 verified"
  elif [ -z "$FROM_SOURCE" ] && [ "$NO_VERIFY" -eq 0 ]; then
    die "The release publishes no $name.sha256; refusing to install unverified (pass --no-verify to override)"
  else
    warn "No .sha256 file for $name; skipping checksum verification"
  fi
}

# ---------- rendering ----------

# render <template> <out>: replaces @KEY@ placeholders; PATH and LANG are escaped for quoted Environment= lines.
render_unit() {
  R_REPO=$AGENT_HUB_REPO R_PORT=$EFFECTIVE_PORT R_PREFIX=$PREFIX R_NODE=$NODE_BIN R_TMUX=$TMUX_BIN \
    R_STATE_DIR=$STATE_DIR R_CONFIG_HOME=$CONFIG_HOME R_STATE_HOME=$STATE_HOME \
    R_PATH=$PATH R_LANG=${LANG:-C.UTF-8} \
    node -e '
      const fs = require("fs")
      const quoted = v => v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")
      const keys = ["REPO", "PORT", "PREFIX", "NODE", "TMUX", "STATE_DIR", "CONFIG_HOME", "STATE_HOME", "PATH", "LANG"]
      let text = fs.readFileSync(process.argv[1], "utf8")
      for (const key of keys) {
        const value = process.env["R_" + key]
        if (/[\r\n]/.test(value)) {
          console.error("Error: " + key + " contains a line break and cannot be written to a unit file")
          process.exit(1)
        }
        text = text.split("@" + key + "@").join(key === "PATH" || key === "LANG" ? quoted(value) : value)
      }
      fs.writeFileSync(process.argv[2], text)
    ' "$1" "$2"
}

# ---------- install steps ----------

unit_port() {
  [ -f "$UNIT_DIR/$SERVER_UNIT" ] || return 1
  sed -n 's/^Environment=AGENT_HUB_PORT=\([0-9][0-9]*\)$/\1/p' "$UNIT_DIR/$SERVER_UNIT" | head -n 1
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
  tar -xzf "$work/agent-hub-$TAG.tar.gz" -C "$work/release" --strip-components=1 --no-same-owner
  [ -f "$work/release/apps/server/dist/index.js" ] || die "Release $TAG is missing apps/server/dist/index.js"
  if [ -d "$work/release/node_modules" ] && (cd "$work/release/apps/server" && node -e "require('node-pty')") >/dev/null 2>&1; then
    info "Using the prebuilt production dependencies"
  else
    rm -rf "$work/release/node_modules" "$work/release/apps/server/node_modules" "$work/release/packages/shared/node_modules"
    ensure_build_tools
    ensure_pnpm "$work/release"
    info "Installing production dependencies (compiles node-pty)"
    (cd "$work/release" && CI=true pnpm install --prod --frozen-lockfile --filter '@agent-hub/server...') ||
      die "pnpm install failed. If node-pty failed to build, see 'node-pty build failure' in docs/install.md"
  fi
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
    run ln -sfn "releases/$old" "$PREFIX/previous.tmp"
    run mv -T "$PREFIX/previous.tmp" "$PREVIOUS_LINK"
  fi
  run ln -sfn "releases/$TAG" "$PREFIX/current.tmp"
  run mv -T "$PREFIX/current.tmp" "$CURRENT_LINK"
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
  [ "$DRY_RUN" -eq 1 ] || printf 'agent-hub %s\n' "$1" >"$MARKER"
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
  [ "$DRY_RUN" -eq 1 ] || printf '# Agent Hub config, see docs/install.md\nport: %s\n' "$EFFECTIVE_PORT" >"$CONFIG_FILE"
  CHANGED=1
}

write_state() {
  if [ ! -d "$STATE_DIR" ]; then
    run mkdir -p "$STATE_DIR"
    CHANGED=1
  fi
  run chmod 0700 "$STATE_DIR"
  src=$CURRENT_LINK/packaging/tmux.conf
  [ "$DRY_RUN" -eq 0 ] || { say "  (dry run) would write $STATE_DIR/tmux.conf"; return 0; }
  if [ -f "$STATE_DIR/tmux.conf" ] && cmp -s "$src" "$STATE_DIR/tmux.conf"; then
    return 0
  fi
  [ ! -f "$STATE_DIR/tmux.conf" ] || TMUX_CONF_CHANGED=1
  run cp "$src" "$STATE_DIR/tmux.conf"
  CHANGED=1
}

# Writes both units; sets UNITS_CHANGED when a file differs from what is installed.
write_units() {
  [ "$DRY_RUN" -eq 0 ] || { say "  (dry run) would write $UNIT_DIR/$TMUX_UNIT and $UNIT_DIR/$SERVER_UNIT"; UNITS_CHANGED=1; return 0; }
  mkdir -p "$UNIT_DIR"
  for unit in "$TMUX_UNIT" "$SERVER_UNIT"; do
    rendered=$(mktemp)
    render_unit "$CURRENT_LINK/packaging/systemd/$unit" "$rendered"
    if [ -f "$UNIT_DIR/$unit" ] && cmp -s "$rendered" "$UNIT_DIR/$unit"; then
      rm -f "$rendered"
    else
      say "  writing $UNIT_DIR/$unit"
      tmp=$(mktemp "$UNIT_DIR/.agent-hub-unit.XXXXXX")
      cat "$rendered" >"$tmp"
      rm -f "$rendered"
      mv "$tmp" "$UNIT_DIR/$unit"
      chmod 0644 "$UNIT_DIR/$unit"
      UNITS_CHANGED=1
    fi
  done
}

enable_linger() {
  linger=$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null || true)
  [ "$linger" != yes ] || return 0
  say "  Enabling lingering so the user services start at boot and keep running without a login session."
  if ! run loginctl enable-linger "$USER_NAME"; then
    warn "loginctl enable-linger failed; run: sudo loginctl enable-linger $USER_NAME"
  fi
}

start_services() {
  info "systemd user units"
  SERVICES=1
  write_units
  if [ "$UNITS_CHANGED" -eq 1 ] || [ "$CHANGED" -eq 1 ]; then
    run systemctl --user daemon-reload
    run systemctl --user enable "$TMUX_UNIT" "$SERVER_UNIT"
    run systemctl --user start "$TMUX_UNIT"
    run systemctl --user restart "$SERVER_UNIT"
    CHANGED=1
  fi
  enable_linger
  if [ "$TMUX_CONF_CHANGED" -eq 1 ]; then
    say "  tmux.conf changed. It applies after 'systemctl --user restart $TMUX_UNIT' (this ends all running sessions)."
  fi
}

health_check() {
  [ "$DRY_RUN" -eq 0 ] || { say "  (dry run) would check http://127.0.0.1:$EFFECTIVE_PORT/api/health"; return 0; }
  command -v curl >/dev/null 2>&1 || { warn "curl not found, skipping the health check"; return 0; }
  info "Health check"
  waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT_SEC" ]; do
    if curl -fsS --max-time 5 "http://127.0.0.1:$EFFECTIVE_PORT/api/health" >/dev/null 2>&1; then
      say "  Agent Hub is up: http://127.0.0.1:$EFFECTIVE_PORT/"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  warn "No answer on http://127.0.0.1:$EFFECTIVE_PORT/api/health after ${HEALTH_TIMEOUT_SEC}s"
  say "  Check: systemctl --user status $SERVER_UNIT; journalctl --user -u $SERVER_UNIT -n 50"
  return 1
}

# print_login_url <port>: the URL carries the owner-only access key in its fragment (never sent to the server).
print_login_url() {
  if [ -r "$STATE_DIR/access-key" ]; then
    key=$(tr -d '[:space:]' <"$STATE_DIR/access-key")
    say "  Open this login URL once per browser (it contains your access key, do not share it):"
    say "  http://127.0.0.1:$1/#key=$key"
    return 0
  fi
  say "  No access key yet; the server creates $STATE_DIR/access-key on its first start."
  say "  Then print the login URL with: $CURRENT_LINK/install.sh --login-url"
  return 1
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
    die "$PREFIX is not empty and has no Agent Hub install marker; choose another --prefix (or pass --force)"
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
  if [ "$NO_SYSTEMD" -eq 0 ]; then
    say "  - user units $TMUX_UNIT + $SERVER_UNIT in $UNIT_DIR, enabled and started; lingering enabled"
  fi
  say "  - port $EFFECTIVE_PORT"
  if [ "$NEED_RELEASE" -eq 1 ] && [ -z "$FROM_SOURCE" ]; then say "  - source: https://github.com/$AGENT_HUB_REPO/releases/tag/$TAG"; fi
  if [ "$NEED_RELEASE" -eq 1 ] || [ ! -f "$CONFIG_FILE" ]; then
    confirm "Continue?" y || die "Aborted"
  fi

  CHANGED=0
  SERVICES=0
  UNITS_CHANGED=0
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

  if [ "$NO_SYSTEMD" -eq 0 ]; then
    if [ "$DRY_RUN" -eq 1 ] || systemd_user_available; then
      start_services
    else
      handle_missing_systemd
    fi
  fi
  install_windows_task

  if [ "$DRY_RUN" -eq 1 ]; then
    say "Dry run finished: would install Agent Hub $TAG. Nothing was changed."
  elif [ "$CHANGED" -eq 0 ]; then
    say "Agent Hub $TAG is already installed and up to date."
  else
    say "Agent Hub $TAG installed."
  fi
  if [ "$SERVICES" -eq 1 ]; then health_check || exit 1; fi
  if [ "$DRY_RUN" -eq 0 ]; then print_login_url "$EFFECTIVE_PORT" || true; fi
  if is_wsl; then
    say "Note: WSL stops an idle distro, which ends all sessions. See 'Keeping WSL running' in docs/install.md."
  fi
}

# ---------- rollback ----------

do_rollback() {
  [ -f "$MARKER" ] || die "No Agent Hub install found in $PREFIX"
  current=$(release_tag_of "$CURRENT_LINK" || true)
  previous=$(release_tag_of "$PREVIOUS_LINK" || true)
  if [ -z "$previous" ] || [ ! -d "$RELEASES_DIR/$previous" ]; then die "No previous release to roll back to"; fi
  info "Rolling back $current -> $previous"
  confirm "Switch to $previous and restart $SERVER_UNIT?" y || die "Aborted"
  run ln -sfn "releases/$previous" "$PREFIX/current.tmp"
  run mv -T "$PREFIX/current.tmp" "$CURRENT_LINK"
  if [ -n "$current" ]; then
    run ln -sfn "releases/$current" "$PREFIX/previous.tmp"
    run mv -T "$PREFIX/previous.tmp" "$PREVIOUS_LINK"
  fi
  write_marker "$previous"
  if [ "$NO_SYSTEMD" -eq 0 ] && { [ "$DRY_RUN" -eq 1 ] || systemd_user_available; }; then
    run systemctl --user restart "$SERVER_UNIT"
  fi
  say "Now running $previous."
}

# ---------- uninstall ----------

do_uninstall() {
  if [ -d "$PREFIX" ] && [ ! -f "$MARKER" ] && [ -n "$(ls -A "$PREFIX")" ]; then
    die "$PREFIX has no Agent Hub install marker ($MARKER); refusing to delete anything"
  fi
  info "Plan"
  say "  - stop and disable $SERVER_UNIT and $TMUX_UNIT (ends all running Agent Hub sessions)"
  say "  - remove $UNIT_DIR/$SERVER_UNIT and $UNIT_DIR/$TMUX_UNIT"
  say "  - remove releases/, current, previous and the install marker from $PREFIX (and $PREFIX if then empty)"
  say "  - ask whether to remove config ($CONFIG_DIR) and state ($STATE_DIR)"
  is_wsl && say "  - remove the Windows logon task if present"
  confirm "Uninstall Agent Hub?" n || die "Aborted"

  if [ "$DRY_RUN" -eq 1 ] || systemd_user_available; then
    run systemctl --user disable --now "$SERVER_UNIT" "$TMUX_UNIT" || warn "Disabling the units failed"
  fi
  for unit in "$SERVER_UNIT" "$TMUX_UNIT"; do
    if [ -f "$UNIT_DIR/$unit" ] || [ "$DRY_RUN" -eq 1 ]; then run rm -f "$UNIT_DIR/$unit"; fi
  done
  if [ "$DRY_RUN" -eq 1 ] || systemd_user_available; then
    run systemctl --user daemon-reload || true
  fi
  if [ -d "$PREFIX" ] && [ ! -f "$MARKER" ]; then
    run rmdir "$PREFIX"
  elif [ -f "$MARKER" ]; then
    run rm -rf "$RELEASES_DIR"
    run rm -f "$CURRENT_LINK" "$PREVIOUS_LINK" "$PREFIX/current.tmp" "$PREFIX/previous.tmp" "$MARKER"
    if [ "$DRY_RUN" -eq 1 ] || rmdir "$PREFIX" 2>/dev/null; then
      say "  removed $PREFIX"
    else
      say "  kept $PREFIX (it contains files Agent Hub did not install)"
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

  say "Agent Hub uninstalled."
  say "  Lingering stays enabled (other user services may need it): loginctl disable-linger $USER_NAME"
  if is_wsl && wsl_conf_has_systemd; then
    say "  $WSL_CONF still enables systemd. To revert, remove 'systemd=true' from [boot]"
    say "  (a backup may exist at $WSL_CONF.agent-hub.bak), then run 'wsl.exe --shutdown' in Windows."
  fi
}

case "$ACTION" in
  install) do_install ;;
  login_url) do_login_url ;;
  rollback) do_rollback ;;
  uninstall) do_uninstall ;;
esac
