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

A runner definition may also set `mocks: true`: the runner places the mocked commands it receives in [`RunnerContext.mocks`](#runner). A case that declares mocks is rejected for a runner without it.

`create` receives an `ImplementationContext`:

| Field           | Meaning                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `authoringDir`  | Directory of the case file, for resolving the author's relative paths.                                       |
| `values`        | The run's placeholder sources, for a parameter the implementation loads itself.                              |
| `validateFiles` | Validates and stages a checker's check-time `files` (workspace destination → authoring source) at load time. |
| `mockTargets`   | The case's declared `mocks.shell` targets; absent when the case declares no mocks.                           |

An error thrown from `create` stops the case before the agent starts, so a setup that cannot work costs no agent run.

## Runner

```text
Runner.run(RunnerContext) -> RunnerOutcome
Runner.stop()             -> completion; must be safe to call more than once
Runner.trace?()           -> TraceEntry[]
Runner.usage?()           -> RunnerUsage | undefined
```

`RunnerContext`:

| Field          | Meaning                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceDir` | The prepared workspace; the agent's working directory.                                                                                                                 |
| `homeDir`      | The run's private `HOME`.                                                                                                                                              |
| `configDir`    | Per-run directory for harness configuration the runner stages.                                                                                                         |
| `scratchDir`   | Per-run temporary directory.                                                                                                                                           |
| `runRootDir`   | Parent of the directories above; removed after the run.                                                                                                                |
| `input`        | The case's initial user message.                                                                                                                                       |
| `timeoutMs`    | The run's execution budget. The engine enforces it and aborts `signal`.                                                                                                |
| `signal`       | Aborted on timeout or cancellation.                                                                                                                                    |
| `mocks`        | Present when the case declares mocks: `forwarderDir` to put first on `PATH`, the host's `socketPath`, and `denyTargets`, the real binaries that must stay unreachable. |

`RunnerOutcome` is `finalText` (string or `null`) and `diagnostics`, a short list such as a stderr tail.

The two optional methods are how a runner supplies evidence, and both are read after a failed run too:

- **`trace()`** returns the run's steps in order of first appearance. An entry is `{ type: "message" | "thought", text }` or `{ type: "tool", toolCallId, ...fields }`, where the other fields are the harness's own. The engine writes it to `trace.json` and hands it to every checker. A runner without `trace()` records no trace; checks that need one then report an `error`.
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

- **The package entry exports the contracts and one trace derivation.** `import type { CheckerDefinition, CheckResult } from "agent-evals"` gives the contracts on this page, and `await skillConsultations(trace, { workspace, baseline })` returns the skills a run consulted, as the built-in [`trace` checker](configuration.md#trace-checker-type-trace) derives them ([`index.ts`](../src/index.ts)). Type imports are erased before the module runs. The package is not published, and nothing resolves it for an extension directory by itself, so the function is not yet importable at run time from an arbitrary extension.
- **Engine helpers are not available.** The identity-checked file reads the built-in `file` checker uses, pattern compilation and mock matching are internal. The exported skill derivation encapsulates its own baseline reads; an extension reading other files uses `workspace.path` and `baseline.path` with its own code and owns the containment checks it needs.
- **An extension resolves its own dependencies.** `params` only has to behave like a Zod schema (`safeParseAsync`), but `import { z } from "zod"` must resolve from the module's own location.
- **`view` does not load extensions.** `--extension-dir` applies to `run` only.
- **`shell` checks do not receive the trace.** `trace.json` is written with the result, after checks ran; trace assertions need a checker in TypeScript or JavaScript.

Type naming and run-time package resolution remain [open questions](roadmap.md#open-questions).
