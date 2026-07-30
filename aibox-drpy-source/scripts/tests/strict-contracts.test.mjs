import assert from 'node:assert/strict';
import test from 'node:test';

import { debugDrpyRule, validateDrpyRule } from '../lib/rule-utils.mjs';

test("模板:'自动' 允许通过 L1，但明确要求继续做 L2", () => {
  const validation = validateDrpyRule(`var rule = {
    类型: '影视',
    title: '自动模板测试',
    version: '1.0.0',
    host: 'https://example.com',
    模板: '自动'
  };`);

  assert.equal(validation.passed, true, validation.issues.join('\n'));
  assert.equal(validation.ruleSummary.template, '自动');
  assert.match(validation.warnings.join('\n'), /L2|动态/);
});

test('分类配对、核心 handler、筛选和搜索证据缺失都会被 L1 拒绝', () => {
  const cases = [
    [
      '分类分段不一致',
      baseRule("class_name: '电影&剧集',\n  class_url: 'movie',"),
      'RULE_CLASS_CONFIG_MISMATCH',
    ],
    [
      '缺少一级',
      baseRule("class_name: '全部',\n  class_url: 'all',", { category: '' }),
      'RULE_CATEGORY_HANDLER_MISSING',
    ],
    [
      '缺少二级',
      baseRule("class_name: '全部',\n  class_url: 'all',", { detail: '' }),
      'RULE_DETAIL_HANDLER_MISSING',
    ],
    [
      '漫画缺少 lazy',
      baseRule("class_name: '全部',\n  class_url: 'all',", { lazy: '', type: '漫画' }),
      'RULE_READER_HANDLER_MISSING',
    ],
    [
      'filterable 无筛选数据',
      baseRule("class_name: '全部',\n  class_url: 'all',\n  filterable: 1,\n  filter: {},"),
      'RULE_FILTER_CONFIG_MISSING',
    ],
    [
      'searchable 无搜索 handler',
      baseRule("class_name: '全部',\n  class_url: 'all',\n  searchable: 1,"),
      'RULE_SEARCH_HANDLER_MISSING',
    ],
  ];

  for (const [name, source, code] of cases) {
    const validation = validateDrpyRule(source);
    assert.equal(validation.passed, false, `${name} 不应通过`);
    assert.equal(validation.diagnostics.some((item) => item.code === code), true, `${name} 缺少 ${code}`);
  }
});

test('debug-selector 的同节点属性 fallback 会返回 src', async () => {
  const result = await debugDrpyRule({
    html: '<article><img src="/fallback.jpg"></article>',
    baseUrl: 'https://img.example/chapter/1',
    mode: 'pdfh',
    rule: 'img&&data-src||src',
  });

  assert.equal(result.result, '/fallback.jpg');
});

function baseRule(classBlock, options = {}) {
  const type = options.type || '影视';
  const category = options.category === undefined
    ? "  一级: 'json:list;title;pic;remarks;id',\n"
    : options.category;
  const detail = options.detail === undefined
    ? "  二级: async function () { return { vod_play_from: '线路', vod_play_url: '第1集$ep1' }; },\n"
    : options.detail;
  const lazy = options.lazy === undefined
    ? "  play_parse: true,\n  play_json: [],\n  lazy: async function () { return { parse: 0, url: 'https://example.com/video.m3u8' }; },\n"
    : options.lazy;
  return `var rule = {
  类型: '${type}',
  title: '严格契约测试',
  version: '1.0.0',
  host: 'https://example.com',
  url: '/list/fyclass/fypage',
  ${classBlock}
${category}${detail}${lazy}};`;
}
