import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL('../../', import.meta.url));
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const api = fileURLToPath(new URL('../../node_modules/vitest/dist/index.js', import.meta.url));
const setup = path.join(root, 'server/src/__tests__/setup-supertest.ts');

for (const parallel of [false, true]) test(`isolated forks retain fresh state with file parallelism ${parallel}`, () => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pc-fork-proof-')));
  try {
    const record = path.join(directory, 'workers.ndjson');
    const config = path.join(directory, 'vitest.config.mjs');
    const files = ['first.test.ts', 'second.test.ts'];
    for (const file of files) writeFileSync(path.join(directory, file), `
      import { expect, it, vi } from ${JSON.stringify(api)};
      import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
      it('starts clean and can contaminate only its own worker', async () => {
        expect(globalThis.serializedLeak).toBeUndefined();
        expect(process.env.PAPERCLIP_SERIALIZED_LEAK).toBeUndefined();
        expect(vi.isFakeTimers()).toBe(false);
        expect(existsSync(process.env.PAPERCLIP_CONFIG)).toBe(false);
        appendFileSync(${JSON.stringify(record)}, JSON.stringify({
          name: ${JSON.stringify(file)}, pid: process.pid, home: process.env.PAPERCLIP_HOME,
          config: process.env.PAPERCLIP_CONFIG, instance: process.env.PAPERCLIP_INSTANCE_ID,
        }) + '\\n');
        writeFileSync(process.env.PAPERCLIP_CONFIG, '{}');
        // In parallel mode both real workers must arrive before either exits.
        // This fails if the controller silently falls back to serial execution.
        if (${parallel}) {
          const { readFileSync } = await import('node:fs');
          const deadline = Date.now() + 10_000;
          while (readFileSync(${JSON.stringify(record)}, 'utf8').trim().split('\\n').length < 2) {
            if (Date.now() > deadline) throw new Error('second isolated worker did not start');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        globalThis.serializedLeak = true;
        process.env.PAPERCLIP_SERIALIZED_LEAK = 'leaked';
        vi.useFakeTimers();
      });
    `);
    for (const order of [files, [...files].reverse()]) {
      rmSync(record, { force: true });
      writeFileSync(config, `import Sequencer from './sequencer.mjs'; export default ${JSON.stringify({
        root: directory,
        test: {
          include: order, pool: 'forks', isolate: true, fileParallelism: parallel,
          maxWorkers: parallel ? 2 : 1, setupFiles: [setup],
          sequence: { sequencer: '__SEQUENCER__' },
        },
      }).replace('"__SEQUENCER__"', 'Sequencer')};`);
      writeFileSync(path.join(directory, 'sequencer.mjs'), `export default class {
        shard(tests) { return tests; }
        sort(tests) { return tests.sort((a, b) => ${JSON.stringify(order)}.indexOf(a.moduleId.split('/').pop()) - ${JSON.stringify(order)}.indexOf(b.moduleId.split('/').pop())); }
      }`);
      const result = spawnSync(process.execPath, [vitest, 'run', '--config', config], {
        cwd: root, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, PAPERCLIP_HOME: path.join(directory, 'controller-home'),
          PAPERCLIP_CONFIG: path.join(directory, 'controller-config.json'), PAPERCLIP_INSTANCE_ID: 'controller' },
      });
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      const workers = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(workers.length, 2);
      assert.deepEqual(workers.map((worker) => worker.name).sort(), [...order].sort());
      if (!parallel) assert.deepEqual(workers.map((worker) => worker.name), order);
      for (const key of ['pid', 'home', 'config', 'instance']) assert.equal(new Set(workers.map((worker) => worker[key])).size, 2, key);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Regression: abandoned wrapper roots exhausted ryzen4's /tmp inodes. Exercise
// the actual wrapper boundary, including collection failures before the run.
for (const [name, keep, failure] of [
  ["successful run", "", ""],
  ["failed run", "", "run"],
  ["failed collection", "", "list"],
  ["explicit keep", "1", ""],
  ["keep after failure", "1", "run"],
  ["keep=0 still cleans up", "0", ""],
]) test(`wrapper temp roots honor TMPDIR and cleanup policy: ${name}`, { skip: process.platform === "win32" }, () => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pc-root-proof-")));
  const parent = path.join(directory, "tmp");
  const receipt = path.join(directory, "root.json");
  const fakePnpm = path.join(directory, "pnpm");
  mkdirSync(parent);
  try {
    writeFileSync(fakePnpm, `#!${process.execPath}
      const fs = require('node:fs');
      const path = require('node:path');
      const root = path.dirname(process.env.PAPERCLIP_HOME);
      fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
        root, home: process.env.PAPERCLIP_HOME, tmpdir: process.env.TMPDIR,
        homeExists: fs.statSync(process.env.PAPERCLIP_HOME).isDirectory(),
        tmpExists: fs.statSync(process.env.TMPDIR).isDirectory(),
      }));
      // Leave nested content behind to require recursive cleanup.
      fs.writeFileSync(path.join(process.env.TMPDIR, 'fixture'), 'temporary');
      if (process.argv.includes('list')) process.exit(7);
      process.exit(${failure === "run" ? 7 : 0});
    `);
    chmodSync(fakePnpm, 0o755);
    const env = { ...process.env, TMPDIR: parent,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      PAPERCLIP_TEST_KEEP_TMP: keep, PAPERCLIP_CI_PROFILE: "false" };
    for (const key of Object.keys(env)) {
      if (key.endsWith("_TEST_DATABASE_URL")) delete env[key];
    }
    delete env.PAPERCLIP_CI_TEST_SELECTION;
    delete env.PAPERCLIP_CI_SELECTION_HASH;
    const result = spawnSync(process.execPath, [path.join(root, "scripts/run-vitest-stable.mjs"),
      "--mode", "general", "--group", failure === "list" ? "general-chat" : "general-workspaces-c"], {
      cwd: root, encoding: "utf8", timeout: 30_000, env,
    });
    assert.equal(result.status, failure ? 1 : 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    const observed = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(path.dirname(observed.root), parent, "root must be created under TMPDIR");
    assert.match(path.basename(observed.root), /^pv-/);
    assert.equal(observed.home, path.join(observed.root, "h"));
    assert.equal(observed.tmpdir, path.join(observed.root, "t"));
    assert.ok(observed.homeExists && observed.tmpExists, "root must exist while the child runs");
    assert.equal(existsSync(observed.root), keep === "1", "only KEEP_TMP=1 retains the root");
    assert.deepEqual(readdirSync(parent), keep === "1" ? [path.basename(observed.root)] : []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
