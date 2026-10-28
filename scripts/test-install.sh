#!/bin/sh
# Smoke test for install.sh: installs from a locally packed tarball into a temp HOME.
# systemctl, loginctl, sudo, powershell.exe, gh and curl are stubs that only log, so the real system is never touched.
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
export AGENT_HUB_WSL_CONF="$T/wsl.conf"
export AGENT_HUB_PROC_VERSION="$T/proc-version"
export STUB_LOG="$T/calls.log"
export STUB_DIR="$T/stub-state"
export TMPDIR="$T/tmp"
unset GITHUB_TOKEN GH_TOKEN
mkdir -p "$HOME" "$T/bin" "$STUB_DIR" "$TMPDIR"
: >"$STUB_LOG"
echo "Linux version 6.0 (generic)" >"$AGENT_HUB_PROC_VERSION"

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
case "$*" in
  *Unregister-ScheduledTask*) rm -f "$STUB_DIR/task" ;;
  *Register-ScheduledTask*) touch "$STUB_DIR/task" ;;
  *Get-ScheduledTask*) [ -f "$STUB_DIR/task" ] ;;
esac
EOF
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

PREFIX="$XDG_DATA_HOME/agent-hub"
CONFIG="$XDG_CONFIG_HOME/agent-hub/config.yaml"
STATE="$XDG_STATE_HOME/agent-hub"
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
pack --tag v1.0.0
pack --tag v1.1.0
V1="$T/pkg/agent-hub-v1.0.0.tar.gz"
V2="$T/pkg/agent-hub-v1.1.0.tar.gz"

# ---------- dry run ----------

install_sh --dry-run --yes --from-source "$V1"
check "dry run changes nothing in HOME" test -z "$(find "$HOME" -mindepth 1 -print -quit)"
check "dry run prints the systemctl steps" contains "$OUT" "systemctl --user enable"
check "dry run never calls systemctl" not_contains "$STUB_LOG" "systemctl --user enable"
check "dry run says it would install" contains "$OUT" "would install Agent Hub v1.0.0"

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
check "uninstall without marker refused" contains "$OUT" "no Agent Hub install marker"
check "uninstall without marker deletes nothing" test -f "$HOME/notours/data.txt"
install_sh_fails --yes --from-source "$V1" --prefix "$HOME/notours"
check "install into a foreign non-empty dir refused" test ! -e "$HOME/notours/releases"
rm -rf "$HOME/notours"

# ---------- fresh install ----------

install_sh --yes --from-source "$V1" --no-windows-task
check "release extracted" test -f "$PREFIX/releases/v1.0.0/apps/server/dist/index.js"
check "web build shipped" test -f "$PREFIX/releases/v1.0.0/apps/web/dist/index.html"
check "node-pty installed" test -d "$PREFIX/releases/v1.0.0/apps/server/node_modules/node-pty"
check "prebuilt dependencies used" contains "$OUT" "Using the prebuilt production dependencies"
check "current symlink points at the release" test "$(readlink "$PREFIX/current")" = releases/v1.0.0
check "install marker written" contains "$PREFIX/.agent-hub-install" "v1.0.0"
check "config written with the default port" contains "$CONFIG" "^port: 7337$"
check "state dir is 0700" test "$(stat -c %a "$STATE")" = 700
check "tmux.conf installed" cmp -s "$STATE/tmux.conf" "$ROOT/packaging/tmux.conf"
check "server unit written" test -f "$UNITS/agent-hub.service"
check "tmux unit written" test -f "$UNITS/agent-hub-tmux.service"
check "no placeholders left" not_contains "$UNITS/agent-hub.service" "@[A-Z_]*@"
check "unit quotes PATH" contains "$UNITS/agent-hub.service" '^Environment="PATH=/'
check "unit pins the port" contains "$UNITS/agent-hub.service" "AGENT_HUB_PORT=7337"
check "unit runs the current release" contains "$UNITS/agent-hub.service" "$PREFIX/current/apps/server/dist/index.js"
check "tmux unit uses the state dir" contains "$UNITS/agent-hub-tmux.service" "-f $STATE/tmux.conf start-server"
check "daemon-reload called" contains "$STUB_LOG" "systemctl --user daemon-reload"
check "units enabled" contains "$STUB_LOG" "systemctl --user enable agent-hub-tmux.service agent-hub.service"
check "linger enabled" contains "$STUB_LOG" "loginctl enable-linger tester"
check "health check called" contains "$STUB_LOG" "curl -fsS --max-time 5 http://127.0.0.1:7337/api/health"
check "non-WSL warning shown" contains "$OUT" "does not look like WSL"
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
check "re-run keeps the installed unit port" contains "$UNITS/agent-hub.service" "AGENT_HUB_PORT=7337"
check "stale staging dirs pruned" test ! -e "$PREFIX/releases/.staging-stale"
install_sh --yes --port 7500 --from-source "$V1" --no-windows-task
check "--port updates the unit without --force" contains "$UNITS/agent-hub.service" "AGENT_HUB_PORT=7500"
check "--port restarts the server" contains "$STUB_LOG" "systemctl --user restart agent-hub.service"
check "--port is saved in config.yaml" contains "$CONFIG" "^port: 7500$"
check "--port keeps other config keys" contains "$CONFIG" "^theme: light$"
install_sh --yes --from-source "$V1" --no-windows-task
check "re-run without --port keeps 7500" contains "$UNITS/agent-hub.service" "AGENT_HUB_PORT=7500"
check "health check uses the kept port" contains "$STUB_LOG" "127.0.0.1:7500/api/health"

