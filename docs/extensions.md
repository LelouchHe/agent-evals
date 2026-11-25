# Extensions

A runner drives the evaluated agent; a checker judges what the run left behind. The built-ins (`pi`, `acp`, `noop`; `file`, `judge`, `mock`, `shell`, `trace`) and extensions implement the same two contracts and are selected the same way, by `$type` in the case. This page is the contract for someone writing one. The source of truth is [`registry.ts`](../src/engine/registry.ts); how the engine uses the contracts is in [Architecture](architecture.md#definitions-factories-and-instances).

## Discovery

`run` loads extensions from the roots named on the command line:

```sh
agent-evals run case.yml --extension-dir ./extensions
```

Each subdirectory of an extension root is one implementation. Its entry point is `index.ts`, `index.js` or `index.mjs`; helper modules, assets and the implementation's own dependencies live beside it. The built-ins use the same layout, for example [`checkers/file/index.ts`](../src/checkers/file/index.ts) and [`runners/pi/index.ts`](../src/runners/pi/index.ts).

```text
extensions/
  tool-count/
    index.ts        the definition
    helper.ts       imported by index.ts, never loaded on its own
```

- The entry point exports `runner`, `checker`, or both.
- A subdirectory without an entry point is a configuration error. Only `node_modules` and directories whose name starts with a dot are skipped, so an extension root may hold shared dependencies and be a repository.
- `--extension-dir` is repeatable. Every root feeds one registry, next to the built-ins.
- The `$type` a case uses is the definition's `type` field. Directory and entry names have no meaning.
- An unreadable root, a subdirectory without an entry point, a missing or malformed export, an entry point exporting neither `runner` nor `checker`, or a `type` that a built-in or another extension already uses is a configuration error. Nothing is overridden or skipped.

Extensions execute as trusted host code, outside every sandbox. Never name an agent-writable workspace or a results directory as an extension root.

## Definition

Runner and checker definitions have the same three parts:

| Field    | Meaning                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`   | Non-empty string; the `$type` cases use.                                                                                                           |
| `params` | A Zod schema for the record's other keys. The engine substitutes [placeholders](configuration.md#placeholders), then parses with this schema once. |
| `create` | `create(params, context)` returns the instance, or a promise of one. It runs before the agent starts, so it is where to reject an unusable setup.  |

A runner definition may also set `mocks: true`: the runner places the mocked commands it receives in [`RunnerContext.mocks`](#runner). A case that declares mocks is rejected for a runner without it. A runner that gives the run a HOME sets `home: true` and implements `prepareHome`; a case that places or checks a `~/` path is rejected for a runner without it.

`create` receives an `ImplementationContext`:

| Field                | Meaning                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `authoringDir`       | Directory of the case file, for resolving the author's relative paths.                                       |
| `values`             | The run's placeholder sources, for a parameter the implementation loads itself.                              |
| `validateFiles`      | Validates and stages a checker's check-time `files` (workspace destination → authoring source) at load time. |
| `mockTargets`        | The case's declared `mocks.shell` targets; absent when the case declares no mocks.                           |
| `runnerSupportsHome` | True when the selected runner gives the run a HOME; a checker that reads `~/` paths needs it.                |

An error thrown from `create` stops the case before the agent starts, so a setup that cannot work costs no agent run.

## Runner

```text
Runner.prepareHome?(RunnerContext) -> readonly string[]
Runner.run(RunnerContext)          -> RunnerOutcome
Runner.stop()                      -> completion; must be safe to call more than once
Runner.trace?()                    -> TraceEntry[]
Runner.usage?()                    -> RunnerUsage | undefined
Runner.homeFiles?                  -> readonly string[]
```

`RunnerContext`:

| Field          | Meaning                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceDir` | The prepared workspace; the agent's working directory.                                                                                                                 |
| `homeDir`      | The run's private `HOME`; the case may place `~/` content in it.                                                                                                       |
| `tmpDir`       | The run's temporary directory, named by `TMPDIR`.                                                                                                                      |
| `engineDir`    | Engine-private state: unreadable to the agent. A runner may stage or write here.                                                                                       |
| `configDir`    | A runner-owned writable directory; only the native Pi runner uses it.                                                                                                  |
| `runRootDir`   | Parent of the directories above; removed after the run. The `deps` link lives here.                                                                                    |
| `input`        | The case's initial user message.                                                                                                                                       |
| `timeoutMs`    | The run's execution budget. The engine enforces it and aborts `signal`.                                                                                                |
| `signal`       | Aborted on timeout or cancellation.                                                                                                                                    |
| `mocks`        | Present when the case declares mocks: `forwarderDir` to put first on `PATH`, the host's `socketPath`, and `denyTargets`, the real binaries that must stay unreachable. |

`RunnerOutcome` is `finalText` (string or `null`) and `diagnostics`, a short list such as a stderr tail.

Three optional members describe a runner's HOME:

- **`prepareHome(context)`** runs before the case's `~/` entries and the baseline snapshot. The runner links its `deps`, copies its agent-file `files` and login state into `homeDir`, and returns the HOME-relative login files the case may not touch. Absent for a runner without a HOME.
- **`homeFiles`** is the same login-file list, available without running `prepareHome`, so the engine can reject a case `~/` entry at load time.
- A definition sets `home: true` only when both are true; without it, a case that places or checks a `~/` path is a configuration error.

The two optional evidence methods are read after a failed run too:

- **`trace()`** returns the run's steps in order of first appearance. An entry is `{ type: "message" | "thought", text }` or `{ type: "tool", toolCallId, ...fields }`, where the other fields are the harness's own. The engine writes it to `trace.json` and hands it to every checker. A runner without `trace()` records no trace; checks that need one then report an `error`. A case asserts on it through [`trace`](configuration.md#trace-checker-type-trace): `event: skill` reads skill consultations, `event: message` reads the text the agent produced — every `message` entry joined in run order, with `thought` and `tool` entries excluded, so an empty join is that check's `error` rather than a vacuous `pass`. Nothing is truncated, and neither derivation is a user-facing output record.
- **`usage()`** returns what the harness reported it consumed: optional `context`, `cost` and `tokens`. Nothing is estimated.

The engine owns the run root, the baseline snapshot, the mock host, the timeout and the result record. The runner owns starting the harness, its sandbox and stopping every process it started.

## Checker

```text
Checker.check(CheckerContext) -> CheckResult[]
```

`CheckerContext` is the evidence of one finished run:

| Field          | Meaning                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `workspace`    | The workspace as the agent left it: `path` plus the directory identity the engine recorded.                       |
| `baseline`     | The workspace as it was before the agent started, outside the agent's writable area. Same shape as `workspace`.   |
| `home`         | The run HOME as the agent left it. For a runner without a HOME it is an empty directory.                          |
| `homeBaseline` | What the case placed in HOME before the agent started; agent-file and login content is not part of it.            |
| `trace`        | The runner's complete trace, the same data as `trace.json`; absent when the runner records none.                  |
| `mockRecords`  | Calls that reached a mocked command, in arrival order, each a `target` and its `arguments`; absent without mocks. |
| `checkSandbox` | `run(command, { files })` runs a program in the engine's fixed check sandbox and reports how it ended.            |
| `input`        | The case's initial user message.                                                                                  |
| `runRootDir`   | The run's root directory.                                                                                         |
| `timeoutMs`    | This check's budget. The engine enforces it and aborts `signal`.                                                  |
| `signal`       | Aborted on timeout or cancellation.                                                                               |

`checkSandbox.run` starts `command` in the workspace without a shell: open reads, writes only beneath the workspace and a private `HOME` and temporary directory, no network. Its `files` option places the files that `validateFiles` staged. The result is `exited` with an `exitCode`, `signalled` with a `signal`, or `failed` with a `reason`, each with the program's `output`.

One check returns one or more `CheckResult`:

| Field     | Meaning                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------ |
| `checker` | The checker's `type`.                                                                            |
| `subject` | What was checked, short enough to read in a result list.                                         |
| `status`  | `pass`, `fail`, or `error`. `fail` is a negative judgment; `error` means it could not be judged. |
| `reason`  | Why, including what was observed.                                                                |

A checker that throws or exceeds its budget is recorded as one `error` result. Missing evidence must be an `error` or a `fail`, never a pass.

### A Minimal Checker

`extensions/tool-count/index.ts`, selected with `--extension-dir ./extensions` and used as `$type: tool-count`:

```ts
import { z } from "zod";

export const checker = {
  type: "tool-count",
  params: z.strictObject({ max: z.number().int().min(0) }),
  create(params: { max: number }) {
    return {
      async check(context: { trace?: readonly { type: string }[] }) {
        if (context.trace === undefined) {
          return [
            { checker: "tool-count", subject: "tool calls", status: "error", reason: "this runner records no trace" },
          ];
        }
        const calls = context.trace.filter((entry) => entry.type === "tool").length;
        return [
          {
            checker: "tool-count",
            subject: `at most ${params.max} tool calls`,
            status: calls <= params.max ? "pass" : "fail",
            reason: `found ${calls}`,
          },
        ];
      },
    };
  },
};
```

```yaml
checks:
  - $type: tool-count
    max: 20
```

## Current Limits

- **The package entry exports the contracts, the trace derivations and the evidence access the built-in `file` checker uses.** `import type { CheckerDefinition, CheckResult } from "agent-evals"` gives the contracts on this page; `skillConsultations` and `messageText` derive what the built-in `trace` checker asserts; and `readRunFile`, `readRunTree` and `runPathExists` answer the same questions as the built-in `file` checker with the same guarantees — the run root identity is verified for every operation, a link is never followed, a read is bounded by `MAX_CHECK_BYTES`, and `runRelativePathSchema`, `patternListSchema`, `searches` and `compilePattern` are the same path and pattern grammar. `WorkspacePathError`, `isMissing` and `ConfigError` are exported so a failure reaches the engine the way a built-in's does ([`index.ts`](../src/index.ts)).
- **The mock argument grammar and matcher are exported too.** `expectMockArgs` and `expectMockTarget` parse the same grammar a `mocks.shell` declaration uses, `mockTargetIdentity` distinguishes a bare command from a workspace path, and `compileRules`/`matchCall` match a recorded call the way the built-in `mock` checker does; `ImplementationContext.mockTargets` carries the declared targets at load time.
- **Not available: a model invocation and a runner's environment.** The `judge` checker's tool-free model call and the ACP and Pi runners' sandbox, supervisor and harness assembly are internal. A third-party checker that needs a model, and a third-party runner that runs an agent, cannot be written against the current contract yet; that is the remaining known gap.
- **An extension resolves its own dependencies.** `params` only has to behave like a Zod schema (`safeParseAsync`), but `import { z } from "zod"` must resolve from the module's own location.
- **`view` does not load extensions.** `--extension-dir` applies to `run` only.
- **`shell` checks do not receive the trace.** `trace.json` is written with the result, after checks ran; trace assertions need a checker in TypeScript or JavaScript.

Type naming and run-time package resolution remain [open questions](roadmap.md#open-questions).
