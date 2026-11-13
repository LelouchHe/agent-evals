# M2: Observable Runs

Status: design. Decisions and verified constraints below come from a throwaway spike on 2026-11-12; no M2 code is implemented. [Writing Cases](cases.md#the-test-model) defines the trace, interaction and side-effect sources this milestone makes real.

## Scope

Two independent parts. Neither depends on the other's mechanism.

- **A. Trace.** An ACP runner records a normalized trace of each run; output is the trace's user-facing view. Checks can assert on output and trace. Delivered in three steps:
  1. A generic ACP runner runs Pi through pi-acp with M1-equivalent isolation and results; the example behaves as with the native runner.
  2. The runner assembles and retains the trace; checks assert on output and tool calls.
  3. A Claude Code launch profile proves the runner is generic, tested model-free with a scripted API; a live run waits for an API key.
- **B. Mocks.** Case-owned mocks replace collaborators at the environment boundary and record the calls that reach them. Checks can assert on those records.

Not in scope: multi-turn authoring beyond what ACP gives for free, network mocks, Linux. Deferred: the credential proxy and sandbox network restriction (see below).

## Decisions

- **ACP is the runner transport.** One generic ACP client (initialize, session, prompt, trace, permission answers, MCP server injection) plus one launch profile per harness. Pi runs through the local [pi-acp fork](https://github.com/LelouchHe/pi-acp). The native Pi runner stays until the ACP runner covers it.
- **Launch profiles are harness-specific by nature.** A profile supplies the command, isolated configuration files and environment, skill placement, what to disable, how the model endpoint and a placeholder credential are set, and the provider API format.
- **The trace is assembled from ACP updates.** Message and thought chunks are joined; every update for one `toolCallId` is merged into one tool-call record. Runners declare which detail they provide; a check needing missing detail is an error.
- **Mocks live at the environment boundary, not in ACP.** ACP session updates are reports, not requests, so they cannot intercept a call. Command mocks are `PATH` shims with the real executable denied by Seatbelt; service mocks are MCP servers injected through `session/new`. Mock behavior and call records live outside the sandbox.
- **Credential proxy: verified, deferred.** A proxy outside the sandbox can hold the real credential while the harness sees a placeholder and a local model endpoint, letting sandbox network shrink to one local port. It works for API keys, but must not carry Claude subscription tokens (see [Credentials for Claude](#credentials-for-claude)). M2 keeps the current behavior: credentials reach the harness environment and network stays open, as recorded in [M1 limits](m1-plan.md#known-limitations).
- **The case is not the environment.** Case files, mock implementations, control configuration, credentials and results stay outside everything the agent can read.

## Verified Constraints

Versions: Pi 1.5.2, pi-acp fork 0.0.34, `claude-agent-acp` 0.101.0, ACP SDK 0.26.0, macOS Seatbelt.

**Trace detail per harness**

| Detail                     | Pi via pi-acp                                                              | Claude Code via `claude-agent-acp`                                          |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Messages, tool calls, kind | Yes; `rawInput` complete on the first `tool_call`                          | Yes; first `tool_call` has empty `rawInput`, the command arrives in updates |
| Reasoning                  | `agent_thought_chunk`                                                      | None observed with `haiku`                                                  |
| Per-turn tokens            | Not in the prompt response                                                 | `session/prompt` result `usage` (marked unstable in ACP)                    |
| Context and cost           | `usage_update`                                                             | `usage_update`                                                              |
| Permission requests        | None                                                                       | Before commands and MCP calls in `default` mode                             |
| Skill loading              | Listed in `available_commands_update`; use shows as a `read` of `SKILL.md` | Not checked                                                                 |

The credential proxy sees every model response, so it can also measure token usage per provider API format, independent of the harness.

**Pi through pi-acp**

- pi-acp starts Pi with fixed arguments. `PI_ACP_PI_COMMAND` pointing at a wrapper script adds the current isolation flags without changing pi-acp; only the declared skill was loaded.
- Injected MCP tools need `_meta.directTools: true` on the server entry, and the `--tools` allowlist must include `mcp__<server>__*`. Otherwise the agent cannot see them.
- `models.json` `baseUrl` plus a placeholder `apiKey` routes Pi through the proxy; `env` inside the sandbox then shows no key.

**Claude Code**

- Runs under our Seatbelt with an isolated `HOME`. It needs `CLAUDE_CODE_TMPDIR`, because it otherwise uses the shared `/tmp/claude-<uid>`.
- Seatbelt cannot nest: `sandbox-exec` inside Seatbelt fails with `sandbox_apply: Operation not permitted`. Claude Code's own sandbox is off by default; with `sandbox.enabled: true` it fails to start, refuses that command, then disables itself for the session. Profiles set `sandbox.enabled: false` explicitly. Project `.claude/settings.json` in a fixture and `/Library/Application Support/ClaudeCode/` managed settings can also change it. Claude Code's own sandbox cannot be evaluated inside ours.
- No `mach-lookup` is needed. The keychain is unreachable from the sandbox because the login keychain file under `HOME` is unreadable.
- With `ANTHROPIC_BASE_URL` and a placeholder `ANTHROPIC_API_KEY`, requests reach the proxy carrying only the placeholder.

**Mocks**

- A `make` shim recorded direct calls and calls from inside a script, in both harnesses. `/usr/bin/make` by absolute path was denied by Seatbelt (exit 126).
- An MCP mock server was called through the harness tool in both harnesses; tool names were `mcp__<server>__<tool>` in both.
- ACP client file-system and terminal methods are not an interception point: pi-acp does not use them, and an ACP v2 [RFD](https://agentclientprotocol.com/rfds/v2/client-filesystem-terminal-capabilities) proposes removing them.

**Agent behavior that shapes the design**

Without being asked, an agent listed its run directory, read a control file that contained a key, read mock logs and source, identified the mocks, and ran a mock server by hand, which created a false call record. Hence: nothing but the environment is readable, mock records are kept by the engine, and mocks are not assumed undetectable.

**Credentials for Claude**

Anthropic's [legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance.md) reserve subscription OAuth for ordinary use of Claude Code and native apps, direct Agent SDK developers to API keys, and forbid intermediating Claude.ai credentials or session tokens. A proxy that swaps a subscription token does exactly that. Live Claude Code evaluation uses a Console API key.

## Not Yet Verified

- A real Claude Code run under Seatbelt with an API key, including which paths it tries to read.
- HTTP service mocks and model-provider fault injection, which would also need the proxy.

## Open Questions

- Launch profile form: one `$type: acp` with a harness name, or one `$type` per harness over shared ACP code.
- Mock syntax, where call expectations live, and the default for unmatched calls.
- Permission answering policy and how a case configures it.
- MCP server names: a mock must use the real server's name to look the same, and harnesses may format tool names differently.
- Normalized trace schema and retention or truncation.
