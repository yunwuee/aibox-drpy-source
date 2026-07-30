import iconv from 'iconv-lite';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';

import { analyzePageContent } from './rule-utils.mjs';
import { listEngineTemplateNames, loadEngineTemplates } from './template-service.mjs';

const DEFAULT_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36';
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export async function fetchSource(input = {}, session = {}) {
  const jar = session.jar || new CookieJar();
  const url = String(input.url || '');
  if (!url) throw new Error('fetchSource 需要 url');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(input.timeoutMs || 25000));
  try {
    const headers = { ...(input.headers || {}) };
    if (!hasHeader(headers, 'user-agent')) headers['User-Agent'] = DEFAULT_MOBILE_UA;
    let method = String(input.method || 'GET').toUpperCase();
    let body = input.body ?? undefined;
    let currentUrl = url;
    let previousUrl = '';
    let response = null;
    const redirects = [];
    const maxRedirects = Math.max(0, Number(input.maxRedirects ?? 10));

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (previousUrl && new URL(previousUrl).origin !== new URL(currentUrl).origin) {
        deleteHeader(headers, 'authorization');
        deleteHeader(headers, 'proxy-authorization');
        deleteHeader(headers, 'cookie');
      }
      const requestHeaders = { ...headers };
      const cookie = await jar.getCookieString(currentUrl);
      if (cookie && !hasHeader(requestHeaders, 'cookie')) requestHeaders.Cookie = cookie;
      response = await fetch(currentUrl, {
        method,
        headers: requestHeaders,
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        redirect: 'manual',
        signal: controller.signal,
      });
      for (const value of getSetCookieHeaders(response.headers)) {
        await jar.setCookie(value, currentUrl, { ignoreError: true });
      }

      const location = response.headers.get('location');
      if (!REDIRECT_STATUS.has(response.status) || !location) break;
      if (hop === maxRedirects) throw new Error(`重定向次数超过限制: ${maxRedirects}`);
      const nextUrl = new URL(location, currentUrl).href;
      redirects.push({ status: response.status, from: currentUrl, to: nextUrl });
      await response.arrayBuffer();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        deleteHeader(headers, 'content-length');
        deleteHeader(headers, 'content-type');
      }
      previousUrl = currentUrl;
      currentUrl = nextUrl;
    }
    if (!response) throw new Error('fetchSource 未收到响应');
    const buffer = Buffer.from(await response.arrayBuffer());
    const charset = detectCharset(response.headers.get('content-type') || '', buffer);
    const decodedBody = iconv.decode(buffer, charset);
    const maxChars = Number(input.maxChars || 240000);
    const content = decodedBody.length > maxChars ? decodedBody.slice(0, maxChars) : decodedBody;
    const contentType = response.headers.get('content-type') || '';
    const analysisSource = /json/i.test(contentType) || /^[\s\uFEFF]*[\[{]/.test(decodedBody)
      ? decodedBody
      : content;
    return {
      requestedUrl: url,
      url: currentUrl,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      charset,
      redirects,
      truncated: content.length < decodedBody.length,
      body: content,
      analysis: analyzePageContent({ content: analysisSource, url: currentUrl, contentTypeHint: contentType }),
      session: { jar },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function triageSite(input = {}) {
  const fetched = input.content
    ? {
        requestedUrl: input.url || '',
        url: input.url || '',
        status: 200,
        headers: {},
        charset: 'utf-8',
        truncated: false,
        body: String(input.content),
        analysis: analyzePageContent({ content: String(input.content), url: input.url || '', contentTypeHint: input.contentTypeHint || '' }),
      }
    : await fetchSource(input);
  const analysis = fetched.analysis || {};
  const contentType = normalizeContentType(analysis.contentGuess, fetched.body);
  const risks = detectRisks(fetched.body, analysis, fetched.status);
  const templates = analysis.mode === 'html'
    ? await guessTemplateCandidates({ html: fetched.body, url: fetched.url, engineRoot: input.engineRoot })
    : [];
  const hasStrongTemplate = templates[0]?.score >= 0.85;
  const apiSignals = countMatches(fetched.body, /(?:fetch|axios|XMLHttpRequest)\s*\(|\/api\/|__NEXT_DATA__|application\/json/gi);
  let route = 'html';
  let sourceKind = 'html';
  let implementationMode = 'string';
  if (analysis.mode === 'json') {
    route = 'api';
    sourceKind = 'json';
    implementationMode = 'string';
  } else if (hasStrongTemplate) {
    route = 'template';
    implementationMode = 'template';
  } else if (apiSignals > 0 && (analysis.candidateSelectors || []).length > 0) {
    route = 'hybrid';
    implementationMode = 'hybrid';
  } else if (apiSignals > 2) {
    route = 'api';
    sourceKind = 'app-api';
    implementationMode = 'full-async';
  }
  if (risks.signature || risks.dynamicHost || risks.captcha) {
    implementationMode = implementationMode === 'template' ? 'hybrid' : 'partial-async';
  }
  return {
    route,
    sourceKind,
    contentType,
    implementationMode,
    status: fetched.status,
    url: fetched.url,
    risks,
    evidence: {
      responseMode: analysis.mode || 'unknown',
      charset: fetched.charset,
      candidateSelectors: (analysis.candidateSelectors || []).slice(0, 8),
      candidateArrays: (analysis.candidateArrays || []).slice(0, 8),
      templateCandidates: templates.slice(0, 5),
      apiSignals,
    },
    nextCommand: hasStrongTemplate
      ? `templates guess --url ${fetched.url}`
      : `compose --input-file <triage-result.json>`,
    analysis,
  };
}

export async function guessTemplateCandidates({ html = '', url = '', engineRoot = '' } = {}) {
  const knownNames = listEngineTemplateNames({ engineRoot });
  if (!html || knownNames.length === 0) return [];
  const templates = await loadEngineTemplates({ engineRoot });
  const $ = cheerio.load(html);
  const lower = String(html).toLowerCase();
  return knownNames.map((name) => {
    const rule = templates[name] || {};
    const classSelector = firstSelector(rule.class_parse);
    const listSelector = firstSelector(rule['一级']);
    const classMatches = queryCount($, classSelector);
    const listMatches = queryCount($, listSelector);
    const familyMatches = familySignal(name, lower, url);
    const score = Math.min(1, (classMatches > 0 ? 0.4 : 0) + (listMatches > 0 ? 0.5 : 0) + (familyMatches ? 0.1 : 0));
    return {
      name,
      score,
      evidence: { classSelector, classMatches, listSelector, listMatches, familyMatches },
      requiresL2: true,
    };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function detectCharset(contentType, buffer) {
  const headerMatch = String(contentType).match(/charset\s*=\s*([^;\s]+)/i);
  const head = buffer.subarray(0, 4096).toString('latin1');
  const metaMatch = head.match(/charset\s*=\s*["']?([^\s"'/>;]+)/i);
  const candidate = String(headerMatch?.[1] || metaMatch?.[1] || 'utf-8').toLowerCase();
  if (/^(?:gbk|gb2312|gb18030)$/i.test(candidate)) return 'gb18030';
  return iconv.encodingExists(candidate) ? candidate : 'utf-8';
}

function detectRisks(body, analysis, status) {
  const source = String(body || '');
  return {
    captcha: Boolean(analysis.keywordFlags?.hasCaptcha || /(验证码|captcha|verify|btwaf)/i.test(source)),
    hardAntiBot: /(cloudflare|cf-chl-|turnstile|geetest|滑块|登录后访问|drm)/i.test(source),
    dynamicHost: Boolean(analysis.keywordFlags?.hasDynamicHost || analysis.dynamicHostSignals?.length),
    signature: /(?:x-auth-signature|authorization|hmac|sha256|sign(?:ature)?\s*[:=])/i.test(source),
    imageEncryption: /(?:CryptoJS\.AES|AES\/CBC|imageDecrypt|decryptImage)/i.test(source),
    gbEncoding: /(?:gbk|gb2312|gb18030)/i.test(source),
    httpError: Number(status) >= 400,
  };
}

function normalizeContentType(guess, body) {
  const value = String(guess || '').toLowerCase();
  if (value.includes('novel') || value.includes('小说')) return 'novel';
  if (value.includes('comic') || value.includes('漫画')) return 'comic';
  if (/magnet:\?xt=urn:btih:|\.torrent/i.test(String(body || ''))) return 'bt';
  return 'video';
}

function firstSelector(ruleValue) {
  if (typeof ruleValue !== 'string' || !ruleValue.trim() || ruleValue === '*' || ruleValue.startsWith('js:') || ruleValue.startsWith('json:')) return '';
  return ruleValue.split(';')[0].split('&&').join(' ').trim();
}

function queryCount($, selector) {
  if (!selector) return 0;
  try {
    return $(selector).length;
  } catch (_) {
    return 0;
  }
}

function familySignal(name, html, url) {
  const signals = {
    mx: /vodshow|vodsearch|player_/,
    mxpro: /vodshow|vodsearch|module-/,
    mxone5: /vodshow|vodsearch|module-/,
    首图: /myui-/,
    首图2: /stui-/,
    vfed: /fed-/,
    海螺3: /hl-/,
    海螺2: /nav-bar|list-a|deployment|play_list_box/,
    短视: /menu_bottom|pic-list|py-tabs|indexshowbox|zkjj_a/,
    短视2: /public-list-box|anthology-list-box|slide-info|index\.php\/api\/vod/,
    采集1: /api\.php\/provide\/vod|ac=detail/,
  };
  return Boolean(signals[name]?.test(`${html}\n${url}`));
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('set-cookie');
  return value ? [value] : [];
}

function hasHeader(headers, name) {
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === String(name).toLowerCase());
}

function deleteHeader(headers, name) {
  const target = String(name).toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === target) delete headers[key];
  }
}

function countMatches(text, pattern) {
  return [...String(text || '').matchAll(pattern)].length;
}
