import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import { loadCase } from "./authoring.ts";
import { ConfigError, resolveAuthoringAsset } from "./config.ts";

async function writeDocument(
  t: Parameters<typeof makeTempDir>[0],
  lines: readonly string[],
  name = "case.yml",
): Promise<{ directory: string; path: string }> {
  const directory = await makeTempDir(t, "ae-authoring-");
  const path = join(directory, name);
  await writeFile(path, lines.join("\n") + "\n");
  return { directory, path };
}

async function expectConfigError(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ConfigError, `expected ConfigError, received ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

test("malformed placeholders in the selected implementation parameters reject at load", async (t) => {
  const document = (apiKey: string, unused = "${env:FINE}") => [
    "input: ${not-a-placeholder",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "cases:",
    "  selected:",
    "    runner:",
    "      $type: pi",
    `      apiKey: '${apiKey}'`,
    "  unused:",
    "    runner:",
    "      $type: pi",
    `      apiKey: '${unused}'`,
  ];

  const valid = await writeDocument(t, document("${env:KEY}", "${env:bad-name}"));
  const loaded = await loadCase(valid.path, { caseName: "selected" });
  // Declarations stay unsubstituted; Case-level fields are data.
  assert.equal(loaded.config.runner.apiKey, "${env:KEY}");
  assert.equal(loaded.config.input, "${not-a-placeholder");

  const malformed = await writeDocument(t, document("${USER}"), "malformed.yml");
  await expectConfigError(
    () => loadCase(malformed.path, { caseName: "selected" }),
    /unknown variable "\$\{USER\}" in case "selected" runner\.apiKey .*use "\$\{env:USER\}"/,
  );
});

test("an ordinary document resolves one case and annotates every top-level field as common", async (t) => {
  const { directory, path } = await writeDocument(t, [
    "input: Create hello.txt",
    "timeoutMs: 1234",
    "fixture: fixture",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
    "  - $type: judge",
    "    file: hello.txt",
    "    rubric: [one, two]",
    "runner:",
    "  $type: pi",
    "  model: p/m",
    "  thinking: high",
  ]);

  const loaded = await loadCase(path);
  assert.equal(loaded.path, path);
  assert.equal(loaded.dir, directory);
  assert.equal(loaded.name, undefined);
  assert.equal(loaded.config.input, "Create hello.txt");
  assert.equal(loaded.config.timeoutMs, 1234);
  assert.equal(loaded.config.fixture, "fixture");
  assert.deepEqual(
    loaded.config.checks.map((check) => check.$type),
    ["file", "judge"],
  );
  assert.deepEqual(loaded.config.checks[1]?.rubric, ["one", "two"]);
  assert.equal(loaded.config.runner.thinking, "high");
  assert.deepEqual(loaded.origins, {
    input: { file: path, line: 1, kind: "common" },
    timeoutMs: { file: path, line: 2, kind: "common" },
    fixture: { file: path, line: 3, kind: "common" },
    checks: {
      kind: "list",
      items: [
        { file: path, line: 5, kind: "common" },
        { file: path, line: 8, kind: "common" },
      ],
    },
    runner: { file: path, line: 11, kind: "common" },
  });
});

test("named cases require explicit selection and preserve common versus case origins", async (t) => {
  const { path } = await writeDocument(t, [
    "input: task",
    "timeoutMs: 1000",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
    "cases:",
    "  with-skill:",
    "    runner:",
    "      $type: pi",
    "      model: p/m",
    "      skills: [skill]",
    "  without-skill:",
    "    runner:",
    "      $type: pi",
    "      model: p/m",
    "      skills: []",
  ]);

  await expectConfigError(() => loadCase(path), /defines named cases \(with-skill, without-skill\); select one/);
  await expectConfigError(() => loadCase(path, { caseName: "missing" }), /has no case named "missing"/);
  await expectConfigError(() => loadCase(path, { caseName: "  " }), /select one with --case/);

  const withSkill = await loadCase(path, { caseName: "with-skill" });
  assert.equal(withSkill.name, "with-skill");
  assert.deepEqual(withSkill.config.runner, { $type: "pi", model: "p/m", skills: ["skill"] });
  assert.deepEqual(withSkill.origins.input, { file: path, line: 1, kind: "common" });
  assert.deepEqual(withSkill.origins.checks, {
    kind: "list",
    items: [{ file: path, line: 4, kind: "common" }],
  });
  assert.deepEqual(withSkill.origins.runner, {
    file: path,
    line: 9,
    kind: "case",
    caseName: "with-skill",
  });

  const withoutSkill = await loadCase(path, { caseName: "without-skill" });
  assert.equal(withoutSkill.name, "without-skill");
  assert.deepEqual(withoutSkill.config.runner.skills, []);
  assert.deepEqual(withoutSkill.origins.runner, {
    file: path,
    line: 14,
    kind: "case",
    caseName: "without-skill",
  });

  // Sibling cases are independent and resolving one does not mutate another.
  assert.notEqual(withSkill.config.runner, withoutSkill.config.runner);
  assert.deepEqual(withSkill.config.runner.skills, ["skill"]);
  const again = await loadCase(path, { caseName: "with-skill" });
  assert.deepEqual(again.config, withSkill.config);
});

test("a document without cases rejects a case selection", async (t) => {
  const { path } = await writeDocument(t, [
    "input: task",
    "runner:",
    "  $type: pi",
    "  model: p/m",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
  ]);

  await expectConfigError(() => loadCase(path, { caseName: "anything" }), /does not define named cases/);
  assert.equal((await loadCase(path)).name, undefined);
});

test("cases must be a non-empty mapping of named mappings with allowed fields", async (t) => {
  const runnerAndChecks = [
    "    runner:",
    "      $type: pi",
    "      model: p/m",
    "    checks:",
    "      - $type: file",
    "        path: hello.txt",
    "        exists: true",
  ];

  for (const [label, lines, pattern] of [
    ["empty", ["cases: {}"], /empty cases mapping/],
    ["sequence", ["cases: []"], /cases in .* must be a YAML mapping/],
    ["null", ["cases:"], /cases in .* must be a YAML mapping/],
    ["scalar entry", ["cases:", "  one: scalar"], /case "one" in .* must be a YAML mapping/],
    ["empty name", ["cases:", '  "": {}'], /empty case name/],
    ["numeric name", ["cases:", "  1: {}"], /cases entry in .* must use a string key/],
    ["nested cases", ["cases:", "  one:", "    cases:", "      two: {}", ...runnerAndChecks], /contains nested cases/],
  ] as const) {
    const { path } = await writeDocument(t, ["input: task", ...lines], `${label}.yml`);
    await expectConfigError(() => loadCase(path, { caseName: "one" }), pattern);
  }

  const { path: unknownCommon } = await writeDocument(t, [
    "input: task",
    "unknown: true",
    "cases:",
    "  one:",
    ...runnerAndChecks,
  ]);
  await expectConfigError(() => loadCase(unknownCommon, { caseName: "one" }), /unknown field: unknown/);

  const { path: unknownEntry } = await writeDocument(t, [
    "input: task",
    "cases:",
    "  one:",
    ...runnerAndChecks,
    "    nmae: typo",
  ]);
  await expectConfigError(() => loadCase(unknownEntry, { caseName: "one" }), /case "one".*unknown field: nmae/);
});

test("single-value fields replace common defaults whole, without partial nested merging", async (t) => {
  const { path } = await writeDocument(t, [
    "input: task",
    "timeoutMs: 1000",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
    "runner:",
    "  $type: pi",
    "  model: p/m",
    "cases:",
    "  override-timeout:",
    "    timeoutMs: 2500",
    "  override-runner:",
    "    runner:",
    "      $type: noop",
  ]);
  const timeoutCase = await loadCase(path, { caseName: "override-timeout" });
  assert.equal(timeoutCase.config.timeoutMs, 2500);
  assert.deepEqual(timeoutCase.config.runner, { $type: "pi", model: "p/m" });
  assert.deepEqual(timeoutCase.origins.timeoutMs, { file: path, line: 12, kind: "case", caseName: "override-timeout" });

  const runnerCase = await loadCase(path, { caseName: "override-runner" });
  assert.deepEqual(runnerCase.config.runner, { $type: "noop" });
  assert.equal(runnerCase.config.timeoutMs, 1000);
  assert.deepEqual(runnerCase.origins.runner, { file: path, line: 14, kind: "case", caseName: "override-runner" });
});

test("collection fields (files, checks, mocks) form additive unions and reject duplicate map keys", async (t) => {
  const { path: merged } = await writeDocument(t, [
    "input: task",
    "files:",
    "  .agents/skills: ../..",
    "mocks:",
    "  shell:",
    "    deployctl:",
    "      return:",
    "        stdout: ok",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: false",
    "runner:",
    "  $type: noop",
    "cases:",
    "  plain: {}",
    "  extended:",
    "    files:",
    "      ~/mine/space: fixtures/vault",
    "    mocks:",
    "      shell:",
    "        make:",
    "          pass: false",
    "    checks:",
    "      - $type: trace",
    "        event: skill",
    "        name: handover",
  ]);
  const plain = await loadCase(merged, { caseName: "plain" });
  assert.deepEqual(plain.config.files, { ".agents/skills": "../.." });
  assert.equal(plain.config.checks.length, 1);
  assert.deepEqual(Object.keys(plain.config.mocks?.shell ?? {}), ["deployctl"]);

  const extended = await loadCase(merged, { caseName: "extended" });
  assert.deepEqual(extended.config.files, {
    ".agents/skills": "../..",
    "~/mine/space": "fixtures/vault",
  });
  assert.deepEqual(
    extended.config.checks.map((check) => check.$type),
    ["file", "trace"],
  );
  assert.deepEqual(Object.keys(extended.config.mocks?.shell ?? {}), ["deployctl", "make"]);
  assert.deepEqual(extended.origins.files, {
    kind: "map",
    entries: {
      ".agents/skills": { file: merged, line: 3, kind: "common" },
      "~/mine/space": { file: merged, line: 19, kind: "case", caseName: "extended" },
    },
  });
  assert.deepEqual(extended.origins.checks, {
    kind: "list",
    items: [
      { file: merged, line: 10, kind: "common" },
      { file: merged, line: 25, kind: "case", caseName: "extended" },
    ],
  });
  assert.deepEqual(extended.origins.mocks, {
    kind: "group",
    entries: {
      shell: {
        kind: "map",
        entries: {
          deployctl: { file: merged, line: 6, kind: "common" },
          make: { file: merged, line: 22, kind: "case", caseName: "extended" },
        },
      },
    },
  });

  const { path: duplicateFiles } = await writeDocument(
    t,
    [
      "input: task",
      "files:",
      "  .agents/skills: ../..",
      "checks:",
      "  - $type: file",
      "    path: hello.txt",
      "    exists: false",
      "runner:",
      "  $type: noop",
      "cases:",
      "  overlap:",
      "    files:",
      "      .agents/skills: other",
    ],
    "duplicate-files.yml",
  );
  await expectConfigError(
    () => loadCase(duplicateFiles, { caseName: "overlap" }),
    /repeats files entry from the common part: \.agents\/skills/,
  );

  const { path: duplicateMocks } = await writeDocument(
    t,
    [
      "input: task",
      "mocks:",
      "  shell:",
      "    make:",
      "      pass: false",
      "checks:",
      "  - $type: file",
      "    path: hello.txt",
      "    exists: false",
      "runner:",
      "  $type: noop",
      "cases:",
      "  overlap:",
      "    mocks:",
      "      shell:",
      "        make:",
      "          pass: true",
    ],
    "duplicate-mocks.yml",
  );
  await expectConfigError(
    () => loadCase(duplicateMocks, { caseName: "overlap" }),
    /repeats mocks\.shell entry from the common part: make/,
  );
});

test("incomplete common or case fragments are allowed only when the combination is complete", async (t) => {
  const { path: completeCombination } = await writeDocument(t, [
    "input: task",
    "cases:",
    "  one:",
    "    runner:",
    "      $type: pi",
    "      model: p/m",
    "    checks:",
    "      - $type: file",
    "        path: hello.txt",
    "        exists: true",
  ]);
  const resolved = await loadCase(completeCombination, { caseName: "one" });
  assert.equal(resolved.config.input, "task");
  assert.equal(resolved.config.runner.model, "p/m");

  const { path: missingChecks } = await writeDocument(t, [
    "input: task",
    "runner:",
    "  $type: pi",
    "  model: p/m",
    "cases:",
    "  one: {}",
  ]);
  await expectConfigError(() => loadCase(missingChecks, { caseName: "one" }), /checks must be a non-empty list/);

  const { path: emptyEntry } = await writeDocument(t, [
    "input: task",
    "runner:",
    "  $type: pi",
    "  model: p/m",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
    "cases:",
    "  one: {}",
  ]);
  const fromCommon = await loadCase(emptyEntry, { caseName: "one" });
  assert.equal(fromCommon.config.runner.model, "p/m");
  assert.equal(fromCommon.origins.runner?.kind, "common");
});

test("YAML anchors and aliases are rejected from parsed structure", async (t) => {
  const { path: anchor } = await writeDocument(t, [
    "input: &task task",
    "runner:",
    "  $type: pi",
    "  model: p/m",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
  ]);
  await expectConfigError(() => loadCase(anchor), /YAML anchors are not supported .*line 1/);

  const { path: alias } = await writeDocument(t, [
    "input: &task task",
    "runner:",
    "  $type: pi",
    "  model: *task",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
  ]);
  await expectConfigError(() => loadCase(alias), /YAML aliases are not supported/);

  const { path: nestedAnchor } = await writeDocument(t, [
    "input: task",
    "runner:",
    "  $type: pi",
    "  model: &model p/m",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
  ]);
  await expectConfigError(() => loadCase(nestedAnchor), /YAML anchors are not supported .*line 4/);

  const { path: nestedAlias } = await writeDocument(t, [
    "input: task",
    "runner:",
    "  $type: pi",
    "  model: &model p/m",
    "  thinking: *model",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
  ]);
  await expectConfigError(() => loadCase(nestedAlias), /YAML aliases are not supported/);
});

test("the merge key is rejected as an ordinary scalar key, quoted or not and at any depth", async (t) => {
  const validTail = [
    "runner:",
    "  $type: pi",
    "  model: p/m",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
  ];

  for (const key of ["<<", '"<<"', "'<<'"]) {
    const { path } = await writeDocument(t, ["input: task", `${key}: {input: ignored}`, ...validTail]);
    await expectConfigError(() => loadCase(path), /reserved YAML key "<<" is not supported/);
  }

  const { path: nested } = await writeDocument(t, [
    "input: task",
    "runner:",
    "  $type: pi",
    "  model: p/m",
    '  "<<": ignored',
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
  ]);
  await expectConfigError(() => loadCase(nested), /reserved YAML key "<<" is not supported/);
});

test("ordinary string values that look like reuse syntax remain data", async (t) => {
  const { path } = await writeDocument(t, [
    "input: |",
    "  literal &pi *pi <<: text",
    "runner:",
    "  $type: pi",
    "  model: 'a&b*c<<d'",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    matches: '<<: &x *x'",
  ]);

  const loaded = await loadCase(path);
  assert.equal(loaded.config.input, "literal &pi *pi <<: text\n");
  assert.equal(loaded.config.runner.model, "a&b*c<<d");
  assert.equal(loaded.config.checks[0]?.matches, "<<: &x *x");
});

test("duplicate keys and malformed documents are configuration errors", async (t) => {
  const duplicateRoot = await writeDocument(t, [
    "input: first",
    "input: second",
    "runner:",
    "  $type: pi",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
  ]);
  await expectConfigError(() => loadCase(duplicateRoot.path), /invalid YAML.*unique|invalid YAML.*Map keys/i);

  const duplicateNested = await writeDocument(t, [
    "input: task",
    "runner:",
    "  $type: pi",
    "  $type: pi",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
  ]);
  await expectConfigError(() => loadCase(duplicateNested.path), /invalid YAML/);

  for (const [name, lines, pattern] of [
    ["empty", [], /must contain a YAML mapping/],
    ["scalar", ["just-a-string"], /must be a YAML mapping/],
    ["sequence", ["- one", "- two"], /must be a YAML mapping/],
    ["multiple", ["input: task", "---", "input: other"], /invalid YAML/],
    ["nested input", ["input:", "  nested: true"], /input must be a non-empty string/],
  ] as const) {
    const { path } = await writeDocument(t, lines, `${name}.yml`);
    await expectConfigError(() => loadCase(path), pattern);
  }

  for (const wrapper of ["case", "subject", "candidate", "name"]) {
    const { path } = await writeDocument(
      t,
      [
        "input: task",
        "runner:",
        "  $type: pi",
        "  model: p/m",
        "checks:",
        "  - $type: file",
        "    path: hello.txt",
        "    exists: true",
        `${wrapper}: ignored`,
      ],
      `${wrapper}-wrapper.yml`,
    );
    await expectConfigError(() => loadCase(path), new RegExp(`unknown field: ${wrapper}`));
  }
});

test("final schema errors name the selected case and validate every required field", async (t) => {
  const cases: Array<[string, readonly string[], RegExp]> = [
    ["missing input", ["runner:", "  $type: pi", "checks:", "  - $type: file"], /input must be a non-empty string/],
    [
      "missing runner type",
      ["input: task", "runner:", "  model: p/m", "checks:", "  - $type: file"],
      /runner.\$type must be a non-empty string/,
    ],
    [
      "missing checker type",
      ["input: task", "runner:", "  $type: pi", "checks:", "  - path: hello.txt"],
      /checks\[0\]\.\$type must be a non-empty string/,
    ],
    [
      "absolute fixture",
      ["input: task", "fixture: /etc", "runner:", "  $type: pi", "checks:", "  - $type: file"],
      /fixture must be relative/,
    ],
    [
      "absolute files destination",
      ["input: task", "files:", "  /etc/passwd: skill", "runner:", "  $type: pi", "checks:", "  - $type: file"],
      /files destination "\/etc\/passwd" must be relative to the workspace root/,
    ],
    [
      "escaping files destination",
      ["input: task", "files:", "  ../outside: skill", "runner:", "  $type: pi", "checks:", "  - $type: file"],
      /files destination "\.\.\/outside" must not contain "\.\."/,
    ],
    [
      "absolute files source",
      ["input: task", "files:", "  file.txt: /etc/passwd", "runner:", "  $type: pi", "checks:", "  - $type: file"],
      /files\["file\.txt"\] must be relative/,
    ],
    [
      "files is not a mapping",
      ["input: task", "files: [skill]", "runner:", "  $type: pi", "checks:", "  - $type: file"],
      /files must be a YAML mapping/,
    ],
    [
      "bad timeout",
      ["input: task", "timeoutMs: 1.5", "runner:", "  $type: pi", "checks:", "  - $type: file"],
      /timeoutMs must be a positive integer/,
    ],
    ["empty checks", ["input: task", "runner:", "  $type: pi", "checks: []"], /checks must be a non-empty list/],
  ];

  for (const [name, lines, pattern] of cases) {
    const { path } = await writeDocument(
      t,
      ["cases:", "  selected:", ...lines.map((line) => `    ${line}`)],
      `${name}.yml`,
    );
    await expectConfigError(() => loadCase(path, { caseName: "selected" }), pattern);
  }
});

test("a case name is metadata only, including names that resemble paths", async (t) => {
  const { directory, path } = await writeDocument(t, [
    "input: task",
    "cases:",
    '  "../escape":',
    "    runner:",
    "      $type: pi",
    "      model: p/m",
    "    checks:",
    "      - $type: file",
    "        path: hello.txt",
    "        exists: true",
  ]);

  const resolved = await loadCase(path, { caseName: "../escape" });
  assert.equal(resolved.name, "../escape");
  assert.equal(resolved.dir, directory);
  assert.equal(resolved.path, path);
  assert.equal(dirname(resolved.path), directory);
});

test("unknown YAML tags are configuration errors while literal tag text remains data", async (t) => {
  const validTail = [
    "runner:",
    "  $type: pi",
    "  model: p/m",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
  ];

  for (const tag of ["!include file.txt", "!foo value"]) {
    const { path } = await writeDocument(t, [`input: ${tag}`, ...validTail]);
    await expectConfigError(() => loadCase(path), /unsupported YAML.*Unresolved tag/);
  }

  const { path } = await writeDocument(t, ["input: literal !include and !foo text", ...validTail]);
  const loaded = await loadCase(path);
  assert.equal(loaded.config.input, "literal !include and !foo text");
});

test("authoring assets resolve relative to the declaring configuration", async (t) => {
  const declaring = await makeTempDir(t, "ae-config-");
  await mkdir(join(declaring, "skill"));
  const resolved = resolveAuthoringAsset(declaring, "skill", "runner.skills[0]");
  assert.equal(resolved, join(declaring, "skill"));
  assert.throws(() => resolveAuthoringAsset(declaring, "/absolute", "asset"), ConfigError);
});
