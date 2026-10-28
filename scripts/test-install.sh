#!/bin/sh
# Smoke test for install.sh: installs from a locally packed tarball into a temp HOME.
# systemctl, loginctl, launchctl, sudo, powershell.exe, gh and curl are stubs that only log, so the real system is never touched.
# The macOS part stubs uname (Darwin) and tmux (except -V), so no real tmux server is ever stopped.
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT INT TERM
FAILS=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf 'ok   %s\n' "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILS=$((FAILS + 1)); printf 'FAIL %s\n' "$1"; }
check() {
  name=$1
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}
contains() { grep -q -- "$2" "$1"; }
not_contains() { ! grep -q -- "$2" "$1"; }

# ---------- sandbox ----------

REAL_HOME=$HOME
export HOME="$T/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_DATA_HOME="$HOME/.local/share"
export USER=tester
export WSL_DISTRO_NAME=TestDistro
export PANEFUL_MANAGER_WSL_CONF="$T/wsl.conf"
export PANEFUL_MANAGER_PROC_VERSION="$T/proc-version"
export PANEFUL_MANAGER_IF_INET6="$T/if_inet6"
export STUB_LOG="$T/calls.log"
export STUB_DIR="$T/stub-state"
export TMPDIR="$T/tmp"
unset GITHUB_TOKEN GH_TOKEN
mkdir -p "$HOME" "$T/bin" "$STUB_DIR" "$TMPDIR"
: >"$STUB_LOG"
echo "Linux version 6.0 (generic)" >"$PANEFUL_MANAGER_PROC_VERSION"
echo "00000000000000000000000000000001 01 80 10 80       lo" >"$PANEFUL_MANAGER_IF_INET6"

cat >"$T/bin/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >>"$STUB_LOG"
[ ! -f "$STUB_DIR/token" ] || ! env | grep -qF -- "$(cat "$STUB_DIR/token")" || echo "${0##*/} saw a token in its environment" >>"$STUB_LOG"
if [ "$2" = show-environment ] && [ -f "$STUB_DIR/no-systemd" ]; then exit 1; fi
exit 0
EOF
cat >"$T/bin/loginctl" <<'EOF'
#!/bin/sh
echo "loginctl $*" >>"$STUB_LOG"
[ "$1" != show-user ] || echo no
EOF
cat >"$T/bin/sudo" <<'EOF'
#!/bin/sh
echo "sudo $*" >>"$STUB_LOG"
exec "$@"
EOF
# Serves release files by URL basename and GitHub API answers from $STUB_DIR/api; health checks always succeed.
# 'curl --version' reports $STUB_DIR/curl-version (default 8.5.0). Stubs log when the token value is in their environment.
# The API needs 'Authorization: Bearer <$STUB_DIR/token>' on stdin (-H @-); headers read there go to headers.log.
cat >"$T/bin/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >>"$STUB_LOG"
[ -z "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ] || echo "curl saw a token in its environment" >>"$STUB_LOG"
[ ! -f "$STUB_DIR/token" ] || ! env | grep -qF -- "$(cat "$STUB_DIR/token")" || echo "${0##*/} saw a token in its environment" >>"$STUB_LOG"
if [ "${1:-}" = --version ]; then
  echo "curl $(cat "$STUB_DIR/curl-version" 2>/dev/null || echo 8.5.0) (x86_64-pc-linux-gnu)"
  exit 0
fi
out=""
url=""
write=""
fail=0
stdin_headers=0
accept=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -w) write=$2; shift ;;
    -H)
      case "$2" in @-) stdin_headers=1 ;; Accept:*) accept=$2 ;; esac
      shift
      ;;
    --proto|--proto-redir|--max-time) shift ;;
    --*) ;;
    -*f*) fail=1 ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
auth=""
if [ "$stdin_headers" -eq 1 ]; then
  auth=$(cat)
  printf '%s\n' "$auth" >>"$STUB_DIR/headers.log"
fi
code=200
effective=$url
file=""
case "$url" in
  */api/health) ;;
  https://api.github.com/*)
    if [ ! -f "$STUB_DIR/token" ] || [ "$auth" != "Authorization: Bearer $(cat "$STUB_DIR/token")" ]; then
      code=404
    else
      case "$url" in
        */releases/latest) file=$STUB_DIR/api/latest.json ;;
        */releases/tags/*) file=$STUB_DIR/api/tag-${url##*/}.json ;;
        */releases/assets/*) [ "$accept" != "Accept: application/octet-stream" ] || file=$STUB_DIR/api/asset-${url##*/} ;;
      esac
      [ -n "$file" ] || code=415
    fi
    ;;
  */releases/latest)
    if [ -f "$STUB_DIR/private" ]; then code=404; else effective=$(cat "$STUB_DIR/latest-url"); fi
    ;;
  *)
    if [ -f "$STUB_DIR/private" ]; then code=404; else file=$STUB_DIR/release/${url##*/}; fi
    ;;
esac
[ -z "$file" ] || [ -f "$file" ] || code=404
if [ "$code" = 200 ] && [ -n "$file" ] && [ -n "$out" ] && [ "$out" != /dev/null ]; then cp "$file" "$out"; fi
[ -z "$write" ] || printf '%s' "$write" | sed "s|%{http_code}|$code|g; s|%{url_effective}|$effective|g"
if [ "$code" != 200 ] && [ "$fail" -eq 1 ]; then exit 22; fi
exit 0
EOF
# 'gh auth token' prints $STUB_DIR/gh-token when it exists, like a logged-in gh.
cat >"$T/bin/gh" <<'EOF'
#!/bin/sh
echo "gh $*" >>"$STUB_LOG"
[ ! -f "$STUB_DIR/token" ] || ! env | grep -qF -- "$(cat "$STUB_DIR/token")" || echo "${0##*/} saw a token in its environment" >>"$STUB_LOG"
[ "$1 $2" = "auth token" ] && [ -f "$STUB_DIR/gh-token" ] && cat "$STUB_DIR/gh-token"
EOF
cat >"$T/bin/powershell.exe" <<'EOF'
#!/bin/sh
echo "powershell.exe $*" >>"$STUB_LOG"
task="$STUB_DIR/task-$(printf '%s' "$*" | sed -n "s/.*-TaskName '\\([^']*\\)'.*/\\1/p")"
case "$*" in
  *Unregister-ScheduledTask*) rm -f "$task" ;;
  *Register-ScheduledTask*) touch "$task" ;;
  *Get-ScheduledTask*) [ -f "$task" ] ;;
