import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const env = {
  PATH: process.env.PATH,
  HUSKY: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  CI: "true",
  npm_config_update_notifier: "false",
};

function run(cwd: string, command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...env,
      HOME: join(dirname(cwd), "home"),
      XDG_CONFIG_HOME: join(dirname(cwd), "config"),
      npm_config_cache: join(dirname(cwd), "npm-cache"),
      npm_config_userconfig: "/dev/null",
    },
    input,
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, output: result.stdout + result.stderr };
}

function succeed(cwd: string, command: string, args: string[]) {
  const result = run(cwd, command, args);
  assert.equal(result.status, 0, result.output);
  return result.output;
}

async function fixture(t: TestContext, content = "export const value = 1;\n") {
  const root = await makeTempDir(t, "ae-hooks-");
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  await mkdir(repo);
  succeed(repo, "git", ["init", "--initial-branch=main"]);
  succeed(repo, "git", ["config", "user.name", "Hook Test"]);
  succeed(repo, "git", ["config", "user.email", "hooks@example.invalid"]);
  succeed(root, "git", ["init", "--bare", remote]);
  succeed(repo, "git", ["remote", "add", "origin", remote]);
  await symlink(join(projectDir, "node_modules"), join(repo, "node_modules"), "dir");

  const actualPackage = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const scripts: Record<string, string> = { ...actualPackage.scripts, test: "node --test smoke.test.mjs" };
  delete scripts.eval;
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ private: true, type: "module", scripts }, null, 2) + "\n",
  );
  await writeFile(join(repo, ".gitignore"), "node_modules/\n.husky/_/\n");
  await writeFile(
    join(repo, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2024",
          module: "nodenext",
          moduleResolution: "nodenext",
          types: ["node"],
          noEmit: true,
          strict: true,
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(repo, "smoke.test.mjs"),
    'import { writeFileSync } from "node:fs";\nimport { test } from "node:test";\ntest("fixture", () => { writeFileSync("../test-ran", "passed"); });\n',
  );
  await mkdir(join(repo, "src"));
  await mkdir(join(repo, "tests"));
  await writeFile(join(repo, "src", "example.ts"), content);
  await writeFile(join(repo, "tests", "sample.ts"), "export const checked = true;\n");

  for (const name of [
    "eslint.config.mjs",
    ".prettierrc.json",
    ".prettierignore",
    ".husky/pre-commit",
    ".husky/pre-push",
  ]) {
    try {
      await mkdir(dirname(join(repo, name)), { recursive: true });
      await copyFile(join(projectDir, name), join(repo, name));
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
      // Before implementation, missing hooks leave Git free to accept bad input.
    }
  }
  succeed(repo, process.execPath, [join(projectDir, "node_modules/prettier/bin/prettier.cjs"), "--write", "."]);
  succeed(repo, "git", ["add", "."]);
  succeed(repo, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "test: prepare hook fixture"]);
  succeed(repo, process.execPath, [join(projectDir, "node_modules/husky/bin.js")]);
  assert.equal(succeed(repo, "git", ["config", "--get", "core.hooksPath"]).trim(), ".husky/_");
  return { repo, remote, root };
}

test("pre-commit rejects a real TypeScript lint violation without rewriting files", async (t) => {
  const { repo } = await fixture(t);
  const file = join(repo, "src", "example.ts");
  const content = "export const value = 1;\nconst unused = 2;\n";
  await writeFile(file, content);
  succeed(repo, "git", ["add", "src/example.ts"]);
  const result = run(repo, "git", ["commit", "-m", "test: lint rejection"]);
  assert.notEqual(result.status, 0, "Git accepted a staged lint violation");
  assert.match(result.output, /no-unused-vars/);
  assert.equal(await readFile(file, "utf8"), content);
});

test("pre-commit rejects formatting differences without rewriting files", async (t) => {
  const { repo } = await fixture(t);
  const file = join(repo, "src", "example.ts");
  const content = "export const value=2\n";
  await writeFile(file, content);
  succeed(repo, "git", ["add", "src/example.ts"]);
  const result = run(repo, "git", ["commit", "-m", "test: format rejection"]);
  assert.notEqual(result.status, 0, "Git accepted an unformatted staged file");
  assert.match(result.output, /Code style issues/);
  assert.equal(await readFile(file, "utf8"), content);
});

