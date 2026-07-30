const DEFAULT_CAPTCHA_TAG = '系统安全验证|输入验证码|安全验证|请输入验证码|验证码|captcha|verify';

export function applyDeterministicFixes({ code, report }) {
  let next = String(code || '');
  const changes = [];

  next = ensureField(next, 'headers', `{\n    'User-Agent': 'MOBILE_UA'\n  }`, ['searchUrl', 'url'], changes, '补充 headers');
  next = ensureField(next, 'searchable', '1', ['searchUrl', 'url'], changes, '补充 searchable');
  next = ensureField(next, 'quickSearch', '0', ['searchable', 'searchUrl', 'url'], changes, '补充 quickSearch');
  next = ensureField(next, 'filterable', '0', ['quickSearch', 'searchable', 'searchUrl', 'url'], changes, '补充 filterable');
  next = ensureField(next, 'searchUrl', quote('/search/**-------------/'), ['url'], changes, '补充 searchUrl');

  const captchaHit = hasCaptchaReport(report);
  if (captchaHit) {
    next = ensureField(next, '搜索验证标识', quote(DEFAULT_CAPTCHA_TAG), ['headers', 'play_parse', 'filterable'], changes, '补充 搜索验证标识');
    next = ensureCaptchaHelpers(next, changes);
    next = replaceCommonCaptchaFetch(next, changes);
  }

  const contentType = inferContentType(next, report);
  next = ensureVodPlayAssignments(next, changes);
  if (contentType === 'novel') {
    next = normalizeNovelProtocolEncoding(next, changes);
    next = ensureNovelLazyReturn(next, changes);
  } else if (contentType === 'comic') {
    next = ensureComicPlayContract(next, changes);
    next = ensureComicLazyReturn(next, changes);
  } else {
    next = ensureLazyDirectCheck(next, changes);
  }

  return {
    changed: next !== code,
    code: next,
    changes,
  };
}

function normalizeNovelProtocolEncoding(code, changes) {
  const pattern = /(['"]novel:\/\/['"]\s*\+\s*)encodeURIComponent\((JSON\.stringify\([\s\S]*?\))\)/g;
  const next = code.replace(pattern, '$1$2');
  if (next !== code) {
    changes.push('移除 novel:// JSON 外层 encodeURIComponent');
  }
  return next;
}

function ensureComicPlayContract(code, changes) {
  let next = code;
  const playParsePattern = /(\bplay_parse\s*:\s*)([^,\n}]+)/;
  if (playParsePattern.test(next)) {
    if (!/\bplay_parse\s*:\s*true\b/.test(next)) {
      next = next.replace(playParsePattern, '$1true');
      changes.push('将漫画 play_parse 修正为 true');
    }
  } else {
    next = ensureField(next, 'play_parse', 'true', ['filterable', 'quickSearch', 'searchable'], changes, '为漫画补充 play_parse: true');
  }

  const playJsonPattern = /(\bplay_json\s*:\s*)(\[[^\]\n]*\]|[^,\n}]+)/;
  if (playJsonPattern.test(next)) {
    if (!/\bplay_json\s*:\s*\[\s*\]/.test(next)) {
      next = next.replace(playJsonPattern, '$1[]');
      changes.push('将漫画 play_json 修正为空数组');
    }
  } else {
    next = ensureField(next, 'play_json', '[]', ['play_parse', 'filterable', 'quickSearch'], changes, '为漫画补充 play_json: []');
  }
  return next;
}

export function buildHealPromptArtifact({ code, report }) {
  const lines = [];
  lines.push('# Aibox Live Heal Prompt');
  lines.push('');
  lines.push('请只修改源文件，不要修改 drpy runtime、Node 启动包装和任何框架文件。');
  lines.push('');
  lines.push('## 当前失败摘要');
  for (const item of report.errors || []) {
    lines.push(`- ${item}`);
  }
  for (const item of report.warnings || []) {
    lines.push(`- warning: ${item}`);
  }
  lines.push('');
  lines.push('## 当前源码');
  lines.push('```javascript');
  lines.push(code);
  lines.push('```');
  return lines.join('\n');
}

function hasCaptchaReport(report) {
  return Object.values(report?.steps || {}).some((step) => step?.captchaRisk === 'confirmed');
}