esac
EOF
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

PREFIX="$XDG_DATA_HOME/paneful-manager"
CONFIG="$XDG_CONFIG_HOME/paneful-manager/config.yaml"
STATE="$XDG_STATE_HOME/paneful-manager"
UNITS="$XDG_CONFIG_HOME/systemd/user"
OUT="$T/out.log"

# Runs the installer without a terminal and expects it to fail.
install_sh_fails() {
  : >"$STUB_LOG"
  if setsid sh "$ROOT/install.sh" "$@" >"$OUT" 2>&1 </dev/null; then
    fail "install.sh $* should fail"
    sed 's/^/    /' "$OUT"
  else
    pass "install.sh $* fails"
  fi
}

# Runs the installer; a non-zero exit is recorded as a failure instead of aborting the suite.
install_sh() {
  : >"$STUB_LOG"
  if sh "$ROOT/install.sh" "$@" >"$OUT" 2>&1; then
    pass "install.sh $*"
  else
    fail "install.sh $* (exit $?)"
    sed 's/^/    /' "$OUT"
  fi
}

# ---------- packages ----------

if [ ! -f "$ROOT/apps/server/dist/index.js" ] || [ ! -f "$ROOT/apps/web/dist/index.html" ]; then
  echo "Build first: pnpm build" >&2
  exit 1
fi
# Packs with the real HOME, so pnpm uses its usual store instead of writing into the sandbox.
pack() {
  env -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_DATA_HOME HOME="$REAL_HOME" \
    sh "$ROOT/scripts/release-pack.sh" --skip-build --out "$T/pkg" "$@" >/dev/null
}
HOST_TARGET=$(node -p 'process.platform + "-" + process.arch')
pack --tag v1.0.0
pack --tag v1.1.0
V1="$T/pkg/paneful-manager-v1.0.0-$HOST_TARGET.tar.gz"
V2="$T/pkg/paneful-manager-v1.1.0-$HOST_TARGET.tar.gz"
check "release-pack names the tarball after the target" test -f "$V1" -a -f "$V1.sha256"

# ---------- dry run ----------

install_sh --dry-run --yes --from-source "$V1"
check "dry run changes nothing in HOME" test -z "$(find "$HOME" -mindepth 1 -print -quit)"
check "dry run prints the systemctl steps" contains "$OUT" "systemctl --user enable"
check "dry run never calls systemctl" not_contains "$STUB_LOG" "systemctl --user enable"
check "dry run says it would install" contains "$OUT" "would install Paneful Manager v1.0.0"

# ---------- prefix safety ----------

install_sh_fails --yes --from-source "$V1" --prefix "$HOME"
check "HOME as prefix refused" contains "$OUT" "Refusing to use"
install_sh_fails --yes --uninstall --prefix "/$HOME"
check "//HOME is normalized and refused" contains "$OUT" "Refusing to use $HOME as install prefix"
install_sh_fails --yes --from-source "$V1" --prefix "$T/outside"
check "prefix outside HOME refused" contains "$OUT" "outside"
mkdir -p "$HOME/notours"
echo keep >"$HOME/notours/data.txt"
install_sh_fails --yes --uninstall --prefix "$HOME/notours"
check "uninstall without marker refused" contains "$OUT" "no Paneful Manager install marker"
check "uninstall without marker deletes nothing" test -f "$HOME/notours/data.txt"
install_sh_fails --yes --from-source "$V1" --prefix "$HOME/notours"
check "install into a foreign non-empty dir refused" test ! -e "$HOME/notours/releases"
rm -rf "$HOME/notours"

# ---------- fresh install ----------

