# 动态域名 / 发布页写源手册

## 适用场景

只要目标站出现下面任一信号，就按动态域名站处理：

- 入口域名不是业务站，而是发布页、导航页、备用网址页或“请收藏发布页”。
- 首页只返回 `Loading`、跳转壳、短 HTML、站点列表卡片、BCE BOS / GitHub Pages / 静态桶页面。
- 老域名偶发 404、空白页、维护页，但发布页还能给出最新可用站点。
- 发布页 HTML 或外链 JS 里用 `document.write`、`location.href`、`window.open`、加密字符串或混淆脚本写出真实站点。
- 规则中固定 `host` 可用一段时间后失效，需要第一候选失败后自动换第二候选。

核心判断：**`host` 可以绑定发布页入口，但真正请求首页、分类、详情、搜索、播放时必须先发现业务域名，再按页面健康度自动切换。**

## 推荐处理顺序

1. 抓发布页入口 HTML，例如 `https://publish.example.com/`。
2. 抽取页面中直接出现的 `http(s)://` 链接，先过滤图片、CSS、JS、统计脚本、发布页自身域名。
3. 抽取 `<script src="...">`，继续抓脚本源码。
4. 如果发布页或脚本用 `document.write` / `writeln`、`location.href`、`window.open` 写站点列表，只静态提取字符串字面量和转义 URL，不在规则中执行远端脚本。
5. 合并 HTML、脚本源码和静态提取结果中的 URL，得到候选业务域。
6. 加入兜底域名列表，顺序放在发布页发现结果之后。
7. 对每个候选域执行健康检查：先请求同一个 path，再用当前页面类型的 validator 判断是否成功。
8. 成功后缓存当前业务域；失败时刷新候选并自动换下一个。
9. 如果候选业务域返回验证码页，再进入验证码链路；不要在发布页域名上提交业务站验证码。

## 关键原则

- 不要把发布页域当成 `pd` / `lmmAbs` 的业务链接根。业务链接根应该是当前成功的 `_active_host`。
- 发布页域、静态桶域、资源域、统计域都要过滤，只保留真正能访问首页/分类/详情/搜索的业务域。
- 每个入口使用自己的 validator：列表页看卡片，详情页看标题和剧集，搜索接口看 JSON，播放页看播放器对象或媒体直链。
- 搜索 JSON 要先判断坏页和验证码页，再 `JSON.parse`。
- 图片相对路径用当前业务域补全，避免生成发布页域名下的错误图片地址。
- 候选域缓存只能加速，不应成为单点依赖；失败后要强制重新发现。
- 禁止在规则中用 `eval`、`Function` 或构造器链执行发布页脚本。若候选域只能通过计算型混淆得到，先在浏览器或隔离分析环境取证，再把已验证候选写入规则。

## 通用骨架

下面是可复用的动态域名骨架。实际写源时按站点前缀改函数名，避免多个源混用全局状态。

```javascript
function dhClean(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function dhTrimHost(host) {
  return String(host || '').trim().replace(/\/+$/g, '');
}

function dhUrlHost(url) {
  const match = String(url || '').trim().match(/^(https?:\/\/[^/?#]+)/i);
  return match ? dhTrimHost(match[1]) : '';
}

function dhUrlPath(url) {
  const value = String(url || '').trim();
  if (!value) return '/';
  if (!/^https?:\/\//i.test(value)) {
    return value.startsWith('/') ? value : '/' + value.replace(/^\.\//, '');
  }
  const match = value.match(/^https?:\/\/[^/?#]+([^#]*)/i);
  return match && match[1] ? match[1] : '/';
}

function dhCurrentHost() {
  return dhTrimHost((typeof rule !== 'undefined' && (rule._active_host || rule.host)) || '');
}

function dhAbs(url, host) {
  const value = String(url || '').trim();
  const base = dhTrimHost(host || dhCurrentHost());
  if (!value) return '';
  if (value.startsWith('//')) return 'https:' + value;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return base + value;
  return base + '/' + value.replace(/^\.\//, '');
}

function dhApplyHost(host, persist) {
  const value = dhTrimHost(host);
  if (!value || typeof rule === 'undefined') return '';
  rule._active_host = value;
  rule.host = value;
  if (rule.headers) rule.headers.Referer = value + '/';
  if (persist !== false) {
    try {
      setItem('demo_active_host', value);
    } catch (e) {}
  }
  return value;
}

function dhPushUnique(list, value) {
  const text = String(value || '').trim();
  if (text && !list.includes(text)) list.push(text);
}
```