function ensureField(code, fieldName, valueExpression, anchorFields, changes, label) {
  if (new RegExp(`${escapeRegExp(fieldName)}\\s*:`).test(code)) {
    return code;
  }
  const insertion = `  ${fieldName}: ${valueExpression},\n`;
  for (const anchor of anchorFields || []) {
    const re = new RegExp(`(^\\s*${escapeRegExp(anchor)}\\s*:[^\\n]*(?:\\n\\s*},)?\\n)`, 'm');
    if (re.test(code)) {
      changes.push(label);
      return code.replace(re, `$1${insertion}`);
    }
  }
  if (/var\s+rule\s*=\s*{\s*\n?/.test(code)) {
    changes.push(label);
    return code.replace(/var\s+rule\s*=\s*{\s*\n?/, (match) => `${match}${insertion}`);
  }
  return code;
}

function ensureCaptchaHelpers(code, changes) {
  if (code.includes('_captchaRule: function') && code.includes('_fetchHtmlWithCaptcha: async function')) {
    return code;
  }
  const helperBlock = [
    `  _captchaRule: function () {`,
    `    return new RegExp(rule.搜索验证标识 || ${quote(DEFAULT_CAPTCHA_TAG)}, 'i');`,
    `  },`,
    `  _shouldHandleCaptcha: function (html) {`,
    `    return typeof html === 'string' && rule._captchaRule().test(html);`,
    `  },`,
    `  _fetchHtmlWithCaptcha: async function (url, label) {`,
    `    let html = await getHtml(url);`,
    `    if (!rule._shouldHandleCaptcha(html)) {`,
    `      return html;`,
    `    }`,
    `    log('[captcha] ' + (label || '页面') + ' 命中验证码，尝试 OCR 自动识别');`,
    `    try {`,
    `      const cookie = await verifyCode(url);`,
    `      if (cookie) {`,
    `        setItem(RULE_CK, cookie);`,
    `        html = await getHtml(url);`,
    `      }`,
    `    } catch (e) {`,
    `      log('[captcha] verifyCode error=>' + e.message);`,
    `    }`,
    `    return html;`,
    `  },`,
    '',
  ].join('\n');

  const anchor = code.match(/(^\s*class_url\s*:[^\n]*\n)/m)
    || code.match(/(^\s*class_name\s*:[^\n]*\n)/m)
    || code.match(/(^\s*headers\s*:[\s\S]*?\n\s*},\n)/m)
    || code.match(/(^\s*filterable\s*:[^\n]*\n)/m);

  if (!anchor) {
    return code;
  }
  changes.push('补充验证码辅助函数');
  return code.replace(anchor[0], `${anchor[0]}${helperBlock}`);
}

function replaceCommonCaptchaFetch(code, changes) {
  let next = code;
  const mapping = [
    { name: '推荐', label: '首页推荐' },
    { name: '一级', label: '分类页' },
    { name: '二级', label: '详情页' },
    { name: '搜索', label: '搜索页' },
  ];

  for (const item of mapping) {
    const range = findFunctionRange(next, item.name);
    if (!range) continue;
    const chunk = next.slice(range.start, range.end);
    if (chunk.includes('rule._fetchHtmlWithCaptcha(')) continue;
    const replaced = chunk
      .replace(/const\s+html\s*=\s*await\s+request\(input\);/, `const html = await rule._fetchHtmlWithCaptcha(input, '${item.label}');`)
      .replace(/const\s+html\s*=\s*await\s+getHtml\(input\);/, `const html = await rule._fetchHtmlWithCaptcha(input, '${item.label}');`);
    if (replaced !== chunk) {
      next = `${next.slice(0, range.start)}${replaced}${next.slice(range.end)}`;
      changes.push(`为 ${item.name} 接入验证码包装`);
    }
  }

  return next;
}

function ensureVodPlayAssignments(code, changes) {
  if (/vod\.vod_play_from\s*=/.test(code) && /vod\.vod_play_url\s*=/.test(code)) {
    return code;
  }
  if (!/const\s+tabs\s*=/.test(code) || !/const\s+playUrls\s*=/.test(code) || !/return\s+vod\s*;/.test(code)) {
    return code;
  }
  changes.push('补充 vod_play_from / vod_play_url 赋值');
  return code.replace(/return\s+vod\s*;/, () => "vod.vod_play_from = tabs.join('$$$');\n    vod.vod_play_url = playUrls.join('$$$');\n    return vod;");
}

function ensureLazyDirectCheck(code, changes) {
  const range = findFunctionRange(code, 'lazy');
  if (!range) {
    return code;
  }
  const chunk = code.slice(range.start, range.end);
  if (/(m3u8|mp4|flv)/i.test(chunk) && /parse\s*:\s*0/.test(chunk)) {
    return code;
  }
  const injection = [
    `    const playUrl = /^https?:\\/\\//i.test(String(id || '')) ? String(id || '') : id;`,
    `    if (/(m3u8|mp4|flv)(\\?|$)/i.test(playUrl)) {`,
    `      return { parse: 0, url: playUrl };`,
    `    }`,
    '',
  ].join('\n');
  const openRe = /lazy\s*:\s*async\s*function\s*\([^)]*\)\s*{/;
  if (!openRe.test(chunk)) {
    return code;
  }
  const replaced = chunk.replace(openRe, (match) => `${match}\n${injection}`);
  if (replaced === chunk) {
    return code;
  }
  changes.push('补充 lazy 直链优先判断');
  return `${code.slice(0, range.start)}${replaced}${code.slice(range.end)}`;
}

function inferContentType(code, report) {
  if (report?.contentType) {
    return report.contentType;
  }
  const match = String(code || '').match(/类型\s*:\s*['"](影视|小说|漫画)['"]/);
  if (!match || !match[1]) {
    return 'video';
  }
  if (match[1] === '小说') return 'novel';
  if (match[1] === '漫画') return 'comic';
  return 'video';
}

function ensureNovelLazyReturn(code, changes) {
  const range = findFunctionRange(code, 'lazy');
  if (!range) {
    return code;
  }
  const chunk = code.slice(range.start, range.end);
  if (/novel:\/\//i.test(chunk)) {
    return code;
  }
  const openRe = /lazy\s*:\s*async\s*function\s*\([^)]*\)\s*{/;
  if (!openRe.test(chunk)) {
    return code;
  }
  const injection = [
    `    const readerUrl = /^https?:\\/\\//i.test(String(id || '')) ? String(id || '') : rule.host + id;`,
    `    const html = await getHtml(readerUrl);`,
    `    const title = pdfh(html, 'h1&&Text') || '';`,
    `    const content = pdfh(html, '#content&&Text') || pdfh(html, 'body&&Text') || '';`,
    `    if (content) {`,
    `      return { parse: 0, url: 'novel://' + JSON.stringify({ title, content }), js: '' };`,
    `    }`,
    '',
  ].join('\n');
  const replaced = chunk.replace(openRe, (match) => `${match}\n${injection}`);
  if (replaced === chunk) {
    return code;
  }
  changes.push('为小说补充 novel:// lazy scaffold');
  return `${code.slice(0, range.start)}${replaced}${code.slice(range.end)}`;
}

function ensureComicLazyReturn(code, changes) {
  const range = findFunctionRange(code, 'lazy');
  if (!range) {
    return code;
  }
  const chunk = code.slice(range.start, range.end);
  if (/pics:\/\//i.test(chunk)) {
    return code;
  }
  const openRe = /lazy\s*:\s*async\s*function\s*\([^)]*\)\s*{/;
  if (!openRe.test(chunk)) {
    return code;
  }
  const injection = [
    `    const readerUrl = /^https?:\\/\\//i.test(String(id || '')) ? String(id || '') : rule.host + id;`,
    `    const html = await getHtml(readerUrl);`,
    `    const images = pdfa(html, '.reader-content img').map((it) => pd(it, 'img&&data-src', rule.host) || pd(it, 'img&&src', rule.host)).filter(Boolean);`,
    `    if (images.length) {`,
    `      return { parse: 0, url: 'pics://' + images.join('&&'), header: rule.headers };`,
    `    }`,
    '',
  ].join('\n');
  const replaced = chunk.replace(openRe, (match) => `${match}\n${injection}`);
  if (replaced === chunk) {
    return code;
  }
  changes.push('为漫画补充 pics:// lazy scaffold');
  return `${code.slice(0, range.start)}${replaced}${code.slice(range.end)}`;
}

function findFunctionRange(code, name) {
  const re = new RegExp(`${escapeRegExp(name)}\\s*:\\s*(?:async\\s*)?function\\s*\\([^)]*\\)\\s*{`, 'm');
  const match = re.exec(code);
  if (!match) {
    return null;
  }
  const start = match.index;
  const openIndex = code.indexOf('{', start);
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    const char = code[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return { start, end: index + 1 };
    }
  }
  return null;
}

function quote(text) {
  return `'${String(text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
