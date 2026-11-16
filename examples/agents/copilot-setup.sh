#!/bin/sh
# Prepare deps/ and login/ for examples/agents/copilot.yml.
# Usage: ./examples/agents/copilot-setup.sh <target-dir>
# Optional overrides: COPILOT_BIN (copy an existing native Mach-O standalone binary),
# COPILOT_VERSION (default latest, downloaded from @github/copilot-<platform> when COPILOT_BIN is unset).
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <target-dir>" >&2
  exit 1
fi


case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64" ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m) (macOS required)" >&2; exit 1 ;;
esac

mkdir -p "$1"
ROOT="$(cd "$1" && pwd)"
DEPS="$ROOT/deps"
LOGIN="$ROOT/login"
mkdir -p "$DEPS/bin"
mkdir -p -m 700 "$LOGIN"

WORK_TMP=""
cleanup() {
  [ -z "$WORK_TMP" ] || rm -rf "$WORK_TMP"
}
trap cleanup EXIT

if [ -n "${COPILOT_BIN:-}" ]; then
  if [ ! -f "$COPILOT_BIN" ]; then
    echo "COPILOT_BIN does not exist: $COPILOT_BIN" >&2
    exit 1
  fi
  case "$(/usr/bin/file -bL "$COPILOT_BIN")" in
    *Mach-O*) ;;
    *)
      echo "COPILOT_BIN must point to a standalone native Mach-O binary (not an npm JS wrapper): $COPILOT_BIN" >&2
      echo "Omit COPILOT_BIN to download the standalone platform binary automatically." >&2
      exit 1
      ;;
  esac
  cp "$COPILOT_BIN" "$DEPS/bin/copilot"
else
  VERSION="${COPILOT_VERSION:-latest}"
  PKG="@github/copilot-${PLATFORM}"
  WORK_TMP="$(mktemp -d)"
  TARBALL_URL="$(curl -fsSL "https://registry.npmjs.org/${PKG}/${VERSION}" | node -e '
    const fs = require("node:fs");
    const meta = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!meta.dist || !meta.dist.tarball) process.exit(1);
    process.stdout.write(meta.dist.tarball);
  ')"
  curl -fsSL "$TARBALL_URL" -o "$WORK_TMP/copilot.tgz"
  tar -xzf "$WORK_TMP/copilot.tgz" -C "$WORK_TMP"
  cp "$WORK_TMP/package/copilot" "$DEPS/bin/copilot"
fi
chmod 755 "$DEPS/bin/copilot"

cat <<EOF

Prepared GitHub Copilot CLI harness directories:
  COPILOT_DEPS=$DEPS
  COPILOT_LOGIN=$LOGIN

Next: add those two lines to .env, then run:
  npm run eval -- login examples/agents/copilot.yml
  npm run eval -- config examples/agents/copilot.yml
EOF
