#!/bin/sh
# Builds Agent Hub and packs the release tarball agent-hub-<tag>.tar.gz plus its .sha256 file.
# Usage: scripts/release-pack.sh [--skip-build] [--out <dir>] [--tag <tag>]
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
OUT_DIR="$ROOT/dist/release"
SKIP_BUILD=0
TAG=""

usage() {
  sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --out) [ $# -ge 2 ] || { echo "--out needs a value" >&2; exit 2; }; OUT_DIR=$2; shift ;;
    --tag) [ $# -ge 2 ] || { echo "--tag needs a value" >&2; exit 2; }; TAG=$2; shift ;;
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

NAME="agent-hub-$TAG"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM
mkdir -p "$STAGE/$NAME"
for f in $FILES; do
  mkdir -p "$STAGE/$NAME/$(dirname "$f")"
  cp -R "$ROOT/$f" "$STAGE/$NAME/$f"
done
find "$STAGE/$NAME" \( -name '*.tsbuildinfo' -o -name '*.test.js' -o -name '*.test.d.ts' \) -exec rm -f {} +
printf '%s\n' "$TAG" > "$STAGE/$NAME/VERSION"

mkdir -p "$OUT_DIR"
OUT_DIR=$(CDPATH='' cd -- "$OUT_DIR" && pwd)
TARBALL="$NAME.tar.gz"
EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || date +%s)}
(cd "$STAGE" && tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$EPOCH" -cf - "$NAME") | gzip -n -9 > "$OUT_DIR/$TARBALL"
(cd "$OUT_DIR" && sha256sum "$TARBALL" > "$TARBALL.sha256")

echo "Packed $OUT_DIR/$TARBALL"
echo "Checksum $OUT_DIR/$TARBALL.sha256"
