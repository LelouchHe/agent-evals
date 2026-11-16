#!/bin/sh
# Prepare deps/ and login/ for examples/agents/claude.yml.
# Usage: ./examples/agents/claude-setup.sh <target-dir>
# Optional overrides: NODE_VERSION (default v24.22.3), CLAUDE_ACP_SPEC (default @agentclientprotocol/claude-agent-acp).
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
CLAUDE_ACP_SPEC="${CLAUDE_ACP_SPEC:-@agentclientprotocol/claude-agent-acp}"

mkdir -p "$1"
ROOT="$(cd "$1" && pwd)"
DEPS="$ROOT/deps"
LOGIN="$ROOT/login"
mkdir -p "$DEPS/.local/bin" "$DEPS/.local/share/pkgs" "$DEPS/.claude"
mkdir -p -m 700 "$LOGIN"

WORK_TMP=""
cleanup() {
  [ -z "$WORK_TMP" ] || rm -rf "$WORK_TMP"
}
trap cleanup EXIT

if [ ! -x "$DEPS/.local/share/node/bin/node" ]; then
  WORK_TMP="$(mktemp -d)"
  ARCHIVE="node-${NODE_VERSION}-${PLATFORM}.tar.gz"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}" -o "$WORK_TMP/$ARCHIVE"
  rm -rf "$DEPS/.local/share/node"
  mkdir -p "$DEPS/.local/share/node"
  tar -xzf "$WORK_TMP/$ARCHIVE" -C "$DEPS/.local/share/node" --strip-components=1
fi

NODE_BIN="$DEPS/.local/share/node/bin"
[ -f "$DEPS/.local/share/pkgs/package.json" ] || printf '%s\n' '{"private":true}' > "$DEPS/.local/share/pkgs/package.json"
PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" install --prefix "$DEPS/.local/share/pkgs" --no-audit --no-fund "$CLAUDE_ACP_SPEC"

CLAUDE_REL="../share/pkgs/node_modules/@anthropic-ai/claude-agent-sdk-${PLATFORM}/claude"
if [ ! -x "$DEPS/.local/bin/$CLAUDE_REL" ]; then
  echo "Bundled claude binary not found at $DEPS/.local/bin/$CLAUDE_REL" >&2
  exit 1
fi

ln -sfn ../share/node/bin/node "$DEPS/.local/bin/node"
ln -sfn ../share/pkgs/node_modules/.bin/claude-agent-acp "$DEPS/.local/bin/claude-agent-acp"
ln -sfn "$CLAUDE_REL" "$DEPS/.local/bin/claude"
cp "$SCRIPT_DIR/claude-settings.json" "$DEPS/.claude/settings.json"

if [ ! -f "$LOGIN/.claude.json" ]; then
  umask 077
  printf '%s\n' '{}' > "$LOGIN/.claude.json"
fi

cat <<EOF

Prepared Claude Code harness directories:
  CLAUDE_DEPS=$DEPS
  CLAUDE_LOGIN=$LOGIN

Next: generate a setup-token, store it in Keychain, and set CLAUDE_OAUTH_TOKEN in .env:
  "$DEPS/.local/bin/claude" setup-token
  security add-generic-password -U -a "\$USER" -s claude-oauth-token -w
  npm run eval -- config examples/agents/claude.yml
EOF
