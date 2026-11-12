# Handover

Updated: 2026-11-12T06:39Z.

## Progress

Explicit credential declarations are complete at `a5bf3ed`; the parent-reviewed combined checkpoint `b862f79` passed clean-checkout gates and the installed-package test. Pi runner/judge records use `credentials: [NAME]` from the invocation `.env`, with the same source/target environment-variable name and no provider mapping. Arbitrary parameter binding is not implemented.

No implementation task is active. [M1](docs/m1-plan.md) owns delivery evidence and limits; [Configuration Reference](docs/configuration.md) owns current syntax and parameters.

## Open Discussions

All items below are **pending**, not implementation requirements or approved syntax.

- **General value sources and bindings.** How should a value's source be declared independently of an extension's parameter names and schema? Distinguish shared `.env` lookup from automatically filling an arbitrary `apiKey`, model or other parameter. Alias/source-to-target mapping, lookup/conversion/validation order and additional source kinds are undecided. `$ref`, `!env`, `.env:...` and interpolation were discussed but none was selected; the current decision is the simple credential-name list only.
- **Retaining effective values.** If external references later supply ordinary configuration, determine how to record the actual non-sensitive resolved/defaulted values without retaining secrets. Keeping only a reference would not identify which model or resource value an earlier run used. No second effective-config record or resource snapshot is approved now.
- **Credential-command unlock UX.** The current direct lookup budget is five seconds. A longer budget for Touch ID/secret-manager authorization was suggested but not measured or approved. Raw command stdout/stderr must remain private.
- **ACP permissions and capabilities.** Define the permission-answering policy and supported session/capability coverage without assuming every harness exposes identical operations.
- **Collaborator substitutes.** Settle case ownership versus harness assembly, declaration/injection/lifecycle interfaces, and how to assess fidelity and drift for substituted skills/tools/services.
- **Observation/tracer contracts.** Define collection timing, snapshots versus streams, selected retention, evidence references and any regrading boundary. Do not infer a generic expression language or full-environment snapshot requirement.

Confirmed target capabilities remain in [Roadmap](docs/roadmap.md); this record owns their unsettled interface questions.

## Next Steps

1. Select further implementation only after a separate user decision; the questions below do not preapprove work.
2. Keep the current credential-name list until general binding has a concrete need and agreed contract. No live-model rerun or push is approved by this record.

## Blockers and Documentation Gaps

No known blocker or current-reference gap remains for the credential-name list. General parameter binding is deliberately deferred; no syntax from the pending discussions is implemented.