LEGACY="$XDG_DATA_HOME/agent-hub"
mkdir -p "$LEGACY/releases/v0" "$XDG_CONFIG_HOME/systemd/user"
: >"$LEGACY/.agent-hub-install"
: >"$XDG_CONFIG_HOME/systemd/user/agent-hub.service"
install_sh --yes --from-source "$V1" --no-windows-task
check "install names the leftover agent-hub install in its plan" contains "$OUT" "remove the pre-rename install in $LEGACY"
check "install stops the leftover agent-hub units" contains "$STUB_LOG" "systemctl --user disable --now agent-hub.service agent-hub-tmux.service"
check "install removes the leftover agent-hub prefix" test ! -e "$LEGACY"
check "install removes the leftover agent-hub unit" test ! -e "$XDG_CONFIG_HOME/systemd/user/agent-hub.service"
check "release extracted" test -f "$PREFIX/releases/v1.0.0/apps/server/dist/index.js"
check "web build shipped" test -f "$PREFIX/releases/v1.0.0/apps/web/dist/index.html"
check "node-pty installed" test -d "$PREFIX/releases/v1.0.0/apps/server/node_modules/node-pty"
check "prebuilt dependencies used" contains "$OUT" "Using the prebuilt production dependencies"
check "current symlink points at the release" test "$(readlink "$PREFIX/current")" = releases/v1.0.0
check "install marker written" contains "$PREFIX/.paneful-manager-install" "v1.0.0"
check "config written with the default port" contains "$CONFIG" "^port: 7337$"
check "state dir is 0700" test "$(stat -c %a "$STATE")" = 700
check "tmux.conf installed" cmp -s "$STATE/tmux.conf" "$ROOT/packaging/tmux.conf"
check "server unit written" test -f "$UNITS/paneful-manager.service"
check "tmux unit written" test -f "$UNITS/paneful-manager-tmux.service"
check "socket unit written" test -f "$UNITS/paneful-manager.socket"
check "socket holds 127.0.0.1" contains "$UNITS/paneful-manager.socket" "^ListenStream=127.0.0.1:7337$"
check "socket holds [::1]" contains "$UNITS/paneful-manager.socket" "^ListenStream=\[::1\]:7337$"
check "socket unit has no placeholders" not_contains "$UNITS/paneful-manager.socket" "@[A-Z_]*@"
check "server requires the socket" contains "$UNITS/paneful-manager.service" "^Requires=paneful-manager.socket$"
check "server starts after the socket" contains "$UNITS/paneful-manager.service" "^After=.*paneful-manager.socket"
check "no placeholders left" not_contains "$UNITS/paneful-manager.service" "@[A-Z_]*@"
check "unit quotes PATH" contains "$UNITS/paneful-manager.service" '^Environment="PATH=/'
check "unit pins the port" contains "$UNITS/paneful-manager.service" "PANEFUL_MANAGER_PORT=7337"
check "unit runs the current release" contains "$UNITS/paneful-manager.service" "$PREFIX/current/apps/server/dist/index.js"
check "tmux unit uses the state dir" contains "$UNITS/paneful-manager-tmux.service" "-f $STATE/tmux.conf start-server"
check "daemon-reload called" contains "$STUB_LOG" "systemctl --user daemon-reload"
check "units enabled" contains "$STUB_LOG" "systemctl --user enable paneful-manager-tmux.service paneful-manager.socket paneful-manager.service"
check "server stopped before the socket binds" test "$(grep -n 'stop paneful-manager.service\|restart paneful-manager.socket\|start paneful-manager.service' "$STUB_LOG" | cut -d: -f2 | tr '\n' ' ')" = \
  "systemctl --user stop paneful-manager.service systemctl --user restart paneful-manager.socket systemctl --user start paneful-manager.service "
check "linger enabled" contains "$STUB_LOG" "loginctl enable-linger tester"
check "health check called" contains "$STUB_LOG" "curl -fsS --max-time 5 http://127.0.0.1:7337/api/health"
check "plain Linux is named" contains "$OUT" "Linux detected (not WSL)"
check "release target named" contains "$OUT" "release target $HOST_TARGET"
check "install explains where the login URL comes from" contains "$OUT" "install.sh --login-url"
check "install wrote a one-time login code" test -f "$STATE/login-code"
install_sh --login-url
code=$(cut -d' ' -f1 "$STATE/login-code")
check "--login-url prints a URL with a new one-time code and the port" contains "$OUT" "^  http://127.0.0.1:7337/#login=$code$"
check "login code is 64 hex characters" test "${#code}" -eq 64
check "login code file is 0600" test "$(stat -c %a "$STATE/login-code")" = 600
check "login code expires in 10 minutes" test "$(cut -d' ' -f2 "$STATE/login-code")" -gt "$(($(date +%s) + 590))"
check "--login-url never prints the access key" not_contains "$OUT" "#key="
rm -f "$STATE/login-code"

# ---------- re-run is a no-op ----------

touch "$T/marker"
sleep 1
install_sh --yes --from-source "$V1" --no-windows-task
check "re-run reports up to date" contains "$OUT" "already installed and up to date"
check "re-run changes no files" test -z "$(find "$PREFIX" "$XDG_CONFIG_HOME" "$STATE" -newer "$T/marker" -print -quit)"
check "re-run does not restart services" not_contains "$STUB_LOG" "systemctl --user restart"

# ---------- config written once, --port persists ----------

