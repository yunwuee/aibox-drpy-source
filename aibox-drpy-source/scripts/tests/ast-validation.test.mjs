import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadRuleSource,
  parseRuleHeader,
} from '../lib/source-loader.mjs';
import { analyzeRuleSource } from '../lib/rule-ast.mjs';
import { createSafeRulePatch } from '../lib/safe-rule-fixer.mjs';
import { nativeTest } from './native-test-support.mjs';

test('AST 校验能发现重复 lazy，并只删除被覆盖的前值', () => {
  const source = buildRule({
    extra: `
  lazy: async function () { return { parse: 0, url: 'https://example.com/first.m3u8' }; },
  lazy: async function () { return { parse: 0, url: 'https://example.com/final.m3u8' }; },`,
    playContract: '  play_parse: true,\n  play_json: [],\n',
  });
  const analysis = analyzeRuleSource(source);
  const duplicate = analysis.diagnostics.find((item) => item.code === 'RULE_DUPLICATE_FIELD');

  assert.equal(duplicate?.field, 'lazy');
  assert.equal(analysis.rule.duplicateFields[0].effectiveIndex > 0, true);
  assert.equal(analysis.rule.handlers.lazy.mode, 'async-function');
  assert.equal(analysis.rule.functions.at(-1).style, 'function-expression');
  assert.equal(analysis.rule.staticFields.title, 'AST fixture');

  const fixed = createSafeRulePatch(source, { analysis });
  assert.equal(fixed.changed, true);
  assert.equal((fixed.code.match(/\blazy\s*:/g) || []).length, 1);
  assert.match(fixed.code, /final\.m3u8/);
  assert.doesNotMatch(fixed.code, /first\.m3u8/);
  assert.match(fixed.diff, /^--- a\/rule\.js/m);
});

test('VM 逃逸表达式只作为源码被诊断，不会在校验进程执行', () => {
  delete globalThis.__AIBOX_AST_ESCAPE_TEST__;
  const source = buildRule({
    extra: `
  lazy: async function () {
    return this.constructor.constructor('globalThis.__AIBOX_AST_ESCAPE_TEST__ = true')();
  },`,
    playContract: '  play_parse: true,\n  play_json: [],\n',
  });
  const analysis = analyzeRuleSource(source);

  assert.equal(globalThis.__AIBOX_AST_ESCAPE_TEST__, undefined);
  assert.equal(analysis.diagnostics.some((item) => item.code === 'DYNAMIC_CODE_EXECUTION'), true);
});

test('@header 使用静态 AST 解析，并校验与 rule 的完整一致性', () => {
  const source = buildRule();
  const parsed = parseRuleHeader(source);
  const analysis = analyzeRuleSource(source);

  assert.deepEqual(parsed.header, {
    searchable: 1,
    filterable: 0,
    quickSearch: 0,
    title: 'AST fixture',
    类型: '影视',
    lang: 'ds',
  });
  assert.equal(analysis.header.consistency.mismatches.length, 0);
  assert.deepEqual(
    [...analysis.header.consistency.matches].sort(),
    ['filterable', 'quickSearch', 'searchable', 'title', '类型'].sort(),
  );
  const mismatched = analyzeRuleSource(source.replace("title: 'AST fixture',", "title: 'changed',"));
  assert.equal(
    mismatched.diagnostics.some((item) => item.code === 'HEADER_RULE_MISMATCH'),
    true,
  );

  delete globalThis.__AIBOX_HEADER_ESCAPE_TEST__;
  const unsafe = source.replace(
    '@header({',
    '@header((globalThis.__AIBOX_HEADER_ESCAPE_TEST__ = true, {',
  ).replace("\n})\n*/", "\n}))\n*/");
  assert.throws(
    () => parseRuleHeader(unsafe),
    (error) => [
      'HEADER_NOT_OBJECT',
      'HEADER_TRAILING_CODE',
      'HEADER_UNSAFE_EXPRESSION',
    ].includes(error.code),
  );
  assert.equal(globalThis.__AIBOX_HEADER_ESCAPE_TEST__, undefined);
});

test('函数型漫画 lazy 必须显式使用 play_parse true 和空 play_json', () => {
  const source = buildRule({
    type: '漫画',
    extra: `
  lazy: async function () { return { parse: 0, url: 'pics://https://example.com/1.jpg' }; },`,
    playContract: '  play_parse: false,\n  play_json: true,\n',
  });
  const analysis = analyzeRuleSource(source);
  const codes = new Set(analysis.diagnostics.map((item) => item.code));

  assert.equal(codes.has('LAZY_REQUIRES_PLAY_PARSE'), true);
  assert.equal(codes.has('LAZY_PLAY_JSON_OVERRIDE'), true);

  const fixed = createSafeRulePatch(source, { analysis });
  assert.match(fixed.code, /play_parse:\s*true/);
  assert.match(fixed.code, /play_json:\s*\[\]/);
  const fixedCodes = new Set(analyzeRuleSource(fixed.code).diagnostics.map((item) => item.code));
  assert.equal(fixedCodes.has('LAZY_REQUIRES_PLAY_PARSE'), false);
  assert.equal(fixedCodes.has('LAZY_PLAY_JSON_OVERRIDE'), false);
});

