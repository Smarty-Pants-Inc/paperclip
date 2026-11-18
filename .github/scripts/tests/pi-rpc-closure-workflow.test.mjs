import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../../workflows/pr.yml", import.meta.url), "utf8");
const selection = workflow.match(/      - name: Select native Pi RPC closure changes\n[\s\S]*?        run: \|\n([\s\S]*?)(?=      - )/);
assert.ok(selection, "native closure path selection step exists");
const script = selection[1].replace(/^          /gm, "");
const runner = "packages/paperclip-runner/";
const inputs = [
  "scripts/pi-rpc-distribution/package.json",
  "scripts/pi-rpc-distribution/package-lock.json",
  "pi-rpc-distribution.json",
  "scripts/materialize-pi-rpc-distribution.mjs",
  "src/drivers/pi/pi-rpc-installation.ts",
  "src/drivers/pi/generated-distribution.ts",
].map((path) => runner + path);
const identity = {
  GIT_AUTHOR_NAME: "smarty-fleet-write[bot]",
  GIT_AUTHOR_EMAIL: "333979660+smarty-fleet-write[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "smarty-fleet-write[bot]",
  GIT_COMMITTER_EMAIL: "333979660+smarty-fleet-write[bot]@users.noreply.github.com",
};

// Keep reason: an incorrect CI path gate can silently bypass the native-closure
// trust boundary. Execute the workflow's real selector against Git tree changes.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-rpc-closure-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ...identity, GITHUB_OUTPUT: join(root, "output") };
  function git(...args) {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function write(path, content = "changed\n") {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  function commit() {
    git("add", "-A");
    git("commit", "-qm", "fixture");
  }
  function select() {
    return spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd: root, env, encoding: "utf8" });
  }
  git("init", "-q");
  for (const path of [...inputs, "unrelated.txt"]) write(path);
  commit();
  return { root, git, write, commit, select, output: () => readFileSync(env.GITHUB_OUTPUT, "utf8") };
}

for (const path of [...inputs, runner + "scripts/pi-rpc-distribution/nested/new-input.json"]) {
  test(`native closure is selected for ${path}`, (t) => {
    const f = fixture(t);
    f.write(path, "updated\n");
    f.commit();
    assert.equal(f.select().status, 0);
    assert.equal(f.output(), "closure=true\n");
  });
}

test("unrelated changes skip the native closure", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "unrelated.txt"), "updated\n");
  f.commit();
  assert.equal(f.select().status, 0);
  assert.equal(f.output(), "closure=false\n");
});

test("deleting a closure input still selects the check", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, inputs[0]));
  f.commit();
  assert.equal(f.select().status, 0);
  assert.equal(f.output(), "closure=true\n");
});

test("renaming a closure input outside the selected paths still selects the check", (t) => {
  const f = fixture(t);
  renameSync(join(f.root, inputs[0]), join(f.root, "moved.json"));
  f.commit();
  assert.equal(f.select().status, 0);
  assert.equal(f.output(), "closure=true\n");
});

test("the tested merge tree is compared to its first parent", (t) => {
  const f = fixture(t);
  f.git("checkout", "-qb", "head");
  writeFileSync(join(f.root, "unrelated.txt"), "updated\n");
  f.commit();
  f.git("checkout", "-qb", "base", "HEAD^1");
  writeFileSync(join(f.root, inputs[0]), "base advanced\n");
  f.commit();
  f.git("merge", "--no-ff", "-qm", "tested merge", "head");
  assert.equal(f.select().status, 0);
  assert.equal(f.output(), "closure=false\n", "base-only input changes are not attributed to the PR");
});

test("missing comparison history fails closed instead of skipping the check", (t) => {
  const f = fixture(t);
  assert.notEqual(f.select().status, 0);
  assert.throws(f.output, { code: "ENOENT" });
});
