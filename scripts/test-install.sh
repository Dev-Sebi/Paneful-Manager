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
cat >"$T/bin/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >>"$STUB_LOG"
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
sh "$ROOT/scripts/release-pack.sh" --skip-build --tag v1.0.0 --out "$T/pkg" >/dev/null
sh "$ROOT/scripts/release-pack.sh" --skip-build --tag v1.1.0 --out "$T/pkg" >/dev/null
V1="$T/pkg/agent-hub-v1.0.0.tar.gz"
V2="$T/pkg/agent-hub-v1.1.0.tar.gz"

# ---------- dry run ----------

install_sh --dry-run --yes --from-source "$V1"
check "dry run changes nothing in HOME" test -z "$(find "$HOME" -mindepth 1 -print -quit)"
check "dry run prints the systemctl steps" contains "$OUT" "systemctl --user enable"
check "dry run never calls systemctl" not_contains "$STUB_LOG" "systemctl --user enable"

# ---------- fresh install ----------

install_sh --yes --from-source "$V1" --no-windows-task
check "release extracted" test -f "$PREFIX/releases/v1.0.0/apps/server/dist/index.js"
check "web build shipped" test -f "$PREFIX/releases/v1.0.0/apps/web/dist/index.html"
check "node-pty installed" test -d "$PREFIX/releases/v1.0.0/apps/server/node_modules/node-pty"
check "current symlink points at the release" test "$(readlink "$PREFIX/current")" = releases/v1.0.0
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
check "health check called" contains "$STUB_LOG" "curl -fsS http://127.0.0.1:7337/api/health"
check "non-WSL warning shown" contains "$OUT" "does not look like WSL"

# ---------- re-run is a no-op ----------

touch "$T/marker"
sleep 1
install_sh --yes --from-source "$V1" --no-windows-task
check "re-run reports up to date" contains "$OUT" "already installed and up to date"
check "re-run changes no files" test -z "$(find "$PREFIX" "$XDG_CONFIG_HOME" "$STATE" -newer "$T/marker" -print -quit)"
check "re-run does not restart services" not_contains "$STUB_LOG" "systemctl --user restart"

# ---------- config written once ----------

printf 'port: 7400\ntheme: light\n' >"$CONFIG"
install_sh --yes --force --from-source "$V1" --no-windows-task
check "existing config kept" contains "$CONFIG" "theme: light"
check "unit follows the configured port" contains "$UNITS/agent-hub.service" "AGENT_HUB_PORT=7400"

# ---------- upgrade and rollback ----------

install_sh --yes --from-source "$V2" --no-windows-task
check "upgrade flips current" test "$(readlink "$PREFIX/current")" = releases/v1.1.0
check "upgrade keeps previous" test "$(readlink "$PREFIX/previous")" = releases/v1.0.0
check "upgrade restarts the server" contains "$STUB_LOG" "systemctl --user restart agent-hub.service"
check "upgrade keeps the tmux server" not_contains "$STUB_LOG" "restart agent-hub-tmux.service"
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
printf '[network]\nhostname=x\n' >"$AGENT_HUB_WSL_CONF"
install_sh --yes --from-source "$V2" --no-windows-task
check "wsl.conf gets a [boot] section" test "$(sed -n '/^\[boot\]$/,$p' "$AGENT_HUB_WSL_CONF" | tr '\n' ' ')" = "[boot] systemd=true "
rm -f "$STUB_DIR/no-systemd"

# ---------- WSL: Windows logon task ----------

install_sh --yes --from-source "$V2"
check "logon task registered" contains "$STUB_LOG" "Register-ScheduledTask -TaskName 'AgentHub-TestDistro'"
check "logon task boots the distro" contains "$STUB_LOG" "-d TestDistro --exec true"

# ---------- uninstall ----------

install_sh --yes --uninstall
check "uninstall disables units" contains "$STUB_LOG" "systemctl --user disable --now agent-hub.service agent-hub-tmux.service"
check "uninstall removes the server unit" test ! -e "$UNITS/agent-hub.service"
check "uninstall removes the tmux unit" test ! -e "$UNITS/agent-hub-tmux.service"
check "uninstall removes the prefix" test ! -e "$PREFIX"
check "uninstall keeps config without --purge" test -f "$CONFIG"
check "uninstall keeps state without --purge" test -d "$STATE"
check "uninstall removes the logon task" contains "$STUB_LOG" "Unregister-ScheduledTask -TaskName 'AgentHub-TestDistro'"
check "uninstall leaves wsl.conf alone" not_contains "$STUB_LOG" "sudo"
install_sh --yes --uninstall --purge
check "purge removes config" test ! -e "$XDG_CONFIG_HOME/agent-hub"
check "purge removes state" test ! -e "$STATE"

printf '\n%s tests, %s failed\n' "$TESTS" "$FAILS"
[ "$FAILS" -eq 0 ]
