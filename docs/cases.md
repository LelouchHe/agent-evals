# Writing Cases

Treat a case like a test: control the inputs, observe outcomes and side effects, and focus on one behavior. [Configuration Reference](configuration.md) owns YAML syntax, parameter tables, selection and result records; this page owns test design.

## Choose the Behavior

| Testing concept       | Agent evaluation                                                   |
| --------------------- | ------------------------------------------------------------------ |
| System under test     | Configured harness and evaluated resources.                        |
| Fixture               | Initial task environment.                                          |
| Assertion             | A check of available evidence.                                     |
| Parameterized test    | Named cases with shared invariants.                                |
| Side-effect assertion | Resulting environment state, including files that must not change. |

- Prefer several narrow cases over one large task with an opaque score.
- Assert outcomes, not a prescribed action sequence, unless the action itself is the behavior being tested.
- A case may target one skill or capability. Reuse it across implementations only when their relevant expectations are shared.
- Names and collections do not imply an A/B experiment. Repeated runs can test the current contents of the same referenced skill; different checks do not automatically yield comparable scores.
- Agents are stochastic. One pass proves that run, not an improvement rate. Repetition/comparison support is a [planned capability](roadmap.md#evidence-and-measurements), not current statistical evidence.

## Prepare Explicit Inputs

Keep fixtures and case-owned assets beside the test. For example:

```text
write-file/
  case.yml
  skill/SKILL.md
```

Add a fixture directory only when initial files are needed. Do not populate an intentionally empty workspace with placeholder files or require a setup/check script for every case. Dedicated setup/custom-check assets may be useful authoring resources, but M1 does not provide generic setup-script or arbitrary checker-script YAML fields.

Use deterministic authored data or explicit preparation instead of asking another model to improvise the environment. Extract shared assets only after actual reuse; share definitions and initial inputs, not mutable per-run state. Keep results separate and never rewrite the source fixture during evaluation.

Expose only the intended task, resources and environment to the agent. Case/check definitions, rubric, reference answers and unrelated operator capabilities should not leak into its workspace. Keep local credentials separate from test data; see [Credentials](../README.md#credentials).

## Choose Evidence and Checks

Use deterministic checks for exact facts and a judge for qualitative criteria. A file check need not become a new checker class for every assertion; one checker can return several results. A rubric can be a list of statements without mandatory business categories.

Do not create routing-versus-behavior pipelines. Skill loading, tool choices, restraint and result quality are concerns expressed through checks and evidence when those observations exist. A missing observation cannot prove that the agent avoided an action.

File/environment evidence is stronger than an agent's own account alone. The simple write-file example is an integration smoke: with and without a skill can both pass, so it does not demonstrate skill effectiveness. Future collaborator substitution and richer observations are described in [Roadmap](roadmap.md), not implemented by adding ad hoc Case fields.

## Keep Validation Data Honest

Train/dev/test organization can separate iterative improvement from held-out evaluation; it does not imply this toolkit trains model weights. Avoid inspecting test answers during optimization, and watch for near-duplicate leakage across related cases. Keep judge-calibration examples separate from the evaluated held-out set.
