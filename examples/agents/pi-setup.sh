#!/bin/sh
# Prepare deps/ and login/ for examples/agents/pi.yml.
# Usage: ./examples/agents/pi-setup.sh <target-dir>
# Optional overrides: NODE_VERSION (default v24.22.3), PI_ACP_SPEC (default pi-acp; set to a
# packed .tgz or checkout directory to install a local pi-acp fork).
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

NODE_VERSION="${NODE_VERSION:-v24.22.3}"
PI_ACP_SPEC="${PI_ACP_SPEC:-pi-acp}"

mkdir -p "$1"
ROOT="$(cd "$1" && pwd)"
DEPS="$ROOT/deps"
LOGIN="$ROOT/login"
mkdir -p "$DEPS/.local/bin" "$DEPS/.local/share/pkgs" "$DEPS/.pi/agent"
mkdir -p -m 700 "$LOGIN"

if [ ! -x "$DEPS/.local/share/node/bin/node" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  ARCHIVE="node-${NODE_VERSION}-${PLATFORM}.tar.gz"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}" -o "$TMP/$ARCHIVE"
  rm -rf "$DEPS/.local/share/node"
  mkdir -p "$DEPS/.local/share/node"
  tar -xzf "$TMP/$ARCHIVE" -C "$DEPS/.local/share/node" --strip-components=1
fi

NODE_BIN="$DEPS/.local/share/node/bin"
if [ -d "$PI_ACP_SPEC" ] && [ -f "$PI_ACP_SPEC/package.json" ]; then
  PACK_TMP="${TMP:-$(mktemp -d)}"
  trap 'rm -rf "$PACK_TMP"' EXIT
  TGZ="$(cd "$PI_ACP_SPEC" && PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" pack --silent --pack-destination "$PACK_TMP" | tail -n 1)"
  PI_ACP_INSTALL="$PACK_TMP/$TGZ"
else
  PI_ACP_INSTALL="$PI_ACP_SPEC"
fi

[ -f "$DEPS/.local/share/pkgs/package.json" ] || printf '%s\n' '{"private":true}' > "$DEPS/.local/share/pkgs/package.json"
PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" install --prefix "$DEPS/.local/share/pkgs" --no-audit --no-fund \
  @earendil-works/pi-coding-agent "$PI_ACP_INSTALL"

ln -sfn ../share/node/bin/node "$DEPS/.local/bin/node"
ln -sfn ../share/node/bin/npm "$DEPS/.local/bin/npm"
ln -sfn ../share/pkgs/node_modules/.bin/pi "$DEPS/.local/bin/pi"
ln -sfn ../share/pkgs/node_modules/.bin/pi-acp "$DEPS/.local/bin/pi-acp"
cp "$SCRIPT_DIR/pi-settings.json" "$DEPS/.pi/agent/settings.json"

cat <<EOF

Prepared Pi harness directories:
  PI_DEPS=$DEPS
  PI_LOGIN=$LOGIN

Next: add those two lines to .env, then run:
  npm run eval -- login examples/agents/pi.yml
  npm run eval -- config examples/agents/pi.yml
EOF
