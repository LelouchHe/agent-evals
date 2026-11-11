#!/usr/bin/env node
// @ts-nocheck -- executable test fixture; runtime behavior is covered by tests.
// Deterministic fake Pi RPC process for tests. Behavior is selected by a
// "scenario" file beside this script; no model or network is involved.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(process.argv[1] ?? process.cwd());
const [scenario = "success", extra = ""] = readFileSync(join(here, "scenario"), "utf8").split("\n");

let assistantText = null;
let prompted = false;
let buffer = "";
const messages = [];

if (scenario === "startup-crash") {
  process.exit(1);
}

function send(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function respond(id, command, data) {
  send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}

function settle(text, stopReason = "stop", errorMessage) {
  assistantText = text;
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: String(text) }],
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  });
  send({ type: "agent_end", messages: [], willRetry: false });
  send({ type: "agent_settled", aborted: false });
}

function handlePrompt(command) {
  if (prompted) {
    send({ id: command.id, type: "response", command: "prompt", success: false, error: "already prompted" });
    return;
  }
  prompted = true;
  if (scenario === "no-response") {
    return;
  }
  respond(command.id, "prompt", { disposition: "started" });
  send({ type: "agent_start" });

  switch (scenario) {
    case "success":
      writeFileSync(join(process.cwd(), "hello.txt"), "Hello, world!\n");
      settle("Created hello.txt.");
      break;
    case "no-write":
      settle("Nothing to do.");
      break;
    case "provider-error":
      settle("provider request failed", "error", "synthetic 401 unauthorized");
      break;
    case "provider-error-pre-satisfied":
      settle("provider request failed", "error", "synthetic 401 unauthorized");
      break;
    case "retry-then-success":
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "transient failure" }],
        stopReason: "error",
        errorMessage: "synthetic 529 overloaded",
      });
      settle("Recovered after a retry.");
      break;
    case "pathological":
      writeFileSync(join(process.cwd(), "hello.txt"), "a".repeat(40) + "!");
      settle("Wrote a pathological string.");
      break;
    case "fifo":
      execFileSync("/usr/bin/mkfifo", [join(process.cwd(), "hello.txt")]);
      settle("Created a FIFO.");
      break;
    case "replace-root": {
      const cwd = process.cwd();
      try {
        for (const entry of readdirSync(cwd)) {
          rmSync(join(cwd, entry), { recursive: true, force: true });
        }
        rmdirSync(cwd);
        symlinkSync(extra, cwd, "dir");
        settle("Replaced the workspace root.");
      } catch (error) {
        settle(`replace-root failed: ${String(error?.code ?? error)}`);
      }
      break;
    }
    case "success-no-newline":
      writeFileSync(join(process.cwd(), "hello.txt"), "Hello, world!");
      settle("Created hello.txt.");
      break;
    case "env":
      writeFileSync(join(process.cwd(), "env.txt"), String(process.env.FAKE_TOKEN ?? "missing"));
      settle("Environment checked.");
      break;
    case "judge-valid":
      settle(JSON.stringify({ criteria: [{ criterion: "copied", pass: true, reason: "content matches" }] }));
      break;
    case "judge-fail":
      settle(JSON.stringify({ criteria: [{ criterion: "copied", pass: false, reason: "content differs" }] }));
      break;
    case "judge-invalid":
      settle("not a JSON verdict");
      break;
    case "judge-count":
      settle(
        JSON.stringify({
          criteria: [
            { criterion: "a", pass: true, reason: "one" },
            { criterion: "b", pass: true, reason: "two" },
          ],
        }),
      );
      break;
    case "judge-type":
      settle(JSON.stringify({ criteria: [{ criterion: "a", pass: "yes", reason: "text" }] }));
      break;
    case "judge-args":
      settle(
        JSON.stringify({
          criteria: [{ criterion: "copied", pass: true, reason: process.argv.slice(2).join(" ").slice(0, 600) }],
        }),
      );
      break;
    case "judge-echo":
      settle(
        JSON.stringify({
          criteria: [{ criterion: "copied", pass: true, reason: String(command.message).slice(0, 600) }],
        }),
      );
      break;
    case "judge-fenced":
      settle("```json\n" + JSON.stringify({ criteria: [{ criterion: "a", pass: true, reason: "ok" }] }) + "\n```");
      break;
    case "probe-baseline": {
      let result;
      try {
        readFileSync(join(process.cwd(), "..", "baseline", "seed.txt"), "utf8");
        result = "read";
      } catch (error) {
        result = String(error?.code ?? error);
      }
      writeFileSync(join(process.cwd(), "probe.txt"), result);
      settle("Probed the baseline.");
      break;
    }
    case "record-args":
      if (extra.length > 0) {
        writeFileSync(
          extra,
          JSON.stringify({
            args: process.argv.slice(2),
            cwd: process.cwd(),
            env: {
              HOME: process.env.HOME,
              TMPDIR: process.env.TMPDIR,
              PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
              PATH: process.env.PATH,
            },
          }),
        );
      }
      settle("Recorded launch arguments.");
      break;
    case "record-prompt":
      if (extra.length > 0) {
        writeFileSync(extra, String(command.message));
      }
      settle(JSON.stringify({ criteria: [{ criterion: "copied", pass: true, reason: "recorded" }] }));
      break;
    case "crash":
      setTimeout(() => process.exit(1), 20);
      break;
    case "bad-json":
      process.stdout.write("{this is not json}\n");
      break;
    case "hang":
      break;
    case "ignore-term":
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
      break;
    case "child-hang": {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      if (extra.length > 0 && child.pid !== undefined) {
        writeFileSync(extra, String(child.pid));
      }
      break;
    }
    default:
      settle(`unknown scenario ${scenario}`);
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      handleLine(line);
    }
    newline = buffer.indexOf("\n");
  }
});

function handleLine(line) {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  if (command.type === "prompt") {
    handlePrompt(command);
    return;
  }
  if (command.type === "get_last_assistant_text") {
    respond(command.id, "get_last_assistant_text", { text: assistantText });
    return;
  }
  if (command.type === "get_messages") {
    respond(command.id, "get_messages", { messages });
    return;
  }
  if (command.type === "get_state") {
    respond(command.id, "get_state", { isStreaming: false });
    return;
  }
  if (command.type === "abort") {
    respond(command.id, "abort");
    if (scenario === "settle-on-abort") {
      settle("aborted");
    }
    return;
  }
  send({ id: command.id, type: "response", command: command.type, success: false, error: "unsupported command" });
}
