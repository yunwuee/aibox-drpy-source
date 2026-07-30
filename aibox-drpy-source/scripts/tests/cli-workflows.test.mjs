import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, '..', '..');
const cliPath = path.join(skillRoot, 'scripts', 'aibox-skill-cli.mjs');

test('compose 拒绝不存在的 appapi 模板', () => {
  withTempRoot((tempRoot) => {
    const inputPath = writeJson(tempRoot, 'appapi.json', {
      siteName: 'invalid template fixture',
      host: 'https://example.com',
      implementationMode: 'template',
      templateName: 'appapi',
    });
    const result = runCli(['compose', '--input-file', inputPath]);

    assert.notEqual(result.status, 0);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.command, 'compose');
    assert.match(result.payload.error.message, /appapi/);
    assert.match(result.payload.error.message, /未知 Aibox 模板/);
  });
});

test('最小自动模板源通过 lint，heal 不添加伪字段', () => {
  withTempRoot((tempRoot) => {
    const sourcePath = path.join(tempRoot, 'minimal-mxpro.js');
    const source = minimalPortableRule();
    fs.writeFileSync(sourcePath, source, 'utf8');

    const lint = runCli(['lint', '--code-file', sourcePath]);
    assert.equal(lint.status, 0, lint.stderr || lint.stdout);
    assert.equal(lint.payload.ok, true);
    assert.equal(lint.payload.data.passed, true);
    assert.equal(lint.payload.data.ruleSummary.template, '自动');

    const heal = runCli(['heal', '--code-file', sourcePath]);
    assert.equal(heal.status, 0, heal.stderr || heal.stdout);
    assert.equal(heal.payload.ok, true);
    assert.equal(heal.payload.data.changed, false);
    assert.equal(heal.payload.data.applied, false);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), source);
  });
});

test('HTML 和 JSON compose 生成器输出可通过 L1 语法与契约校验', () => {
  withTempRoot((tempRoot) => {
    for (const sourceKind of ['html', 'json']) {
      const fixture = readJson(path.join(skillRoot, 'assets', `compose-rule.${sourceKind}-video.example.json`));
      const inputPath = writeJson(tempRoot, `${sourceKind}.json`, fixture);
      const result = runCli(['compose', '--input-file', inputPath]);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.payload.ok, true);
      assert.equal(result.payload.data.sourceKind, sourceKind);
      assert.equal(result.payload.data.validation.passed, true);
      assert.equal(result.payload.data.validation.syntax.passed, true);
      assert.match(result.payload.data.code, /version:\s*['"]1\.0\.0['"]/);
      assert.match(result.payload.data.code, /play_parse:\s*true/);
      assert.match(result.payload.data.code, /play_json:\s*\[\]/);
    }
  });
});

test('save 在新源语法错误时不覆盖旧文件', () => {
  withTempRoot((tempRoot) => {
    const outputDir = path.join(tempRoot, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const targetPath = path.join(outputDir, 'existing.js');
    const original = '// existing source must survive\nvar sentinel = true;\n';
    fs.writeFileSync(targetPath, original, 'utf8');
    const invalidPath = path.join(tempRoot, 'invalid.js');
    fs.writeFileSync(invalidPath, "var rule = { title: 'broken'", 'utf8');

    const result = runCli([
      'save',
      '--code-file', invalidPath,
      '--output-dir', outputDir,
      '--file-name', 'existing.js',
      '--overwrite',
    ]);

    assert.notEqual(result.status, 0);
    assert.equal(result.payload.ok, false);
    assert.match(result.payload.error.message, /拒绝保存/);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(outputDir), ['existing.js']);
  });
});

test('share --dry-run 本地回读并校验字节数与 SHA-256', () => {
  withTempRoot((tempRoot) => {
    const sourcePath = path.join(tempRoot, 'share.js');
    const source = minimalPortableRule();
    fs.writeFileSync(sourcePath, source, 'utf8');
    const expectedHash = sha256(source);

    const result = runCli([
      'share',
      '--code-file', sourcePath,
      '--name', 'dry run fixture',
      '--category', 'comic',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.data.dryRun, true);
    assert.equal(result.payload.data.sha256, expectedHash);
    assert.equal(result.payload.data.rawLength, Buffer.byteLength(source, 'utf8'));
    assert.equal(result.payload.data.verification.verified, true);
    assert.equal(result.payload.data.verification.dryRun, true);
    assert.equal(result.payload.data.verification.sha256, expectedHash);
    assert.equal(result.payload.data.verification.bytes, Buffer.byteLength(source, 'utf8'));
  });
});

test('旧 CLI alias 保持可用并返回 deprecated 迁移信息', () => {
  withTempRoot((tempRoot) => {
    const sourcePath = path.join(tempRoot, 'alias.js');
    fs.writeFileSync(sourcePath, minimalPortableRule(), 'utf8');

    const result = runCli(['validate-rule', '--code-file', sourcePath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.command, 'lint');
    assert.deepEqual(result.payload.deprecated, {
      command: 'validate-rule',
      replacement: 'lint',
    });
  });
});

function runCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: skillRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
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
    signal: result.signal,
    stdout,
    stderr: String(result.stderr || ''),
    payload,
  };
}

function minimalPortableRule() {
  return `/*
@header({
  title: 'minimal portable fixture',
  类型: '影视',
  lang: 'ds'
})
*/

var rule = {
  类型: '影视',
  title: 'minimal portable fixture',
  version: '1.0.0',
  host: 'https://example.com',
  模板: '自动'
};
`;
}

function writeJson(root, fileName, value) {
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function withTempRoot(callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-cli-workflow-'));
  try {
    return callback(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
