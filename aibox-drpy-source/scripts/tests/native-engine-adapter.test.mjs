import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  inspectNativeEngineAvailability,
  resolveNativeEngineLayout,
  runNativeEngineChain,
  runNativeEngineOperation,
} from '../lib/aibox-engine-adapter.mjs';
import { runRuleCheck } from '../lib/rule-checker.mjs';
import { createLocalComicSite, writeComicRule } from './native-engine-fixture.mjs';
import { nativeTest } from './native-test-support.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, '..', '..');

test('native adapter reports an unavailable engine without portable fallback', async () => {
  const missingRoot = path.join(os.tmpdir(), `missing-aibox-engine-${Date.now()}`);
  const availability = inspectNativeEngineAvailability(skillRoot, { engineRoot: missingRoot });
  assert.equal(availability.available, false);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-unavailable-'));
  const sourcePath = path.join(tempRoot, 'fixture.js');
  fs.writeFileSync(sourcePath, 'var rule = {};', 'utf8');
  try {
    const result = await runNativeEngineOperation('home', {
      skillRoot,
      engineRoot: missingRoot,
      sourcePath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.engine, 'native');
    assert.equal(result.fidelity, 'unavailable');
    assert.equal(result.error.code, 'NATIVE_ENGINE_UNAVAILABLE');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('native adapter chains real class_id to vod_id and play URL in one worker session', async () => {
  const site = await createLocalComicSite();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-chain-'));
  const sourcePath = writeComicRule(path.join(tempRoot, 'fixture.js'), site.baseUrl);
  try {
    const result = await runNativeEngineChain({
      skillRoot,
      sourcePath,
      timeoutMs: 45_000,
      args: { keyword: 'needle' },
    });
    assert.equal(result.ok, true, JSON.stringify(result.error || {}, null, 2));
    assert.equal(result.fidelity, 'native');
    assert.equal(result.data.selected.classId, 'comic');
    assert.match(result.data.selected.vodId, /\/detail\/vod-1$/);
    assert.match(result.data.selected.playUrl, /\/chapter\/chapter-1$/);
    assert.equal(result.data.steps.category.list[0].vod_name, 'Category item');
    assert.equal(result.data.steps.category.list[0].vod_pic, `${site.baseUrl}/images/vod-1.jpg?stage=category`);
    assert.equal(result.data.steps.detail.list[0].vod_name, 'vod-1');
    assert.equal(result.data.steps.play.parse, 0);
    assert.match(result.data.steps.play.url, /^pics:\/\//);
    assert.equal(result.data.steps.search.list[0].vod_name, 'Search needle');

    const resolved = await runNativeEngineOperation('getRuleObject', {
      skillRoot,
      sourcePath,
      timeoutMs: 45_000,
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved.error || {}, null, 2));
    assert.equal(resolved.data.title, 'native parity fixture');
    assert.equal(resolved.data.lazy.type, 'function');

    const proxy = await runNativeEngineOperation('proxy', {
      skillRoot,
      sourcePath,
      timeoutMs: 45_000,
      args: { params: { url: `${site.baseUrl}/image`, value: 'ok' } },
    });
    assert.equal(proxy.ok, true, JSON.stringify(proxy.error || {}, null, 2));
    assert.deepEqual(proxy.data, [200, 'text/plain', 'proxy:ok']);
  } finally {
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('native adapter gives getItem/setItem an isolated local directory and removes it after success', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-storage-'));
  const workspaceParent = path.join(tempRoot, 'workspaces');
  const title = `native storage isolation ${process.pid}-${Date.now()}`;
  const sourcePath = writeStorageRule(path.join(tempRoot, 'fixture.js'), {
    title,
    classParse: `
    const expected = 'persisted-in-worker';
    setItem('storage_probe', expected);
    const actual = getItem('storage_probe', 'missing');
    if (actual !== expected) {
      throw new Error('getItem did not return the value written by setItem');
    }
    return {
      class: [{ type_name: actual, type_id: 'comic' }],
      filters: {}
    };`,
  });
  const engineRoot = resolveNativeEngineLayout(skillRoot).engineRoot;
  const engineStoragePath = path.join(engineRoot, 'local', `js_drpyS_${title}`);
  assert.equal(fs.existsSync(engineStoragePath), false);

  try {
    const result = await runNativeEngineOperation('home', {
      skillRoot,
      sourcePath,
      workerWorkspaceParent: workspaceParent,
      timeoutMs: 45_000,
    });

    assert.equal(result.ok, true, JSON.stringify(result.error || {}, null, 2));
    assert.equal(result.data.class[0].type_name, 'persisted-in-worker');
    assert.equal(result.data.class[0].type_id, 'comic');
    assert.deepEqual(fs.readdirSync(workspaceParent), []);
    assert.equal(fs.existsSync(engineStoragePath), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('native adapter removes the isolated workspace after a rule exception', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-exception-'));
  const workspaceParent = path.join(tempRoot, 'workspaces');
  const sourcePath = writeStorageRule(path.join(tempRoot, 'fixture.js'), {
    title: `native exception cleanup ${process.pid}-${Date.now()}`,
    classParse: `throw new Error('intentional native fixture failure');`,
  });

  try {
    const result = await runNativeEngineOperation('home', {
      skillRoot,
      sourcePath,
      workerWorkspaceParent: workspaceParent,
      timeoutMs: 45_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NATIVE_ENGINE_EXECUTION_FAILED');
    assert.match(result.error.message, /intentional native fixture failure/);
    assert.deepEqual(fs.readdirSync(workspaceParent), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('native adapter removes the isolated workspace after a timeout', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-timeout-'));
  const workspaceParent = path.join(tempRoot, 'workspaces');
  const sourcePath = writeStorageRule(path.join(tempRoot, 'fixture.js'), {
    title: `native timeout cleanup ${process.pid}-${Date.now()}`,
    classParse: `
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    return { class: [], filters: {} };`,
  });

  try {
    const result = await runNativeEngineOperation('home', {
      skillRoot,
      sourcePath,
      workerWorkspaceParent: workspaceParent,
      timeoutMs: 100,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NATIVE_ENGINE_TIMEOUT');
    assert.deepEqual(fs.readdirSync(workspaceParent), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('L3 严格验收拒绝有分类但分类列表为空的源', async () => {
  const site = await createLocalComicSite({ emptyCategory: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-empty-category-'));
  const sourcePath = writeComicRule(path.join(tempRoot, 'fixture.js'), site.baseUrl);
  try {
    const result = await runRuleCheck({
      skillRoot,
      codeFile: sourcePath,
      level: 'l3',
      engine: 'native',
      timeoutMs: 45_000,
    });

    assert.equal(result.passed, false, JSON.stringify({
      errors: result.errors,
      category: result.steps?.category,
      nativeError: result.result?.error,
    }, null, 2));
    assert.equal(result.evidenceLevel, 'L3');
    assert.equal(result.failureClass, 'chain_failure');
    assert.match(result.errors.join('\n'), /(?:分类|category).*(?:空|no items)/i);
  } finally {
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('L3 漫画验收探测推荐、分类、详情和搜索的真实封面文件头', async () => {
  const site = await createLocalComicSite();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-cover-probes-'));
  const sourcePath = writeComicRule(path.join(tempRoot, 'fixture.js'), site.baseUrl);
  try {
    const result = await runRuleCheck({
      skillRoot,
      codeFile: sourcePath,
      level: 'l3',
      engine: 'native',
      timeoutMs: 45_000,
    });

    assert.equal(result.passed, true, JSON.stringify(result.errors, null, 2));
    for (const stage of ['homeVod', 'category', 'detail', 'search']) {
      assert.equal(result.probes.covers[stage].passed, true, stage);
      assert.equal(result.probes.covers[stage].via, 'direct', stage);
      assert.equal(result.probes.covers[stage].signature, 'png', stage);
      assert.deepEqual(result.probes.covers[stage].errors, [], stage);
    }
    assert.deepEqual(result.stageErrors.category, []);
    assert.deepEqual(result.stageErrors.detail, []);
    assert.equal(result.scoring.earned.category, 20);
    assert.equal(result.scoring.earned.detail, 25);
  } finally {
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('L3 漫画验收把分类和详情的伪图片作为硬错误并扣除阶段分数', async () => {
  const site = await createLocalComicSite({
    coverModes: { category: 'invalid', detail: 'invalid' },
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-invalid-covers-'));
  const sourcePath = writeComicRule(path.join(tempRoot, 'fixture.js'), site.baseUrl);
  try {
    const result = await runRuleCheck({
      skillRoot,
      codeFile: sourcePath,
      level: 'l3',
      engine: 'native',
      timeoutMs: 45_000,
    });

    assert.equal(result.passed, false);
    assert.equal(result.probes.covers.category.passed, false);
    assert.equal(result.probes.covers.detail.passed, false);
    assert.match(result.stageErrors.category.join('\n'), /分类封面不可读/);
    assert.match(result.stageErrors.detail.join('\n'), /详情封面不可读/);
    assert.equal(result.scoring.earned.category, 0);
    assert.equal(result.scoring.earned.detail, 0);
  } finally {
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('L3 漫画验收按 allowEmpty 跳过空推荐和空搜索封面', async () => {
  const site = await createLocalComicSite({ emptyHome: true, emptySearch: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-optional-covers-'));
  const sourcePath = writeComicRule(path.join(tempRoot, 'fixture.js'), site.baseUrl);
  try {
    const result = await runRuleCheck({
      skillRoot,
      codeFile: sourcePath,
      level: 'l3',
      engine: 'native',
      timeoutMs: 45_000,
      allowEmpty: 'homevod,search',
    });

    assert.equal(result.passed, true, JSON.stringify(result.errors, null, 2));
    assert.equal(result.probes.covers.homeVod.skipped, true);
    assert.equal(result.probes.covers.homeVod.reason, 'allow-empty');
    assert.equal(result.probes.covers.search.skipped, true);
    assert.equal(result.probes.covers.search.reason, 'allow-empty');
    assert.equal(result.scoring.earned.search, null);
  } finally {
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('L3 漫画验收的 allowEmpty 不放行非空推荐和搜索中的伪封面', async () => {
  const site = await createLocalComicSite({
    coverModes: { homeVod: 'invalid', search: 'invalid' },
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-nonempty-optional-covers-'));
  const sourcePath = writeComicRule(path.join(tempRoot, 'fixture.js'), site.baseUrl);
  try {
    const result = await runRuleCheck({
      skillRoot,
      codeFile: sourcePath,
      level: 'l3',
      engine: 'native',
      timeoutMs: 45_000,
      allowEmpty: 'homevod,search',
    });

    assert.equal(result.passed, false);
    assert.equal(result.probes.covers.homeVod.skipped, false);
    assert.equal(result.probes.covers.homeVod.passed, false);
    assert.equal(result.probes.covers.search.skipped, false);
    assert.equal(result.probes.covers.search.passed, false);
    assert.match(result.stageErrors.homeVod.join('\n'), /推荐封面不可读/);
    assert.match(result.stageErrors.search.join('\n'), /搜索封面不可读/);
    assert.equal(result.scoring.earned.home, 0);
    assert.equal(result.scoring.earned.search, 0);
    assert.equal(result.scoring.available, 100);
  } finally {
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('L3 漫画验收按推荐和搜索能力跳过未启用阶段的封面', async () => {
  const site = await createLocalComicSite({
    coverModes: { homeVod: 'invalid', search: 'invalid' },
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-disabled-cover-capabilities-'));
  const sourcePath = writeComicRule(path.join(tempRoot, 'fixture.js'), site.baseUrl, {
    recommendable: false,
    searchable: false,
  });
  try {
    const result = await runRuleCheck({
      skillRoot,
      codeFile: sourcePath,
      level: 'l3',
      engine: 'native',
      timeoutMs: 45_000,
    });

    assert.equal(result.passed, true, JSON.stringify(result.errors, null, 2));
    assert.equal(result.probes.covers.homeVod.skipped, true);
    assert.equal(result.probes.covers.homeVod.reason, 'capability-disabled');
    assert.equal(result.probes.covers.search.skipped, true);
    assert.equal(result.probes.covers.search.reason, 'capability-disabled');
    assert.equal(result.scoring.earned.home, 20);
    assert.equal(result.scoring.earned.search, null);
    assert.equal(result.scoring.available, 90);
  } finally {
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('L3 漫画封面在同一原生会话中通过 proxy_rule 验证', async () => {
  const site = await createLocalComicSite();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-proxy-covers-'));
  const sourcePath = writeProxyCoverRule(path.join(tempRoot, 'fixture.js'), site.baseUrl);
  try {
    const result = await runRuleCheck({
      skillRoot,
      codeFile: sourcePath,
      level: 'l3',
      engine: 'native',
      timeoutMs: 45_000,
    });

    assert.equal(result.passed, true, JSON.stringify(result.errors, null, 2));
    for (const stage of ['homeVod', 'category', 'detail', 'search']) {
      assert.equal(result.probes.covers[stage].passed, true, stage);
      assert.equal(result.probes.covers[stage].via, 'proxy_rule', stage);
      assert.equal(result.probes.covers[stage].signature, 'png', stage);
    }
  } finally {
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

nativeTest('L3 漫画直连封面使用规则请求头并接受真实 SVG 文件头', async () => {
  const token = { name: 'x-cover-token', value: 'cover-ready' };
  const site = await createLocalComicSite({
    requiredCoverHeader: token,
    coverModes: { homeVod: 'svg', category: 'svg', detail: 'svg', search: 'svg' },
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-native-cover-headers-'));
  const sourcePath = writeComicRule(path.join(tempRoot, 'fixture.js'), site.baseUrl, {
    headers: { 'X-Cover-Token': token.value },
  });
  try {
    const result = await runRuleCheck({
      skillRoot,
      codeFile: sourcePath,
      level: 'l3',
      engine: 'native',
      timeoutMs: 45_000,
    });

    assert.equal(result.passed, true, JSON.stringify(result.errors, null, 2));
    for (const stage of ['homeVod', 'category', 'detail', 'search']) {
      assert.equal(result.probes.covers[stage].via, 'direct', stage);
      assert.equal(result.probes.covers[stage].signature, 'svg', stage);
    }
  } finally {
    await site.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function writeStorageRule(targetPath, { title, classParse }) {
  const code = `var rule = {
  title: ${JSON.stringify(title)},
  类型: '漫画',
  version: '1.0.0',
  host: 'http://127.0.0.1',
  homeUrl: '/',
  class_name: 'Fallback',
  class_url: 'fallback',
  class_parse: async function () {${classParse}
  }
};`;
  fs.writeFileSync(targetPath, code, 'utf8');
  return targetPath;
}

function writeProxyCoverRule(targetPath, baseUrl) {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUg==';
  const code = `var rule = {
  title: 'native proxy cover fixture',
  类型: '漫画',
  version: '1.0.0',
  host: ${JSON.stringify(baseUrl)},
  homeUrl: '/',
  url: '/list/fyclass/fypage',
  detailUrl: '/detail/fyid',
  searchUrl: '/search?wd=**&page=fypage',
  class_name: 'Comics',
  class_url: 'comic',
  searchable: 1,
  filterable: 0,
  quickSearch: 0,
  play_parse: true,
  play_json: [],
  _cover: function (stage) {
    return getProxyUrl() + '&stage=' + encodeURIComponent(stage);
  },
  推荐: async function () {
    return setResult([{ title: 'Home', pic_url: rule._cover('homeVod'), url: 'home' }]);
  },
  一级: async function () {
    setItem('cover_session', 'ready');
    return setResult([{ title: 'Category', pic_url: rule._cover('category'), url: 'vod-1' }]);
  },
  二级: async function (ids) {
    return {
      vod_id: ids[0],
      vod_name: 'Detail',
      vod_pic: rule._cover('detail'),
      vod_play_from: 'Reader',
      vod_play_url: 'Chapter 1$chapter-1'
    };
  },
  搜索: async function () {
    return setResult([{ title: 'Search', pic_url: rule._cover('search'), url: 'vod-search' }]);
  },
  lazy: async function () {
    return { parse: 0, url: 'pics://' + rule.host + '/images/page-1.png' };
  },
  proxy_rule: async function () {
    if (getItem('cover_session', '') !== 'ready') {
      return [500, 'text/plain', 'missing shared session'];
    }
    return [200, 'image/png', ${JSON.stringify(pngBase64)}, {}, 1];
  }
};`;
  fs.writeFileSync(targetPath, code, 'utf8');
  return targetPath;
}
