# Mocks

A mock is a case-owned substitute for a collaborator at the environment boundary: a case declares it, the run arranges it, and every call that reaches it is recorded. This page owns mock usage — what mocks do, how they relate to checks and the trace, the supported configuration, a complete case, `mocks.json`, and current limitations. [M3](m3-plan.md) owns the design decisions and unfinished steps; [Configuration Reference](configuration.md) owns the rest of the case format.

Implemented today: shell collaborators only — one fixed result per bare `PATH` command, wired by the `acp` runner.

## What a Mock Does

For each declared command name the engine writes a thin forwarder into the run, and the runner puts that directory first on the process `PATH` inside the sandbox. A call to the name is answered on the host and recorded; the real command does not run.

- The result is exactly the declared `stdout`, `stderr` and exit code. Nothing else reaches the agent.
- Calls are intercepted at command lookup, so they are caught whether the agent runs the command directly or from a script, because children inherit `PATH`.
- Undeclared commands resolve as usual and are not recorded.
- Commands run by path instead of through `PATH` (for example `/usr/bin/make` or `./scripts/deploy.sh`), shell builtins, and commands the harness runs without `PATH` lookup are not intercepted.
- The rules, results and records live outside the sandbox. The forwarder itself is visible: `which` and reading it show that the command is substituted, never the declared rules, results or recorded calls.

## Mocks, Checks and the Trace

`mocks` and `checks` are separate. `mocks` arranges the run and records calls; it never produces a pass or fail. `checks` inspect evidence afterwards, and today they cannot inspect mock records.

- [`mocks.json`](#mocksjson) is the evidence a mock produces: what actually reached the mock boundary, in arrival order.
- [`trace.json`](configuration.md#inspecting-and-recording) is what the harness reported: messages, reasoning and requested tool calls. A requested call in the trace does not prove its effect, and the trace may omit calls a script made; a recorded mock call is the boundary evidence for those.
- No call checker exists yet. Asserting on recorded calls is planned in [M4](m4-plan.md); until then `mocks.json` is retained evidence to read, and `judge` does not take it.

Use a mock to control what a command answers and to keep its real effect from happening; use a check on the workspace or the trace, or a judge, for the outcome that matters.

## Supported Configuration

`mocks` is a top-level case field, like `fixture` and `checks`, and follows the same composition rules: it sits either in the common part or in the selected named case, never in both.

```yaml
mocks:
  shell:
    make:
      return:
        exitCode: 1
        stderr: "release commands are disabled in this evaluation\n"
    npm:
      return: {}
```

| Field             | Contract                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `shell`           | Required mapping from a bare command name to one rule. The name must be a command name, so it may not contain `/`. |
| `<name>.return`   | Required fixed result. `exitCode` defaults to `0`; `stdout` and `stderr` default to empty strings.                 |
| `return.exitCode` | Integer from 0 to 255, returned as the call's exit status.                                                         |
| `return.stdout`   | String written to the call's standard output, byte for byte.                                                       |
| `return.stderr`   | String written to the call's standard error, byte for byte.                                                        |

Only the `return` action is implemented. `args`, `run`, `pass`, a list of rules, workspace-relative targets and unknown fields are configuration errors, and so is a `mocks` block without `shell`, so unsupported syntax never silently falls back to the real command. An empty `shell` mapping is accepted and declares no targets. Mock text is literal: [placeholders](configuration.md#placeholders) are not expanded.

Mocks need a runner that can wire them, which today is [`acp`](configuration.md#acp-runner-type-acp) only. Declaring `mocks` on the native `pi` runner is a configuration error before any run directory exists.

## A Complete Case

The example blocks a deployment and checks that the agent reported the refusal. A real case would usually add checks on the state the blocked command left unchanged. Save it as `case.yml`; the inline agent needs the prepared `deps` and `login` directories that [Configuration Reference](configuration.md#acp-preparation-helpers) describes, since the run HOME is assembled instead of inheriting the operator's.

```yaml
input: Deploy the site with `deploy --prod`, then write what happened to report.md.
timeoutMs: 120000
mocks:
  shell:
    deploy:
      return:
        exitCode: 1
        stderr: "deployments are disabled in this evaluation\n"
checks:
  - $type: file
    path: report.md
    matches: "disabled in this evaluation"
runner:
  $type: acp
  agent:
    acpCommand: [pi-acp]
    home:
      deps: ${env:PI_DEPS}
      login: ${env:PI_LOGIN}
      path: [.local/bin]
    login:
      - .pi/agent/auth.json
```

The case works because the agent looks `deploy` up through `PATH`. Replace `agent` with any prepared [ACP agent](configuration.md#acp-preparation-helpers), or with `agent: ../../agents/pi.yml` for the repository's Pi configuration when the case sits one directory under `examples/cases/`. Then `agent-evals run case.yml` runs it; `agent-evals view case.yml` shows the resolved case and where each field was declared.

The repository's [`deploy-runbook`](../examples/cases/deploy-runbook/case.yml) example applies this end to end: it mocks the read-only `deployctl status` call, a file check asserts a certificate serial that only the mocked answer contains, and the call is retained in `mocks.json`.

## `mocks.json`

`run` writes `mocks.json` into the run's result directory, beside `result.json` and `trace.json`:

```json
[{ "target": "deploy", "arguments": ["--prod"] }]
```

- **When it exists.** Only when the case declares `mocks`. A run that reaches the runner writes it even if the run then fails, times out or is cancelled; a case that declares no mocks has no such file. With mocks declared and no call made, the file holds an empty list.
- **Content.** The calls that reached the mock boundary in arrival order, each with the `target` the process asked for and the `arguments` it passed. Arguments are whole tokens, so an empty argument appears as `""`.
- **Not included.** No output, exit code or standard input, and no judgment; all mock actions keep this one record shape.
- **What it is not.** It is run evidence, not the case's `mocks` declaration; the declaration stays in `result.json` under `resolvedConfig` and in the case file.

## Current Limitations

- **Only the `acp` runner**, and only inside its macOS Seatbelt sandbox; Linux is unsupported.
- **Only bare `PATH` names.** Workspace-relative script targets and rules that match arguments are later steps, as is running the real command on demand (`pass`) or from a host program (`run`).
- **Absolute paths bypass mocks.** A command run by path is not intercepted and the real binary executes. Denying the real binary in Seatbelt is a planned later step, so a case about restraint needs a check that does not depend on the agent choosing `PATH`.
- **Standard input is not forwarded**, so a mock downstream of a pipe answers without seeing the piped data.
- **Output is returned after the call completes**, not streamed; the original interleaving of stdout and stderr is lost.
- **No call checker**, so mock records are not assertable yet ([M4](m4-plan.md)). Unmatched-call denial and MCP collaborators ([M3](m3-plan.md), M5) are not available either.
- **A forwarder that cannot reach the host** fails the command with exit code 126; the run does not end as an error for that reason yet.
- **Records cannot be read, altered or erased from inside the sandbox**, but any process there can cause one by calling a mocked command, or by writing to the forwarder's socket directly. Records prove that a call was made, not that only the harness made it.