printf 'theme: light\nport: 7400\n' >"$CONFIG"
mkdir -p "$PREFIX/releases/.staging-stale"
install_sh --yes --force --from-source "$V1" --no-windows-task
check "existing config kept" contains "$CONFIG" "^port: 7400$"
check "re-run keeps the installed unit port" contains "$UNITS/paneful-manager.service" "PANEFUL_MANAGER_PORT=7337"
check "stale staging dirs pruned" test ! -e "$PREFIX/releases/.staging-stale"
install_sh --yes --port 7500 --from-source "$V1" --no-windows-task
check "--port updates the unit without --force" contains "$UNITS/paneful-manager.service" "PANEFUL_MANAGER_PORT=7500"
check "--port rebinds the socket" contains "$STUB_LOG" "systemctl --user restart paneful-manager.socket"
check "--port moves the socket" contains "$UNITS/paneful-manager.socket" "^ListenStream=127.0.0.1:7500$"
check "--port is saved in config.yaml" contains "$CONFIG" "^port: 7500$"
check "--port keeps other config keys" contains "$CONFIG" "^theme: light$"
install_sh --yes --from-source "$V1" --no-windows-task
check "re-run without --port keeps 7500" contains "$UNITS/paneful-manager.service" "PANEFUL_MANAGER_PORT=7500"
check "health check uses the kept port" contains "$STUB_LOG" "127.0.0.1:7500/api/health"

# ---------- upgrade and rollback ----------

install_sh --yes --from-source "$V2" --no-windows-task
check "upgrade flips current" test "$(readlink "$PREFIX/current")" = releases/v1.1.0
check "upgrade keeps previous" test "$(readlink "$PREFIX/previous")" = releases/v1.0.0
check "upgrade restarts the server" contains "$STUB_LOG" "systemctl --user restart paneful-manager.service"
check "upgrade keeps the socket bound" not_contains "$STUB_LOG" "stop paneful-manager.socket\|restart paneful-manager.socket"
check "upgrade keeps the tmux server" not_contains "$STUB_LOG" "restart paneful-manager-tmux.service"
install_sh_fails --rollback
check "rollback without a terminal is refused" test "$(readlink "$PREFIX/current")" = releases/v1.1.0
check "no-terminal refusal explains --yes" contains "$OUT" "pass --yes"
install_sh --yes --rollback
check "rollback flips current back" test "$(readlink "$PREFIX/current")" = releases/v1.0.0
check "rollback restarts the server" contains "$STUB_LOG" "systemctl --user restart paneful-manager.service"

# ---------- WSL: systemd missing ----------

echo "Linux version 5.15 (microsoft-standard-WSL2)" >"$PANEFUL_MANAGER_PROC_VERSION"
touch "$STUB_DIR/no-systemd"
printf '[automount]\nenabled=true\n\n[boot]\ncommand=echo hi\nsystemd=false\n' >"$PANEFUL_MANAGER_WSL_CONF"
install_sh --yes --force --from-source "$V2" --no-windows-task
check "wsl.conf enables systemd" contains "$PANEFUL_MANAGER_WSL_CONF" "^systemd=true$"
check "wsl.conf keeps other settings" contains "$PANEFUL_MANAGER_WSL_CONF" "^command=echo hi$"
check "wsl.conf has no stale systemd line" not_contains "$PANEFUL_MANAGER_WSL_CONF" "systemd=false"
check "wsl.conf backup written" test -f "$PANEFUL_MANAGER_WSL_CONF.paneful-manager.bak"
check "wsl.conf written with sudo" contains "$STUB_LOG" "sudo install -m 0644"
check "shutdown instructions printed" contains "$OUT" "wsl.exe --shutdown"
printf '[boot] # init\nsystemd=true # on\n' >"$PANEFUL_MANAGER_WSL_CONF"
install_sh --yes --from-source "$V2" --no-windows-task
check "[boot] with a comment is recognized" contains "$OUT" "already enables systemd"
check "recognized wsl.conf is not rewritten" not_contains "$STUB_LOG" "sudo"
printf '[network]\nhostname=x\n' >"$PANEFUL_MANAGER_WSL_CONF"
setsid sh "$ROOT/install.sh" --from-source "$V2" --no-windows-task >"$OUT" 2>&1 </dev/null || true
check "wsl.conf prompt defaults to no without a terminal" not_contains "$PANEFUL_MANAGER_WSL_CONF" "systemd=true"
install_sh --yes --from-source "$V2" --no-windows-task
check "wsl.conf gets a [boot] section" test "$(sed -n '/^\[boot\]$/,$p' "$PANEFUL_MANAGER_WSL_CONF" | tr '\n' ' ')" = "[boot] systemd=true "
rm -f "$STUB_DIR/no-systemd"

# ---------- WSL: Windows logon task ----------

install_sh --yes --from-source "$V2"
check "logon task registered" contains "$STUB_LOG" "Register-ScheduledTask -TaskName 'paneful-manager-TestDistro'"
check "logon task boots the distro" contains "$STUB_LOG" "-d TestDistro --exec true"
check "logon task prompt names instanceIdleTimeout" contains "$OUT" "instanceIdleTimeout=-1"

: >"$PANEFUL_MANAGER_IF_INET6"
install_sh --yes --from-source "$V2" --no-windows-task
check "socket skips [::1] without IPv6" not_contains "$UNITS/paneful-manager.socket" "^ListenStream=\[::1\]"
check "a changed socket unit is rebound" contains "$STUB_LOG" "systemctl --user restart paneful-manager.socket"
echo "00000000000000000000000000000001 01 80 10 80       lo" >"$PANEFUL_MANAGER_IF_INET6"

# ---------- WSL: --enable-wsl-systemd (install.ps1) ----------

