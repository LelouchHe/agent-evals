# Roadmap

## Target Shape

Build a general toolkit for evaluating agent systems: instructions, skills, workflows, configurations, and harnesses. Changes should be assessable through repeatable tests, controlled environments, observed behavior and outcomes, and eventually cost/latency measurements.

The reusable machinery is execution, isolation, checking and recording—not the assumption that every test applies to every agent or skill. A test collection need not be a comparison group, and case names do not activate special evaluation modes.

[Architecture](architecture.md) describes the implemented composition and current limitations. The capabilities below are confirmed directions, not implemented interfaces or dated commitments; do not infer a delivery order where none is agreed.

## Harnesses and Conversation

Use ACP as the planned primary protocol-level route for additional harnesses. One ACP runner can serve harnesses that expose the required protocol capabilities; native runners remain valid.

- Further user messages belong to the same evaluation/session model, not a separate case category. ACP is the planned route for multi-turn execution, not a logical prerequisite for all multi-turn support.
- Conversation transport can be shared, while skill/configuration/tool-server assembly remains harness-specific. Decided in [M2](archive/m2-plan.md#runner-configuration): one generic ACP runner with no per-harness code; harness installation comes from caller-prepared `deps`, harness settings and credentials from the agent file, project configuration from the prepared workspace, and user data from the case's `~/` entries ([M6](m6-plan.md)).
- A credential proxy outside the sandbox can keep real API keys away from the agent and let sandbox network shrink to the engine; it was verified but is deferred, and it must not carry Claude subscription tokens. See [M2](archive/m2-plan.md#decisions).
- Session reports such as tool calls, plans and permission requests can be evidence, but reported calls do not prove external effects.
- Permission decisions are an evaluation variable. Configuration and capability coverage are not yet specified.

Keep the runner boundary independent of a single protocol's terminology rather than changing the engine for each harness.

## Controlled Collaborators

Extend the prepared environment with substitutes for tools, services, skills or other agents. The purpose is to control inputs and failures, observe interactions, and prevent real consequences such as sending messages or publishing changes. In the [test model](cases.md#the-test-model) these are mocks: observing calls and intercepting them are one mechanism.

- Mocks are part of the case, supplied by its author like the fixture, and are an environment component with paired setup and teardown. Each mock records the calls that reach it.
- A collaborator may be real, substituted or absent. Bound what the run exposes instead of trying to predict every autonomous call.
- Prefer useful simplified implementations (fakes) to substitutes that only accept one scripted sequence. Otherwise gaps in the fake can look like agent failures.
- Substitutes are trusted authoring assets outside the evaluated agent's writable area. Harness-native tools and protocol-served operations have different interception capabilities.
- A substituted skill retains selection-relevant identity but changes instruction content. It remains model context, not a transparent function-call boundary, and can affect later behavior.
- Substituted collaborators isolate behavior; real collaborators assess the combined outcome. Both kinds of test matter.

Mocks sit at the environment boundary because ACP session updates report calls rather than request them; see [M3](archive/m3-plan.md) for the agreed boundary design, separation of `mocks` and `checks`, and remaining open syntax questions. Shell collaborators (`PATH` programs and workspace scripts) were delivered in [M3](archive/m3-plan.md), and [M4](archive/m4-plan.md) delivered the `mock` checker over their records; MCP servers are milestone M7. Harness-native tools need harness support; network interception is shelved. Replacing the model itself remains a way to test this toolkit's deterministic code, not a promised agent-evaluation case feature.

## Evidence and Measurements

Develop a coherent observation responsibility rather than accumulating unrelated special fields for files, messages, tool calls, permissions, environment variables and services. The [test model](cases.md#why-the-trace-matters) fixes three sources: the runner's trace, mock interaction records and environment side effects.

- The trace is a normalized event stream (messages, reasoning, tool requests and results) and becomes part of the runner contract. Output is the trace's user-facing view, not a second record. Runners declare which detail they provide, as they do for recorded usage.

- Collect observations while they are accessible; references cannot recover data never captured. Snapshots and event streams can need different timing.
- Separate collection from referencing. An observation interface must supply evidence, not merely rename existing data.
- Preserve required evidence outside the agent's writable area, minimize secret-bearing data, and distinguish failed collection from a failed check.
- Selected retained evidence can enable later inspection or regrading. Do not equate this with always retaining a whole environment.
- Add behavior, usage, cost and latency measurements when the observations support them. [M4](archive/m4-plan.md) records reported usage and cost in `result.json`; comparing them across repetitions remains open.

The normalized event schema and trace retention layout are not defined yet. No tracer plugin lifecycle, observation-reference language or JSON Pointer language is approved. The narrow `.env` parameter reference is separate from evidence collection. M1's small result/configuration record cannot reconstruct the removed workspace or its earlier resource contents.

## Host Platforms

Keep evaluation on the host OS under its own sandbox rather than making Linux containers the universal environment. Platform/runtime behavior, such as a harness using PowerShell instead of Bash, is itself relevant to evaluation.

macOS (Seatbelt), Linux/WSL2 (`bubblewrap`), and native Windows (dedicated sandbox users + Restricted Token + Job Object + Firewall) are supported; see [Platforms](platforms.md). Each backend states its actual capabilities and fails closed when a required restriction is unavailable; common test inputs/checks do not imply identical guarantees.

## Open Questions

The following product-design questions are **pending**, not implementation requirements or approved syntax. Session progress and agent coordination do not belong in this document.

- **Additional value sources.** Placeholders read `${env:NAME}` and the built-in `${HOME}` and `${TMPDIR}`. A new source extends `${source:NAME}` when a concrete case needs it; field-to-field references remain undecided.
- **Placed package content and a read-only attribute.** Snapshot semantics are decided: every placement is a copy taken at run start, so a sweep is hermetic against edits during a run, the sandbox never opens an authoring tree for reading, and no host path reaches the run. A link, bind mount or overlaid read-only directory is not the chosen mechanism for that. The copy is made usable for a package by a declaration of what is not placed, and that is delivered: `.agentevalsignore` at a source directory's root, gitignore syntax, honoured by every authoring copy — the fixture, a case's workspace and `~/` `files`, check-time `files`, the Pi runner's `skills` and an agent file's `files` ([syntax](configuration.md#fixture-and-files)). It replaces the enumeration that made a whole skill costly — a body that requires `references/` is complete without hand-listing it, and a roster no longer exposes the `evals/` beside each body — because the exclusion is a property of the tree its owner declares, not a per-case list that can be forgotten. Still open, and not approved syntax: a read-only attribute, meaning writes are denied on the placed copy rather than the copy being a link. [M6](m6-plan.md) delivered the run layout and layering this attribute would apply to but not the attribute itself. It is an on-demand item for a case that must show the agent could not modify its skill package, not a prerequisite for placing one.
- **Retaining effective configuration.** Which effective/defaulted values, if any, should be recorded beyond declarations and implementation outputs? Placeholders alone do not identify their earlier values. No second config record, resource snapshot or framework-level sensitivity classification is approved.
- **Credential-command unlock UX.** The current direct lookup budget is five seconds. A longer budget for Touch ID/secret-manager authorization was suggested but not measured or approved. Raw command stdout/stderr must remain private.
- **Sandbox network restriction.** Network is open today because the harness must reach its model provider. Seatbelt cannot allow a destination by IP or domain: a network address is `*` or `localhost`, optionally with a port, plus Unix sockets by path (verified: any other host is rejected with `host must be * or localhost`). Restricting egress on macOS without privileges therefore means allowing only a local port and running an allowlisting proxy outside the sandbox, which each harness must honor through its proxy settings; the credential proxy above additionally needs a base-URL change and cannot carry Claude subscription tokens. Approaches that need no harness cooperation need privileges and are unverified: `pf` rules matched by a dedicated user (root, IP-based), a Network Extension (signed system extension) or a virtual machine. Linux network namespaces can give the sandbox its own egress without cooperation. The mock socket is allowed by path and is unaffected either way. No approach is approved.
- **Sandbox configuration (M6, partly delivered).** [M6](m6-plan.md) delivered the run layout and ownership split: `deps` outside `HOME` and linked in place, a layered home (agent-file settings, copied login state, case-owned `~/` user data), `mocks/`, and engine-private state under one denied directory. That is what a declared policy would attach to; the declaration itself is still open. Policy is assembled separately today by the ACP runner and the native Pi runner (which the judge uses rather than holding one of its own), and [M4](archive/m4-plan.md#the-check-sandbox) adds a check sandbox whose policy is fixed in code: open reads, writes limited to the workspace and private directories, no network. Harnesses also need different host services to use the same logical capability — Node-based harnesses (Pi, Claude Code) bundle Mozilla CA roots and only need the `/var` symlink for DNS, whereas Copilot CLI's native Rust TLS stack evaluates macOS system trust anchors through `/private/var/db/mds` and `mach-lookup` (`com.apple.SecurityServer`, `com.apple.trustd.agent`, `com.apple.system.opendirectoryd.membership`), currently folded into `allowNetwork` for all callers. Still open: one declared configuration of roots, host services and network; which parts a case versus an agent configuration may set; the network restriction above; per-harness host-service policy; unifying the check sandbox with the run's; and how the same declaration maps to other platforms.
- **ACP permissions and capabilities.** Define the permission-answering policy and supported session/capability coverage without assuming every harness exposes identical operations.
- **Varying one nested field.** Composition follows field type (collection fields form an additive union; single-value fields are replaced whole by the case), so varying only `runner.model` still writes the case's `runner` block in full rather than merging nested keys. Revisit only if real cases make that duplication costly.
- **Mocks.** Case ownership, host-side execution/recording, `mocks` (`shell` / `mcp`) versus `checks` separation, `return` / `run` / `pass` actions and shell argument matching were decided in [M3](archive/m3-plan.md); the call checker was delivered in [M4](archive/m4-plan.md). MCP details (M7), and how to assess fidelity and drift for substituted skills/tools/services, remain open.
- **Trace checks and observation contracts.** [M5](archive/m5-plan.md) delivered the `trace` checker for skill consultations through one exported derivation, and [M6](m6-plan.md) extended it to skills a case places in `HOME` while keeping shell access reported but uncounted; `trace.json` stays as the harness reported it. Still open: assertions on tool calls and on user-facing output as a record distinct from the trace's messages, a normalized event schema, runner capability declaration beyond `mocks`/`home`, trace retention and truncation, evidence references and any regrading boundary. Do not infer a generic expression language or full-environment snapshot requirement.
- **Extension discovery and identity.** Decided: one implementation is one directory whose `index.ts` (`index.js` or `index.mjs`) exports `runner`, `checker`, or both; built-ins use the same layout; `--extension-dir` discovers implementations from trusted roots; `$type` stays the definition's explicit name, never derived from a directory; `@lelouchhe/agent-evals` is published on npm and importable from extensions that install it. Still open: resolving `@lelouchhe/agent-evals` automatically from an arbitrary uninstalled `--extension-dir`, and whether extension type names need a shared namespace.

## Delivery

Delivered milestone records live under [`docs/archive/`](archive/): [M1](archive/m1-plan.md) (filesystem evaluation), [M2](archive/m2-plan.md) (ACP runner and trace), [M3](archive/m3-plan.md) (shell collaborator mocks), [M4](archive/m4-plan.md) (`mock`/`shell` checkers, usage and `noop` baseline) and [M5](archive/m5-plan.md) (deterministic `trace` skill checks). [M6](m6-plan.md), the sandbox configuration redesign, is in progress: the run layout (`deps` outside `HOME`, a layered home, case `~/` placement and engine-private state) is delivered and the policy declaration is not, so its record is not archived yet. MCP collaborators are M7, whose plan is not written yet. Define later milestone plans when there is a real scenario and agreed scope; this document does not invent a schedule or turn the directions above into implementation obligations.
