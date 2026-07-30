#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createKnowledgeBase } from './lib/knowledge-base.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, '..');
const errors = [];
const warnings = [];

const requiredPaths = [
  'SKILL.md',
  'LICENSE',
  'agents/openai.yaml',
  'assets/runtime-capability-matrix.json',
  'config/aibox.config.example.json',
  'package.json',
  'package-lock.json',
  'scripts/aibox-skill-cli.mjs',
  'scripts/validate-public-package.mjs',
  'template/ds_template.js',
  'vendor/crypto-js/LICENSE',
  'vendor/embedded-drpy/index.js',
];

for (const relativePath of requiredPaths) {
  if (!fs.existsSync(path.join(skillRoot, relativePath))) {
    errors.push('缺少必需文件: ' + relativePath);
  }
}

const publishFiles = listPublishFiles(skillRoot);
const publishSet = new Set(publishFiles.map(normalizePath));
const forbiddenPathPatterns = [
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)output(\/|$)/i,
  /(^|\/)temp(\/|$)/i,
  /(^|\/)coverage(\/|$)/i,
  /(^|\/)assets\/examples(\/|$)/i,
  /(^|\/)sources(\/|$)/i,
  /(^|\/)spider(\/|$)/i,
];

for (const relativePath of publishSet) {
  if (forbiddenPathPatterns.some((pattern) => pattern.test(relativePath))) {
    errors.push('发行文件包含禁止路径: ' + relativePath);
  }
  if (relativePath.toLowerCase() === 'config/aibox.config.json') {
    errors.push('发行文件包含本地配置: ' + relativePath);
  }
}

validateSkillFrontmatter();
validateAgentMetadata();
validatePackageMetadata();
validateJsonFiles();
validateTextEncodingAndPrivacy();
validatePublishedHosts();
validateMarkdownLinks();
validateKnowledgeBase();
validateStarterAssets();

const result = {
  ok: errors.length === 0,
  skillRoot,
  checkedFiles: publishFiles.length,
  errors,
  warnings,
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (errors.length > 0) {
  process.exit(1);
}

function validateSkillFrontmatter() {
  const filePath = path.join(skillRoot, 'SKILL.md');
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    errors.push('SKILL.md 缺少有效 YAML frontmatter');
    return;
  }

  const entries = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':');
      return separator > 0
        ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
        : [line, ''];
    });
  const keys = entries.map(([key]) => key);
  if (entries.length !== 2 || keys.some((key) => !['name', 'description'].includes(key))) {
    errors.push('SKILL.md frontmatter 只能包含 name 和 description');
  }
  const values = Object.fromEntries(entries);
  if (values.name !== 'aibox-drpy-source') {
    errors.push('SKILL.md name 必须为 aibox-drpy-source');
  }
  if (!values.description || values.description.length < 40) {
    errors.push('SKILL.md description 过短或为空');
  }
}

function validateAgentMetadata() {
  const filePath = path.join(skillRoot, 'agents', 'openai.yaml');
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const field of ['display_name', 'short_description', 'default_prompt']) {
    if (!new RegExp('^\\s*' + field + ':\\s*\"[^\"]+\"\\s*$', 'm').test(text)) {
      errors.push('agents/openai.yaml 缺少带引号字段: ' + field);
    }
  }
  if (!text.includes('$aibox-drpy-source')) {
    errors.push('agents/openai.yaml default_prompt 必须显式提到 $aibox-drpy-source');
  }
}

function validatePackageMetadata() {
  const packagePath = path.join(skillRoot, 'package.json');
  const lockPath = path.join(skillRoot, 'package-lock.json');
  if (!fs.existsSync(packagePath) || !fs.existsSync(lockPath)) return;
  const packageJson = readJson(packagePath);
  const lockJson = readJson(lockPath);
  if (!packageJson || !lockJson) return;

  if (packageJson.author?.url !== 'https://github.com/yunwuee') {
    errors.push('package.json author.url 必须指向 https://github.com/yunwuee');
  }
  if (packageJson.repository?.url !== 'git+https://github.com/yunwuee/aibox-drpy-source.git') {
    errors.push('package.json repository.url 不正确');
  }
  if (packageJson.license !== 'MIT') {
    errors.push('package.json license 必须为 MIT');
  }
  if (lockJson.version !== packageJson.version || lockJson.packages?.['']?.version !== packageJson.version) {
    errors.push('package-lock.json 版本与 package.json 不一致');
  }
}

function validateJsonFiles() {
  for (const relativePath of publishFiles.filter((item) => item.endsWith('.json'))) {
    readJson(path.join(skillRoot, relativePath));
  }
}

function validateTextEncodingAndPrivacy() {
  const textExtensions = new Set(['.md', '.mjs', '.js', '.json', '.yaml', '.yml', '.ps1', '.txt']);
  const privatePathPatterns = [
    /[A-Za-z]:\\Users\\[^\\\r\n]+\\/i,
    /\/Users\/[^/\r\n]+\//,
    /\/home\/[^/\r\n]+\//,
    /Winter Holiday Project/i,
  ];
  const secretAssignmentPattern = /\b(?:authorization|cookie|api[_-]?key|access[_-]?token|secret)\b\s*[:=]\s*['"]([^'"]{12,})['"]/ig;

  for (const relativePath of publishFiles) {
    const extension = path.extname(relativePath).toLowerCase();
    if (!textExtensions.has(extension)) continue;
    const filePath = path.join(skillRoot, relativePath);
    const bytes = fs.readFileSync(filePath);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      errors.push('文本文件包含 UTF-8 BOM: ' + relativePath);
    }
    const text = bytes.toString('utf8');
    const isValidator = normalizePath(relativePath) === 'scripts/validate-public-package.mjs';
    const isTestFixture = normalizePath(relativePath).startsWith('scripts/tests/');
    if (!isValidator && privatePathPatterns.some((pattern) => pattern.test(text))) {
      errors.push('文本文件包含本机绝对路径: ' + relativePath);
    }
    if (isValidator || isTestFixture) continue;
    for (const match of text.matchAll(secretAssignmentPattern)) {
      const value = match[1].trim();
      if (!/^(?:example|placeholder|your[-_ ]|replace[-_ ]|test[-_ ])/i.test(value)) {
        errors.push('疑似硬编码敏感值: ' + relativePath);
        break;
      }
    }
  }
}

