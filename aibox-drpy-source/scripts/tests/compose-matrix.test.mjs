import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { createKnowledgeBase } from '../lib/knowledge-base.mjs';
import { composeDrpyRule, validateDrpyRule } from '../lib/rule-utils.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, '..', '..');
const assetsRoot = path.join(skillRoot, 'assets');

const composeCases = [
  { sourceKind: 'html', contentType: 'video' },
  { sourceKind: 'html', contentType: 'novel' },
  { sourceKind: 'html', contentType: 'comic' },
  { sourceKind: 'json', contentType: 'video' },
  { sourceKind: 'json', contentType: 'novel' },
  { sourceKind: 'json', contentType: 'comic' },
  { sourceKind: 'app-api', contentType: 'video' },
  { sourceKind: 'app-api', contentType: 'novel' },
  { sourceKind: 'app-api', contentType: 'comic' },
].map((item) => ({
  ...item,
  name: `${item.sourceKind}-${item.contentType}`,
  specPath: path.join(assetsRoot, `compose-rule.${item.sourceKind}-${item.contentType}.example.json`),
}));

test('HTML/JSON/App API 九种 compose 模式通过 validate 与 node --check', async (t) => {
  await Promise.all(composeCases.map((fixture) => t.test(fixture.name, () => {
      const spec = readJson(fixture.specPath);
      assert.equal(spec.sourceKind, fixture.sourceKind);
      assert.equal(spec.contentType, fixture.contentType);

      const code = composeDrpyRule(spec);
      const validation = validateDrpyRule(code);
      assert.equal(validation.passed, true, validation.issues.join('\n'));
      assertNodeCheck(code, fixture.name);

      assert.match(code, /class_name:\s*['"][^'"]+['"]/);
      assert.match(code, /class_url:\s*['"][^'"]+['"]/);
      assert.match(code, /play_parse:\s*true/);
      assert.match(code, /play_json:\s*\[\]/);
      assert.equal(code.includes('^https?:///'), false, `${fixture.name} 生成了损坏的 URL 正则`);
    })));
});

test('公开技能不暴露内置源资源', () => {
  const knowledgeBase = createKnowledgeBase(skillRoot);
  const resources = knowledgeBase.listResources();

  assert.equal(fs.existsSync(path.join(assetsRoot, 'examples')), false);
  assert.equal(resources.some((item) => item.uri.startsWith('aibox://examples/')), false);
  assert.equal(resources.some((item) => /catni|zyfun|html-novel-source-retrospective/i.test(item.uri)), false);
});

