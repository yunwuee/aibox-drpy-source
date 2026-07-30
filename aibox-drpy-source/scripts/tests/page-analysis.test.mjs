import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzePageContent } from '../lib/rule-utils.mjs';

test('截断 JSON 对象保留 json 模式、partial 证据和已出现的顶层字段', () => {
  const result = analyzePageContent({
    content: '{"data":{"list":[{"title":"A"}]},"next":"cursor",',
    contentTypeHint: 'application/json; charset=utf-8',
  });

  assert.equal(result.mode, 'json');
  assert.equal(result.partial, true);
  assert.equal(result.rootType, 'object-fragment');
  assert.deepEqual(result.topKeys, ['data', 'next']);
  assert.match(result.parseError, /JSON|position|end|property/i);
  assert.match(result.summary, /JSON 片段/);
  assert.equal(result.candidateArrays.length, 0);
});

test('以数组开头或由 JSON content-type 标记的坏响应不会误判成 HTML', () => {
  const arrayFragment = analyzePageContent({ content: '[{"id":1},' });
  assert.equal(arrayFragment.mode, 'json');
  assert.equal(arrayFragment.partial, true);
  assert.equal(arrayFragment.rootType, 'array-fragment');
  assert.deepEqual(arrayFragment.topKeys, []);

  const hintedFragment = analyzePageContent({
    content: '<html>upstream truncated',
    contentTypeHint: 'APPLICATION/JSON',
  });
  assert.equal(hintedFragment.mode, 'json');
  assert.equal(hintedFragment.partial, true);
  assert.equal(hintedFragment.rootType, 'unknown-fragment');
  assert.equal(typeof hintedFragment.parseError, 'string');

  const emptyHintedFragment = analyzePageContent({
    content: '',
    contentTypeHint: 'application/json',
  });
  assert.equal(emptyHintedFragment.mode, 'json');
  assert.equal(emptyHintedFragment.partial, true);
  assert.match(emptyHintedFragment.parseError, /JSON 响应为空/);
});

test('完整 JSON 保持非 partial 的结构分析', () => {
  const result = analyzePageContent({
    content: JSON.stringify({ data: { list: [{ title: 'A', id: '1' }] } }),
    contentTypeHint: 'application/json',
  });

  assert.equal(result.mode, 'json');
  assert.equal(result.partial, false);
  assert.equal(result.parseError, null);
  assert.deepEqual(result.topKeys, ['data']);
  assert.equal(result.candidateArrays[0].path, 'data.list');
});
