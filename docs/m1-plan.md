# M1: Filesystem Evaluation

Status: the filesystem runtime, single-file authoring, typed factories, installable CLI and invocation-`.env` credentials are implemented and parent-reviewed. The latest `$env` source passed model-free gates and installed-package verification; earlier checkpoints also have clean-checkout evidence. No new live-model invocation is authorized by this record.

## Delivered Scope

Complete one local evaluation: prepare independent files and harness state, let Pi handle one initial user message, stop the supported runtime processes, inspect the files, retain a small result, and clean up.

- TypeScript/Node.js 24+, native Pi RPC, direct macOS Seatbelt.
- One YAML case or common fields plus one explicitly selected named case; top-level collisions are errors, with no inheritance/overrides.
- Engine-only, quote-aware `$env` value lookup before declared Zod validation; factories capture ordinary typed fields and return context-only instances. Business logic and output visibility belong to implementations.
- `view` uses the run resolver for declared configuration/source annotations, without harnesses, implementation readiness or credential resolution.
- File existence, literal-or-RE2 content and change assertions, and independent tool-free Pi judging over one evidence file.
- One built CLI entry for npm and the installed command, Node `parseArgs` flag parsing, and workers/supervisor/shell assets included in the private tarball. Retained reports default to `.agent-evals/`; extension module directories are repeatable options.
- Small result records preserve declarations/reference metadata, source/case identity, judgments, diagnostics and cleanup—not expanded config snapshots, resource snapshots or hashes.

[Architecture](architecture.md) owns composition/lifecycle; [Configuration Reference](configuration.md) owns exact formats and parameters; [Roadmap](roadmap.md) owns unimplemented capabilities. Historical intermediate implementation plans and debugging details are recoverable from Git rather than repeated here.

## Acceptance

- [x] Parse real YAML, enforce Case composition/selection, and show correct top-level origins.
- [x] Reject invalid declared-schema values before evaluated runtime creation; preserve declared rather than normalized configuration in results.
- [x] Exercise real Seatbelt allow/deny and local Pi RPC skill/process paths without model calls.
- [x] Distinguish failed assertions from execution, observation and checker errors; enforce deadlines/cancellation and cleanup.
- [x] Build/pack/install outside repository module-resolution ancestry and verify runtime dependency/asset independence.
- [x] Complete bounded independent reviews and close introduced blockers through the remaining-cleanup range.
- [x] Run both single-file example cases once with approved live models at `8fd2778`.
- [x] Verify and independently review the invocation-`.env` source, lazy command values, per-run caching, parameter-value lookup and unexpanded configuration records, with direct-command termination and test-child cancellation covered.

`$env` reads only the invocation `.env`, without ambient fallback. It supplies ordinary parameter values, not a framework-level secrecy annotation. The agreed behavior is specified once in [Credentials](../README.md#credentials). Credential lookup commands are trusted operator code, managed as direct commands rather than a process-group workload. Their descendants are operator-owned; evaluated Pi process cleanup remains a separate guarantee.

## Verification

| Evidence                                                  | What it establishes                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quote-aware parameter references `60b6f57`                | The actual pre-push lint/format/type/build gate passed 137 model-free tests with no failures/skips. The standalone installed-package test passed. Independent review found no blockers; output visibility is by design, and adapter-specific failures remain implementation-owned.         |
| Repeatable `npm run test:package`                         | Real tarball and production-only external install passed. Dependencies resolved inside that install; executable help and installed/built view matched; file/regex/judge checks passed with one shared synthetic credential command and cleanup.                                            |
| External context-only extensions with a separate Zod copy | Schema/factory/instance receivers, one validation, captured typed values, unchanged declared results, and ordinary/named-case execution.                                                                                                                                                   |
| Targeted failure probes                                   | Replaced-root/symlink containment, FIFO rejection, regex-worker termination, native provider-error classification, process/signal cleanup and test-child cancellation.                                                                                                                     |
| Credential source and command lifecycle                   | Default-cwd lookup, no ambient fallback, lazy/shared reference resolution and declaration metadata verified with synthetic values. Node handles direct-command timeout/abort and buffered output; credential-command descendants are not managed. Test-child cancellation remains covered. |

Independent review of the persistent verification entry points at `6eb97e4` found no material findings. They are reproducible through the repository commands rather than retained ad hoc scripts.

The non-atomic development build was reviewed and accepted as a serialized-checkout limit. Unknown-tag warnings and control-character labels were fixed; the remaining pre-existing/runtime limits are below. No retry, skip or timeout increase substitutes for an unresolved flaky test.

### Live Example Smoke

These commands each ran once on 2026-11-12 at `8fd2778`, before the later Zod judge-verdict and `.env` credential changes:

```sh
npm run eval -- run examples/write-file/case.yml --case with-skill
npm run eval -- run examples/write-file/case.yml --case without-skill
```

| Case            | Result                                           | Total / runner time |
| --------------- | ------------------------------------------------ | ------------------- |
| `with-skill`    | File existence/content and real judge all passed | 22.8 / 17.4 s       |
| `without-skill` | File existence/content and real judge all passed | 22.0 / 17.0 s       |

Both used `opencode-go/deepseek-v4.1-flash`, default thinking `medium`, separate runner/judge invocations and the example's 120-second budgets. Cleanup was `removed`, diagnostics were empty, and no new sandbox permissions or wrapper script was needed. Secrets were injected only in memory at that revision. Results are Git-ignored; costs/tokens were not measured.

This proves that revision's integration, not skill effectiveness, later credential changes, or a live run from the separately installed tarball. An earlier two-file smoke also passed on 2026-11-11; later model-free checks do not retroactively broaden either live result.

## Known Limitations

- macOS only for execution; Node.js 24+ and the packaged dependency/assets layout are required. No bundled standalone binary.
- One initial user message and one selected case per invocation. Judge evidence is one file, not a generic message/event evidence interface.
- Checks run after the agent stops and before workspace removal. No retained full workspace, resource-content hash, or general offline regrading.
- The runner budget is not a whole-run wall-clock/cost cap; each check has its own budget and credential lookups occur during preparation.
- Fixture symlinks are not a supported sharing mechanism; checks reject unsafe escapes. File evidence is regular and size-bounded.
- Evaluated Pi process cleanup covers tracked shell groups, not deliberate new-session/group escape or forced supervisor death. Agent-written registry data never authorizes host signals.
- Staged supervisor modules rely on Node module-syntax detection; unusual CommonJS-scoped temporary roots remain unverified/unsupported.
- The provider key reaches the evaluated agent: Pi receives it through its environment and shell tools inherit it, so `env` in the agent's shell prints it and it can enter retained output. A credential proxy that would remove this is verified but deferred; see [M2](m2-plan.md#decisions).
- Sandboxed DNS works only because the run root sits under `/var/folders`: Node's resolver needs read access to the `/var` symlink, which the policy grants implicitly through that path's metadata. A run root elsewhere loses DNS. Network access is also unrestricted while the run needs the provider.
- Live networking was tested only with the earlier OpenCode Go example. Current `apiKey` transport requires `provider/model` and a compatible Pi build; provider availability, key validity and business failures are handled by the adapter/harness, not framework schema policy.
- Dynamic extensions are trusted code. Runtime capability checks do not statically prove an external module's schema/factory consistency.
- Checkout build concurrency is restricted as documented in [Development](../README.md#development).