printf '[network]\nhostname=x\n' >"$PANEFUL_MANAGER_WSL_CONF"
install_sh --yes --enable-wsl-systemd
check "--enable-wsl-systemd enables systemd" contains "$PANEFUL_MANAGER_WSL_CONF" "^systemd=true$"
check "--enable-wsl-systemd keeps other settings" contains "$PANEFUL_MANAGER_WSL_CONF" "^hostname=x$"
check "--enable-wsl-systemd uses sudo when not root" contains "$STUB_LOG" "sudo install -m 0644"
check "--enable-wsl-systemd installs nothing else" not_contains "$STUB_LOG" "systemctl"
install_sh --yes --enable-wsl-systemd
check "--enable-wsl-systemd on an enabled distro changes nothing" contains "$OUT" "already enables systemd"
install_sh --yes --dry-run --uninstall --no-windows-task
check "--no-windows-task leaves the logon task to install.ps1" not_contains "$STUB_LOG" "ScheduledTask"

# ---------- uninstall ----------

echo mine >"$PREFIX/notes.txt"
install_sh_fails --uninstall
check "uninstall without a terminal deletes nothing" test -L "$PREFIX/current"
install_sh --yes --uninstall
check "uninstall disables units" contains "$STUB_LOG" "systemctl --user disable --now paneful-manager.service paneful-manager.socket paneful-manager-tmux.service"
check "uninstall removes the server unit" test ! -e "$UNITS/paneful-manager.service"
check "uninstall removes the socket unit" test ! -e "$UNITS/paneful-manager.socket"
check "uninstall removes the tmux unit" test ! -e "$UNITS/paneful-manager-tmux.service"
check "uninstall removes releases" test ! -e "$PREFIX/releases"
check "uninstall removes the current link" test ! -L "$PREFIX/current"
check "uninstall removes the marker" test ! -e "$PREFIX/.paneful-manager-install"
check "uninstall keeps foreign files and the prefix" test -f "$PREFIX/notes.txt"
rm -f "$PREFIX/notes.txt"
check "uninstall keeps config without --purge" test -f "$CONFIG"
check "uninstall keeps state without --purge" test -d "$STATE"
check "uninstall removes the logon task" contains "$STUB_LOG" "Unregister-ScheduledTask -TaskName 'paneful-manager-TestDistro'"
check "uninstall leaves wsl.conf alone" not_contains "$STUB_LOG" "sudo"
ELSEWHERE="$HOME/elsewhere"
mkdir -p "$ELSEWHERE/releases/v0"
: >"$ELSEWHERE/.agent-hub-install"
ln -s "$ELSEWHERE" "$LEGACY"
install_sh --yes --dry-run --uninstall
check "a symlinked agent-hub prefix is never followed" not_contains "$OUT" "pre-rename install"
check "the target of a symlinked agent-hub prefix stays" test -d "$ELSEWHERE/releases/v0"
rm -rf "$LEGACY" "$ELSEWHERE"
mkdir -p "$LEGACY/releases/v0" "$UNITS"
: >"$LEGACY/.agent-hub-install"
ln -sfn "$LEGACY/releases/v0" "$LEGACY/current"
: >"$UNITS/agent-hub.service"
: >"$UNITS/agent-hub-tmux.service"
touch "$STUB_DIR/task-AgentHub-TestDistro"
install_sh --yes --uninstall --purge
check "uninstall names the leftover agent-hub install in its plan" contains "$OUT" "remove the pre-rename install in $LEGACY"
check "uninstall disables leftover agent-hub units" contains "$STUB_LOG" "systemctl --user disable --now agent-hub.service agent-hub-tmux.service"
check "uninstall removes the leftover logon task" contains "$STUB_LOG" "Unregister-ScheduledTask -TaskName 'AgentHub-TestDistro'"
check "uninstall removes leftover agent-hub units" test ! -e "$UNITS/agent-hub.service" -a ! -e "$UNITS/agent-hub-tmux.service"
check "uninstall removes the leftover agent-hub prefix" test ! -e "$LEGACY"
check "purge removes config" test ! -e "$XDG_CONFIG_HOME/paneful-manager"
check "purge removes state" test ! -e "$STATE"

# ---------- downloads ----------

