# M5: Deterministic Trace Checks

Status: draft, design agreed, not implemented. [M2](m2-plan.md) retains `trace.json` and lets `judge` inspect it; [M4](m4-plan.md) gave mock records and workspace execution their deterministic checkers (`mock` and `shell`). This milestone gives the third observation source — the runner's trace — its deterministic checker (`trace`), starting with skill consultations across harnesses.

## Scope

1. **Skill-use observation across harnesses.** Derive which skills a run consulted from the recorded trace, without harness-specific runner branches, workspace naming rules or any change to `trace.json`.
2. **The `trace` checker.** Assert on trace events through one flat shape that later event kinds extend, starting with `event: skill`.
3. **Worked example update.** In [`deploy-runbook`](../examples/cases/deploy-runbook/case.yml), a `trace` check replaces the judge statement about consulting the skill. The judge's restraint statement stays, next to the `mock` `times: 0` check it is compared with.

Not in scope: the `tool`, `message` and `thought` event kinds (added when a real case needs them), ordering assertions, multi-turn input, repetition aggregation, run-time package resolution for extensions (see [Deferred](#deferred)), sandbox configuration ([M6](roadmap.md#open-questions)) and MCP collaborators ([M7](m3-plan.md#open-questions)).

## Decisions

Carried from earlier milestones:

- **Checkers are per evidence source.** Environment files have `file`, collaborator records have `mock`, and runner traces get `trace` — not one `$type` per assertion topic such as `$type: skill`.
- **Output is a view of the trace, not a separate record.** Slicing `finalText` after the last tool call drops answers followed by a cleanup tool or split across tool calls, and fails to generalize to multi-turn runs. Cases that need deterministic structural or text checks write a workspace file and use `file` or `shell`; qualitative conversation checks use `judge` with `trace: true`.

Agreed for M5:

- **The trace is not changed.** `trace.json` stays what the harness reported. Skill consultations are a read-only derivation over it, so a new harness form is a new recognition rule and retained traces stay valid.
- **The derivation is an exported engine function, not checker-private code.** One pure function takes the trace and the run's baseline and returns the consulted skills. The built-in `trace` checker is one caller; an extension checker, which already receives `trace` and `baseline` in its `CheckerContext`, can be another. Nothing is added to `CheckerContext`.
- **Skill identity is the skill's `name`, never its directory name.** Skill directories often carry prefixes or layout conventions (for example `.claude/skills/aw-task-delegation/SKILL.md` whose frontmatter declares `name: task-delegation`). Pi (`pi-acp`), Claude Code (`claude-agent-acp`) and GitHub Copilot CLI (`copilot --acp`) all advertise the frontmatter `name`.
- **A consultation is counted once per skill.** Chunked reads of one `SKILL.md` and repeated loads of one skill are one event.
- **Copies of a same-named skill are not distinguished.** Skill tools report only a name, so the trace cannot say which copy was loaded. A case that depends on which content took effect checks the outcome with `file` or `shell`.
- **Runners without a trace fail closed at check time.** `$type: trace` on a runner that records no trace (the native `pi` runner) is a checker `error`, as `judge` with `trace: true` already is. `noop` records an empty trace, so positive checks fail and `times: 0` checks pass, matching `mock`.

## The `trace` Checker

```yaml
checks:
  # Consulted (omitting `times` means at least one matching event)
  - $type: trace
    event: skill
    name: deploy-runbook

  # Not consulted
  - $type: trace
    event: skill
    name: unrelated-skill
    times: 0

  # No skill consulted at all
  - $type: trace
    event: skill
    name: /.*/
    times: 0
```

| Key     | Meaning                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------- |
| `event` | The kind of trace event to select. M5 accepts only `skill`.                                               |
| `name`  | For `event: skill`: the skill's name, as a literal or a `/…/` RE2 pattern (the `file` checker's grammar). |
| `times` | Optional exact number of matching events. Omitted means at least one. Same meaning as in `mock`.          |

`event` is a value rather than a key, so a new kind adds one value with its own fields instead of another mutually exclusive key. The values are this project's, not an ACP standard:

| `event`                      | Source                                                          | Status                 |
| ---------------------------- | --------------------------------------------------------------- | ---------------------- |
| `skill`                      | Derived from the trace as described below.                      | M5                     |
| `message`, `thought`, `tool` | The `type` of an entry in `trace.json`, with the same spelling. | When a case needs them |

Parameters are validated when the case loads: an unknown `event` or an extra key is a configuration error that lists what is accepted. A literal `name` matches at most one event, so `times` other than `0` or `1` with a literal `name` is rejected at load time too.

A result's reason names the skills the run consulted (for example `expected deploy-runbook, consulted: none`), so an author sees what the checker recognized.

## Recognizing Skill Consultations

ACP v1 has no dedicated skill update; harnesses report skill loading as ordinary tool calls. Only completed calls count (`type === "tool"` and `status === "completed"`). They take two structural forms, verified against 23 retained traces of the example (Pi 8, Claude Code 4 and Copilot CLI 1 with a skill; no match in any run without one):

| Harness            | How a skill consultation appears in `trace.json`                                 |
| ------------------ | -------------------------------------------------------------------------------- |
| Claude Code        | Tool call titled `Load skill: <name>` with `rawInput: { skill: "<name>" }`.      |
| GitHub Copilot CLI | Tool call titled `Using skill: <name>` with `rawInput: { skill: "<name>" }`.     |
| Pi via `pi-acp`    | `read` tool call (`kind: "read"`) whose target path has the basename `SKILL.md`. |

Rules for a completed tool entry:

1. **Dedicated skill tool.** `kind !== "read"` and `rawInput.skill` is a non-empty string: that string is the skill name.
2. **`SKILL.md` read.** `kind === "read"` and the target path (`locations[0].path`, `rawInput.path` or `rawInput.file_path`) has the basename `SKILL.md`. The name comes from the first source that gives one:
   1. **The run's baseline**, when the path is inside the workspace: the frontmatter `name` of the same file in `baseline`. The baseline is each run's own initial workspace snapshot, taken after `fixture` and the case's `files` are placed, so it is that case's skill environment and is outside the agent's writable area. Offsets, chunked reads and edits during the run do not affect it.
   2. **The text the read returned**, for a path outside the workspace such as a skill in the harness home: the frontmatter `name` parsed from the entry's `content` text or `rawOutput`.
   3. **The parent directory's name**, when neither gives a name. The result's reason says so.

Traces spell workspace paths three ways — relative, `/var/…` and `/private/var/…` — so a target path is resolved against the workspace's canonical path before it is compared.

### What `trace` Can and Cannot Prove

- **Completed consultations only.** Failed or cancelled tool calls do not count.
- **Shell reads are not recognized.** An agent that reads `SKILL.md` through a shell command (`cat .agents/skills/*/SKILL.md`) is not parsed from command text, which would also match `ls` or a failed pipeline. Retained Pi traces do show files read with `cat`, so this happens: a positive check can then fail although the skill was read, and `times: 0` proves only that no recognized tool call loaded the skill.
- **Description visibility vs body consultation.** A placed skill's `description` stays visible in the harness's skill roster; `times: 0` is about loading the body.
- **A tool parameter named `skill`.** Rule 1 counts any completed non-read tool call with a string `rawInput.skill`. No retained trace has such an unrelated tool; the risk is accepted.
- **Sample size.** The Copilot CLI form rests on one retained trace.

## Deferred

- **Resolving the package from an extension.** The derivation is exported from the package entry ([`index.ts`](../src/index.ts)), but an extension module in an arbitrary directory cannot yet import it at run time; see [Extensions](extensions.md#current-limits). This belongs with [extension discovery and identity](roadmap.md#open-questions).
- **Load-time failure for runners without a trace.** A capability declared on `RunnerDefinition` would reject the case before spending a run. If it is added, `judge` with `trace: true` moves with it.
- **Field matching for `tool`, `message` and `thought`.** Harness-owned fields cannot be validated, so a misspelled field would never match and `times: 0` would pass vacuously. Decide the guard when the first of these kinds is added.
