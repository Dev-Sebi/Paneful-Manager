#!/bin/sh
# Builds Paneful Manager and packs paneful-manager-<tag>-<target>.tar.gz with production node_modules for this machine
# (target linux-x64, linux-arm64, darwin-x64 or darwin-arm64), or with --no-deps the generic paneful-manager-<tag>.tar.gz; each with a .sha256.
# Usage: scripts/release-pack.sh [--skip-build] [--no-deps] [--target <target>] [--out <dir>] [--tag <tag>]
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
OUT_DIR="$ROOT/dist/release"
SKIP_BUILD=0
NO_DEPS=0
TAG=""
TARGET=""

usage() {
  sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --no-deps) NO_DEPS=1 ;;
    --out) [ $# -ge 2 ] || { echo "--out needs a value" >&2; exit 2; }; OUT_DIR=$2; shift ;;
    --tag) [ $# -ge 2 ] || { echo "--tag needs a value" >&2; exit 2; }; TAG=$2; shift ;;
    --target) [ $# -ge 2 ] || { echo "--target needs a value" >&2; exit 2; }; TARGET=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$TAG" ]; then
  VERSION=$(node -p "require(process.argv[1]).version" "$ROOT/package.json")
  TAG="v$VERSION"
fi
case "$TAG" in
  *[!A-Za-z0-9._-]*|'') echo "Invalid tag: $TAG" >&2; exit 2 ;;
esac

# The target is this machine (the bundled node-pty is compiled here); --target only asserts it, e.g. in the release matrix.
if [ "$NO_DEPS" -eq 0 ]; then
  HOST_TARGET=$(node -p '({ linux: "linux", darwin: "darwin" })[process.platform] + "-" + process.arch')
  case "$HOST_TARGET" in
    linux-x64|linux-arm64|darwin-x64|darwin-arm64) ;;
    *) echo "No release target for $HOST_TARGET; pack with --no-deps" >&2; exit 1 ;;
  esac
  if [ -n "$TARGET" ] && [ "$TARGET" != "$HOST_TARGET" ]; then
    echo "--target $TARGET does not match this machine ($HOST_TARGET)" >&2
    exit 1
  fi
  TARGET=$HOST_TARGET
elif [ -n "$TARGET" ]; then
  echo "--target needs bundled dependencies; --no-deps packs the generic tarball" >&2
  exit 2
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  (cd "$ROOT" && pnpm build)
fi

# Kept in sync with the release layout install.sh expects.
FILES="apps/server/dist apps/server/package.json apps/web/dist apps/web/package.json
packages/shared/dist packages/shared/package.json
package.json pnpm-workspace.yaml pnpm-lock.yaml packaging install.sh LICENSE README.md"

for f in $FILES; do
  [ -e "$ROOT/$f" ] || { echo "Missing $f (run pnpm build first)" >&2; exit 1; }
done
[ -f "$ROOT/apps/server/dist/index.js" ] || { echo "Missing apps/server/dist/index.js" >&2; exit 1; }
[ -f "$ROOT/apps/web/dist/index.html" ] || { echo "Missing apps/web/dist/index.html" >&2; exit 1; }

NAME="paneful-manager-$TAG${TARGET:+-$TARGET}"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM
mkdir -p "$STAGE/$NAME"
for f in $FILES; do
  mkdir -p "$STAGE/$NAME/$(dirname "$f")"
  cp -R "$ROOT/$f" "$STAGE/$NAME/$f"
done
find "$STAGE/$NAME" \( -name '*.tsbuildinfo' -o -name '*.test.js' -o -name '*.test.d.ts' \) -exec rm -f {} +
printf '%s\n' "$TAG" > "$STAGE/$NAME/VERSION"

# Ships the server's production dependencies with node-pty for this machine (compiled on Linux, node-pty's own
# prebuild on macOS), so installing on the same target needs no compiler. install.sh compiles when it does not load.
if [ "$NO_DEPS" -eq 0 ]; then
  (cd "$STAGE/$NAME" && CI=true pnpm install --prod --frozen-lockfile --filter '@paneful-manager/server...' >/dev/null)
  PTY_DIR=$(cd "$STAGE/$NAME/apps/server" && node -p "require('path').dirname(require.resolve('node-pty/package.json'))")
  # Keeps only the addon node-pty loads here: sources, other platforms' prebuilds, the build tree and pnpm's state
  # files are not needed at runtime and the latter two carry absolute paths of this machine.
  rm -rf "$PTY_DIR/deps" "$PTY_DIR/src" "$PTY_DIR/third_party"
  if [ -f "$PTY_DIR/build/Release/pty.node" ]; then
    rm -rf "$PTY_DIR/prebuilds"
    find "$PTY_DIR/build" -mindepth 1 -maxdepth 1 ! -name Release -exec rm -rf {} +
    find "$PTY_DIR/build/Release" -mindepth 1 -maxdepth 1 ! -name '*.node' ! -name spawn-helper -exec rm -rf {} +
  else
    rm -rf "$PTY_DIR/build"
    find "$PTY_DIR/prebuilds" -mindepth 1 -maxdepth 1 ! -name "$TARGET" -exec rm -rf {} +
  fi
  (cd "$STAGE/$NAME/apps/server" && node -e "require('node-pty')") || { echo "The bundled node-pty does not load" >&2; exit 1; }
  rm -f "$STAGE/$NAME/node_modules/.modules.yaml" "$STAGE/$NAME/node_modules/.pnpm-workspace-state"*.json
  # The .bin shims are not used at runtime and embed the staging directory in NODE_PATH.
  find "$STAGE/$NAME" -type d -name .bin -path '*/node_modules/.bin' -prune -exec rm -rf {} +
fi

mkdir -p "$OUT_DIR"
OUT_DIR=$(CDPATH='' cd -- "$OUT_DIR" && pwd)
TARBALL="$NAME.tar.gz"
EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || date +%s)}
if tar --version 2>/dev/null | grep -q 'GNU tar'; then GNU_TAR=tar; elif command -v gtar >/dev/null 2>&1; then GNU_TAR=gtar; else GNU_TAR=""; fi
if [ -n "$GNU_TAR" ]; then
  (cd "$STAGE" && "$GNU_TAR" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$EPOCH" -cf - "$NAME") | gzip -n -9 > "$OUT_DIR/$TARBALL"
else
  # bsdtar (macOS): sorted file list and fixed times and owners, as close to the GNU archive as it gets.
  node -e '
    const fs = require("fs"), path = require("path"), t = Number(process.argv[2])
    const walk = p => { if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e)); fs.lutimesSync(p, t, t) }
    walk(process.argv[1])
  ' "$STAGE/$NAME" "$EPOCH"
  (cd "$STAGE" && find "$NAME" -print | LC_ALL=C sort | tar --uid 0 --gid 0 --uname root --gname root -n -cf - -T -) | gzip -n -9 > "$OUT_DIR/$TARBALL"
fi
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum "$TARBALL" > "$TARBALL.sha256")
else
  (cd "$OUT_DIR" && shasum -a 256 "$TARBALL" > "$TARBALL.sha256")
fi

echo "Packed $OUT_DIR/$TARBALL"
echo "Checksum $OUT_DIR/$TARBALL.sha256"
