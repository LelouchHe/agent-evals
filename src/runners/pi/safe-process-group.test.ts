import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeProcessGroup } from "./safe-process-group.ts";

test("only positive non-broadcast process groups are eligible for sandbox cleanup signals", () => {
  assert.equal(isSafeProcessGroup(2), true);
  assert.equal(isSafeProcessGroup("12345"), true);
  assert.equal(isSafeProcessGroup(2_147_483_647), true);

  for (const value of [0, 1, -1, -12345, 2.5, "", "not-a-pgid", "1e3", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isSafeProcessGroup(value), false, String(value));
  }
  assert.equal(isSafeProcessGroup(2_147_483_648), false);
  assert.equal(isSafeProcessGroup(process.pid), false);
});
