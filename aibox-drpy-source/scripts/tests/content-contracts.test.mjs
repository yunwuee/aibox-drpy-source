import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseComicReaderPayload,
  parseNovelReaderPayload,
  parsePlayCatalog,
} from '../lib/content-contracts.mjs';
import {
  buildDetailRequest,
  normalizePlayResult,
} from '../lib/embedded-drpy-runtime-core.mjs';
import { applyDeterministicFixes } from '../lib/source-fixer.mjs';

test('parsePlayCatalog follows the App $$$ / # / $ contract', () => {
  const catalog = parsePlayCatalog({
    vod_play_from: '正文$$$备用',
    vod_play_url: '第一章$c1#第二章$c2$$$第三章$c3',
  });
  assert.equal(catalog.sourceCount, 2);
  assert.equal(catalog.episodeCount, 3);
  assert.equal(catalog.firstEpisode.name, '第一章');
  assert.equal(catalog.lastEpisode.flag, '备用');
  assert.deepEqual(catalog.errors, []);
});

test('parsePlayCatalog rejects chapters without a $ URL separator', () => {
  const catalog = parsePlayCatalog({
    vod_play_from: '正文',
    vod_play_url: '第一章',
  });
  assert.equal(catalog.episodeCount, 1);
  assert.match(catalog.errors.join('\n'), /缺少 \$ 后的章节地址/);
});

test('parseNovelReaderPayload accepts raw JSON and rejects percent-encoded JSON', () => {
  const valid = parseNovelReaderPayload('novel://' + JSON.stringify({ title: '第一章', content: '正文内容' }));
  assert.equal(valid.status, 'ok');
  assert.equal(valid.title, '第一章');

  const invalid = parseNovelReaderPayload('novel://' + encodeURIComponent(JSON.stringify({ title: '第一章', content: '正文内容' })));
  assert.equal(invalid.status, 'invalid');
  assert.match(invalid.error, /encodeURIComponent/);
});

test('parseComicReaderPayload matches the formats accepted by the App reader', () => {
  assert.equal(parseComicReaderPayload('pics://https://a/1.jpg&&https://a/2.jpg').imageCount, 2);
  assert.equal(parseComicReaderPayload('https://a/1.jpg|||https://a/2.jpg').imageCount, 2);
  assert.equal(parseComicReaderPayload('https://a/1.jpg\nhttps://a/2.jpg').imageCount, 2);
  assert.equal(parseComicReaderPayload('["https://a/1.jpg","https://a/2.jpg"]').imageCount, 2);
  assert.equal(parseComicReaderPayload('https://a/1.jpg').imageCount, 1);
});

test('buildDetailRequest mirrors drpy detail id parsing', () => {
  const request = buildDetailRequest({
    host: 'https://example.com',
    homeUrl: '/home/',
    detailUrl: '/detail/fyclass/fyid',
  }, 'books$123@@name@@pic');
  assert.equal(request.orId, 'books$123@@name@@pic');
  assert.equal(request.fyclass, 'books');
  assert.equal(request.vid, '123@@name@@pic');
  assert.equal(request.detailUrl, '123');
  assert.equal(request.input, 'https://example.com/detail/books/123');
});

test('normalizePlayResult preserves string reader protocols like the built-in engine', () => {
  const result = normalizePlayResult({ play_parse: true, lazy: function () {} }, 'novel://正文', 'chapter-1', '正文');
  assert.equal(result.url, 'novel://正文');
  assert.equal(result.parse, 1);
  assert.equal(result.flag, '正文');
});

test('live-heal removes encodeURIComponent around novel protocol JSON', () => {
  const code = `var rule = {
    类型: '小说',
    title: 'test',
    version: '1.0.0',
    host: 'https://example.com',
    url: '/list',
    searchUrl: '/search',
    searchable: 1,
    quickSearch: 0,
    filterable: 0,
    headers: {},
    play_parse: true,
    play_json: [],
    二级: async function () { return { vod_play_from: '正文', vod_play_url: '第一章$c1' }; },
    lazy: async function () { return 'novel://' + encodeURIComponent(JSON.stringify({ title: '第一章', content: '正文' })); }
  };`;
  const fixed = applyDeterministicFixes({ code, report: { contentType: 'novel', steps: {} } });
  assert.equal(fixed.code.includes("'novel://' + encodeURIComponent"), false);
  assert.equal(fixed.code.includes("'novel://' + JSON.stringify"), true);
  assert.match(fixed.changes.join('\n'), /encodeURIComponent/);
});
