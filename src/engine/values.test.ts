import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError } from "./config.ts";
import { substituteValues, type ValueSource } from "./values.ts";

function source(values: Record<string, string>, lookups: string[] = []): ValueSource {
  return {
    env: {
      require: async (name) => {
        lookups.push(name);
        if (!(name in values)) throw new ConfigError(`environment value ${name} is not defined`);
        return values[name]!;
      },
    },
    run: { HOME: "/run/home", TMPDIR: "/run/tmp" },
  };
}

test("placeholders substitute anywhere in nested strings, once, leaving keys and other values", async () => {
  const lookups: string[] = [];
  // JSON.parse keeps __proto__ as an own data key, as YAML parameters can.
  const params = Object.assign(JSON.parse('{"__proto__":"data"}') as Record<string, unknown>, {
    token: "${env:TOKEN}",
    url: "https://${env:HOST}/${env:HOST}?tmp=${TMPDIR}",
    literal: "$${env:TOKEN} and $${HOME} cost $5",
    nested: { list: ["${HOME}/.config", 3, true, null] },
    "${env:KEY}": "key stays",
  });
  const result = await substituteValues(params, "runner", source({ TOKEN: "${HOME}", HOST: "example.com" }, lookups));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    // Substituted text is not scanned again.
    token: "${HOME}",
    url: "https://example.com/example.com?tmp=/run/tmp",
    literal: "${env:TOKEN} and ${HOME} cost $5",
    nested: { list: ["/run/home/.config", 3, true, null] },
    "${env:KEY}": "key stays",
    ["__proto__"]: "data",
  });
  assert.ok(Object.hasOwn(result, "__proto__"));
  assert.deepEqual(lookups, ["TOKEN", "HOST"]);
});

test("malformed placeholders are configuration errors naming their location", async () => {
  for (const [value, pattern] of [
    ["${env:KEY", /unterminated "\$\{" in runner\.v; write "\$\$\{" for a literal/],
    ["${vault:KEY}", /unknown value source "vault" .* in runner\.v \(available: env\)/],
    ["${USER}", /unknown variable "\$\{USER\}" in runner\.v \(built-in: HOME, TMPDIR\); use "\$\{env:USER\}"/],
    ["${env:BAD-NAME}", /invalid placeholder "\$\{env:BAD-NAME\}" in runner\.v/],
    ["${}", /invalid placeholder "\$\{\}"/],
    ["${env:}", /invalid placeholder "\$\{env:\}"/],
    ["${ HOME }", /invalid placeholder "\$\{ HOME \}"/],
    ["${:HOME}", /unknown value source "" /],
    ["${env:KEY:X}", /invalid placeholder "\$\{env:KEY:X\}"/],
    // The first `}` closes a placeholder, so nesting is not supported.
    ["${env:${HOME}}", /invalid placeholder "\$\{env:\$\{HOME\}"/],
    // A malformed token after a valid one still fails.
    ["${HOME} then ${env:KEY", /unterminated/],
  ] as const) {
    await assert.rejects(substituteValues({ v: value }, "runner", source({ KEY: "x" })), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, pattern);
      return true;
    });
  }
});

test("token boundaries: adjacent placeholders, stray braces and dollars, and escapes", async () => {
  for (const [value, expected] of [
    ["${HOME}${TMPDIR}", "/run/home/run/tmp"],
    ["a}b$c ${HOME}}", "a}b$c /run/home}"],
    ["$", "$"],
    ["$$", "$$"],
    ["{}", "{}"],
    ["$${HOME}", "${HOME}"],
    ["$${HOME}${HOME}", "${HOME}/run/home"],
    // Leftmost match: `$` then the escape `$${`.
    ["$$${HOME}", "$${HOME}"],
    ["", ""],
  ] as const) {
    assert.deepEqual(await substituteValues({ v: value }, "runner", source({})), { v: expected }, value);
  }
});

test("lookups happen only for real placeholders and only after every string is valid", async () => {
  const lookups: string[] = [];
  // An escaped placeholder is text: MISSING is never looked up.
  assert.deepEqual(await substituteValues({ v: "$${env:MISSING}" }, "runner", source({}, lookups)), {
    v: "${env:MISSING}",
  });
  assert.deepEqual(lookups, []);

  // A malformed later string fails before the earlier lookup command could run.
  await assert.rejects(
    substituteValues({ a: "${env:KEY}", b: "${env:" }, "runner", source({ KEY: "x" }, lookups)),
    /unterminated "\$\{" in runner\.b/,
  );
  assert.deepEqual(lookups, []);

  // A missing .env name reports the source's error.
  await assert.rejects(
    substituteValues({ v: "${env:MISSING}" }, "runner", source({}, lookups)),
    /environment value MISSING is not defined/,
  );
});
