import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { composeDrpyRule, validateDrpyRule } from '../lib/rule-utils.mjs';

test('App API video play 支持 text 媒体直链且拒绝无效文本', async () => {
  let response = 'https://media.example.com/video/master.m3u8?token=1\n';
  const rule = instantiateRule(appApiSpec('video', {
    play: { url: '/play/fyid', responseType: 'text' },
  }), async () => response);

  const direct = await rule.lazy('', 'episode-1');
  assert.equal(direct.parse, 0);
  assert.equal(direct.url, 'https://media.example.com/video/master.m3u8?token=1');

  response = '{"url":"https://media.example.com/video/master.m3u8"}';
  await assert.rejects(() => rule.lazy('', 'episode-1'), /必须返回可识别的媒体直链/);
});

test('App API novel reader 支持 text 正文与 POST body 原始或 URI 编码', async () => {
  const calls = [];
  const rawRule = instantiateRule(appApiSpec('novel', {
    reader: {
      method: 'POST',
      url: '/reader',
      responseType: 'text',
      bodyType: 'json',
      body: { id: 'fyid' },
    },
  }), async (url, options) => {
    calls.push({ url, options });
    return JSON.stringify('第一段\n第二段');
  });

  const rawResult = await rawRule.lazy('', 'chapter/中文');
  assert.equal(calls[0].options.body, JSON.stringify({ id: 'chapter/中文' }));
  assert.deepEqual(JSON.parse(rawResult.url.slice('novel://'.length)), {
    title: '',
    content: '第一段\n第二段',
  });

  const encodedCalls = [];
  const encodedRule = instantiateRule(appApiSpec('novel', {
    reader: {
      method: 'POST',
      url: '/reader',
      responseType: 'text',
      bodyType: 'json',
      bodyEncoding: 'uri',
      body: { id: 'fyid' },
    },
  }), async (url, options) => {
    encodedCalls.push({ url, options });
    return '正文';
  });

  await encodedRule.lazy('', 'chapter/中文');
  assert.equal(encodedCalls[0].options.body, JSON.stringify({ id: 'chapter%2F%E4%B8%AD%E6%96%87' }));
});

test('App API comic reader text 支持 JSON 对象、嵌套 JSON 字符串、数组和换行图片', async () => {
  const cases = [
    {
      response: JSON.stringify({ data: { images: [{ url: '/images/1.jpg' }, { url: 'https://img.example.com/2.jpg' }] } }),
      expected: ['https://api.example.com/images/1.jpg', 'https://img.example.com/2.jpg'],
    },
    {
      response: JSON.stringify(JSON.stringify(['/images/3.jpg', '/images/4.jpg'])),
      expected: ['https://api.example.com/images/3.jpg', 'https://api.example.com/images/4.jpg'],
    },
    {
      response: JSON.stringify(['/images/5.jpg', '/images/6.jpg']),
      expected: ['https://api.example.com/images/5.jpg', 'https://api.example.com/images/6.jpg'],
    },
    {
      response: '/images/7.jpg\n/images/8.jpg',
      expected: ['https://api.example.com/images/7.jpg', 'https://api.example.com/images/8.jpg'],
    },
  ];

  for (const fixture of cases) {
    const rule = instantiateRule(appApiSpec('comic', {
      reader: { url: '/reader/fyid', responseType: 'text' },
    }), async () => fixture.response);
    const result = await rule.lazy('', 'chapter-1');
    assert.equal(result.parse, 0);
    assert.deepEqual(result.url.slice('pics://'.length).split('&&'), fixture.expected);
  }
});

test('App API compose 对无法结构化读取的 text 阶段和未知 responseType 明确拒绝', () => {
  for (const stageName of ['home', 'category', 'search', 'detail', 'catalog']) {
    const spec = appApiSpec('comic', {
      reader: { url: '/reader/fyid', responseType: 'text' },
    });
    spec.stages[stageName] = { ...spec.stages[stageName], responseType: 'text' };
    assert.throws(
      () => composeDrpyRule(spec),
      new RegExp(`stages\\.${stageName}.*不能静默按空数据处理`),
    );
  }

  const invalid = appApiSpec('video', {
    play: { url: '/play/fyid', responseType: 'xml' },
  });
  assert.throws(() => composeDrpyRule(invalid), /responseType 只支持 json 或 text/);
});

function appApiSpec(contentType, extraStages = {}) {
  return {
    sourceKind: 'app-api',
    contentType,
    siteName: `app-api ${contentType} text fixture`,
    host: 'https://api.example.com',
    headers: {},
    searchable: 0,
    filterable: 0,
    classes: [{ name: '全部', id: 'all' }],
    stages: {
      home: { url: '/home', listPath: 'data.list' },
      category: { url: '/category?type=fyclass&page=fypage', listPath: 'data.list' },
      detail: { url: '/detail/fyid', dataPath: 'data' },
      ...extraStages,
    },
  };
}

function instantiateRule(spec, request) {
  const code = composeDrpyRule(spec);
  const validation = validateDrpyRule(code);
  assert.equal(validation.passed, true, validation.issues.join('\n'));
  const context = vm.createContext({
    request,
    setResult: (value) => value,
    urljoin: (base, value) => new URL(value, base).toString(),
  });
  return new vm.Script(`${code}\nrule;`).runInContext(context);
}
