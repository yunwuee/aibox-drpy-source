import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { fetchSource, guessTemplateCandidates } from '../lib/site-triage.mjs';
import { resolveAiboxEngineRoot } from '../lib/template-service.mjs';
import { nativeTest } from './native-test-support.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, '..', '..');
const engineRoot = resolveAiboxEngineRoot();

test('fetchSource 使用 Aibox UA，并在重定向链中保留 Set-Cookie 和 JSON 分析', async (t) => {
  let finalHeaders = null;
  const largePayload = {
    data: {
      list: Array.from({ length: 40 }, (_, index) => ({
        id: `comic-${index}`,
        title: `漫画 ${index}`,
        images: [`https://img.example/${index}.jpg`],
      })),
    },
  };
  const server = http.createServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, {
        Location: '/final',
        'Set-Cookie': 'session=aibox-cookie; Path=/; HttpOnly',
      });
      response.end();
      return;
    }
    finalHeaders = request.headers;
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(largePayload));
  });
  await listen(server);
  t.after(() => close(server));

  const address = server.address();
  const result = await fetchSource({
    url: `http://127.0.0.1:${address.port}/start`,
    maxChars: 48,
  });

  assert.equal(result.status, 200);
  assert.equal(result.redirects.length, 1);
  assert.equal(result.redirects[0].status, 302);
  assert.equal(result.truncated, true);
  assert.equal(result.analysis.mode, 'json');
  assert.equal(result.analysis.contentGuess, 'comic');
  assert.match(finalHeaders.cookie || '', /session=aibox-cookie/);
  assert.match(finalHeaders['user-agent'] || '', /Android 11; Pixel 5/);
});

test('fetchSource 保留调用方显式 User-Agent', async (t) => {
  let receivedUa = '';
  const server = http.createServer((request, response) => {
    receivedUa = request.headers['user-agent'] || '';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<html><title>fixture</title></html>');
  });
  await listen(server);
  t.after(() => close(server));

  const address = server.address();
  await fetchSource({
    url: `http://127.0.0.1:${address.port}/`,
    headers: { 'User-Agent': 'Custom-UA/1.0' },
  });

  assert.equal(receivedUa, 'Custom-UA/1.0');
});

nativeTest('模板族特征与当前 Aibox 模板选择器保持一致', async () => {
  const cases = [
    ['首图', '<div class="myui-vodlist"></div>'],
    ['首图2', '<div class="stui-vodlist"></div>'],
    ['海螺2', '<nav id="nav-bar"></nav><ul class="list-a"></ul><div class="deployment"></div>'],
    ['短视', '<div class="menu_bottom"></div><ul class="pic-list"></ul><select class="py-tabs"></select>'],
    ['短视2', '<div class="public-list-box"></div><div class="anthology-list-box"></div>'],
  ];

  for (const [name, html] of cases) {
    const candidates = await guessTemplateCandidates({ html, url: 'https://example.com/', engineRoot });
    const candidate = candidates.find((item) => item.name === name);
    assert.equal(candidate?.evidence.familyMatches, true, `${name} 未命中自身模板族特征`);
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
