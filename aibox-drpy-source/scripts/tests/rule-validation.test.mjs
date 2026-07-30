import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildComicHtmlRule,
  buildComicJsonRule,
} from '../lib/content-type-specialists.mjs';
import { validateDrpyRule } from '../lib/rule-utils.mjs';
import { applyDeterministicFixes } from '../lib/source-fixer.mjs';

test('validate-rule rejects comic lazy without the Android play contract', () => {
  const validation = validateDrpyRule(buildRule({ type: '漫画' }));
  assert.equal(validation.passed, false);
  assert.match(validation.issues.join('\n'), /play_parse: true/);
  assert.match(validation.issues.join('\n'), /play_json: \[\]/);
});

test('validate-rule accepts comic lazy with play_parse true and empty play_json', () => {
  const validation = validateDrpyRule(buildRule({
    type: '漫画',
    playContract: '  play_parse: true,\n  play_json: [],\n',
  }));
  assert.equal(validation.passed, true, validation.issues.join('\n'));
  assert.equal(validation.ruleSummary.playParse, true);
  assert.equal(validation.ruleSummary.hasExplicitPlayJson, true);
  assert.equal(validation.ruleSummary.playJsonIsEmptyArray, true);
});

test('函数型 lazy 对所有内容类型都使用同一播放契约', () => {
  for (const type of ['影视', '小说', '漫画']) {
    const invalid = validateDrpyRule(buildRule({
      type,
      readerUrl: type === '影视' ? 'https://example.com/video.m3u8' : type === '小说' ? 'novel://{}' : 'pics://https://example.com/1.jpg',
    }));
    assert.equal(invalid.passed, false, `${type} 缺少契约时应失败`);
    assert.match(invalid.issues.join('\n'), /play_parse: true/);
    assert.match(invalid.issues.join('\n'), /play_json: \[\]/);

    const valid = validateDrpyRule(buildRule({
      type,
      readerUrl: type === '影视' ? 'https://example.com/video.m3u8' : type === '小说' ? 'novel://{}' : 'pics://https://example.com/1.jpg',
      playContract: '  play_parse: true,\n  play_json: [],\n',
    }));
    assert.equal(valid.passed, true, valid.issues.join('\n'));
  }
});

test('comic generators include the Android play contract', () => {
  for (const code of [buildComicHtmlRule(), buildComicJsonRule()]) {
    assert.match(code, /play_parse: true/);
    assert.match(code, /play_json: \[\]/);
  }
});

test('live-heal adds the Android play contract to comic rules', () => {
  const fixed = applyDeterministicFixes({
    code: buildRule({ type: '漫画', playContract: '  play_parse: false,\n  play_json: false,\n' }),
    report: { contentType: 'comic', steps: {} },
  });
  assert.match(fixed.code, /play_parse: true/);
  assert.match(fixed.code, /play_json: \[\]/);
  assert.match(fixed.changes.join('\n'), /play_parse/);
  assert.match(fixed.changes.join('\n'), /play_json/);
});

function buildRule({ type, playContract = '', readerUrl = 'pics://https://example.com/1.jpg&&https://example.com/2.jpg' }) {
  return `var rule = {
  类型: '${type}',
  title: 'contract fixture',
  version: '1.0.0',
  host: 'https://example.com',
  url: '/list',
  searchUrl: '/search',
  searchable: 1,
  quickSearch: 0,
  filterable: 0,
  headers: {},
  class_name: '全部',
  class_url: 'all',
${playContract}  推荐: async function () { return []; },
  一级: async function () { return []; },
  二级: async function () {
    return {
      vod_name: 'fixture',
      vod_content: 'fixture',
      vod_play_from: '正文',
      vod_play_url: '第一章$chapter-1'
    };
  },
  搜索: async function () { return []; },
  lazy: async function () { return { parse: 0, url: '${readerUrl}' }; }
};`;
}
