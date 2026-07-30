import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLocalComicSite, writeComicRule } from './native-engine-fixture.mjs';
import { nativeTest } from './native-test-support.mjs';

const execFileAsync = promisify(execFile);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, '..', '..');
const cliPath = path.join(skillRoot, 'scripts', 'aibox-skill-cli.mjs');

nativeTest('CLI check --level l3 --engine native 完成真实漫画链路', async () => {
  const site = await createLocalComicSite();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-cli-native-check-'));
  const sourcePath = writeComicRule(path.join(tempRoot, 'fixture.js'), site.baseUrl);
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'check',
      '--code-file', sourcePath,
      '--level', 'l3',
      '--engine', 'native',
      '--timeout-ms', '45000',
    ], {
      cwd: skillRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const payload = JSON.parse(stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.data.passed, true);
    assert.equal(payload.data.engine, 'native');
    assert.equal(payload.data.evidenceLevel, 'L3');
    assert.equal(payload.data.probes.first.passed, true);
    assert.equal(payload.data.probes.last.passed, true);
    for (const stage of ['homeVod', 'category', 'detail', 'search']) {
      assert.equal(payload.data.probes.covers[stage].passed, true, stage);
    }
    assert.equal(stdout.includes(tempRoot), false);
  } finally {
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
