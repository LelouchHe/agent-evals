# Configuration Composition

Status: agreed design; not implemented. The current CLI still requires separate `--case` and `--candidate` files. See [the implemented M1 records](cases.md#m1-supported-records) for the format that works today. This document records the next authoring model, not an instruction to migrate code or examples immediately.

## Case, Common Configuration, and Run

- A **case** is a complete, executable test definition: its task, initial environment, runner configuration, checks, and execution requirements.
- **Common configuration** supplies reusable fields. It is not necessarily a runnable case or only an environment description; it can also contain a shared task, runner, or checks.
- An **authoring document** contains either one ordinary case or common fields plus a mapping of named cases. It can extend another document.
- A **resolved case** is the final configuration after file composition and the selected case's overrides. Only this complete configuration is executed.
- A **run** is one actual execution of one resolved case, with independent runtime state and a retained result.

Do not require separate Candidate, Subject, or Variant entities or files. Named cases are ordinary tests, not a special A/B pipeline. Names such as `with-skill`, `without-skill`, `baseline`, and `revision-a` are author-defined identifiers for selection and result labeling; they have no built-in behavior.

A case may be specific to a skill or capability. Reuse it across implementations when they share the relevant expectations, not because every skill or harness must support every case. A collection of cases need not be a comparison group. Different cases may replace their checks as well as their runner parameters; comparability is not implied by membership in the same file.

## Ordinary Single-Case Documents

Write simple tests directly, without a `case`, `subject`, or `candidate` wrapper:

```yaml
input: Create hello.txt with exactly the content "Hello, world!".
timeoutMs: 120000

runner:
  $type: pi
  model: opencode-go/deepseek-v4.1-flash
  envPassthrough: [OPENCODE_API_KEY]

checks:
  - $type: file
    path: hello.txt
    exists: true
    matches: '^Hello, world!\n?$'
```

Without `cases`, the document resolves to one ordinary case and one invocation executes one run. Without `fixture`, the example starts from an empty workspace. The key's value is supplied by the invoking environment, not stored in YAML.

## Common Fields and Named Cases

Add a `cases` mapping alongside the common fields to describe several tests. For example, append this to the ordinary configuration above:

```yaml
cases:
  with-skill:
    runner:
      skills: [skill]

  without-skill:
    runner:
      skills: []
```

Each entry overrides the common configuration to produce one complete case. When `cases` is present, the common part is not also executed as an extra unnamed case.

The resolver does not understand what these labels or parameters mean. In this example, the Pi runner interprets `skills`; its existing automatic-discovery restrictions make an empty list meaningful. Other runners can have entirely different parameters.

Execute a selected case through the ordinary single-case execution path. A helper may iterate over several selected cases, but batching does not require a separate lifecycle or evaluation category. Repeatedly execute the same saved configuration to test changes to the resources it references; do not require a new configuration or manually entered version number for every run.

## Separate Files and `extends`

Both `extends` and `cases` are optional:

| `extends` | `cases` | Meaning                                                           |
| --------- | ------- | ----------------------------------------------------------------- |
| Absent    | Absent  | One ordinary case.                                                |
| Absent    | Present | Common fields and named case overrides in one document.           |
| Present   | Absent  | Inherited common fields plus local overrides resolve to one case. |
| Present   | Present | Inherited common fields plus named case overrides.                |

Let the case collection reference the common file, rather than requiring the common file to enumerate all its users:

```text
write-file/
  base.yml
  skills.yml
  skill/
```

For example, `base.yml` can contain the shared task, runner, and checks above. `skills.yml` contains:

```yaml
extends: ./base.yml

cases:
  with-skill:
    runner:
      skills: [skill]

  without-skill:
    runner:
      skills: []
```

Adding another test collection does not require changing `base.yml`. File names are conventions, not semantic selectors: a file called `skills.yml` does not activate a skill-specific mode.

Support multi-level, single-parent chains, for example `skills.yml -> pi.yml -> base.yml`. Each layer can override fields inherited from its parent; overriding is not restricted to the final named case. Do not introduce multiple-parent inheritance.

## Mechanical Merge Rules

Use one data-merge mechanism at every layer:

1. Load and parse the referenced parent configuration.
2. Merge the current document's common fields over inherited common fields.
3. Apply the selected named case's overrides, when present.
4. Validate the complete resolved case before runtime execution.

The precedence is the most distant ancestor, nearer ancestors, the entry document's common fields, then the selected case override.

- Merge mappings recursively. Overriding `runner.skills` preserves other inherited runner fields.
- Replace scalar values.
- Replace arrays as a whole; never append implicitly. This applies equally to `skills`, `checks`, `rubric`, and any implementation-owned arrays.
- Preserve fields absent from an override.
- Resolve every case independently without mutating shared configuration or another case.
- Reject missing inherited files and inheritance cycles, and enforce a bounded inheritance depth.

The merge operates on parsed YAML data, not concatenated text. It does not interpret skill names, migrate parameters between runner types, or guess business intent. The final schema and selected implementations reject invalid or incompatible configurations. Common fragments and overrides do not each have to be executable on their own.

`extends` and `cases` are authoring controls, not parameters passed to a runner or checker. Within implementation records, `$type` still selects the implementation and all other fields remain implementation-owned. Composition does not add engine-defined meanings to model, thinking, skill, or rubric parameters.

Do not add template interpolation, a variable-expression language, JSON Pointer references, or implicit environment expansion to implement this mechanism.

## Paths and Provenance

Resolve an `extends` reference relative to the file containing that reference. Preserve the declaring source of inherited values instead of rebasing everything to the last file loaded.

Authoring assets remain relative to the file that declares them. For example, an inherited fixture keeps the base file's directory as its reference point, while a skill path overridden by another file uses that overriding file's directory. Check targets remain relative to the evaluated workspace, not either configuration directory.

Carry source information through parsing and merging:

- The source file and location of each final field/value.
- The selected case name for values supplied by a named case override.
- The origin needed to interpret relative resource paths correctly.

A merged mapping can contain values from several files. One source label for the whole mapping is therefore insufficient. An array replacement gets its provenance from the replacing declaration. Compute provenance during resolution, not by guessing after the merge.

## Read-Only `view`

Provide a `view` operation that expands a configuration and displays the resolved case with field-level source annotations. It must not launch a harness, invoke a model, require provider credentials, or fetch credential values from the environment.

An illustrative display is:

```yaml
timeoutMs: 120000 # base.yml:3

runner:
  $type: pi # pi.yml:4
  model: opencode-go/deepseek-v4.1-flash # pi.yml:5
  thinking: medium # base.yml:8
  skills: [skill] # skills.yml:7, case: with-skill
```

For a single-case document, no case selector is needed. A named case can be selected from a collection for inspection. Resolution errors must be visible without starting a run.

`view` and execution must use the same resolver and the same resolved values and origins. Execution performs the full runtime/implementation validation before launching anything; inspection must not obtain credentials merely to show the configuration. The exact CLI syntax and provenance serialization are not fixed by this design.

Make the final configuration inspectable before encouraging multi-level inheritance. Keep ordinary tests in one file, extract shared fields only after real reuse, and prefer shallow chains when they suffice. Inheritance is not a reason to make a simple case hard to read.

## Run Records and Implementation Boundary

Retain the actual resolved, non-sensitive configuration used by each run, together with its selected case/source identity and sufficient version or content identification for the evaluated resources. Do not require manual version edits for every execution, and do not assume unchanged resource paths mean unchanged content. Changing a source YAML later must not change the meaning of an old result.

Do not retain secret values. For environment-provided credentials, retain only their declared variable names. This configuration/version evidence is not a commitment to full filesystem snapshots, a generic tracer, or offline regrading of all checks.

The existing M1 implementation does not yet support this composition format, a `view` operation, per-field origins, or complete resolved-configuration/resource-version retention. Its runner/checker interfaces currently receive one `authoringDir` per implementation record; that alone does not implement mixed-origin parameter resolution. Implementing the agreed origin behavior will require deliberate interface work rather than silently choosing the entry file's directory for every value.

See [cases and configuration](cases.md) for shared authoring and implementation-selection rules, [architecture](architecture.md) for responsibilities, and [M1](m1-plan.md) for the delivered behavior.
