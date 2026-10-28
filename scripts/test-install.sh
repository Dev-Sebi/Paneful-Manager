#!/bin/sh
# Smoke test for install.sh: installs from a locally packed tarball into a temp HOME.
# systemctl, loginctl, sudo, powershell.exe and curl are stubs that only log, so the real system is never touched.
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
mkdir -p "$HOME" "$T/bin" "$STUB_DIR"
: >"$STUB_LOG"
echo "Linux version 6.0 (generic)" >"$AGENT_HUB_PROC_VERSION"

cat >"$T/bin/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >>"$STUB_LOG"
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
# Serves files from $STUB_DIR/release by URL basename; health checks always succeed.
cat >"$T/bin/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >>"$STUB_LOG"
out=""
url=""
effective=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -w) effective=1; shift ;;
    --proto|--max-time) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
if [ "$effective" -eq 1 ]; then cat "$STUB_DIR/latest-url"; exit 0; fi
case "$url" in */api/health) exit 0 ;; esac
file="$STUB_DIR/release/${url##*/}"
[ -f "$file" ] || exit 22
[ -z "$out" ] || [ "$out" = /dev/null ] || cp "$file" "$out"
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
install_sh_fails --login-url
check "--login-url without a key explains why" contains "$OUT" "No access key yet"
printf 'test-access-key-0123456789abcdefghijkl\n' >"$STATE/access-key"
install_sh --login-url
check "--login-url prints the URL with the key and port" contains "$OUT" "^  http://127.0.0.1:7337/#key=test-access-key-0123456789abcdefghijkl$"
rm -f "$STATE/access-key"

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

# ---------- release without prebuilt dependencies ----------

pack --no-deps --tag v1.2.0
install_sh --yes --no-systemd --no-windows-task --prefix "$HOME/nodeps" --from-source "$T/pkg/agent-hub-v1.2.0.tar.gz"
check "tarball without node_modules falls back to pnpm install" contains "$OUT" "compiles node-pty"
check "fallback installs node-pty" test -d "$HOME/nodeps/releases/v1.2.0/apps/server/node_modules/node-pty"

printf '\n%s tests, %s failed\n' "$TESTS" "$FAILS"
[ "$FAILS" -eq 0 ]