# ---------- upgrade and rollback ----------

install_sh --yes --from-source "$V2" --no-windows-task
check "upgrade flips current" test "$(readlink "$PREFIX/current")" = releases/v1.1.0
check "upgrade keeps previous" test "$(readlink "$PREFIX/previous")" = releases/v1.0.0
check "upgrade restarts the server" contains "$STUB_LOG" "systemctl --user restart agent-hub.service"
check "upgrade keeps the tmux server" not_contains "$STUB_LOG" "restart agent-hub-tmux.service"
install_sh_fails --rollback
check "rollback without a terminal is refused" test "$(readlink "$PREFIX/current")" = releases/v1.1.0
check "no-terminal refusal explains --yes" contains "$OUT" "pass --yes"
install_sh --yes --rollback
check "rollback flips current back" test "$(readlink "$PREFIX/current")" = releases/v1.0.0
check "rollback restarts the server" contains "$STUB_LOG" "systemctl --user restart agent-hub.service"

# ---------- WSL: systemd missing ----------

echo "Linux version 5.15 (microsoft-standard-WSL2)" >"$AGENT_HUB_PROC_VERSION"
touch "$STUB_DIR/no-systemd"
printf '[automount]\nenabled=true\n\n[boot]\ncommand=echo hi\nsystemd=false\n' >"$AGENT_HUB_WSL_CONF"
install_sh --yes --force --from-source "$V2" --no-windows-task
check "wsl.conf enables systemd" contains "$AGENT_HUB_WSL_CONF" "^systemd=true$"
check "wsl.conf keeps other settings" contains "$AGENT_HUB_WSL_CONF" "^command=echo hi$"
check "wsl.conf has no stale systemd line" not_contains "$AGENT_HUB_WSL_CONF" "systemd=false"
check "wsl.conf backup written" test -f "$AGENT_HUB_WSL_CONF.agent-hub.bak"
check "wsl.conf written with sudo" contains "$STUB_LOG" "sudo install -m 0644"
check "shutdown instructions printed" contains "$OUT" "wsl.exe --shutdown"
printf '[boot] # init\nsystemd=true # on\n' >"$AGENT_HUB_WSL_CONF"
install_sh --yes --from-source "$V2" --no-windows-task
check "[boot] with a comment is recognized" contains "$OUT" "already enables systemd"
check "recognized wsl.conf is not rewritten" not_contains "$STUB_LOG" "sudo"
printf '[network]\nhostname=x\n' >"$AGENT_HUB_WSL_CONF"
setsid sh "$ROOT/install.sh" --from-source "$V2" --no-windows-task >"$OUT" 2>&1 </dev/null || true
check "wsl.conf prompt defaults to no without a terminal" not_contains "$AGENT_HUB_WSL_CONF" "systemd=true"
install_sh --yes --from-source "$V2" --no-windows-task
check "wsl.conf gets a [boot] section" test "$(sed -n '/^\[boot\]$/,$p' "$AGENT_HUB_WSL_CONF" | tr '\n' ' ')" = "[boot] systemd=true "
rm -f "$STUB_DIR/no-systemd"

# ---------- WSL: Windows logon task ----------