function validatePublishedHosts() {
  const textExtensions = new Set(['.md', '.mjs', '.js', '.json', '.yaml', '.yml', '.ps1', '.txt']);
  const approvedHosts = new Set([
    '127.0.0.1',
    'api.nn.ci',
    'crypto-js.googlecode.com',
    'cryptojs.gitbook.io',
    'github.com',
    'localhost',
    'opensource.org',
    'registry.npmjs.org',
    'textdb.online',
    'www.w3.org',
  ]);
  const reported = new Set();

  for (const relativePath of publishFiles) {
    if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue;
    const text = fs.readFileSync(path.join(skillRoot, relativePath), 'utf8');
    for (const match of text.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/ig)) {
      const hostname = match[1].toLowerCase();
      if (
        approvedHosts.has(hostname)
        || !hostname.includes('.')
        || /(^|\.)example\.(?:com|org|net)$/i.test(hostname)
        || /(^|\.)example$/i.test(hostname)
        || /(^|\.)invalid$/i.test(hostname)
      ) {
        continue;
      }
      const key = normalizePath(relativePath) + '|' + hostname;
      if (reported.has(key)) continue;
      reported.add(key);
      errors.push('发行文本包含未批准外部主机: ' + relativePath + ' -> ' + hostname);
    }
  }
}

function validateMarkdownLinks() {
  for (const relativePath of publishFiles.filter((item) => item.endsWith('.md'))) {
    const filePath = path.join(skillRoot, relativePath);
    const text = fs.readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].trim().replace(/^<|>$/g, '');
      if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
      if (/[\[\]'"]/.test(target)) continue;
      const pathOnly = decodeURIComponent(target.split('#')[0]);
      const resolved = path.resolve(path.dirname(filePath), pathOnly);
      if (!resolved.startsWith(skillRoot + path.sep) && resolved !== skillRoot) {
        errors.push('Markdown 链接越出 skill 根目录: ' + relativePath + ' -> ' + target);
        continue;
      }
      if (!fs.existsSync(resolved)) {
        errors.push('Markdown 链接目标不存在: ' + relativePath + ' -> ' + target);
      }
    }
  }
}

function validateKnowledgeBase() {
  try {
    const knowledgeBase = createKnowledgeBase(skillRoot);
    const resources = knowledgeBase.listResources();
    for (const resource of resources) {
      if (resource.uri.startsWith('aibox://examples/')) {
        errors.push('知识库仍暴露内置源资源: ' + resource.uri);
      }
      knowledgeBase.readResource(resource.uri);
    }
  } catch (error) {
    errors.push('知识库资源校验失败: ' + error.message);
  }
}

function validateStarterAssets() {
  const templatePath = path.join(skillRoot, 'template', 'ds_template.js');
  if (fs.existsSync(templatePath)) {
    const template = fs.readFileSync(templatePath, 'utf8');
    if (!template.includes('example.com')) {
      errors.push('空白模板必须使用 example.com，禁止携带真实站点');
    }
  }

  for (const relativePath of publishFiles.filter((item) => /^assets\/compose-rule\..+\.example\.json$/i.test(normalizePath(item)))) {
    const spec = readJson(path.join(skillRoot, relativePath));
    if (!spec) continue;
    const host = String(spec.host || '');
    if (host) {
      let hostname = '';
      try {
        hostname = new URL(host).hostname;
      } catch (_) {
        errors.push('生成器规格 host 不是有效 URL: ' + relativePath + ' -> ' + host);
        continue;
      }
      if (!/(^|\.)example\.(?:com|org|net)$/i.test(hostname)) {
        errors.push('生成器规格包含非示例域名: ' + relativePath + ' -> ' + host);
      }
    }
  }
}

function listPublishFiles(rootDir) {
  const gitRootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (gitRootResult.status === 0) {
    const gitRoot = String(gitRootResult.stdout || '').trim();
    const relativeSkill = normalizePath(path.relative(gitRoot, rootDir));
    const listResult = spawnSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '--', relativeSkill],
      { cwd: gitRoot, encoding: 'utf8', windowsHide: true },
    );
    if (listResult.status === 0) {
      return String(listResult.stdout || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => normalizePath(path.relative(relativeSkill, item)))
        .filter((item) => item && item !== '..' && !item.startsWith('../'))
        .sort();
    }
    warnings.push('git ls-files 失败，改用文件系统扫描');
  }
  return walkFiles(rootDir);
}

function walkFiles(rootDir) {
  const files = [];
  const skippedDirectories = new Set(['.git', 'node_modules', 'output', 'temp', 'coverage']);
  const visit = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(normalizePath(path.relative(rootDir, fullPath)));
      }
    }
  };
  visit(rootDir);
  return files.sort();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push('JSON 解析失败: ' + normalizePath(path.relative(skillRoot, filePath)) + ' - ' + error.message);
    return null;
  }
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}