## 发布页 URL 收集

```javascript
function dhHtmlDecode(text) {
  return String(text || '')
    .replace(/&amp;/ig, '&')
    .replace(/&lt;/ig, '<')
    .replace(/&gt;/ig, '>')
    .replace(/&quot;/ig, '"')
    .replace(/&#39;/ig, "'");
}

function dhIsPublishHost(host) {
  const value = String(host || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  return /(^|\.)example-pub\.com$|(^|\.)bcebos\.com$|(^|\.)github\.io$/.test(value);
}

function dhCollectUrls(text) {
  const source = dhHtmlDecode(String(text || '').replace(/\\\//g, '/'));
  const urls = [];
  const patterns = [
    /https?:\/\/[^'"`<>\s)]+/ig,
    /(?:href|src)\s*=\s*['"]([^'"]+)['"]/ig,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      let value = String(match[1] || match[0] || '').trim();
      if (value.startsWith('//')) value = 'https:' + value;
      if (!/^https?:\/\//i.test(value)) continue;
      value = value.replace(/[),.;]+$/g, '');
      dhPushUnique(urls, value);
    }
  }
  return urls;
}

function dhCollectSiteHosts(text) {
  const hosts = [];
  dhCollectUrls(text).forEach((url) => {
    const host = dhUrlHost(url);
    if (!host || dhIsPublishHost(host)) return;
    if (/\.(?:js|css|png|jpg|jpeg|gif|svg|ico|webp)(?:[?#]|$)/i.test(url)) return;
    dhPushUnique(hosts, host);
  });
  return hosts;
}

function dhCollectScriptUrls(text, baseHost) {
  const scripts = [];
  const source = dhHtmlDecode(String(text || '').replace(/\\\//g, '/'));
  let match;
  const pattern = /<script[^>]+src\s*=\s*['"]([^'"]+)['"]/ig;
  while ((match = pattern.exec(source)) !== null) {
    const src = String(match[1] || '').trim();
    if (src) dhPushUnique(scripts, dhAbs(src, baseHost));
  }
  dhCollectUrls(source).forEach((url) => {
    if (/\.js(?:[?#]|$)/i.test(url)) dhPushUnique(scripts, url);
  });
  return scripts;
}
```

## 静态提取发布页脚本字面量

只收集脚本源码中明确出现的字符串，不运行脚本。下面覆盖常见的 `document.write`、跳转赋值和 `window.open`；计算型混淆需要在规则外取证。

```javascript
function dhDecodeScriptLiteral(text) {
  return String(text || '')
    .replace(/\\x([0-9a-f]{2})/ig, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/\\u([0-9a-f]{4})/ig, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/\\\//g, '/')
    .replace(/\\(["'`\\])/g, '$1');
}

function dhCollectScriptLiterals(code) {
  const out = [];
  const source = String(code || '');
  const patterns = [
    /document\.(?:write|writeln)\s*\(\s*(["'`])([\s\S]*?)\1\s*\)/ig,
    /(?:window\.)?location(?:\.href)?\s*=\s*(["'`])([\s\S]*?)\1/ig,
    /window\.open\s*\(\s*(["'`])([\s\S]*?)\1/ig,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const value = dhDecodeScriptLiteral(match[2]);
      if (value) out.push(value);
    }
  }
  return out.join('\n');
}

function dhCollectInlineScriptLiterals(html) {
  const out = [];
  const pattern = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/ig;
  let match;
  while ((match = pattern.exec(String(html || ''))) !== null) {
    out.push(dhCollectScriptLiterals(match[1]));
  }
  return out.filter(Boolean).join('\n');
}
```

## 候选域发现与缓存

```javascript
async function dhFetchText(url, options) {
  const opts = options || {};
  const headers = Object.assign({
    'User-Agent': PC_UA,
    'Referer': opts.referer || url,
  }, opts.headers || {});
  try {
    const resp = await request(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.data,
      data: opts.data,
      postType: opts.postType,
    });
    return typeof resp === 'string' ? resp : String(resp || '');
  } catch (e) {}
  return '';
}

async function dhDiscoverHosts() {
  const hosts = [];
  const scripts = [];
  const publishUrls = [
    'https://publish.example.com/',
    'https://static.example.com/publish.html',
  ];

  for (const url of publishUrls) {
    const html = await dhFetchText(url, { referer: publishUrls[0] });
    if (!html) continue;
    const rendered = dhCollectInlineScriptLiterals(html);
    const combined = html + '\n' + rendered;
    dhCollectSiteHosts(combined).forEach((host) => dhPushUnique(hosts, host));
    dhCollectScriptUrls(combined, dhUrlHost(url)).forEach((scriptUrl) => dhPushUnique(scripts, scriptUrl));
  }

  for (const scriptUrl of scripts) {
    const text = await dhFetchText(scriptUrl, { referer: publishUrls[0], headers: { Accept: '*/*' } });
    if (!text) continue;
    const rendered = dhCollectScriptLiterals(text);
    const combined = text + '\n' + rendered;
    dhCollectSiteHosts(combined).forEach((host) => dhPushUnique(hosts, host));
  }

  return hosts;
}

async function dhHostCandidates(force) {
  if (!force && Array.isArray(rule._host_candidates) && rule._host_candidates.length) {
    return rule._host_candidates;
  }

  const hosts = [];
  try {
    const discovered = await dhDiscoverHosts();
    discovered.forEach((host) => dhPushUnique(hosts, host));
  } catch (e) {
    log('dynamic host discover error=>' + e.message);
  }

  try {
    const savedHost = getItem('demo_active_host');
    if (savedHost) dhPushUnique(hosts, savedHost);
  } catch (e) {}

  ['https://backup1.example.com', 'https://backup2.example.com'].forEach((host) => dhPushUnique(hosts, host));
  rule._host_candidates = hosts;
  log('dynamic hosts=>' + hosts.join(','));
  return hosts;
}
```

## 失败自动切换

```javascript
function dhIsBadPage(html) {
  const source = String(html || '');
  return !source ||
    /<title>\s*Loading\s*<\/title>/i.test(source) ||
    /404|not found|页面不存在|维护中|发布页|最新网址/i.test(source);
}

function dhIsCardPage(html) {
  const source = String(html || '');
  return !dhIsBadPage(source) && /\/detail\/\d+\.html/i.test(source) && /module-item|video|vod/i.test(source);
}

function dhIsDetailPage(html) {
  const source = String(html || '');
  return !dhIsBadPage(source) && (/vod_play_url|module-player-list|player_|\/play\//i.test(source));
}

function dhIsSearchResponse(text) {
  const source = String(text || '');
  if (dhIsBadPage(source) || /验证码|captcha|verify|安全验证/i.test(source)) return false;
  try {
    const payload = JSON.parse(source || '{}');
    return Array.isArray(payload.list) || Array.isArray(payload.data) || Array.isArray(payload.data && payload.data.list);
  } catch (e) {}
  return false;
}

async function dhFetchHtmlOnHost(host, path, label, verifyType) {
  const currentHost = dhApplyHost(host, false);
  const url = dhAbs(path, currentHost);
  let html = await getHtml(url);
  if (/验证码|captcha|verify|安全验证/i.test(String(html || ''))) {
    let cookie = '';
    try {
      cookie = await verifyCode(url);
    } catch (e) {}
    if (cookie) {
      setItem(RULE_CK, cookie);
      html = await getHtml(url);
    }
  }
  return { host: currentHost, url: url, html: html };
}

async function dhFetchAuto(url, label, verifyType, validator, force) {
  const path = dhUrlPath(url);
  const preferHost = dhUrlHost(url);
  const hosts = [];
  if (preferHost && !dhIsPublishHost(preferHost)) dhPushUnique(hosts, preferHost);
  const candidates = await dhHostCandidates(force);
  candidates.forEach((host) => dhPushUnique(hosts, host));

  let last = null;
  for (const host of hosts) {
    try {
      const page = await dhFetchHtmlOnHost(host, path, label, verifyType);
      last = page;
      const ok = typeof validator === 'function' ? validator(page.html) : !dhIsBadPage(page.html);
      if (ok) {
        dhApplyHost(host, true);
        return page;
      }
      log('[dynamic host fail] ' + host + ' ' + (label || '') + ' invalid');
    } catch (e) {
      log('[dynamic host fail] ' + host + ' ' + (label || '') + ' =>' + e.message);
    }
  }

  if (!force) {
    rule._host_candidates = [];
    return await dhFetchAuto(url, label, verifyType, validator, true);
  }

  return last || { host: dhCurrentHost(), url: dhAbs(path, dhCurrentHost()), html: '' };
}
```

## 规则中怎么接入

`host` 可以写发布页入口，`headers.Referer` 也先指向发布页。所有业务请求通过 `dhFetchAuto`：

```javascript
var rule = {
  类型: '影视',
  title: '示例动态域名站',
  host: 'https://publish.example.com',
  headers: {
    'User-Agent': PC_UA,
    'Referer': 'https://publish.example.com/',
  },
  推荐: async function () {
    const page = await dhFetchAuto('/', '首页', 'search', dhIsCardPage);
    return setResult(parseCards(this, page.html));
  },
  一级: async function (tid, pg) {
    const path = '/type/' + tid + (Number(pg || 1) > 1 ? '_' + pg : '') + '.html';
    const page = await dhFetchAuto(path, '分类页', 'search', dhIsCardPage);
    return setResult(parseCards(this, page.html));
  },
  二级: async function (ids) {
    const page = await dhFetchAuto(dhUrlPath(ids[0]), '详情页', 'detail', dhIsDetailPage);
    const detailUrl = dhAbs(dhUrlPath(ids[0]), dhCurrentHost());
    // 解析详情时，vod_id 和剧集链接都尽量使用当前成功业务域。
    return { vod_id: detailUrl, vod_name: '' };
  },
  搜索: async function (wd, quick, pg) {
    const path = '/index.php/ajax/suggest?wd=' + encodeURIComponent(wd) + '&page=' + (pg || 1);
    const page = await dhFetchAuto(path, '搜索接口', 'search', dhIsSearchResponse);
    const payload = JSON.parse(page.html || '{}');
    return setResult((payload.list || []).map((item) => ({
      title: item.name,
      pic_url: dhAbs(item.pic, dhCurrentHost()),
      desc: item.en || '',
      url: dhAbs('/detail/' + item.id + '.html', dhCurrentHost()),
    })));
  },
};
```

## 与验证码组合

推荐顺序是：

1. 先通过发布页拿候选业务域。
2. 再请求候选业务域的业务 path。
3. 如果返回验证码页，调用 `verifyCode` / `OcrApi` / 自定义验证码 helper。
4. 验证通过后重拉当前业务 path。
5. 如果还是坏页，再换下一个候选域。

不要把验证码 cookie 固定理解为发布页 cookie；通常应以当前业务域为准。

## 验收标准

- `resources list` 能看到 `dynamic-host-playbook`。
- `resources read --name dynamic-host-playbook` 能读出本文档。
- `triage` 在动态域名输入下应报告发布页、脚本和候选业务域健康检查风险。
- 源文件先通过 `lint`。
- 至少运行 `check --level l2 --engine auto`，重要源运行 `check --level l3 --engine auto`。
- 日志中能看到候选域名、当前成功业务域、失败切换记录。
