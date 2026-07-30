import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runLiveCheck } from '../lib/live-checker.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, '..', '..');

test('full live-check validates novel catalog plus first and last chapter content', async () => {
  const report = await runFixture('novel-fixture.js');
  assert.equal(report.passed, true, report.errors.join('\n'));
  assert.equal(report.contentType, 'novel');
  assert.equal(report.steps.novel_catalog.responseSummary.episodeCount, 2);
  assert.equal(report.steps.novel_chapter_first.mediaProbe.status, 'ok');
  assert.equal(report.steps.novel_chapter_last.mediaProbe.status, 'ok');
});

test('full live-check validates comic catalog plus first and last chapter images', async () => {
  const report = await runFixture('comic-fixture.js');
  assert.equal(report.passed, true, report.errors.join('\n'));
  assert.equal(report.contentType, 'comic');
  assert.equal(report.steps.comic_catalog.responseSummary.episodeCount, 2);
  assert.equal(report.steps.comic_chapter_first.mediaProbe.firstImageProbe.imageKind, 'png');
  assert.equal(report.steps.comic_chapter_last.mediaProbe.lastImageProbe.imageKind, 'png');
});

async function runFixture(fileName) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-drpy-skill-test-'));
  const port = await reservePort();
  try {
    return await runLiveCheck({
      skillRoot,
      config: {
        outputDir: path.join(tempRoot, 'output'),
        configDir: skillRoot,
        embeddedDrpy: {
          port,
          cleanupOnSuccess: true,
          sessionRoot: path.join(tempRoot, 'sessions'),
          reportRoot: path.join(tempRoot, 'reports'),
          stateFile: path.join(tempRoot, 'runtime.state.json'),
        },
      },
      codeFile: path.join(testRoot, 'fixtures', fileName),
      depth: 'full',
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
