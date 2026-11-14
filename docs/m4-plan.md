# M4: Interaction Checks

Status: planned. Nothing here is implemented. [M3](m3-plan.md) delivers shell collaborator mocks and writes their interaction records; this milestone asserts on those records. Moving the checker here leaves M3 on interception and evidence only.

## Scope

One deterministic checker that reads the run's interaction records and asserts on them, plus the engine plumbing that makes those records available to checks.

1. **Interaction evidence reaches checkers.** `CheckerContext` carries the run's interaction records.
2. **The deterministic call checker.** An ordinary `$type` checker without engine assertion magic, judging recorded calls and their arguments.

Not in scope: MCP collaborators, which belong to a later milestone that is not yet assigned (their configuration, input matching and spy behavior stay open in [M3's open questions](m3-plan.md#open-questions)); harness-internal tools, shell builtins, HTTP/network interception, model-provider fault injection, Linux.

## Decisions Carried From M3

These were settled with the mock design and are not reopened here:

- **Arrange and Assert stay separate.** M3's top-level `mocks` records calls and never produces pass/fail judgments; a check inspects the records after the run.
- **One record shape.** A call record holds the target and its arguments, with no output or exit code.
- **The engine stays assertion-agnostic.** The engine exposes raw records on `CheckerContext` and writes `interactions.json` beside `trace.json`. Checking lives in a replaceable `$type` checker.
- **Asserting on an unmocked target is a checker `error`, not a vacuous pass.**
- **`judge` is unchanged.** It does not take `interactions` unless a real case later needs qualitative judgment over indirect script calls absent from `trace.json`.

## Open Questions

- **Call checker `$type` name and schema.** Naming (`call` vs `interactions`), whether it takes the same `args` as a mock rule, count constraints (`times: 0`, exact count, bounds) and whether one generic matcher checker later spans calls, JSON files and output or stays per-evidence-source first.
