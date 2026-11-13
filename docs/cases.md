# Writing Cases

Treat a case like a test: arrange an environment, send input, observe what happens, and assert on one behavior. [Configuration Reference](configuration.md) owns YAML syntax, parameter tables, selection and result records; this page owns the test model and test design.

## The Test Model

| Testing concept    | Agent evaluation                                                                                         | Status                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Input              | The user's prompts: the first message and any later turns.                                               | First message only.                    |
| Output             | The messages the agent returns to the user. A view of the trace, not a separate record.                  | Final text retained, not checkable.    |
| Trace              | How the agent ran: messages, reasoning, tool requests and results, skill loading, usage.                 | Planned.                               |
| Interactions       | Calls that reached a collaborator, recorded by its mock.                                                 | Planned.                               |
| Side effects       | Changes to the environment: files, commands, network and other state.                                    | Files only.                            |
| Fixture            | Fixed initial data, such as the files copied into the workspace. Part of the environment, not all of it. | `fixture`.                             |
| Environment        | Everything the agent runs in: workspace, harness configuration (skills, settings), mocks and sandbox.    | Workspace, Pi configuration, Seatbelt. |
| Setup / teardown   | Each environment component prepares and removes itself; YAML declares components, not procedures.        | Built-in components only.              |
| Mock               | A case-owned substitute for a collaborator that controls its responses and records calls to it.          | Planned.                               |
| Assertion          | A check of observed evidence.                                                                            | `checks`.                              |
| Parameterized test | Named cases that share common fields.                                                                    | `cases`.                               |

### Anything Can Be the Subject

Unlike a unit test, a case has no fixed system-under-test slot. Every declared part—input, fixture, runner type, model, skills or other configuration, mocks, even a judge's model or rubric—can be what is evaluated. The subject is whatever differs between the cases being compared; the fields they share are the controls. Common fields and named cases express exactly this, and the engine does not know or need to know which part is the subject.

### Why the Trace Matters

Code can be read to learn its execution paths, so tests can focus on results. An agent has no readable program: it decides its path at run time and may take a different one each run. The trace is the only record of what actually ran, so white-box evaluation of an agent depends on it.

The three observation sources are complementary and cannot be derived from one another:

- **Trace** comes from the runner, because only the harness sees the agent's internals. It reports what the agent said, thought and requested. Harnesses expose different detail (reasoning may be hidden), so a check needing detail a runner cannot provide is an error, not a pass.
- **Interactions** come from mocks. They record what actually reached a collaborator, including calls the trace does not show, such as a command run from inside a script.
- **Side effects** come from the environment after the run. They show what changed, not who changed it or why.

A requested call in the trace does not prove its effect, and a missing observation cannot prove an action was avoided.

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

Add a fixture directory only when initial files are needed. Do not populate an intentionally empty workspace with placeholder files or require a setup/check script for every case. Dedicated setup/custom-check assets may be useful authoring resources, but M1 does not provide generic setup-script or arbitrary checker-script YAML fields.

Use deterministic authored data or explicit preparation instead of asking another model to improvise the environment. Extract shared assets only after actual reuse; share definitions and initial inputs, not mutable per-run state. Keep results separate and never rewrite the source fixture during evaluation.

Expose only the intended task, resources and environment to the agent. Case/check definitions, rubric, reference answers and unrelated operator capabilities should not leak into its workspace. Keep local credentials separate from test data; see [Credentials](../README.md#credentials).

## Choose Evidence and Checks

Use deterministic checks for exact facts and a judge for qualitative criteria. A file check need not become a new checker class for every assertion; one checker can return several results. A rubric can be a list of statements without mandatory business categories.

Do not create routing-versus-behavior pipelines. Skill loading, tool choices, restraint and result quality are concerns expressed through checks and evidence when those observations exist.

Environment and interaction evidence is stronger than an agent's own account alone. Trace, output checks and mocks are described in [Roadmap](roadmap.md), not implemented by adding ad hoc Case fields.

## Keep Validation Data Honest

Train/dev/test organization can separate iterative improvement from held-out evaluation; it does not imply this toolkit trains model weights. Avoid inspecting test answers during optimization, and watch for near-duplicate leakage across related cases. Keep judge-calibration examples separate from the evaluated held-out set.
