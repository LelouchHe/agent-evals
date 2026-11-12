# Roadmap

## Target Shape

Build a general toolkit for evaluating agent systems: instructions, skills, workflows, configurations, and harnesses. Changes should be assessable through repeatable tests, controlled environments, observed behavior and outcomes, and eventually cost/latency measurements.

The reusable machinery is execution, isolation, checking and recording—not the assumption that every test applies to every agent or skill. A test collection need not be a comparison group, and case names do not activate special evaluation modes.

[Architecture](architecture.md) describes the implemented composition. [M1](m1-plan.md) records delivered scope and verification. The capabilities below are confirmed directions, not implemented interfaces or dated commitments; do not infer a delivery order where none is agreed.

## Harnesses and Conversation

Use ACP as the planned primary protocol-level route for additional harnesses. One ACP runner can serve harnesses that expose the required protocol capabilities; native runners remain valid.

- Further user messages belong to the same evaluation/session model, not a separate case category. ACP is the planned route for multi-turn execution, not a logical prerequisite for all multi-turn support.
- Conversation transport can be shared, while skill/configuration/tool-server assembly remains harness-specific.
- Session reports such as tool calls, plans and permission requests can be evidence, but reported calls do not prove external effects.
- Permission decisions are an evaluation variable. Configuration and capability coverage are not yet specified.

Keep the runner boundary independent of a single protocol's terminology rather than changing the engine for each harness.

## Controlled Collaborators

Extend the prepared environment with substitutes for tools, services, skills or other agents. The purpose is to control inputs and failures, observe interactions, and prevent real consequences such as sending messages or publishing changes.

- A collaborator may be real, substituted or absent. Bound what the run exposes instead of trying to predict every autonomous call.
- Prefer useful simplified implementations (fakes) to substitutes that only accept one scripted sequence. Otherwise gaps in the fake can look like agent failures.
- Substitutes are trusted authoring assets outside the evaluated agent's writable area. Harness-native tools and protocol-served operations have different interception capabilities.
- A substituted skill retains selection-relevant identity but changes instruction content. It remains model context, not a transparent function-call boundary, and can affect later behavior.
- Substituted collaborators isolate behavior; real collaborators assess the combined outcome. Both kinds of test matter.

Declaration, injection and lifecycle interfaces are not defined yet. ACP client-served operations may be useful injection points where supported. Replacing the model itself remains a way to test this toolkit's deterministic code, not a promised agent-evaluation case feature.

## Evidence and Measurements

Develop a coherent observation/tracer responsibility rather than accumulating unrelated special fields for files, messages, tool calls, permissions, environment variables and services.

- Collect observations while they are accessible; references cannot recover data never captured. Snapshots and event streams can need different timing.
- Separate collection from referencing. An observation interface must supply evidence, not merely rename existing data.
- Preserve required evidence outside the agent's writable area, minimize secret-bearing data, and distinguish failed collection from a failed check.
- Selected retained evidence can enable later inspection or regrading. Do not equate this with always retaining a whole environment.
- Add behavior, usage, cost and latency measurements when the observations support them. Repetition and comparison should build on ordinary case runs, not skill-specific pipelines.

No tracer plugin lifecycle, evidence layout, observation-reference language, JSON Pointer language or general interpolation mechanism is approved. The narrow `.env` parameter reference is separate from evidence collection. M1's small result/configuration record cannot reconstruct the removed workspace or its earlier resource contents.

## Host Platforms

Keep evaluation on the host OS under its own sandbox rather than making Linux containers the universal environment. Platform/runtime behavior, such as a harness using PowerShell instead of Bash, is itself relevant to evaluation.

The intended coverage is macOS, Linux and Windows, beginning with macOS and then Linux. Each backend must state its actual capabilities and fail closed when a required restriction is unavailable; common test inputs/checks do not imply identical guarantees.

## Open Questions

The following product-design questions are **pending**, not implementation requirements or approved syntax. Session progress and agent coordination do not belong in this document.

- **Additional value sources.** Fixed `.env` parameter references are implemented. Whether other sources, field-to-field references or interpolation are needed remains undecided; no general resolver framework is planned without a concrete case.
- **Retaining effective configuration.** Which effective/defaulted values, if any, should be recorded beyond declarations and implementation outputs? References alone do not identify their earlier contents. No second config record, resource snapshot or framework-level sensitivity classification is approved.
- **Credential-command unlock UX.** The current direct lookup budget is five seconds. A longer budget for Touch ID/secret-manager authorization was suggested but not measured or approved. Raw command stdout/stderr must remain private.
- **ACP permissions and capabilities.** Define the permission-answering policy and supported session/capability coverage without assuming every harness exposes identical operations.
- **Collaborator substitutes.** Settle case ownership versus harness assembly, declaration/injection/lifecycle interfaces, and how to assess fidelity and drift for substituted skills/tools/services.
- **Observation/tracer contracts.** Define collection timing, snapshots versus streams, selected retention, evidence references and any regrading boundary. Do not infer a generic expression language or full-environment snapshot requirement.
- **Extension discovery and identity.** Trusted-directory discovery currently loads modules with explicitly declared types; built-ins are registered explicitly. Revisit the discovery unit (one implementation versus a module providing multiple capabilities), type naming, entrypoint conventions and built-in/extension consistency when more runner/checker/tracer implementations provide concrete cases. Defer changes; directory-derived types and fixed entrypoints are not approved.

## Delivery

Only [M1](m1-plan.md) has a concrete delivery/acceptance record. Define later milestone plans when there is a real scenario and agreed scope; this document does not invent an M2/M3 schedule or turn the directions above into implementation obligations.
