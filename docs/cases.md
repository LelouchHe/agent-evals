# Writing Cases

Treat a case like a test: arrange an environment, send input, observe what happens, and assert on one behavior. [Configuration Reference](configuration.md) owns YAML syntax, parameter tables, selection and result records; this page owns the test model and test design.

## The Test Model

| Testing concept    | Agent evaluation                                                                                            | Status                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Input              | The user's prompts: the first message and any later turns.                                                  | First message only.                       |
| Output             | The messages the agent returns to the user. A view of the trace, not a separate record.                     | ACP runner; `trace` `event: message`.     |
| Trace              | How the agent ran: messages, reasoning, tool requests and results, skill loading, usage.                    | ACP runner; `trace` and `judge`.          |
| Interactions       | Calls that reached a collaborator, recorded by its mock.                                                    | Shell mocks on `acp`; `mock` checks.      |
| Side effects       | Changes to the environment: files, commands, network and other state.                                       | Files and commands.                       |
| Fixture            | Fixed initial data: the workspace tree copied first, or user data a case places under `~/`.                 | `fixture`, `files` with `~/`.             |
| Environment        | Everything the agent runs in: workspace, HOME, harness configuration (skills, settings), mocks and sandbox. | Workspace, HOME, harness files, Seatbelt. |
| Setup / teardown   | Each environment component prepares and removes itself; YAML declares components, not procedures.           | Built-in components only.                 |
| Mock               | A case-owned substitute for a collaborator that controls its responses and records calls to it.             | `mocks.shell`: return, run, pass.         |
| Assertion          | A check of observed evidence.                                                                               | `checks`.                                 |
| Parameterized test | Named cases that share common fields.                                                                       | `cases`.                                  |

### Anything Can Be the Subject

Unlike a unit test, a case has no fixed system-under-test slot. Every declared part—input, fixture, runner type, model, skills or other configuration, mocks, even a judge's model or rubric—can be what is evaluated. The subject is whatever differs between the cases being compared; the fields they share are the controls. Common fields and named cases express exactly this, and the engine does not know or need to know which part is the subject.

### Why the Trace Matters

Code can be read to learn its execution paths, so tests can focus on results. An agent has no readable program: it decides its path at run time and may take a different one each run. The trace is the only record of what actually ran, so white-box evaluation of an agent depends on it.

The three observation sources are complementary and cannot be derived from one another:

- **Trace** comes from the runner, because only the harness sees the agent's internals. It reports what the agent said, thought and requested. Harnesses expose different detail (reasoning may be hidden), so a check needing detail a runner cannot provide is an error, not a pass. Skill consultations and the text the agent produced are derived deterministically across harnesses ([`trace`](configuration.md#trace-checker-type-trace) `event: skill` and `event: message`); other trace questions need a judge.
- **Interactions** come from mocks. They record what actually reached a collaborator, including calls the trace does not show, such as a command run from inside a script. The `mock` checker asserts on them; a matching record proves a call, while absence is only meaningful when the sandbox also denies the real command.
- **Side effects** come from the environment after the run. They show what changed, not who changed it or why.

A requested call in the trace does not prove its effect, and a missing observation cannot prove an action was avoided.

### User Data and User-Level Instructions

The workspace is the project the agent is asked to change. `HOME` is the user it works for: real user data (`~/notes`, a vault), user-level instructions and user-level skills. A case places them through `files` destinations that start with `~/`, next to the project entries that stay workspace-relative; the harness's own settings and login state come from the agent file and are not the case's to supply.

- **Use `~/` when the task names a home path.** A query like "add a page under `~/vault`" reads the vault it names and is the query minus its setup, instead of a rewritten prompt that points inside the workspace.
- **Separate user-level from project-level skills.** A project skill belongs in the workspace where the harness discovers project skills (`.agents/skills/`, `.claude/skills/`); a user-level skill belongs under the corresponding `~/` directory. Both are ordinary authoring copies, with `.agentevalsignore` applied.
- **HOME is layered, not shared.** The agent file's settings, then its login files, then the case's `~/` entries. A case may replace an agent-placed settings file — settings are an evaluation variable — but never a login file.
- **Evidence works the same way.** A `file` check accepts `~/` paths, and `trace` recognizes a `SKILL.md` the case placed in HOME. `changed` compares against what the case placed, so a restraint check over `~/` proves the case's own baseline was respected.
- **Runners without a HOME reject `~/`.** The native `pi` runner fails the case at load time rather than silently ignoring the placement. Use an ACP harness or `noop` for HOME placement.

