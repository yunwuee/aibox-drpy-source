import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { nativeTest } from './native-test-support.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, '..', '..');
const cliPath = path.join(skillRoot, 'scripts', 'aibox-skill-cli.mjs');

test('CLI 拒绝把 --module 当作路径使用', () => {
  const result = runCli(['lint', '--module', '..\\outside']);

  assert.notEqual(result.status, 0);
  assert.equal(result.payload.error.code, 'MODULE_NAME_INVALID');
  assert.match(result.payload.error.message, /只接受模块名/);
});

test('CLI 默认 JSON 输出递归脱敏源码、密钥和绝对路径', () => {
  withTempRoot((tempRoot) => {
    const spec = JSON.parse(fs.readFileSync(path.join(skillRoot, 'assets', 'compose-rule.html-video.example.json'), 'utf8'));
    spec.headers = {
      Authorization: 'Bearer AUTH_SECRET_123',
      Cookie: 'session=COOKIE_SECRET_456; device=DEVICE_SECRET_789',
      'x-auth-signature': 'SIGNATURE_SECRET_000',
    };
    const inputPath = writeJson(tempRoot, 'secret-compose.json', spec);
    const compose = runCli(['compose', '--input-file', inputPath]);

    assert.equal(compose.status, 0, compose.stderr || compose.stdout);
    assert.equal(compose.stdout.includes('AUTH_SECRET_123'), false);
    assert.equal(compose.stdout.includes('COOKIE_SECRET_456'), false);
    assert.equal(compose.stdout.includes('SIGNATURE_SECRET_000'), false);
    assert.match(compose.stdout, /\[REDACTED\]/);
    assert.match(compose.stdout, /https:\/\/example\.com/);
    assert.match(compose.payload.data.code, /https:\/\/example\.com/);

    const sourcePath = path.join(tempRoot, 'valid.js');
    fs.writeFileSync(sourcePath, validComicRule({ playContract: '  play_parse: true,\n  play_json: [],\n' }), 'utf8');
    const resolved = runCli([
      'resolved',
      '--code-file', sourcePath,
      '--engine-root', path.join(tempRoot, 'missing-engine'),
    ]);

    assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
    assert.equal(resolved.stdout.includes(tempRoot), false);
    assert.equal(/"(?:stack|stderr|stdout)"\s*:/.test(resolved.stdout), false);
  });
});

test('heal --apply 以修复后的 L1 结果返回成功并原子写回', () => {
  withTempRoot((tempRoot) => {
    const sourcePath = path.join(tempRoot, 'heal-comic.js');
    fs.writeFileSync(sourcePath, validComicRule(), 'utf8');

    const result = runCli(['heal', '--code-file', sourcePath, '--apply']);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.data.applied, true);
    assert.equal(result.payload.data.validation.passed, true);
    const written = fs.readFileSync(sourcePath, 'utf8');
    assert.match(written, /play_parse:\s*true/);
    assert.match(written, /play_json:\s*\[\]/);
  });
});

nativeTest('密文单源与分组 share --dry-run 使用同一解密源码', () => {
  withTempRoot((tempRoot) => {
    const body = validComicRule({
      includeHeader: false,
      playContract: '  play_parse: true,\n  play_json: [],\n',
    });
    const encryptedPath = path.join(tempRoot, 'encrypted.js');
    fs.writeFileSync(encryptedPath, `${ruleHeader()}\n${Buffer.from(body, 'utf8').toString('base64')}\n`, 'utf8');

    const single = runCli([
      'share', '--code-file', encryptedPath, '--name', '密文单源', '--category', 'comic', '--dry-run',
    ]);
    assert.equal(single.status, 0, single.stderr || single.stdout);
    assert.equal(single.payload.data.verification.verified, true);

    const groupPath = writeJson(tempRoot, 'group.json', {
      groupTag: '密文测试组',
      category: 'comic',
      entries: [{ name: '密文单源', codeFile: 'encrypted.js' }],
    });
    const group = runCli(['share', '--group-file', groupPath, '--dry-run']);

    assert.equal(group.status, 0, group.stderr || group.stdout);
    assert.equal(group.payload.data.verification.verified, true);
    assert.equal(group.payload.data.manifest.sources[0].sha256, single.payload.data.sha256);
  });
});

function runCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: skillRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  const stdout = String(result.stdout || '').trim();
  let payload = null;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    assert.fail(`CLI 未返回有效 JSON: ${error.message}\nstdout:\n${stdout}\nstderr:\n${result.stderr || ''}`);
  }
  return {
    status: result.status,
    stdout,
    stderr: String(result.stderr || ''),
    payload,
  };
}

function validComicRule({ includeHeader = true, playContract = '' } = {}) {
  return `${includeHeader ? `${ruleHeader()}\n` : ''}var rule = {
  类型: '漫画',
  title: 'CLI 安全测试漫画',
  version: '1.0.0',
  host: 'https://example.com',
  url: '/comics?type=fyclass&page=fypage',
  searchable: 0,
  quickSearch: 0,
  filterable: 0,
  class_name: '全部',
  class_url: 'all',
${playContract}  推荐: '*',
  一级: 'json:list;title;pic;remarks;id',
  二级: async function (ids) {
    return {
      vod_id: ids[0],
      vod_name: '测试漫画',
      vod_pic: 'https://example.com/cover.jpg',
      vod_play_from: '图片',
      vod_play_url: '第一话$chapter-1'
    };
  },
  lazy: async function () {
    return { parse: 0, url: 'pics://https://example.com/1.jpg' };
  }
};
`;
}

function ruleHeader() {
  return `/*
@header({
  title: 'CLI 安全测试漫画',
  类型: '漫画',
  lang: 'ds'
})
*/`;
}

function writeJson(root, fileName, value) {
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function withTempRoot(callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-cli-security-'));
  try {
    return callback(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