test('compose 示例覆盖独立目录、相对 URL 与 App reader 请求方式', () => {
  const jsonVideo = composeCaseCode('json', 'video');
  const jsonNovel = composeCaseCode('json', 'novel');
  const jsonComic = composeCaseCode('json', 'comic');
  const appVideo = composeCaseCode('app-api', 'video');
  const appNovel = composeCaseCode('app-api', 'novel');
  const appComic = composeCaseCode('app-api', 'comic');
  const htmlComic = composeCaseCode('html', 'comic');

  for (const code of [jsonNovel, jsonComic]) {
    assert.match(code, /catalogUrl:\s*['"]\/api\//);
    assert.match(code, /rule\._url\(workId, rule\.catalogUrl\)/);
    assert.match(code, /readerUrl:\s*['"]\/api\//);
  }
  assert.match(jsonComic, /urljoin\(readerUrl, url\)/);
  assert.match(htmlComic, /pd\(it, imageRule, readerUrl\)/);
  for (const code of [jsonVideo, jsonNovel, jsonComic]) {
    assert.match(code, /vod_pic:\s*rule\._abs\(this\.input,/);
    assert.match(code, /urljoin\(baseUrl \|\| rule\.host, text\)/);
  }

  assert.match(appVideo, /catalog:\s*\{[\s\S]*url: "\/v1\/videos\/fyid\/episodes"/);
  assert.match(appVideo, /play:\s*\{[\s\S]*url: "\/v1\/episodes\/fyid\/play"/);
  assert.match(appNovel, /reader:\s*\{[\s\S]*method: "POST"[\s\S]*body: \{\s*id: "fyid"/);
  assert.match(appNovel, /const body = rule\._render\(stage\.body, vars, encodeBody\)/);
  assert.match(appComic, /reader:\s*\{[\s\S]*method: "GET"[\s\S]*url: "\/v1\/chapters\/fyid\/pages"/);
  assert.match(appComic, /\.map\(\(url\) => rule\._abs\(target, url\)\)/);
});

test('App API 生成规则执行时保留原始章节 ID 并正确处理 GET/POST reader', async () => {
  const novelRuntime = instantiateRule('app-api', 'novel', ({ url }) => {
    if (url.endsWith('/v1/books/book-1')) {
      return JSON.stringify({ data: { name: '示例小说', cover: '/covers/book.jpg', latest: '连载中', summary: '简介' } });
    }
    if (url.endsWith('/v1/books/book-1/chapters')) {
      return JSON.stringify({ data: { items: [{ name: '第一章', id: 'chapter-1' }] } });
    }
    if (url.endsWith('/v1/chapters/read')) {
      return JSON.stringify({ data: { name: '第一章', content: '这是用于验证 POST reader 的正文内容。' } });
    }
    throw new Error(`未处理的小说请求: ${url}`);
  });
  const novelDetail = await novelRuntime.rule.二级.call({
    input: 'https://api.example.com/v1/books/book-1',
    detailUrl: 'book-1',
    vid: 'book-1',
    fyclass: 'fantasy',
  }, ['fantasy$book-1']);
  assert.equal(novelRuntime.calls.length, 2);
  assert.equal(novelDetail.vod_play_url, '第一章$chapter-1');
  assert.equal(novelDetail.vod_pic, 'https://api.example.com/covers/book.jpg');
  assert.equal(novelRuntime.calls[1].url, 'https://api.example.com/v1/books/book-1/chapters');

  novelRuntime.calls.length = 0;
  const novelReader = await novelRuntime.rule.lazy('正文', 'chapter-1');
  assert.equal(novelRuntime.calls.length, 1);
  assert.equal(novelRuntime.calls[0].url, 'https://api.example.com/v1/chapters/read');
  assert.equal(novelRuntime.calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(novelRuntime.calls[0].options.body), { id: 'chapter-1' });
  assert.equal(novelReader.parse, 0);
  assert.match(novelReader.url, /^novel:\/\/\{"title":"第一章","content":"这是用于验证 POST reader 的正文内容。"\}$/);

  const comicRuntime = instantiateRule('app-api', 'comic', ({ url }) => {
    assert.equal(url, 'https://api.example.com/v1/chapters/chapter-9/pages');
    return JSON.stringify({ data: { pages: [{ src: './images/1.jpg' }, { src: '/images/2.jpg' }] } });
  });
  const comicReader = await comicRuntime.rule.lazy('图片', 'chapter-9');
  assert.equal(comicRuntime.calls.length, 1);
  assert.equal(comicRuntime.calls[0].options.method, 'GET');
  assert.equal(comicRuntime.calls[0].options.body, undefined);
  assert.equal(comicReader.parse, 0);
  assert.equal(comicReader.url, 'pics://https://api.example.com/v1/chapters/chapter-9/images/1.jpg&&https://api.example.com/images/2.jpg');

  const videoRuntime = instantiateRule('app-api', 'video', ({ url }) => {
    assert.equal(url, 'https://api.example.com/v1/episodes/episode-7/play');
    return JSON.stringify({ data: { play_url: 'https://media.example.com/episode-7.m3u8' } });
  });
  const videoPlay = await videoRuntime.rule.lazy('默认', 'episode-7');
  assert.equal(videoRuntime.calls.length, 1);
  assert.equal(videoPlay.parse, 0);
  assert.equal(videoPlay.url, 'https://media.example.com/episode-7.m3u8');
});

test('JSON 详情相对封面以实际详情 URL 为基准补全', async () => {
  const videoRuntime = instantiateRule('json', 'video', ({ url, transport }) => {
    assert.equal(transport, 'getHtml');
    assert.equal(url, 'https://api.example.com/api/vod/detail?id=video-1');
    return JSON.stringify({
      data: {
        title: '示例视频',
        pic: './covers/video.jpg',
        vod_play_from: '默认',
        vod_play_url: '正片$https://media.example.com/video-1.m3u8',
      },
    });
  });
  const videoDetail = await videoRuntime.rule.二级.call({
    input: 'https://api.example.com/api/vod/detail?id=video-1',
  }, ['video-1']);
  assert.equal(videoDetail.vod_pic, 'https://api.example.com/api/vod/covers/video.jpg');

  const novelRuntime = instantiateRule('json', 'novel', ({ url, transport }) => {
    assert.equal(transport, 'getHtml');
    if (url === 'https://api.example.com/api/book/detail?id=book-1') {
      return JSON.stringify({ data: { title: '示例小说', pic: './covers/book.jpg', remarks: '连载中', content: '简介' } });
    }
    if (url === 'https://api.example.com/api/book/book-1/chapters') {
      return JSON.stringify({ data: { chapters: [{ title: '第一章', id: 'chapter-1' }] } });
    }
    throw new Error(`未处理的 JSON 小说请求: ${url}`);
  });
  const novelDetail = await novelRuntime.rule.二级.call({
    input: 'https://api.example.com/api/book/detail?id=book-1',
    detailUrl: 'book-1',
    vid: 'book-1',
  }, ['book-1']);
  assert.equal(novelDetail.vod_pic, 'https://api.example.com/api/book/covers/book.jpg');

  const comicRuntime = instantiateRule('json', 'comic', ({ url, transport }) => {
    assert.equal(transport, 'getHtml');
    if (url === 'https://api.example.com/api/comic/detail?id=comic-1') {
      return JSON.stringify({ data: { title: '示例漫画', pic: './covers/comic.jpg', remarks: '连载中', content: '简介' } });
    }
    if (url === 'https://api.example.com/api/comic/comic-1/chapters') {
      return JSON.stringify({ data: { chapters: [{ title: '第一话', id: 'chapter-1' }] } });
    }
    throw new Error(`未处理的 JSON 漫画请求: ${url}`);
  });
  const comicDetail = await comicRuntime.rule.二级.call({
    input: 'https://api.example.com/api/comic/detail?id=comic-1',
    detailUrl: 'comic-1',
    vid: 'comic-1',
  }, ['comic-1']);
  assert.equal(comicDetail.vod_pic, 'https://api.example.com/api/comic/covers/comic.jpg');
});

function composeCaseCode(sourceKind, contentType) {
  const fixture = composeCases.find((item) => item.sourceKind === sourceKind && item.contentType === contentType);
  return composeDrpyRule(readJson(fixture.specPath));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function instantiateRule(sourceKind, contentType, responseFactory) {
  const calls = [];
  const invoke = async (transport, url, options = {}) => {
    const call = { transport, url: String(url), options: { ...options } };
    calls.push(call);
    return responseFactory(call);
  };
  const sandbox = {
    request: (url, options = {}) => invoke('request', url, options),
    getHtml: (url) => invoke('getHtml', url),
    setResult: (items) => items,
    urljoin: (base, value) => new URL(String(value), String(base)).toString(),
  };
  vm.createContext(sandbox);
  new vm.Script(composeCaseCode(sourceKind, contentType), { filename: `${sourceKind}-${contentType}.js` }).runInContext(sandbox);
  assert.equal(typeof sandbox.rule, 'object');
  return { rule: sandbox.rule, calls };
}

function assertNodeCheck(code, name) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-compose-check-'));
  const filePath = path.join(tempRoot, `${name}.js`);
  try {
    fs.writeFileSync(filePath, code, 'utf8');
    const result = spawnSync(process.execPath, ['--check', filePath], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