DL="$HOME/dl"
mkdir -p "$STUB_DIR/release"
cp "$V1" "$STUB_DIR/release/"
echo "https://github.com/Dev-Sebi/Paneful-Manager/releases" >"$STUB_DIR/latest-url"
install_sh_fails --yes --no-systemd --no-windows-task --prefix "$DL"
check "latest without a release is rejected" contains "$OUT" "Invalid release tag"
install_sh_fails --yes --no-systemd --no-windows-task --prefix "$DL" --version v1.0.0
check "download without .sha256 is refused" contains "$OUT" "refusing to install unverified"
echo "0000  $(basename "$V1")" >"$STUB_DIR/release/$(basename "$V1").sha256"
install_sh_fails --yes --no-systemd --no-windows-task --prefix "$DL" --version v1.0.0
check "checksum mismatch is refused" contains "$OUT" "Checksum mismatch"
check "refused downloads leave no release" test ! -e "$DL/current"
cp "$V1.sha256" "$STUB_DIR/release/"
echo "https://github.com/Dev-Sebi/Paneful-Manager/releases/tag/v1.0.0" >"$STUB_DIR/latest-url"
install_sh --yes --no-systemd --no-windows-task --prefix "$DL"
check "latest resolves and verifies the download" contains "$OUT" "sha256 verified"
check "downloaded release installed" test "$(readlink "$DL/current")" = releases/v1.0.0
check "latest lookup is https only" contains "$STUB_LOG" "--proto =https"
check "the target's tarball is downloaded" contains "$STUB_LOG" "releases/download/v1.0.0/$(basename "$V1")"
mkdir -p "$STUB_DIR/generic"
mv "$STUB_DIR/release/"* "$STUB_DIR/generic/"
cp "$V1" "$STUB_DIR/release/paneful-manager-v1.0.0.tar.gz"
(cd "$STUB_DIR/release" && sha256sum paneful-manager-v1.0.0.tar.gz >paneful-manager-v1.0.0.tar.gz.sha256)
install_sh --yes --no-systemd --no-windows-task --prefix "$HOME/generic"
check "without a target build the generic tarball is used" contains "$OUT" "No $HOST_TARGET build in v1.0.0"
check "generic tarball verified and installed" test "$(readlink "$HOME/generic/current")" = releases/v1.0.0
rm -f "$STUB_DIR/release/"*
mv "$STUB_DIR/generic/"* "$STUB_DIR/release/"

# ---------- private repository ----------

TOKEN=github_pat_TestOnly0123456789abcdef
API="https://api.github.com/repos/Dev-Sebi/Paneful-Manager/releases/assets"
mkdir -p "$STUB_DIR/api"
# api_release <tag> <tarball id> <sha id> <tarball> [asset name]: the API answer for one release with its two assets,
# plus a generic tarball asset (id 999) that must not be picked while the target's one exists.
api_release() {
  name=${5:-$(basename "$4")}
  cp "$4" "$STUB_DIR/api/asset-$2"
  cp "$4.sha256" "$STUB_DIR/api/asset-$3"
  printf '{"tag_name":"%s","assets":[{"name":"paneful-manager-%s.tar.gz","url":"%s/999"},{"name":"%s","url":"%s/%s"},{"name":"%s.sha256","url":"%s/%s"}]}\n' \
    "$1" "$1" "$API" "$name" "$API" "$2" "$name" "$API" "$3"
}
api_release v1.0.0 101 102 "$V1" >"$STUB_DIR/api/latest.json"
# Asset URLs carry the canonical name of a renamed repository; this release only has the generic tarball.
api_release v1.1.0 201 202 "$V2" paneful-manager-v1.1.0.tar.gz | sed 's|/Paneful-Manager/|/Panefull-Manager/|g; s|"url":"[^"]*/999"|"url":"https://api.github.com/repos/Dev-Sebi/Panefull-Manager/releases/assets/201"|' >"$STUB_DIR/api/tag-v1.1.0.json"
touch "$STUB_DIR/private"
token_never_leaked() {
  not_contains "$STUB_LOG" "$TOKEN" && not_contains "$OUT" "$TOKEN" && not_contains "$STUB_LOG" "saw a token" &&
    ! grep -rqF -- "$TOKEN" "$HOME" "$TMPDIR"
}

install_sh_fails --yes --no-systemd --no-windows-task --prefix "$HOME/anon"
check "anonymous 404 on latest hints at a private repo" contains "$OUT" "may be private"
check "private repo hint names GITHUB_TOKEN" contains "$OUT" "Set GITHUB_TOKEN"
check "private repo hint names gh" contains "$OUT" "gh auth login"
install_sh_fails --yes --no-systemd --no-windows-task --prefix "$HOME/anon" --version v1.0.0
check "anonymous 404 on a download hints at a private repo" contains "$OUT" "may be private"
check "gh without a login falls back to anonymous" contains "$STUB_LOG" "gh auth token --hostname github.com"

printf '%s' "$TOKEN" >"$STUB_DIR/token"
: >"$STUB_DIR/headers.log"
export GITHUB_TOKEN="$TOKEN"
install_sh --yes --no-systemd --no-windows-task --prefix "$HOME/tok"
unset GITHUB_TOKEN
check "token: latest resolved through the API" contains "$STUB_LOG" "api.github.com/repos/Dev-Sebi/Paneful-Manager/releases/latest"
check "token: assets fetched as octet-stream" contains "$STUB_LOG" "Accept: application/octet-stream -o .* $API/101$"
check "token: checksum asset verified" contains "$OUT" "sha256 verified"
check "token: release installed" test "$(readlink "$HOME/tok/current")" = releases/v1.0.0
check "token: header passed on stdin" contains "$STUB_LOG" "-H @-"
check "token: bearer header sent" contains "$STUB_DIR/headers.log" "^Authorization: Bearer $TOKEN$"
check "token: no anonymous download" not_contains "$STUB_LOG" "releases/download"
check "token: gh not asked" not_contains "$STUB_LOG" "gh auth"
check "token: names its source" contains "$OUT" "token from GITHUB_TOKEN"
check "token: never in argv, output, child env or files" token_never_leaked

