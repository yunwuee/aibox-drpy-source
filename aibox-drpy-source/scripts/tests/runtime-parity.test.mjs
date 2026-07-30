import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runNativeEngineChain } from '../lib/aibox-engine-adapter.mjs';
import {
  createSession,
  ensureRuntimeRunning,
  mountSourceIntoSession,
  stopManagedRuntime,
} from '../lib/embedded-drpy-manager.mjs';
import {
  normalizePlayResult,
  resolveInheritedListRule,
} from '../lib/embedded-drpy-runtime-core.mjs';
import {
  createLocalComicSite,
  firstEpisode,
  writeComicRule,
} from './native-engine-fixture.mjs';
import { nativeTest } from './native-test-support.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, '..', '..');

test('portable rule inheritance and play_json policy match current Aibox semantics', () => {
  const categoryRule = '.item;.title&&Text;img&&data-src||src;.remark&&Text;a&&href';
  assert.equal(resolveInheritedListRule('推荐', '*', categoryRule), categoryRule);
  assert.equal(resolveInheritedListRule('搜索', '*;*;*;*;*', categoryRule), categoryRule);

  const lazy = function () {};
  const reader = { parse: 0, jx: 0, url: 'pics://https://local/1.jpg' };
  assert.equal(normalizePlayResult({ play_parse: true, lazy, play_json: [] }, reader, 'chapter-1', '正文').parse, 0);
  assert.deepEqual(
    normalizePlayResult({ play_parse: true, lazy, play_json: false }, reader, 'chapter-1', '正文'),
    { parse: 1, jx: 0, url: reader.url, flag: '正文' },
  );
  const forcedJx = normalizePlayResult({ play_parse: true, lazy, play_json: true }, reader, 'chapter-1', '正文');
  assert.equal(forcedJx.parse, 1);
  assert.equal(forcedJx.jx, 1);
});

nativeTest('portable runtime matches native chain and never takes over an occupied port', async () => {
  const site = await createLocalComicSite();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-runtime-parity-'));
  const sourcePath = writeComicRule(path.join(tempRoot, 'fixture.js'), site.baseUrl);
  const config = {
    configDir: skillRoot,
    outputDir: path.join(tempRoot, 'output'),
    embeddedDrpy: {
      port: site.port,
      nodeCommand: process.execPath,
      sessionRoot: path.join(tempRoot, 'sessions'),
      reportRoot: path.join(tempRoot, 'reports'),
      stateFile: path.join(tempRoot, 'runtime.state.json'),
      sourceDirs: [tempRoot],
    },
  };
  const session = createSession(skillRoot, config, 'runtime-parity');
  const mounted = mountSourceIntoSession(session, sourcePath, 'fixture');
  let runtime;
  try {
    const native = await runNativeEngineChain({
      skillRoot,
      sourcePath,
      timeoutMs: 45_000,
      args: { keyword: 'needle' },
    });
    assert.equal(native.ok, true, JSON.stringify(native.error || {}, null, 2));

    runtime = await ensureRuntimeRunning(session, {
      skillRoot,
      port: site.port,
      nodeCommand: process.execPath,
    });
    assert.notEqual(runtime.port, site.port);
    assert.equal((await fetch(site.baseUrl)).status, 200);

    const home = await getJson(`${runtime.baseUrl}/api/${mounted.moduleName}`);
    const classId = home.class[0].type_id;
    const category = await getJson(`${runtime.baseUrl}/api/${mounted.moduleName}?ac=videolist&t=${encodeURIComponent(classId)}&pg=1`);
    const vodId = category.list[0].vod_id;
    const detail = await getJson(`${runtime.baseUrl}/api/${mounted.moduleName}?ac=detail&ids=${encodeURIComponent(vodId)}`);
    const episode = firstEpisode(detail.list[0]);
    const play = await getJson(`${runtime.baseUrl}/api/${mounted.moduleName}?flag=${encodeURIComponent(episode.flag)}&play=${encodeURIComponent(episode.url)}`);
    const search = await getJson(`${runtime.baseUrl}/api/${mounted.moduleName}?wd=needle&pg=1`);

    assert.equal(classId, native.data.selected.classId);
    assert.equal(vodId, native.data.selected.vodId);
    assert.equal(episode.url, native.data.selected.playUrl);
    assert.equal(category.list[0].vod_pic, native.data.steps.category.list[0].vod_pic);
    assert.equal(detail.list[0].vod_pic, native.data.steps.detail.list[0].vod_pic);
    assert.equal(play.parse, native.data.steps.play.parse);
    assert.equal(play.url, native.data.steps.play.url);
    assert.equal(search.list[0].vod_name, native.data.steps.search.list[0].vod_name);

    const refused = await stopManagedRuntime({ ...runtime, ownershipToken: 'forged-token' });
    assert.equal(refused.stopped, false);
    assert.equal(refused.reason, 'health-ownership-mismatch');
    const healthResponse = await fetch(`${runtime.baseUrl}/__aibox_health`, {
      headers: { 'x-aibox-runtime-token': runtime.ownershipToken },
    });
    assert.equal(healthResponse.status, 200);
  } finally {
    if (runtime) {
      const stopped = await stopManagedRuntime(runtime);
      assert.equal(stopped.stopped, true, JSON.stringify(stopped));
    }
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text);
}
