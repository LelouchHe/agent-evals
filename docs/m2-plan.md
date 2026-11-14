# M2: Observable Runs

Status: partial implementation. Step A.1 is implemented: the preparation helpers and the ACP evaluation runner. The ACP runner retains a merged trace; trace evidence for the judge, Claude Code and mocks remain planned. [Writing Cases](cases.md#the-test-model) defines the trace, interaction and side-effect sources this milestone makes real. Current usage is documented in [Configuration Reference](configuration.md#acp-runner-type-acp); a full installation walkthrough is not yet verified.

## Scope

Two independent parts. Neither depends on the other's mechanism.

- **A. Trace.** One generic ACP runner records a normalized trace of each run; output is the trace's user-facing view. Checks can assert on output and trace. Delivered in three steps:
  1. The generic ACP runner with a caller-prepared harness home (`deps` and `login`), ACP config validation, the standalone `config` and `login` preparation commands; Pi through pi-acp reproduces the native runner's example results.
  2. The runner assembles and retains the trace (done); the judge can take the trace as evidence.
  3. Claude Code runs through the same runner with only its own `deps` and `login`, proving no harness-specific code is needed.
- **B. Mocks.** Case-owned mocks replace collaborators at the environment boundary and record the calls that reach them. Checks can assert on those records.

Not in scope: multi-turn authoring beyond what ACP gives for free, network mocks, Linux. Deferred: the credential proxy and sandbox network restriction (see [Decisions](#decisions)).

## Delivered Preparation Slice

[PR #2](https://github.com/LelouchHe/agent-evals/pull/2), merged as `858d8e2` on 2026-11-13, delivered the standalone `config` and `login` helpers, their shared Zod configuration, isolated HOME assembly and supervised process cleanup. This is part of step A.1, not completion of that step. [Configuration Reference](configuration.md#acp-preparation-helpers) owns the current command contract.

- **Verification:** 157 model-free tests passed with no failures or skips; the external production-only package installation verified dependency isolation and installed helper execution. Independent reviews and closure checks completed.
- **Live Pi checks:** the checked-in agent configuration returned actual ACP options. A separate temporary configuration using `command: [/usr/bin/env, PI_OFFLINE=1, pi]` opened Pi's native `/login` menu and exited normally. No new authentication or model prompt was performed, credential contents were unchanged and no runtime directory remained. This does not verify the default interactive startup path; neither the repository example nor the toolkit has a default offline mode.

## Delivered ACP Runner

The registered `acp` runner completes step A.1. It reuses the helpers' HOME assembly, sandbox policy and supervisor inside the engine's run directories; [Configuration Reference](configuration.md#acp-runner-type-acp) owns its contract.

- **Verification:** model-free tests cover a full run (path-referenced agent, session config, fixture workspace, output, login copy-back, runtime removal), rejection of an unoffered config value before prompting, and cancellation of a hung turn.
- **Live Pi check (2026-11-13):** [`deploy-runbook-acp`](../examples/cases/deploy-runbook-acp/case.yml) through pi-acp with `opencode-go/deepseek-v4.1-flash` reproduced the native example: `with-skill` passed all three checks after loading the skill from the workspace's `.agents/skills/`; `without-skill` failed the pattern and judge checks. One run each.
- **Trace (A.2, first part):** the runner merges session updates into `trace.json` ([format](configuration.md#inspecting-and-recording)). A live `deploy-runbook-acp` `with-skill` run produced a 7 KB trace showing the log read, the `SKILL.md` read and the written diagnosis.
- **Still planned:** trace evidence for the judge (A.2), Claude Code (A.3), mocks (B). The native Pi runner stays.

## Runner Configuration

The runner's `agent` parameter accepts an inline startup object or a path to the same object; one standalone file can be shared across cases. ACP-specific schemas and operations live under `src/runners/acp/`, not in a general harness registry. The engine provides generic YAML/value-source loading and schema validation; operational use belongs to the ACP implementation.

```yaml
runner:
  $type: acp
  agent: ./agents/pi.yml # or inline the same object
  config:
    model: opencode-go/deepseek-v4.1-flash
    thought_level: high
```

The standalone format, shared with the [preparation helpers](configuration.md#acp-preparation-helpers):

```yaml
# agents/pi.yml
command: [pi]
acpCommand: [pi-acp]
home:
  deps: $env:PI_DEPS
  login: $env:PI_LOGIN
  path: [.local/bin]
login:
  - .pi/agent/auth.json
```

`acpCommand` starts the adapter; `command` starts the native interactive program. `home.login` is the persistent directory, and the top-level `login` list describes its HOME-relative file composition. Loading the configuration never performs login. There is no agent `env` field; `$env:NAME` remains a configuration-value source. The same object can ultimately be inlined in a case; a standalone file is optional, reusable or disposable after preparation. Nothing is selected from file or directory names.

Per-case `runner.config` remains separate: keys match an ACP option's category, otherwise its ID. Set model first because other choices may depend on it. Offered values are validated after session creation and before prompting.

Checked-in startup examples: [Pi](../examples/agents/pi.yml), [Claude](../examples/agents/claude.yml).

### Harness home

ACP makes the conversation generic; installing a harness, logging in and its own settings stay harness-specific. The caller prepares two directories per harness. The ACP implementation assembles and removes each temporary HOME; the general engine supplies loading and type validation, not harness-home rules. The helpers and the runner share this setup; the runner assembles into the engine's per-run HOME.

| Part    | The caller puts there                                                                              | ACP setup                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deps`  | Runnable software: the harness, ACP adapter, runtime, non-system commands and user-level settings. | Recreates directories and symlinks files into HOME. The sandbox can read but not write deps.                                                                 |
| `login` | Credentials and login state at HOME-relative paths.                                                | Copies existing files into HOME and copies changed originals back after stopping the sandbox. The source login directory is inaccessible inside the sandbox. |

A relative path in either source appears at the same path under the temporary HOME. Which paths matter is the harness's rule, not ours: Pi expects `~/.pi/agent/auth.json`, so its login directory holds `.pi/agent/auth.json`. ACP setup copies the data without interpreting credential contents.

- The same file in both parts is an error.
- Sessions, caches, locks and other new runtime files are discarded. Ordinary copy-back never adds files to login; the explicit login helper can populate the declared login file list after successful native exit.
- Initially available commands come from the system and deps, not the operator's everyday installation. Each configuration declares its own software and login sources.
- Versions are whatever the caller installed; the operator's everyday installation is neither used nor affected.
- Planned command mocks need nothing in deps: their per-run command directory goes ahead of `home.path`.
- Project-level configuration and skills belong to the workspace: `fixture` supplies the base and a case's `files` entry places the rest, for example `.agents/skills/` for Pi or `.claude/skills/` for Claude Code. `with-skill` places the skill directory there; `without-skill` places nothing.

#### What the directories hold

The directories used for the spikes, outside the repository. Names and locations are the caller's choice.

```text
agent-evals-home/
  pi/
    deps/
      .local/bin/                node, npm, pi, pi-acp   (links into .local/share)
      .local/share/node/         official Node.js
      .local/share/pkgs/         npm install of pi and pi-acp
      .pi/agent/settings.json
    login/
      .pi/agent/auth.json        only the provider the cases use
  claude/
    deps/
      .claude/settings.json      software not installed yet
    login/
      .claude.json
      .claude/.credentials.json
```

Settings that make a harness usable for unattended, isolated runs:

| Harness     | File in `deps`            | Settings                                                                                                                                                                     |
| ----------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi          | `.pi/agent/settings.json` | `"defaultProjectTrust": "always"` so project-level skills load without a prompt; `"quietStartup": true`, `"enableInstallTelemetry": false`, `"retry": { "enabled": false }`. |
| Claude Code | `.claude/settings.json`   | `"syncClaudeAiSkills": false` and `"disableClaudeAiConnectors": true` keep account content out of the run.                                                                   |

#### The assembled HOME

For the Pi directories above with `path: [.local/bin]`, a run sees:

```text
$HOME/                           fresh per run, removed afterwards
  .local/bin/pi                  -> deps   symlink, read-only target
  .local/share/...               -> deps   symlinks
  .pi/agent/settings.json        -> deps   symlink
  .pi/agent/auth.json            copy of login; copied back if changed
  .pi/agent/sessions/            created by Pi during the run; removed
  .pi/agent/models-store.json    created by Pi during the run; removed

PATH=$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

Directories are real, so the harness can create files beside the linked ones. Deps remains read-only; persistent login updates follow the rules above.

### Commands

`agent-evals config <agent.yml>` and `agent-evals login <agent.yml>` take a standalone [ACP startup configuration](#runner-configuration), not a case. They are optional preparation tools, not a harness-registration workflow. npm and the installed CLI use the same command implementation; see [the format and behavior reference](configuration.md#acp-preparation-helpers).

- **Configuration query.** Starts the declared ACP command in the same sandbox and runs only `initialize` and `session/new`. Reports the agent's config option IDs/categories, descriptions, current values and available values with their labels, plus declared auth methods. A caller need not already know or supply valid session config values to discover them. No prompt is sent and no model call is made.
- **Login.** Runs the declared native `command` interactively in the same sandbox with a temporary `HOME` built the same way, then saves the top-level `login` file list into `home.login` after successful completion. The result is stored login data, not printed tokens. Because the sandbox can write nothing else and cannot reach the keychain, a harness that logs in successfully has to store its credentials in `HOME`. ACP auth methods alone are not sufficient: neither tested harness provides a portable ACP-only login flow.

## Decisions

- **One generic ACP runner, no per-harness profiles.** The runner knows ACP, not harnesses; everything harness-specific is data the caller prepares for the [harness home](#harness-home). Pi runs through the local [pi-acp fork](https://github.com/LelouchHe/pi-acp); the native Pi runner stays until the ACP runner covers it.
- **The trace is assembled from ACP updates.** Message and thought chunks are joined; every update for one `toolCallId` is merged into one tool-call record holding its final state. Pi resends cumulative tool output in every update, so keeping intermediate states would grow with output length and add nothing. Runners declare which detail they provide; a check needing missing detail is an error.
- **No field-level tool checks.** Harnesses shape the same action differently: Claude sends an empty `rawInput` first and fills it later, `kind` varies for the same tool, and agents read files through shell commands as often as through read tools. Process questions go to a judge reading the trace; deterministic evidence of what ran comes from mocks.
- **Mocks live at the environment boundary, not in ACP.** ACP session updates are reports, not requests, so they cannot intercept a call. Command mocks are `PATH` shims with the real executable denied by Seatbelt; service mocks are MCP servers injected through `session/new`. Mock behavior and call records live outside the sandbox.
- **The environment is built only from directories the evaluation owns.** The sandbox reads the system directories, `deps` and the run, and nothing else under the operator's home. Granting read access to existing installations was rejected: they sit beside the operator's credentials, and no rule derives a safe installation root for every installer.
- **Credentials sit in `login`.** They reach the sandbox and the agent can read them, as recorded in [M1 limits](m1-plan.md#known-limitations). Keep only what a run needs there; for example, Pi's `login` holds just the one provider's key, not the operator's whole `auth.json`.
- **Login files are copied, not linked.** How a harness rewrites a file is outside our control, so ACP setup copies `login` in and copies its original files back.
- **Credential proxy: verified, deferred.** A proxy outside the sandbox can hold an API key while the harness sees a placeholder and a local model endpoint, letting sandbox network shrink to one local port. It must not carry Claude subscription tokens (see [Credentials for Claude](#credentials-for-claude)). Network stays open for now.
- **Process cleanup is sandbox-wide, not harness-specific.** An in-sandbox supervisor launches the workload and sends `SIGKILL` to all signalable processes on completion or a stop request. Seatbelt's `(allow signal (target same-sandbox))` rule limits this to that instance, including orphaned processes and new sessions. The helpers implement this with a private workload-completion pipe, not an agent-writable status file or the supervisor's SIGKILL exit status. The ACP runner reuses it for completion, timeout and cancellation. The native Pi runner and its tracked-group cleanup are unchanged.
- **The case is not the environment.** Case files, mock implementations, control configuration and results stay outside everything the agent can read. The environment is the fixture and the run's `HOME`.

## Verified Constraints

Earlier spike versions: Pi 1.5.2, pi-acp fork 0.0.34, Claude Code 2.1.318, `claude-agent-acp` 0.101.0, ACP SDK 0.26.0, macOS Seatbelt.

The implemented helpers now use ACP SDK 2.6.0 and its stable ACP v1 app API (`client().connectWith()` and typed method requests). The SDK package version does not select experimental ACP v2; earlier spike evidence below retains its original version scope.

### ACP

- Both agents expose `configOptions` with standard categories: Pi offers `model` and `thought_level`; Claude Code offers `model`, `thought_level` (id `effort`), `mode` and `model_config` options.
- ACP has an unstable `env_var` auth method that names required variables, but neither agent uses it: pi-acp advertises only an interactive terminal login and `claude-agent-acp` advertises none. Claude Code reports missing auth with the standard `-32000`; pi-acp does too at `session/new`, while a rejected key surfaces as an internal error carrying the provider's 401.
- ACP client file-system and terminal methods are not an interception point: pi-acp does not use them, and an ACP v2 [RFD](https://agentclientprotocol.com/rfds/v2/client-filesystem-terminal-capabilities) proposes removing them.

### Trace detail per harness

| Detail                     | Pi via pi-acp                                                              | Claude Code via `claude-agent-acp`                                          |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Messages, tool calls, kind | Yes; `rawInput` complete on the first `tool_call`                          | Yes; first `tool_call` has empty `rawInput`, the command arrives in updates |
| Reasoning                  | `agent_thought_chunk`                                                      | None observed with `haiku`                                                  |
| Per-turn tokens            | Not in the prompt response                                                 | `session/prompt` result `usage` (marked unstable in ACP)                    |
| Context and cost           | `usage_update`                                                             | `usage_update`                                                              |
| Permission requests        | None                                                                       | Before commands and MCP calls in `default` mode                             |
| Skill loading              | Listed in `available_commands_update`; use shows as a `read` of `SKILL.md` | Listed in `available_commands_update`                                       |

### Harness home

- A `deps` directory holding official Node 24.22.2, `pi` 1.5.2 and the packed pi-acp fork under `.local/`, plus Pi's settings (`defaultProjectTrust: "always"`), ran the example with no read access to the operator's own Pi, Node or pi-acp: `with-skill` loaded `skill:deploy-runbook` from the workspace's `.agents/skills/` and found the fix. No `PI_CODING_AGENT_DIR`, wrapper script or extra flags were needed.
- Mirroring that installation, about 21,000 files, took 0.7 s and removing it 0.6 s. The policy needs one `subpath` rule per directory; one rule per mirrored file failed to compile.
- Linking login files into the run failed in both directions. Pi locks the resolved path of `auth.json` and needed write access beside the real file. Claude Code rewrote `.claude.json` through its link but replaced the `.credentials.json` link with a new file, so a refreshed token, whose refresh token had rotated, stayed in the run and would have been deleted.
- Copying `login` in and copying its original files back fixed both without harness rules: Pi ran with no extra write rule and left `auth.json` unchanged; a forced Claude token refresh was copied back and the next run authenticated with it. `login` gained no files in any run.
- Claude Code changes `.claude.json` on every run (feature-flag cache and timestamps), so that login state is copied back each time.

### Claude Code

- `claude` run interactively in the sandbox with a fresh `HOME` logged in to the operator's subscription and wrote `.claude/.credentials.json` and `.claude.json` into that `HOME`. The keychain was not touched, so the operator's normal login stayed separate. Runs from that login authenticated.
- A subscription login brings account content into every run: about 15 claude.ai skills and claude.ai MCP connectors such as Claude Docs. Connectors run on Anthropic's side, outside our sandbox. `"disableClaudeAiConnectors": true` and `"syncClaudeAiSkills": false` in `deps`'s `.claude/settings.json` removed both; the environment variable `ENABLE_CLAUDEAI_MCP_SERVERS=false` also removes connectors.
- It needs `CLAUDE_CODE_TMPDIR`, because it otherwise uses the shared `/tmp/claude-<uid>`; it ignores `TMPDIR`. It also refuses to start in an unreadable working directory.
- Seatbelt cannot nest: `sandbox-exec` inside Seatbelt fails with `sandbox_apply: Operation not permitted`. Claude Code's own sandbox is off by default; with `sandbox.enabled: true` it fails to start, refuses that command, then disables itself for the session. A fixture's `.claude/settings.json` or managed settings under `/Library/Application Support/ClaudeCode/` can turn it on. Claude Code's own sandbox cannot be evaluated inside ours.
- No `mach-lookup` is needed. The keychain is unreachable from the sandbox because the login keychain file under the real `HOME` is unreadable.

### Pi through pi-acp

- Injected MCP tools need `_meta.directTools: true` on the server entry; a `--tools` allowlist must include `mcp__<server>__*`.
- `models.json` `baseUrl` plus a placeholder `apiKey` routes Pi through a credential proxy; `env` inside the sandbox then shows no key.

### Sandbox

- Node's resolver needs read access to the `/var` symlink; without it DNS fails under Seatbelt.
- The agent's working directory must be readable, and only the prepared workspace is.
- Interactive Pi needs terminal-mode ioctl permission, not just terminal reads/writes. A live offline UI check opened its `/login` menu and exited normally using the helper, without new authentication, credential-content changes or model prompts; automatic `fd`/`rg` downloads were disabled explicitly for that check. The initial prototype login policies allowed all file ioctls; the implemented helper scopes termios setters to the current terminal.

### Process cleanup

Three sequential probes used sandbox A, sandbox B created independently from the same policy, and an unsandboxed control process:

- Sending `SIGURG` by PID from A succeeded for A's process and was denied for B and the outside control.
- Broadcasting `SIGURG` with `kill -URG -1` inside A reached A's ready signal handler, but neither ready control handler. The command returned success.
- Broadcasting `SIGKILL` inside A removed its supervisor shell, ordinary background process, orphaned `nohup` process and orphaned new-session process. B and the outside control survived and were then explicitly cleaned up. No matching test processes remained.

A subsequent `/bin/sh` supervisor prototype launched a model-free harness through the production `spawnSandboxed` helper and generated Seatbelt policy. Five cases passed: normal exit 0, normal exit 7, a deadline-triggered `SIGTERM`, explicit `SIGINT` cancellation, and `SIGTERM` with a harness that ignores both stop signals. Each case first verified live ordinary, orphaned `nohup` and orphaned new-session processes; after cleanup none remained. An independent sandbox using the same policy and an unsandboxed control survived every case. The prototype also forwarded stdin, stdout and stderr. These are prototype lifecycle probes, not tests of the unimplemented ACP runner or the engine's timeout/cancellation wiring.

The broadcast also killed the prototype supervisor, so its OS exit status could not carry the workload result. The implemented helper supervisor now reports that result through a private pipe that the workload does not inherit. Production runtime tests cover native exit 0/7 and explicit stop, with live ordinary/orphan/new-session processes and surviving independent sandbox/host controls; helper tests also cover cancellation and primary-error preservation. Agent-writable files are not a trusted completion channel.

This verifies the helper components on the tested macOS host, not the future evaluation runner's engine integration or recovery from forced supervisor death.

### Mocks

- A `make` shim recorded direct calls and calls from inside a script, in both harnesses. `/usr/bin/make` by absolute path was denied by Seatbelt (exit 126).
- An MCP mock server was called through the harness tool in both harnesses; tool names were `mcp__<server>__<tool>` in both.

### Agent behavior that shapes the design

Without being asked, an agent listed its run directory, read a control file that contained a key, read mock logs and source, identified the mocks, and ran a mock server by hand, which created a false call record. Hence: nothing but the environment is readable, mock records are kept by the engine, and mocks are not assumed undetectable.

### Credentials for Claude

Anthropic's [legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance.md) reserve subscription OAuth for ordinary use of Claude Code and native apps and forbid intermediating Claude.ai credentials or session tokens; a proxy that swaps a subscription token does exactly that. Logging in to the unmodified Claude Code with the operator's own subscription, as `login` does, involves no intermediary. Subscription limits assume ordinary individual use; heavy automated evaluation should use a Console API key.

## Not Yet Verified

- Pi's default interactive path with `fd` and `rg` prepared in deps, using the checked-in agent YAML unchanged. The successful live UI check used the temporary offline command above; fresh authentication was not repeated.
- A Claude Code `deps` directory: the runs above still read `claude-agent-acp` from the operator's Node installation, and whether it needs a separate `claude` command is unchecked.
- Reporting the paths Seatbelt denied when an agent fails to start; a first query of the system log returned nothing.
- HTTP service mocks and model-provider fault injection, which would also need the proxy.

## Open Questions

- `CLAUDE_CODE_TMPDIR`: a generic way to point Claude Code at the run's temporary directory, or an accepted documented exception.
- Concurrent runs sharing one `login`: two token refreshes would overwrite each other.
- Permission answering: the runner currently approves every request; whether and how a case configures this is open.
- Mock syntax, where call expectations live, and the default for unmatched calls. Command mocks sit in a per-run directory ahead of `home.path`.
- MCP server names: a mock must use the real server's name to look the same, and harnesses may format tool names differently.
- Trace truncation: tool output is retained as the harness reports it.
