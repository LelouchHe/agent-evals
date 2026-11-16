#!/bin/sh
# Prepare deps/ and login/ for examples/agents/copilot.yml.
# Usage: ./examples/agents/copilot-setup.sh <target-dir>
# Optional overrides: COPILOT_BIN (copy an existing standalone binary), COPILOT_VERSION (default latest,
# downloaded from the official @github/copilot-<platform> registry tarball when COPILOT_BIN is unset).
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <target-dir>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64" ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m) (macOS required)" >&2; exit 1 ;;
esac

mkdir -p "$1"
ROOT="$(cd "$1" && pwd)"
DEPS="$ROOT/deps"
LOGIN="$ROOT/login"
mkdir -p "$DEPS/.local/bin" "$DEPS/.copilot"
mkdir -p -m 700 "$LOGIN"

if [ -n "${COPILOT_BIN:-}" ]; then
  cp "$COPILOT_BIN" "$DEPS/.local/bin/copilot"
else
  VERSION="${COPILOT_VERSION:-latest}"
  PKG="@github/copilot-${PLATFORM}"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  TARBALL_URL="$(curl -fsSL "https://registry.npmjs.org/${PKG}/${VERSION}" | node -e '
    const fs = require("node:fs");
    const meta = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!meta.dist || !meta.dist.tarball) process.exit(1);
    process.stdout.write(meta.dist.tarball);
  ')"
  curl -fsSL "$TARBALL_URL" -o "$TMP/copilot.tgz"
  tar -xzf "$TMP/copilot.tgz" -C "$TMP"
  cp "$TMP/package/copilot" "$DEPS/.local/bin/copilot"
fi
chmod 755 "$DEPS/.local/bin/copilot"
cp "$SCRIPT_DIR/copilot-settings.json" "$DEPS/.copilot/settings.json"

cat <<EOF

Prepared GitHub Copilot CLI harness directories:
  COPILOT_DEPS=$DEPS
  COPILOT_LOGIN=$LOGIN

Next: add those two lines to .env, then run:
  npm run eval -- login examples/agents/copilot.yml
  npm run eval -- config examples/agents/copilot.yml
EOF