A case that needs the harness's own settings changed places its own file over the agent-placed one: settings are an evaluation variable, and the case overlay runs last. It may not place over login state. A case that only needs `HOME` to resemble a user's home leaves the agent file's settings alone.

A case that should need the agent can be checked for vacuity: run it with `runner: { $type: noop }` as a named case. Checks that pass there do not depend on what the agent did.

## Choose the Behavior

- Prefer several narrow cases over one large task with an opaque score.
- Assert outcomes, not a prescribed action sequence, unless the action itself is the behavior being tested. Trace assertions work best as constraints (must, must not, at most N) rather than exact step sequences.
- A case may target one skill or capability. Reuse it across implementations only when their relevant expectations are shared.
- Names and collections do not imply an A/B experiment. Repeated runs can test the current contents of the same referenced skill; different checks do not automatically yield comparable scores.
- A check separates runs with and without a resource only if that resource supplies what the model cannot infer from the task, fixture or common practice. Conventions that match widespread standards rarely show a difference.
- Agents are stochastic. One pass proves that run, not an improvement rate. Repetition/comparison support is a [planned capability](roadmap.md#evidence-and-measurements), not current statistical evidence.

## Prepare the Environment

Keep fixtures and case-owned assets beside the test. For example:

```text
my-case/
  case.yml
  fixture/
  skill/SKILL.md
```

`fixture` is the base environment. A case's `files` entry places a file or directory at a destination: a workspace-relative one, for example `.agents/skills/deploy-runbook: skill` for Pi's project-level discovery path, or a `~/` one for user data and user-level instructions, for example `~/vault: ../fixtures/vault`. The engine copies and assigns no meaning to the destination. Placed files are part of the baseline that `changed: false` compares against, so a case may replace a fixture file rather than duplicate the whole fixture.

Because placement copies, a package is placed as one directory only when its non-runtime content is declared. Each skill owns that declaration in a `.agentevalsignore` at its root — `/evals` for the expectation assets beside its body, plus `/tests` or `__pycache__` where they exist — so a case can name a skill directory, or a whole roster, and still place the `SKILL.md` and the `references/` its body requires without the material that would tell an evaluated agent the answer. The file is authoring input: the engine reads it during every copy from authoring sources and never places it. [Configuration](configuration.md#fixture-and-files) owns the pattern syntax. Denying writes on the placed copy is not a placement option today; that remains [open](roadmap.md#open-questions).

Add a fixture directory only when initial files are needed. Do not populate an intentionally empty workspace with placeholder files or require a setup/check script for every case. Dedicated setup/custom-check assets may be useful authoring resources, but M1 does not provide generic setup-script or arbitrary checker-script YAML fields.

Use deterministic authored data or explicit preparation instead of asking another model to improvise the environment. Extract shared assets only after actual reuse; share definitions and initial inputs, not mutable per-run state. Keep results separate and never rewrite the source fixture during evaluation.

Expose only the intended task, resources and environment to the agent. Case/check definitions, rubric, reference answers and unrelated operator capabilities should not leak into its workspace. Keep local credentials separate from test data; see [Setup](setup.md#credentials-and-env).

## Choose Evidence and Checks

Use deterministic checks for exact facts and a judge for qualitative criteria. A file check need not become a new checker class for every assertion; one checker can return several results. A rubric can be a list of statements without mandatory business categories. Use `shell` for an outcome only execution shows, such as the project's tests; it runs the command, so pair it with `file` `changed: false` on the files, or the directory, the agent must not edit. A `shell` check's `files` places authored tests into the workspace only when it runs, so the agent never sees them; placement replaces whatever the agent left at that path without following a symlink.

Do not create routing-versus-behavior pipelines. Use the [`trace`](configuration.md#trace-checker-type-trace) checker for skill consultations; tool choices, restraint and result quality remain concerns for checks and evidence as those observations exist: a requested call in the trace does not prove its effect, so restraint is stronger when a mock proves the call never reached the collaborator.

Environment and interaction evidence is stronger than an agent's own account alone. Shell collaborator mocks ([usage](mocks.md)) and their `mock` checker are implemented; broader directions are in [Roadmap](roadmap.md), and none of this is added through ad hoc Case fields.

## Keep Validation Data Honest

Train/dev/test organization can separate iterative improvement from held-out evaluation; it does not imply this toolkit trains model weights. Avoid inspecting test answers during optimization, and watch for near-duplicate leakage across related cases. Keep judge-calibration examples separate from the evaluated held-out set.
