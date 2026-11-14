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
  ] as const) {
    await assert.rejects(substituteValues({ v: value }, "runner", source({ KEY: "x" })), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, pattern);
      return true;
    });
  }
});
