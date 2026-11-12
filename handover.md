# Handover

Updated: 2026-11-12T06:32Z.

## Progress

The runtime, single-file authoring, typed factories, private CLI package and repeatable verification commands are delivered through `fdd647a`; [M1](docs/m1-plan.md) owns completed delivery evidence and limitations.

Explicit credential declarations are implemented at `a5bf3ed`: Pi runner/judge records use `credentials: [NAME]`, read only the invocation `.env`, and inject under the same environment-variable names. The provider-to-key mapping is removed; arbitrary parameter binding is not implemented. The source task has handed off; the parent owns final documentation and combined verification.

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

1. Finish the parent's combined clean-checkout gate and `test:package` verification, then close the current documentation record.
2. Keep future binding proposals pending until there is a separate decision and concrete need. No live-model rerun or push is approved by this record.

## Blockers and Documentation Gaps

General parameter binding is deliberately deferred, not a blocker for explicit same-name credential injection. Current references now describe the list-based implementation; no schema/source syntax from the pending discussions is implemented.
