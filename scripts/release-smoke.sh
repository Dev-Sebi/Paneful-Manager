#!/bin/sh
# Smoke test for a packed release: installs it with its own install.sh into a temp HOME, starts the server, checks /api/health.
# Usage: scripts/release-smoke.sh <dir>/paneful-manager-<tag>.tar.gz [port]
set -eu

[ $# -ge 1 ] || { sed -n '3p' "$0" | sed 's/^# //' >&2; exit 2; }
TARBALL=$(realpath -- "$1")
PORT=${2:-17337}
[ -f "$TARBALL" ] || { echo "Tarball not found: $TARBALL" >&2; exit 1; }
NAME=$(basename "$TARBALL" .tar.gz)
TAG=${NAME#paneful-manager-}
[ "$TAG" != "$NAME" ] || { echo "Tarball name must be paneful-manager-<tag>.tar.gz" >&2; exit 1; }
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

T=$(mktemp -d)
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  TMUX_TMPDIR="$T/tmux" tmux -L paneful-manager kill-server 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
  echo "Port $PORT is already in use; pass another port" >&2
  exit 1
fi

echo "==> Extracting $NAME.tar.gz"
mkdir "$T/extract"
tar -xzf "$TARBALL" -C "$T/extract"
REL="$T/extract/$NAME"
for f in VERSION install.sh apps/server/dist/index.js apps/web/dist/index.html apps/server/node_modules/node-pty; do
  [ -e "$REL/$f" ] || { echo "Tarball is missing $NAME/$f" >&2; exit 1; }
done
[ "$(cat "$REL/VERSION")" = "$TAG" ] || { echo "VERSION in the tarball does not match $TAG" >&2; exit 1; }

# Compiler stubs that fail: the install must use the prebuilt node-pty and never compile anything.
mkdir -p "$T/no-compiler" "$T/home" "$T/tmux"
for tool in make cc gcc g++ c++; do
  printf '#!/bin/sh\necho "%s must not be called during the install" >&2\nexit 1\n' "$tool" >"$T/no-compiler/$tool"
  chmod +x "$T/no-compiler/$tool"
done
chmod 0700 "$T/tmux"

export HOME="$T/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_DATA_HOME="$HOME/.local/share"
export TMUX_TMPDIR="$T/tmux"
PREFIX="$XDG_DATA_HOME/paneful-manager"

echo "==> Installing with install.sh --from-source --no-systemd"
PATH="$T/no-compiler:$PATH" sh "$REL/install.sh" --from-source "$TARBALL" --no-systemd --no-wsl-conf --no-windows-task \
  --yes --port "$PORT" </dev/null >"$T/install.log" 2>&1 || {
  cat "$T/install.log" >&2
  echo "install.sh failed" >&2
  exit 1
}
cat "$T/install.log"
grep -q 'Using the prebuilt production dependencies' "$T/install.log" || { echo "install.sh did not use the prebuilt dependencies" >&2; exit 1; }
[ "$(readlink "$PREFIX/current")" = "releases/$TAG" ] || { echo "current does not point at releases/$TAG" >&2; exit 1; }

echo "==> Starting the server on port $PORT"
cd "$PREFIX/current" || exit 1
NODE_ENV=production PANEFUL_MANAGER_PORT=$PORT node "$PREFIX/current/apps/server/dist/index.js" >"$T/server.log" 2>&1 &
SERVER_PID=$!

waited=0
until curl -fsS --max-time 2 "$HEALTH_URL" >"$T/health.json" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -ge 30 ] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
    cat "$T/server.log" >&2
    echo "No answer on $HEALTH_URL" >&2
    exit 1
  fi
  sleep 1
done
echo "  $HEALTH_URL -> $(cat "$T/health.json")"
curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/" || { cat "$T/server.log" >&2; echo "The web app is not served" >&2; exit 1; }
echo "  http://127.0.0.1:$PORT/ serves the web app"
echo "Smoke test passed for $TAG"
