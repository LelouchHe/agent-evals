# Setup

Requirements: Node.js 24+ and macOS with `/usr/bin/sandbox-exec`. `view` needs neither a harness nor credentials; `run` needs the selected harness prepared as below, plus an installed `pi` CLI and provider key whenever a case uses `$type: judge` or the native `pi` runner.

## Install the CLI

From a source checkout (`npm run eval` rebuilds `dist/` first):

```sh
npm ci
npm run eval -- --help
```

To install the private package into a separate prefix (for example to run concurrent evaluations without rebuilding `dist/` underneath them):

```sh
npm pack --pack-destination /tmp
npm install --prefix /tmp/agent-evals-install /tmp/agent-evals-0.0.0.tgz
/tmp/agent-evals-install/node_modules/.bin/agent-evals --help
```

Both entry points execute the same built `dist/cli.js`. The tarball includes built runtime assets, package metadata, `README.md`, `LICENSE` and `.env.example`, never source/tests/dev tooling or actual `.env` files. It is a Node.js package, not a standalone binary; installation does not require the source checkout, TypeScript, Husky or Git metadata.

## Credentials and `.env`

Start from [`.env.example`](../.env.example) in the directory where you invoke `agent-evals`:

```sh
cp .env.example .env
```

Runner and checker parameters reference entries with `${env:NAME}` ([syntax and placeholder rules](configuration.md#placeholders)). There is no host-environment fallback: only names referenced by the selected case or agent file are read, lazily and cached once per run. `view` never reads `.env` or runs lookups.

Each entry in `.env` is either a plain string or a `!`-prefixed lookup command:

```dotenv
OPENCODE_API_KEY=replace-with-your-local-key
# Or a trusted local lookup command:
OPENCODE_API_KEY="!security find-generic-password -w -s opencode-api-key"

PI_DEPS=/absolute/path/to/agent-evals-home/pi/deps
PI_LOGIN=/absolute/path/to/agent-evals-home/pi/login
CLAUDE_DEPS=/absolute/path/to/agent-evals-home/claude/deps
CLAUDE_LOGIN=/absolute/path/to/agent-evals-home/claude/login
CLAUDE_OAUTH_TOKEN="!security find-generic-password -w -s claude-oauth-token"
COPILOT_DEPS=/absolute/path/to/agent-evals-home/copilot/deps
COPILOT_LOGIN=/absolute/path/to/agent-evals-home/copilot/login
```

Lookup commands execute as trusted operator code from the invocation directory, with the operator environment. Node `execFile` applies a five-second timeout, a 64 KiB output limit and direct-process cancellation; descendants are operator-owned. Failures report entry names and exit status without printing raw command output, and are not retried.

`${env:NAME}` is a value source, not a secrecy flag: implementations own their outputs and the engine does not redact by field name. Always use placeholders rather than literal keys in YAML, because declared literals are retained in `result.json`. Keep `.env` private and out of Git, and never execute untrusted lookup commands.

## Prepare ACP Harnesses

The generic [`acp` runner](configuration.md#acp-runner-type-acp) does not touch your everyday `HOME` or global tool installations. For each harness you evaluate, prepare two separate directories outside the repository:

- **`deps`** — runnable software and evaluation-specific user settings, laid out like `HOME`. Recreated as directories with read-only file symlinks inside each run's temporary `HOME` (directory symlinks and special files are unsupported).
- **`login`** — evaluation-owned credentials and state files at `HOME`-relative paths, separate from everyday sessions. Copied into each run's `HOME`, with modified originals copied back after the sandbox stops.

```text
agent-evals-home/
  pi/
    deps/
      .local/bin/                node, npm, pi, pi-acp (links into .local/share)
      .local/share/node/         official Node.js 24+ distribution
      .local/share/pkgs/         npm install of @earendil-works/pi-coding-agent and pi-acp
      .pi/agent/settings.json
    login/
      .pi/agent/auth.json        populated by agent-evals login (keep only needed providers)
  claude/
    deps/
      .local/bin/                node, claude-agent-acp, claude (link to the SDK's bundled binary)
      .local/share/node/         official Node.js 24+ distribution
      .local/share/pkgs/         npm install of @agentclientprotocol/claude-agent-acp
      .claude/settings.json
    login/
      .claude.json               state file; authentication comes from CLAUDE_OAUTH_TOKEN
  copilot/
    deps/
      .local/bin/                copilot (standalone SEA binary)
      .copilot/settings.json
    login/
      .copilot/config.json       plaintext OAuth account state
```

Checked-in agent configurations live under [`examples/agents/`](../examples/agents/): [`pi.yml`](../examples/agents/pi.yml), [`claude.yml`](../examples/agents/claude.yml) and [`copilot.yml`](../examples/agents/copilot.yml).

### Pi (`pi.yml`)

1. Unpack an official Node.js 24+ archive into `$PI_DEPS/.local/share/node`, install `@earendil-works/pi-coding-agent` and the [`pi-acp`](https://github.com/LelouchHe/pi-acp) adapter under `$PI_DEPS/.local/share/pkgs`, and link `node`, `npm`, `pi` and `pi-acp` into `$PI_DEPS/.local/bin` (also place `fd` and `rg` there if interactive startup needs them).
2. Write `$PI_DEPS/.pi/agent/settings.json` so project-level skills load without interactive trust prompts:

   ```json
   {
     "quietStartup": true,
     "defaultProjectTrust": "always",
     "enableInstallTelemetry": false,
     "retry": { "enabled": false }
   }
   ```

3. Authenticate into `$PI_LOGIN` through the sandboxed helper:

   ```sh
   npm run eval -- login examples/agents/pi.yml
   ```

### Claude Code (`claude.yml`)

1. Unpack Node.js 24+ into `$CLAUDE_DEPS/.local/share/node`, install `@agentclientprotocol/claude-agent-acp` under `$CLAUDE_DEPS/.local/share/pkgs`, and link `node`, `claude-agent-acp` and the bundled `claude` binary (`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`) into `$CLAUDE_DEPS/.local/bin`. Create an empty `$CLAUDE_LOGIN` directory (or `.claude.json` containing `{}`).
2. Write `$CLAUDE_DEPS/.claude/settings.json` to keep account-synced skills and remote connectors out of runs:

   ```json
   {
     "theme": "auto",
     "syncClaudeAiSkills": false,
     "disableClaudeAiConnectors": true
   }
   ```

3. Authenticate with a one-year [`claude setup-token`](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) subscription token (never refreshed, so idle periods and concurrent runs do not invalidate your everyday login; requires Pro, Max, Ultra, Team or Enterprise — use `ANTHROPIC_API_KEY` instead for heavy automated runs):

   ```sh
   # Opens browser authorization and prints the token without saving it:
   "$CLAUDE_DEPS/.local/bin/claude" setup-token
   # Store in macOS Keychain (-w last prompts without echoing into shell history):
   security add-generic-password -U -a "$USER" -s claude-oauth-token -w
   ```

   Reference it in `.env` as `CLAUDE_OAUTH_TOKEN="!security find-generic-password -w -s claude-oauth-token"`. [`claude.yml`](../examples/agents/claude.yml) also sets `CLAUDE_CODE_TMPDIR: ${TMPDIR}` because Claude Code ignores `TMPDIR` and otherwise writes to `/tmp/claude-<uid>`, which Seatbelt denies.

### GitHub Copilot CLI (`copilot.yml`)

1. Copy the standalone `copilot` binary into `$COPILOT_DEPS/.local/bin/copilot` (`chmod 755`).
2. Write `$COPILOT_DEPS/.copilot/settings.json` so credentials persist in `HOME` instead of the operator's login keychain and Copilot's own Seatbelt sandbox stays off inside ours:

   ```json
   {
     "storeTokenPlaintext": true,
     "sandbox": { "enabled": false }
   }
   ```

3. Authenticate via `npm run eval -- login examples/agents/copilot.yml`, or seed `$COPILOT_LOGIN/.copilot/config.json` (`chmod 600`) with `copilotTokens`, `authTokens`, `lastLoggedInUser` and `loggedInUsers` from an existing sign-in. [`copilot.yml`](../examples/agents/copilot.yml) sets `COPILOT_ALLOW_ALL: "true"` (trusts the workspace so project skills load), `COPILOT_AUTO_UPDATE: "false"`, `COPILOT_DISABLE_LOGIN_SHELL_ENV: "1"`, `COPILOT_SYSTEM_PROXY: "0"` and `COPILOT_TELEMETRY_DISABLED: "true"`.

## Verify Readiness

Check configuration resolution without credentials, run the offline `noop` baseline before spending tokens, and query each prepared harness's advertised models and options (`config` runs `initialize` and `session/new` inside the sandbox without sending a prompt):

```sh
npm run eval -- view examples/cases/deploy-runbook/case.yml --case baseline
npm run eval -- run examples/cases/deploy-runbook/case.yml --case baseline # expected to fail positive checks
npm run eval -- config examples/agents/pi.yml
npm run eval -- config examples/agents/claude.yml
npm run eval -- config examples/agents/copilot.yml
```
