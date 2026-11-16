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
mkdir -p "$DEPS/bin" "$DEPS/share/pkgs"
mkdir -p -m 700 "$LOGIN"

WORK_TMP=""
cleanup() {
  [ -z "$WORK_TMP" ] || rm -rf "$WORK_TMP"
}
trap cleanup EXIT

if [ ! -x "$DEPS/share/node/bin/node" ]; then
  WORK_TMP="$(mktemp -d)"
  ARCHIVE="node-${NODE_VERSION}-${PLATFORM}.tar.gz"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}" -o "$WORK_TMP/$ARCHIVE"
  rm -rf "$DEPS/share/node"
  mkdir -p "$DEPS/share/node"
  tar -xzf "$WORK_TMP/$ARCHIVE" -C "$DEPS/share/node" --strip-components=1
fi

NODE_BIN="$DEPS/share/node/bin"
if [ -d "$PI_ACP_SPEC" ] && [ -f "$PI_ACP_SPEC/package.json" ]; then
  [ -n "$WORK_TMP" ] || WORK_TMP="$(mktemp -d)"
  TGZ="$(cd "$PI_ACP_SPEC" && PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" pack --silent --pack-destination "$WORK_TMP" | tail -n 1)"
  PI_ACP_INSTALL="$WORK_TMP/$TGZ"
else
  PI_ACP_INSTALL="$PI_ACP_SPEC"
fi

[ -f "$DEPS/share/pkgs/package.json" ] || printf '%s\n' '{"private":true}' > "$DEPS/share/pkgs/package.json"
PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" install --prefix "$DEPS/share/pkgs" --no-audit --no-fund \
  @earendil-works/pi-coding-agent "$PI_ACP_INSTALL"

ln -sfn ../share/node/bin/node "$DEPS/bin/node"
ln -sfn ../share/node/bin/npm "$DEPS/bin/npm"
ln -sfn ../share/pkgs/node_modules/.bin/pi "$DEPS/bin/pi"
ln -sfn ../share/pkgs/node_modules/.bin/pi-acp "$DEPS/bin/pi-acp"

cat <<EOF

Prepared Pi harness directories:
  PI_DEPS=$DEPS
  PI_LOGIN=$LOGIN

Next: add those two lines to .env, then run:
  npm run eval -- login examples/agents/pi.yml
  npm run eval -- config examples/agents/pi.yml
EOF