install_sh --yes --from-source "$V2"
check "logon task registered" contains "$STUB_LOG" "Register-ScheduledTask -TaskName 'AgentHub-TestDistro'"
check "logon task boots the distro" contains "$STUB_LOG" "-d TestDistro --exec true"
check "logon task prompt names instanceIdleTimeout" contains "$OUT" "instanceIdleTimeout=-1"

# ---------- uninstall ----------

echo mine >"$PREFIX/notes.txt"
install_sh_fails --uninstall
check "uninstall without a terminal deletes nothing" test -L "$PREFIX/current"
install_sh --yes --uninstall
check "uninstall disables units" contains "$STUB_LOG" "systemctl --user disable --now agent-hub.service agent-hub-tmux.service"
check "uninstall removes the server unit" test ! -e "$UNITS/agent-hub.service"
check "uninstall removes the tmux unit" test ! -e "$UNITS/agent-hub-tmux.service"
check "uninstall removes releases" test ! -e "$PREFIX/releases"
check "uninstall removes the current link" test ! -L "$PREFIX/current"
check "uninstall removes the marker" test ! -e "$PREFIX/.agent-hub-install"
check "uninstall keeps foreign files and the prefix" test -f "$PREFIX/notes.txt"
rm -f "$PREFIX/notes.txt"
check "uninstall keeps config without --purge" test -f "$CONFIG"
check "uninstall keeps state without --purge" test -d "$STATE"
check "uninstall removes the logon task" contains "$STUB_LOG" "Unregister-ScheduledTask -TaskName 'AgentHub-TestDistro'"
check "uninstall leaves wsl.conf alone" not_contains "$STUB_LOG" "sudo"
install_sh --yes --uninstall --purge
check "purge removes config" test ! -e "$XDG_CONFIG_HOME/agent-hub"
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
echo "0000  agent-hub-v1.0.0.tar.gz" >"$STUB_DIR/release/agent-hub-v1.0.0.tar.gz.sha256"
install_sh_fails --yes --no-systemd --no-windows-task --prefix "$DL" --version v1.0.0
check "checksum mismatch is refused" contains "$OUT" "Checksum mismatch"
check "refused downloads leave no release" test ! -e "$DL/current"
cp "$V1.sha256" "$STUB_DIR/release/"
echo "https://github.com/Dev-Sebi/Paneful-Manager/releases/tag/v1.0.0" >"$STUB_DIR/latest-url"
install_sh --yes --no-systemd --no-windows-task --prefix "$DL"
check "latest resolves and verifies the download" contains "$OUT" "sha256 verified"
check "downloaded release installed" test "$(readlink "$DL/current")" = releases/v1.0.0
check "latest lookup is https only" contains "$STUB_LOG" "--proto =https"

# ---------- private repository ----------

TOKEN=github_pat_TestOnly0123456789abcdef
API="https://api.github.com/repos/Dev-Sebi/Paneful-Manager/releases/assets"
mkdir -p "$STUB_DIR/api"
# api_release <tag> <tarball id> <sha id> <tarball>: the API answer for one release with its two assets.
api_release() {
  cp "$4" "$STUB_DIR/api/asset-$2"
  cp "$4.sha256" "$STUB_DIR/api/asset-$3"
  printf '{"tag_name":"%s","assets":[{"name":"agent-hub-%s.tar.gz","url":"%s/%s"},{"name":"agent-hub-%s.tar.gz.sha256","url":"%s/%s"}]}\n' \
    "$1" "$1" "$API" "$2" "$1" "$API" "$3"
}
api_release v1.0.0 101 102 "$V1" >"$STUB_DIR/api/latest.json"
# Asset URLs carry the canonical name of a renamed repository.
api_release v1.1.0 201 202 "$V2" | sed 's|/Paneful-Manager/|/Panefull-Manager/|g' >"$STUB_DIR/api/tag-v1.1.0.json"
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
install_sh --yes --no-systemd --no-windows-task --prefix "$HOME/nodeps" --from-source "$T/pkg/agent-hub-v1.2.0.tar.gz"
check "tarball without node_modules falls back to pnpm install" contains "$OUT" "compiles node-pty"
check "fallback installs node-pty" test -d "$HOME/nodeps/releases/v1.2.0/apps/server/node_modules/node-pty"

printf '\n%s tests, %s failed\n' "$TESTS" "$FAILS"
[ "$FAILS" -eq 0 ]