export GH_TOKEN="$TOKEN"
install_sh --yes --no-systemd --no-windows-task --prefix "$HOME/tok" --version v1.1.0
unset GH_TOKEN
check "tag: looked up by tag" contains "$STUB_LOG" "releases/tags/v1.1.0"
check "tag: assets of a renamed repo downloaded" contains "$STUB_LOG" "Panefull-Manager/releases/assets/201"
check "tag: release installed" test "$(readlink "$HOME/tok/current")" = releases/v1.1.0
check "GH_TOKEN is used" contains "$OUT" "token from GH_TOKEN"
check "GH_TOKEN never leaked" token_never_leaked

export API_TOKEN=preset GITHUB_TOKEN="$TOKEN"
install_sh --yes --no-systemd --no-windows-task --prefix "$HOME/tok" --version v1.1.0 --force
unset API_TOKEN GITHUB_TOKEN
check "an API_TOKEN from the environment does not export the token" token_never_leaked

echo 7.57.0 >"$STUB_DIR/curl-version"
export GITHUB_TOKEN="$TOKEN"
install_sh_fails --yes --no-systemd --no-windows-task --prefix "$HOME/tok2"
unset GITHUB_TOKEN
rm -f "$STUB_DIR/curl-version"
check "curl older than 7.58 refused for token downloads" contains "$OUT" "curl 7.58 or later is required"
check "old curl never gets the token" not_contains "$STUB_LOG" "api.github.com"

printf '%s\n' "$TOKEN" >"$STUB_DIR/gh-token"
: >"$STUB_DIR/headers.log"
install_sh --yes --no-systemd --no-windows-task --prefix "$HOME/ghtok"
check "gh: token taken from gh auth token" contains "$STUB_LOG" "gh auth token --hostname github.com"
check "gh: bearer header sent" contains "$STUB_DIR/headers.log" "^Authorization: Bearer $TOKEN$"
check "gh: release installed" test "$(readlink "$HOME/ghtok/current")" = releases/v1.0.0
check "gh: token never leaked" token_never_leaked
rm -f "$STUB_DIR/gh-token"

export GITHUB_TOKEN=github_pat_WrongToken
install_sh_fails --yes --no-systemd --no-windows-task --prefix "$HOME/tok2"
check "token without access explains the needed permission" contains "$OUT" "Contents read-only"
install_sh_fails --yes --no-systemd --no-windows-task --prefix "$HOME/tok2" --version 'v1;x'
check "invalid tag is refused before any request" not_contains "$STUB_LOG" "api.github.com"
export GITHUB_TOKEN='bad token'
install_sh_fails --yes --no-systemd --no-windows-task --prefix "$HOME/tok2"
check "token with odd characters refused without echoing it" not_contains "$OUT" "bad token"
unset GITHUB_TOKEN
rm -f "$STUB_DIR/private"

# ---------- release without prebuilt dependencies ----------

pack --no-deps --tag v1.2.0
install_sh --yes --no-systemd --no-windows-task --prefix "$HOME/nodeps" --from-source "$T/pkg/paneful-manager-v1.2.0.tar.gz"
check "tarball without node_modules falls back to pnpm install" contains "$OUT" "compiles node-pty"
check "fallback installs node-pty" test -d "$HOME/nodeps/releases/v1.2.0/apps/server/node_modules/node-pty"

# ---------- macOS (launchd) ----------

REAL_TMUX=$(command -v tmux)
REAL_UNAME=$(command -v uname)
mkdir -p "$T/darwin-bin" "$T/a&b"
printf '#!/bin/sh\nif [ "${1:-}" = -s ] || [ $# -eq 0 ]; then echo Darwin; else exec %s "$@"; fi\n' "$REAL_UNAME" >"$T/darwin-bin/uname"
# Loaded agents are files in $STUB_DIR/launchd; 'launchctl print gui/<uid>' (the GUI domain) always exists.
cat >"$T/darwin-bin/launchctl" <<'EOF'
#!/bin/sh
echo "launchctl $*" >>"$STUB_LOG"
mkdir -p "$STUB_DIR/launchd"
case "$1" in
  print) case "$2" in */*/*) [ -f "$STUB_DIR/launchd/${2##*/}" ] ;; *) exit 0 ;; esac ;;
  bootstrap) touch "$STUB_DIR/launchd/$(basename "$3" .plist)" ;;
  bootout) rm -f "$STUB_DIR/launchd/${2##*/}" ;;
esac
EOF
printf '#!/bin/sh\nif [ "$1" = -V ]; then exec %s -V; fi\necho "tmux $*" >>"$STUB_LOG"\n' "$REAL_TMUX" >"$T/darwin-bin/tmux"
chmod +x "$T/darwin-bin/"*
LINUX_PATH=$PATH
export HOME="$T/mac-home"
export XDG_CONFIG_HOME="$HOME/.config" XDG_STATE_HOME="$HOME/.local/state" XDG_DATA_HOME="$HOME/.local/share"
export PATH="$T/darwin-bin:$T/a&b:$PATH"
mkdir -p "$HOME"
AGENTS="$HOME/Library/LaunchAgents"
MPREFIX="$XDG_DATA_HOME/paneful-manager"
MSTATE="$XDG_STATE_HOME/paneful-manager"
UID_NOW=$(id -u)
# A WSL /proc/version must not matter on macOS.
echo "Linux version 5.15 (microsoft-standard-WSL2)" >"$PANEFUL_MANAGER_PROC_VERSION"

