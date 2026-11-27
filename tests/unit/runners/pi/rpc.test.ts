import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createFakePi } from "../../../helpers/fake-pi-control.ts";
import { PiProcess, PiRpcError } from "../../../../src/runners/pi/rpc.ts";

function startFake(executable: string, options: { commandTimeoutMs?: number; stopGraceMs?: number } = {}): PiProcess {
  return new PiProcess({
    commandTimeoutMs: options.commandTimeoutMs ?? 2_000,
    stopGraceMs: options.stopGraceMs ?? 200,
    spawn: () =>
      spawn(process.execPath, [executable], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      }),
  });
}

test("PiProcess correlates responses after CRLF framing", async (t) => {
  const fake = await createFakePi(t, "record-args");
  const pi = startFake(fake.executable);
  t.after(() => pi.stop());
  const settled = pi.waitForEvent("agent_settled", 5_000);
  const response = (await pi.command("prompt", { message: "hi" })) as { disposition: string };
  assert.equal(response.disposition, "started");
  await settled;
  const text = (await pi.command("get_last_assistant_text")) as { text: string };
  assert.match(text.text, /Recorded/);
});

test("PiProcess reports a command timeout", async (t) => {
  const fake = await createFakePi(t, "no-response");
  const pi = startFake(fake.executable, { commandTimeoutMs: 100 });
  t.after(() => pi.stop());
  await assert.rejects(
    () => pi.command("prompt", { message: "hi" }),
    (error: unknown) => {
      return error instanceof PiRpcError && /did not respond/.test(error.message);
    },
  );
});

test("PiProcess escalates to SIGKILL when SIGTERM is ignored", async (t) => {
  const fake = await createFakePi(t, "ignore-term");
  const pi = startFake(fake.executable, { stopGraceMs: 100 });
  t.after(() => pi.stop());
  await pi.command("prompt", { message: "hi" });
  const pid = pi.pid;
  assert.ok(pid !== undefined);
  const started = performance.now();
  await pi.stop();
  assert.ok(performance.now() - started < 10_000);
  const deadline = Date.now() + 2_000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(alive, false, `process ${pid} remained alive after stop()`);
});