test('二级字典 tabs 不能以 &&Text 结尾', () => {
  const source = buildRule({
    extra: `
  二级: {
    title: 'h1&&Text',
    tabs: '.tab&&Text',
    tab_text: 'body&&Text',
    lists: '.playlist',
  },`,
  });
  const analysis = analyzeRuleSource(source);

  assert.equal(
    analysis.diagnostics.some((item) => item.code === 'DETAIL_TABS_TERMINAL_ATTRIBUTE'),
    true,
  );
});

test('JSON.parse(this.input) 被识别为 URL 与响应混用', () => {
  const source = buildRule({
    extra: `
  推荐: async function () {
    return JSON.parse(this.input);
  },`,
  });
  const analysis = analyzeRuleSource(source);

  assert.equal(
    analysis.diagnostics.some((item) => item.code === 'JSON_PARSE_THIS_INPUT'),
    true,
  );
});

test('规则阶段函数禁止直接引用未绑定的裸变量 input', () => {
  const source = buildRule({
    extra: `
  推荐: async function () { return request(input); },
  一级: async function () { return request(input); },
  二级: async function () { return request(input); },
  搜索: async function () { return request(input); },
  lazy: async function () { return input; },
  proxy_rule: async function () { return input; },`,
    playContract: '  play_parse: true,\n  play_json: [],\n',
  });
  const diagnostics = analyzeRuleSource(source).diagnostics
    .filter((item) => item.code === 'RULE_HANDLER_UNBOUND_INPUT');

  assert.deepEqual(
    diagnostics.map((item) => item.field),
    ['推荐', '一级', '二级', '搜索', 'lazy', 'proxy_rule'],
  );
  for (const diagnostic of diagnostics) {
    assert.match(diagnostic.message, /未绑定的裸变量 input/);
    assert.match(diagnostic.message, /this\.input/);
    assert.deepEqual(diagnostic.details, { identifier: 'input' });
  }
});

test('规则阶段函数允许形参、局部声明和从 this 解构得到的 input', () => {
  const source = buildRule({
    extra: `
  推荐: async function (input) { return request(input); },
  一级: async function () { const { input } = this; return request(input); },
  二级: async function () { const input = this.input; return request(input); },
  搜索: async function () { let input; input = this.input; return request(input); },
  lazy: async function (flag, id) { var input = id; return input; },
  proxy_rule: async function () {
    const config = { input: this.input };
    const values = [1].map((input) => input);
    return config.input || values[0];
  },`,
    playContract: '  play_parse: true,\n  play_json: [],\n',
  });
  const diagnostics = analyzeRuleSource(source).diagnostics
    .filter((item) => item.code === 'RULE_HANDLER_UNBOUND_INPUT');

  assert.deepEqual(diagnostics, []);
});

test('块级 input 只在声明作用域内有效', () => {
  const source = buildRule({
    extra: `
  一级: async function () {
    if (true) {
      const input = this.input;
      await request(input);
    }
    return request(input);
  },`,
  });
  const diagnostics = analyzeRuleSource(source).diagnostics
    .filter((item) => item.code === 'RULE_HANDLER_UNBOUND_INPUT');

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].field, '一级');
  assert.equal(source.slice(...diagnostics[0].range), 'input');
});

nativeTest('源码加载器保留密文外层 header，并通过 Aibox getOriginalJs 解密 DS Base64', async () => {
  const body = "var rule = { 类型: '影视', title: 'encrypted fixture' };";
  const envelope = `${buildHeader('影视')}\n${Buffer.from(body, 'utf8').toString('base64')}`;
  const loaded = await loadRuleSource(envelope);

  assert.equal(loaded.encrypted, true);
  assert.equal(loaded.sourceType, 'encrypted-header');
  assert.equal(loaded.header.title, 'AST fixture');
  assert.match(loaded.code, /var rule\s*=/);
  assert.match(loaded.code, /@header\(/);
  assert.equal(typeof globalThis.log, 'undefined');
});

test('源码加载器把不含 var rule 的普通 JavaScript 工具库识别为明文', async () => {
  const helper = 'function pick(list) { return list[0]; }';
  const loaded = await loadRuleSource(helper);

  assert.equal(loaded.encrypted, false);
  assert.equal(loaded.sourceType, 'plain');
  assert.equal(loaded.code, helper);
});

test('未知模板由调用方提供的当前引擎模板集合判定', () => {
  const source = buildRule({ extra: "\n  模板: 'appapi'," });
  const analysis = analyzeRuleSource(source, { knownTemplates: new Set(['mx', 'mxpro']) });

  assert.equal(analysis.template.checked, true);
  assert.equal(analysis.template.known, false);
  assert.equal(analysis.diagnostics.some((item) => item.code === 'RULE_UNKNOWN_TEMPLATE'), true);
});

function buildRule({ type = '影视', extra = '', playContract = '' } = {}) {
  return `${buildHeader(type)}

var rule = {
  类型: '${type}',
  title: 'AST fixture',
  version: '1.0.0',
  host: 'https://example.com',
  searchable: 1,
  filterable: 0,
  quickSearch: 0,
${playContract}${extra}
};`;
}

function buildHeader(type) {
  return `/*
@header({
  searchable: 1,
  filterable: 0,
  quickSearch: 0,
  title: 'AST fixture',
  类型: '${type}',
  lang: 'ds'
})
*/`;
}