test("pre-commit accepts a clean formatted change through Husky", async (t) => {
  const { repo } = await fixture(t);
  await writeFile(join(repo, "src", "example.ts"), "export const value = 2;\n");
  succeed(repo, "git", ["add", "src/example.ts"]);
  const output = succeed(repo, "git", ["commit", "-m", "test: valid commit"]);
  assert.match(output, /format:check/);
  assert.equal(succeed(repo, "git", ["status", "--porcelain"]).trim(), "");
});

test("pre-push runs the complete gate for a clean outgoing HEAD", async (t) => {
  const { repo, root } = await fixture(t);
  const result = run(repo, "git", ["push", "origin", "HEAD:refs/heads/main"]);
  assert.equal(result.status, 0, result.output);
  for (const command of ["eslint src tests", "prettier --check", "tsc --noEmit", "node --test smoke.test.mjs"]) {
    assert.ok(result.output.includes(command), result.output);
  }
  assert.equal(await readFile(join(root, "test-ran"), "utf8"), "passed");
  assert.equal(
    succeed(repo, "git", ["rev-parse", "HEAD"]).trim(),
    succeed(repo, "git", ["ls-remote", "origin", "refs/heads/main"]).trim().split(/\s/)[0],
  );
});

test("pre-push rejects a committed type error before uploading a tree", async (t) => {
  const { repo } = await fixture(t, "export const value: string = 1;\n");
  const result = run(repo, "git", ["push", "origin", "HEAD:refs/heads/main"]);
  assert.notEqual(result.status, 0, "Git pushed a commit with a type error");
  assert.match(result.output, /TS2322/);
  assert.equal(succeed(repo, "git", ["ls-remote", "origin", "refs/heads/main"]).trim(), "");
});

test("pre-push rejects a runtime test failure before uploading a tree", async (t) => {
  const { repo } = await fixture(t);
  await writeFile(
    join(repo, "smoke.test.mjs"),
    'import { test } from "node:test";\ntest("fixture", () => {\n  throw new Error("fixture test failure");\n});\n',
  );
  succeed(repo, "git", ["add", "smoke.test.mjs"]);
  succeed(repo, "git", ["commit", "-m", "test: failing runtime test"]);
  const result = run(repo, "git", ["push", "origin", "HEAD:refs/heads/main"]);
  assert.notEqual(result.status, 0, "Git pushed despite a failing runtime test");
  assert.match(result.output, /fixture test failure/);
  assert.equal(succeed(repo, "git", ["ls-remote", "origin", "refs/heads/main"]).trim(), "");
});

test("pre-push rejects a dirty worktree rather than validating different content", async (t) => {
  const { repo } = await fixture(t);
  await writeFile(join(repo, "src", "example.ts"), "export const value = 2;\n");
  const result = run(repo, "git", ["push", "origin", "HEAD:refs/heads/main"]);
  assert.notEqual(result.status, 0, "Git pushed while checks would see uncommitted content");
  assert.match(result.output, /clean worktree/);
  assert.equal(succeed(repo, "git", ["ls-remote", "origin", "refs/heads/main"]).trim(), "");
});

test("pre-push rejects an outgoing commit other than the checked-out HEAD", async (t) => {
  const { repo } = await fixture(t);
  const previous = succeed(repo, "git", ["rev-parse", "HEAD"]).trim();
  succeed(repo, "git", ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "test: advance HEAD"]);
  const result = run(repo, "git", ["push", "origin", `${previous}:refs/heads/older`]);
  assert.notEqual(result.status, 0, "Git pushed a commit that the worktree checks cannot verify");
  assert.match(result.output, /checked-out HEAD/);
  assert.equal(succeed(repo, "git", ["ls-remote", "origin", "refs/heads/older"]).trim(), "");
});