install_sh --yes --dry-run --from-source "$V1"
check "macOS: dry run changes nothing" test -z "$(find "$HOME" -mindepth 1 -print -quit)"
check "macOS: dry run plans launchd agents" contains "$OUT" "launchd agents dev.paneful-manager.tmux + dev.paneful-manager"

install_sh --yes --from-source "$V1"
check "macOS: detected" contains "$OUT" "macOS detected"
check "macOS: release installed" test "$(readlink "$MPREFIX/current")" = releases/v1.0.0
check "macOS: server agent written" test -f "$AGENTS/dev.paneful-manager.plist"
check "macOS: tmux agent written" test -f "$AGENTS/dev.paneful-manager.tmux.plist"
check "macOS: no placeholders left" not_contains "$AGENTS/dev.paneful-manager.plist" "@[A-Z_]*@"
check "macOS: agent pins the port" contains "$AGENTS/dev.paneful-manager.plist" "<string>7337</string>"
check "macOS: agent runs the current release" contains "$AGENTS/dev.paneful-manager.plist" "<string>$MPREFIX/current/apps/server/dist/index.js</string>"
check "macOS: agent logs to the state dir" contains "$AGENTS/dev.paneful-manager.plist" "<string>$MSTATE/logs/server.log</string>"
check "macOS: agent restarts the server" contains "$AGENTS/dev.paneful-manager.plist" "<key>KeepAlive</key>"
check "macOS: PATH is XML-escaped" contains "$AGENTS/dev.paneful-manager.plist" "a&amp;b"
check "macOS: tmux agent abandons its daemon" contains "$AGENTS/dev.paneful-manager.tmux.plist" "<key>AbandonProcessGroup</key>"
check "macOS: tmux agent uses the state dir" contains "$AGENTS/dev.paneful-manager.tmux.plist" "<string>$MSTATE/tmux.conf</string>"
if command -v python3 >/dev/null 2>&1; then
  check "macOS: plists parse" python3 -c 'import plistlib, sys; [plistlib.load(open(f, "rb")) for f in sys.argv[1:]]' \
    "$AGENTS/dev.paneful-manager.plist" "$AGENTS/dev.paneful-manager.tmux.plist"
fi
check "macOS: log dir created" test -d "$MSTATE/logs"
check "macOS: server agent bootstrapped" contains "$STUB_LOG" "launchctl bootstrap gui/$UID_NOW $AGENTS/dev.paneful-manager.plist"
check "macOS: tmux agent bootstrapped" contains "$STUB_LOG" "launchctl bootstrap gui/$UID_NOW $AGENTS/dev.paneful-manager.tmux.plist"
check "macOS: no systemd" not_contains "$STUB_LOG" "systemctl"
check "macOS: no lingering" not_contains "$STUB_LOG" "loginctl"
check "macOS: no WSL or Windows steps" not_contains "$STUB_LOG" "powershell.exe\|sudo"
check "macOS: no WSL note" not_contains "$OUT" "WSL"
check "macOS: login URL printed, not opened" contains "$OUT" "^  http://127.0.0.1:7337/#login="
check "macOS: no unit files" test ! -e "$XDG_CONFIG_HOME/systemd"

install_sh --yes --from-source "$V1"
check "macOS: re-run is a no-op" not_contains "$STUB_LOG" "launchctl bootstrap\|kickstart"
install_sh --yes --from-source "$V1" --port 7600
check "macOS: --port rewrites the agent" contains "$AGENTS/dev.paneful-manager.plist" "<string>7600</string>"
check "macOS: --port reloads the server agent" contains "$STUB_LOG" "launchctl bootout gui/$UID_NOW/dev.paneful-manager$"
install_sh --yes --from-source "$V2"
check "macOS: upgrade keeps the port of the agent" contains "$AGENTS/dev.paneful-manager.plist" "<string>7600</string>"
check "macOS: upgrade restarts the server" contains "$STUB_LOG" "launchctl kickstart -k gui/$UID_NOW/dev.paneful-manager$"
check "macOS: upgrade leaves the tmux agent alone" not_contains "$STUB_LOG" "boot[a-z]* .*dev.paneful-manager.tmux"
install_sh --yes --rollback
check "macOS: rollback flips current" test "$(readlink "$MPREFIX/current")" = releases/v1.0.0
check "macOS: rollback restarts the server" contains "$STUB_LOG" "launchctl kickstart -k gui/$UID_NOW/dev.paneful-manager$"
install_sh --yes --uninstall --purge
check "macOS: uninstall unloads the server agent" contains "$STUB_LOG" "launchctl bootout gui/$UID_NOW/dev.paneful-manager$"
check "macOS: uninstall unloads the tmux agent" contains "$STUB_LOG" "launchctl bootout gui/$UID_NOW/dev.paneful-manager.tmux$"
check "macOS: uninstall stops the tmux server" contains "$STUB_LOG" "tmux -L paneful-manager kill-server"
check "macOS: uninstall removes the agents" test ! -e "$AGENTS/dev.paneful-manager.plist" -a ! -e "$AGENTS/dev.paneful-manager.tmux.plist"
check "macOS: uninstall removes the release" test ! -L "$MPREFIX/current"
check "macOS: uninstall never mentions lingering" not_contains "$OUT" "loginctl"
export PATH="$LINUX_PATH"

printf '\n%s tests, %s failed\n' "$TESTS" "$FAILS"
[ "$FAILS" -eq 0 ]
