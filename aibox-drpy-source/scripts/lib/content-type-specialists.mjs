import {
  analyzeHtmlFilterSignals,
  analyzeJsonFilterSignals,
  renderRuleFilterBlock,
  resolveRuleFilterConfig,
} from './filter-support.mjs';

const DEFAULT_HEADERS = { 'User-Agent': 'MOBILE_UA' };

export function analyzeHtmlContentType(html, url = '') {
  const source = String(html || '');
  const lowerUrl = String(url || '').toLowerCase();
  const novelKeywordHits = collectMatches(source, /(小说|书籍|作者|正文|阅读|reader|book|chapter|章节|最新章节)/gi, 12);
  const comicKeywordHits = collectMatches(source, /(漫画|comic|manga|连载|图集|图片|image|chapter|章节)/gi, 12);
  const mediaHints = collectMatches(source, /https?:\/\/[^\s'"<>]+\.(?:m3u8|mp4|flv)[^\s'"<>]*/gi, 8);
  const novelSignals = {
    keywordHits: novelKeywordHits,
    chapterLinkCount: countMatches(source, /href=["'][^"']*(?:chapter|reader|book|read)[^"']*["']/gi),
    readerContentLength: extractReaderContent(source).length,
    hasBookMeta: /(作者|书名|简介|最新章节)/i.test(source),
  };
  const comicSignals = {
    keywordHits: comicKeywordHits,
    chapterLinkCount: countMatches(source, /href=["'][^"']*(?:chapter|comic|manga)[^"']*["']/gi),
    imageCount: countMatches(source, /<img\b/gi),
    imageUrlCount: countMatches(source, /https?:\/\/[^\s'"<>]+\.(?:jpg|jpeg|png|webp|gif)[^\s'"<>]*/gi),
  };

  let videoScore = mediaHints.length * 3 + (/player_|videojs|dplayer|hls|m3u8|mp4/i.test(source) ? 2 : 0);
  let novelScore = novelSignals.keywordHits.length + (novelSignals.chapterLinkCount > 2 ? 2 : 0) + (novelSignals.readerContentLength > 120 ? 2 : 0) + (novelSignals.hasBookMeta ? 1 : 0);
  let comicScore = comicSignals.keywordHits.length + (comicSignals.imageCount > 5 ? 2 : 0) + (comicSignals.imageUrlCount > 2 ? 2 : 0) + (comicSignals.chapterLinkCount > 2 ? 1 : 0);

  if (/reader|book|novel/.test(lowerUrl)) novelScore += 1;
  if (/comic|manga|chapter/.test(lowerUrl)) comicScore += 1;

  const filterSignals = analyzeHtmlFilterSignals(source, url);
  return {
    contentGuess: pickContentGuess({ video: videoScore, novel: novelScore, comic: comicScore }),
    novelSignals,
    comicSignals,
    filterSignals,
  };
}

export function analyzeJsonContentType(payload) {
  const flatKeys = collectObjectKeys(payload);
  const snapshot = JSON.stringify(payload).slice(0, 120000);
  const novelSignals = {
    keywordHits: flatKeys.filter((key) => /(book|novel|reader|chapter|content|author|title)/i.test(key)).slice(0, 20),
    hasLongContent: /"content"\s*:\s*".{120,}/i.test(snapshot),
    chapterListCount: countMatches(snapshot, /chapter/gi),
  };
  const comicSignals = {
    keywordHits: flatKeys.filter((key) => /(comic|manga|image|images|chapter|page)/i.test(key)).slice(0, 20),
    imageUrlCount: countMatches(snapshot, /https?:\/\/[^\s'"<>]+\.(?:jpg|jpeg|png|webp|gif)[^\s'"<>]*/gi),
    imageListCount: countMatches(snapshot, /"images?"\s*:/gi),
  };
  const videoScore = countMatches(snapshot, /(m3u8|mp4|flv|play_url|player)/gi) * 2;
  const novelScore = novelSignals.keywordHits.length + (novelSignals.hasLongContent ? 3 : 0) + Math.min(novelSignals.chapterListCount, 4);
  const comicScore = comicSignals.keywordHits.length + Math.min(comicSignals.imageUrlCount, 4) + Math.min(comicSignals.imageListCount, 4);

  const filterSignals = analyzeJsonFilterSignals(payload);
  return {
    contentGuess: pickContentGuess({ video: videoScore, novel: novelScore, comic: comicScore }),
    novelSignals,
    comicSignals,
    filterSignals,
  };
}

export function buildNovelHtmlRule(input = {}) {
  const siteName = input.siteName || '未命名小说站';
  const version = input.version || '1.0.0';
  const host = input.host || '';
  const selectors = { ...(input.selectors || {}) };
  const searchable = numberOrDefault(input.searchable, 1);
  const quickSearch = numberOrDefault(input.quickSearch, 0);
  const headers = input.headers || DEFAULT_HEADERS;
  const url = input.url || '/list/fyclass-fypage.html';
  const searchUrl = stringOption(input, 'searchUrl', '/search/**-fypage.html');
  const className = input.className || '全部';
  const classUrl = input.classUrl || '0';
  const filterConfig = resolveRuleFilterConfig(input, { url, classUrl });
  const filterable = Object.prototype.hasOwnProperty.call(input, 'filterable')
    ? numberOrDefault(input.filterable, filterConfig.filterable)
    : filterConfig.filterable;
  const filterBlock = renderRuleFilterBlock({ ...filterConfig, filterable }, '  ').trimEnd();
  const recommendRule = buildListRuleString(selectors.recommendList || selectors.categoryList, selectors.recommendTitle || selectors.categoryTitle, selectors.recommendImage || selectors.categoryImage, selectors.recommendDesc || selectors.categoryDesc, selectors.recommendLink || selectors.categoryLink);
  const categoryRule = buildListRuleString(selectors.categoryList, selectors.categoryTitle, selectors.categoryImage, selectors.categoryDesc, selectors.categoryLink);
  const searchRule = buildListRuleString(selectors.searchList, selectors.searchTitle, selectors.searchImage, selectors.searchDesc, selectors.searchLink);

  return [
    ...buildHeaderLines({ siteName, type: '小说', searchable, filterable, quickSearch }),
    'var rule = {',
    `  类型: ${q('小说')},`,
    `  title: ${q(siteName)},`,
    `  version: ${q(version)},`,
    `  host: ${q(host)},`,
    `  homeUrl: ${q(input.homeUrl || '')},`,
    `  url: ${q(url)},`,
    `  searchUrl: ${q(searchUrl)},`,
    `  headers: ${jsonToJs(headers)},`,
    `  searchable: ${searchable},`,
    `  quickSearch: ${quickSearch},`,
    `  filterable: ${filterable},`,
    '  play_parse: true,',
    '  play_json: [],',
    `  class_name: ${q(className)},`,
    `  class_url: ${q(classUrl)},`,
    ...(filterBlock ? filterBlock.split('\n') : []),
    `  _chapterList: ${q(selectors.chapterList || '.chapter-list a')},`,
    `  _chapterTitle: ${q(selectors.chapterTitle || 'a&&Text')},`,
    `  _chapterLink: ${q(selectors.chapterLink || 'a&&href')},`,
    `  _readerTitle: ${q(selectors.readerTitle || 'h1&&Text')},`,
    `  _readerContent: ${q(selectors.readerContent || '#content&&Text')},`,
    `  推荐: ${q(recommendRule === categoryRule ? '*' : recommendRule)},`,
    `  一级: ${q(categoryRule)},`,
    '  二级: async function (ids) {',
    '    const baseUrl = this.input || rule.host;',
    '    const html = await getHtml(this.input);',
    '    const chapters = pdfa(html, rule._chapterList).map((it) => {',
    '      const name = String(pdfh(it, rule._chapterTitle) || "").replace(/[#$]/g, " ").trim();',
    '      const link = pd(it, rule._chapterLink, baseUrl);',
    '      return name && link ? name + "$" + link : "";',
    '    }).filter(Boolean);',
    '    return {',
    '      vod_id: ids[0],',
    `      vod_name: pdfh(html, ${q(selectors.detailTitle || 'h1&&Text')}),`,
    `      vod_pic: pd(html, ${q(selectors.detailImage || '.detail-pic img&&src')}, baseUrl),`,
    `      vod_remarks: pdfh(html, ${q(selectors.detailRemarks || '.detail-remarks&&Text')}),`,
    `      vod_content: pdfh(html, ${q(selectors.detailContent || '.detail-content&&Text')}),`,
    '      vod_play_from: "正文",',
    '      vod_play_url: chapters.join("#")',
    '    };',
    '  },',
    `  搜索: ${q(searchRule)},`,
    '  lazy: async function (flag, id) {',
    '    const readerUrl = /^https?:\\/\\//i.test(String(id || "")) ? String(id) : rule.host + String(id || "");',
    '    const html = await getHtml(readerUrl);',
    '    const title = pdfh(html, rule._readerTitle) || "";',
    '    const content = pdfh(html, rule._readerContent) || pdfh(html, "body&&Text") || "";',
    '    return { parse: 0, url: "novel://" + JSON.stringify({ title, content }), js: "" };',
    '  },',
    '};',
    '',
  ].join('\n');
}

export function buildComicHtmlRule(input = {}) {
  const siteName = input.siteName || '未命名漫画站';
  const version = input.version || '1.0.0';
  const host = input.host || '';
  const selectors = { ...(input.selectors || {}) };
  const searchable = numberOrDefault(input.searchable, 1);
  const quickSearch = numberOrDefault(input.quickSearch, 0);
  const headers = input.headers || DEFAULT_HEADERS;
  const url = input.url || '/list/fyclass-fypage.html';
  const searchUrl = stringOption(input, 'searchUrl', '/search/**-fypage.html');
  const className = input.className || '全部';
  const classUrl = input.classUrl || '0';
  const filterConfig = resolveRuleFilterConfig(input, { url, classUrl });
  const filterable = Object.prototype.hasOwnProperty.call(input, 'filterable')
    ? numberOrDefault(input.filterable, filterConfig.filterable)
    : filterConfig.filterable;
  const filterBlock = renderRuleFilterBlock({ ...filterConfig, filterable }, '  ').trimEnd();
  const recommendRule = buildListRuleString(selectors.recommendList || selectors.categoryList, selectors.recommendTitle || selectors.categoryTitle, selectors.recommendImage || selectors.categoryImage, selectors.recommendDesc || selectors.categoryDesc, selectors.recommendLink || selectors.categoryLink);
  const categoryRule = buildListRuleString(selectors.categoryList, selectors.categoryTitle, selectors.categoryImage, selectors.categoryDesc, selectors.categoryLink);
  const searchRule = buildListRuleString(selectors.searchList, selectors.searchTitle, selectors.searchImage, selectors.searchDesc, selectors.searchLink);

  return [
    ...buildHeaderLines({ siteName, type: '漫画', searchable, filterable, quickSearch }),
    'var rule = {',
    `  类型: ${q('漫画')},`,
    `  title: ${q(siteName)},`,
    `  version: ${q(version)},`,
    `  host: ${q(host)},`,
    `  homeUrl: ${q(input.homeUrl || '')},`,
    `  url: ${q(url)},`,
    `  searchUrl: ${q(searchUrl)},`,
    `  headers: ${jsonToJs(headers)},`,
    `  searchable: ${searchable},`,
    `  quickSearch: ${quickSearch},`,
    `  filterable: ${filterable},`,
    '  play_parse: true,',
    '  play_json: [],',
    `  class_name: ${q(className)},`,
    `  class_url: ${q(classUrl)},`,
    ...(filterBlock ? filterBlock.split('\n') : []),
    `  _chapterList: ${q(selectors.chapterList || '.chapter-list a')},`,
    `  _chapterTitle: ${q(selectors.chapterTitle || 'a&&Text')},`,
    `  _chapterLink: ${q(selectors.chapterLink || 'a&&href')},`,
    `  _imageList: ${q(selectors.imageList || '.reader-content img')},`,
    `  _imageAttr: ${q(selectors.imageAttr || 'data-src')},`,
    `  推荐: ${q(recommendRule === categoryRule ? '*' : recommendRule)},`,
    `  一级: ${q(categoryRule)},`,
    '  二级: async function (ids) {',
    '    const baseUrl = this.input || rule.host;',
    '    const html = await getHtml(this.input);',
    '    const chapters = pdfa(html, rule._chapterList).map((it) => {',
    '      const name = String(pdfh(it, rule._chapterTitle) || "").replace(/[#$]/g, " ").trim();',
    '      const link = pd(it, rule._chapterLink, baseUrl);',
    '      return name && link ? name + "$" + link : "";',
    '    }).filter(Boolean);',
    '    return {',
    '      vod_id: ids[0],',
    `      vod_name: pdfh(html, ${q(selectors.detailTitle || 'h1&&Text')}),`,
    `      vod_pic: pd(html, ${q(selectors.detailImage || '.detail-pic img&&src')}, baseUrl),`,
    `      vod_remarks: pdfh(html, ${q(selectors.detailRemarks || '.detail-remarks&&Text')}),`,
    `      vod_content: pdfh(html, ${q(selectors.detailContent || '.detail-content&&Text')}),`,
    '      vod_play_from: "图片",',
    '      vod_play_url: chapters.join("#")',
    '    };',
    '  },',
    `  搜索: ${q(searchRule)},`,
    '  lazy: async function (flag, id) {',
    '    const readerUrl = /^https?:\\/\\//i.test(String(id || "")) ? String(id) : rule.host + String(id || "");',
    '    const html = await getHtml(readerUrl);',
    '    const imageRule = "img&&" + rule._imageAttr + (rule._imageAttr === "src" ? "" : "||src");',
    '    const images = Array.from(new Set(pdfa(html, rule._imageList).map((it) => pd(it, imageRule, readerUrl)).filter(Boolean)));',
    '    return { parse: 0, url: "pics://" + images.join("&&"), header: rule.headers };',
    '  },',
    '};',
    '',
  ].join('\n');
}

export function buildNovelJsonRule(input = {}) {
  const siteName = input.siteName || '未命名小说站';
  const version = input.version || '1.0.0';
  const host = input.host || '';
  const mappings = { ...(input.mappings || {}) };
  const searchable = numberOrDefault(input.searchable, 1);
  const quickSearch = numberOrDefault(input.quickSearch, 0);
  const headers = input.headers || DEFAULT_HEADERS;
  const url = input.url || '/api/book/list?t=fyclass&pg=fypage';
  const searchUrl = stringOption(input, 'searchUrl', '/api/book/search?wd=**&pg=fypage');
  const chapterListPath = mappings.chapterListPath || (String(input.catalogUrl || '').trim() ? 'data.chapters' : 'chapters');
  const className = input.className || input.class_name || '全部';
  const classUrl = input.classUrl || input.class_url || '0';
  const filterConfig = resolveRuleFilterConfig(input, { url, classUrl });
  const filterable = Object.prototype.hasOwnProperty.call(input, 'filterable')
    ? numberOrDefault(input.filterable, filterConfig.filterable)
    : filterConfig.filterable;
  const filterBlock = renderRuleFilterBlock({ ...filterConfig, filterable }, '  ').trimEnd();
  const recommendRule = buildJsonListRule(mappings.recommendListPath || 'data.list', mappings.titleField || 'title', mappings.imageField || 'pic', mappings.descField || 'remarks', mappings.linkField || 'id');
  const categoryRule = buildJsonListRule(mappings.categoryListPath || 'data.list', mappings.titleField || 'title', mappings.imageField || 'pic', mappings.descField || 'remarks', mappings.linkField || 'id');
  const searchRule = buildJsonListRule(mappings.searchListPath || 'data.list', mappings.titleField || 'title', mappings.imageField || 'pic', mappings.descField || 'remarks', mappings.linkField || 'id');
  return [
    ...buildHeaderLines({ siteName, type: '小说', searchable, filterable, quickSearch }),
    'var rule = {',
    `  类型: ${q('小说')},`,
    `  title: ${q(siteName)},`,
    `  version: ${q(version)},`,
    `  host: ${q(host)},`,
    `  homeUrl: ${q(input.homeUrl || '')},`,
    `  url: ${q(url)},`,
    `  searchUrl: ${q(searchUrl)},`,
    `  headers: ${jsonToJs(headers)},`,
    `  searchable: ${searchable},`,
    `  quickSearch: ${quickSearch},`,
    `  filterable: ${filterable},`,
    `  class_name: ${q(className)},`,
    `  class_url: ${q(classUrl)},`,
    ...(filterBlock ? filterBlock.split('\n') : []),
    `  detailUrl: ${q(input.detailUrl || '')},`,
    `  catalogUrl: ${q(input.catalogUrl || '')},`,
    `  readerUrl: ${q(input.readerUrl || '')},`,
    '  play_parse: true,',
    '  play_json: [],',
    '  _pick: function (obj, path, fallback) {',
    '    if (!path) return fallback;',
    '    const value = String(path).split(".").filter(Boolean).reduce((acc, key) => acc && typeof acc === "object" ? acc[key] : undefined, obj);',
    '    return value === undefined ? fallback : value;',
    '  },',
    '  _url: function (value, template) {',
    '    const text = String(value || "").trim();',
    '    if (!text) return "";',
    '    if (/^https?:\\/\\//i.test(text)) return text;',
    '    const base = String(rule.host || "").endsWith("/") ? String(rule.host).slice(0, -1) : String(rule.host || "");',
    '    const pattern = String(template || "");',
    '    if (pattern) {',
    '      const target = pattern.replace(/fyid/g, encodeURIComponent(text));',
    '      return /^https?:\\/\\//i.test(target) ? target : base + (target.startsWith("/") ? target : "/" + target);',
    '    }',
    '    return base + (text.startsWith("/") ? text : "/" + text);',
    '  },',
    '  _abs: function (baseUrl, value) {',
    '    const text = String(value || "").trim();',
    '    if (!text || /^data:/i.test(text)) return text;',
    '    return text.startsWith("http://") || text.startsWith("https://") ? text : urljoin(baseUrl || rule.host, text);',
    '  },',
    `  _detailPath: ${q(mappings.detailPath || 'data')},`,
    `  _detailTitleField: ${q(mappings.detailTitleField || 'title')},`,
    `  _detailImageField: ${q(mappings.detailImageField || 'pic')},`,
    `  _detailRemarksField: ${q(mappings.detailRemarksField || 'remarks')},`,
    `  _detailContentField: ${q(mappings.detailContentField || 'content')},`,
    `  _chapterListPath: ${q(chapterListPath)},`,
    `  _chapterTitleField: ${q(mappings.chapterTitleField || 'title')},`,
    `  _chapterUrlField: ${q(mappings.chapterUrlField || 'url')},`,
    `  _readerTitlePath: ${q(mappings.readerTitlePath || 'data.title')},`,
    `  _readerContentPath: ${q(mappings.readerContentPath || 'data.content')},`,
    `  推荐: ${q(recommendRule === categoryRule ? '*' : recommendRule)},`,
    `  一级: ${q(categoryRule)},`,
    '  二级: async function (ids) {',
    '    const workId = String(this.detailUrl || this.vid || ids[0] || "");',
    '    const json = JSON.parse(await getHtml(this.input));',
    '    const detail = rule._pick(json, rule._detailPath, {});',
    '    const catalog = rule.catalogUrl ? JSON.parse(await getHtml(rule._url(workId, rule.catalogUrl))) : detail;',
    '    const chapters = rule._pick(catalog, rule._chapterListPath, []);',
    '    return {',
    '      vod_id: ids[0],',
    '      vod_name: String(rule._pick(detail, rule._detailTitleField, "")),',
    '      vod_pic: rule._abs(this.input, rule._pick(detail, rule._detailImageField, "")),',
    '      vod_remarks: String(rule._pick(detail, rule._detailRemarksField, "")),',
    '      vod_content: String(rule._pick(detail, rule._detailContentField, "")),',
    '      vod_play_from: "正文",',
    '      vod_play_url: (Array.isArray(chapters) ? chapters : []).map((it) => {',
    '        const name = String(rule._pick(it, rule._chapterTitleField, "")).replace(/[#$]/g, " ").trim();',
    '        const url = rule._url(rule._pick(it, rule._chapterUrlField, ""), rule.readerUrl);',
    '        return name && url ? name + "$" + url : "";',
    '      }).filter(Boolean).join("#")',
    '    };',
    '  },',
    `  搜索: ${q(searchRule)},`,
    '  lazy: async function (flag, id) {',
    '    const json = JSON.parse(await getHtml(rule._url(id, rule.readerUrl)));',
    '    const title = String(rule._pick(json, rule._readerTitlePath, ""));',
    '    const content = String(rule._pick(json, rule._readerContentPath, ""));',
    '    return { parse: 0, url: "novel://" + JSON.stringify({ title, content }), js: "" };',
    '  },',
    '};',
    '',
  ].join('\n');
}

export function buildComicJsonRule(input = {}) {
  const siteName = input.siteName || '未命名漫画站';
  const version = input.version || '1.0.0';
  const host = input.host || '';
  const mappings = { ...(input.mappings || {}) };
  const searchable = numberOrDefault(input.searchable, 1);
  const quickSearch = numberOrDefault(input.quickSearch, 0);
  const headers = input.headers || DEFAULT_HEADERS;
  const url = input.url || '/api/comic/list?t=fyclass&pg=fypage';
  const searchUrl = stringOption(input, 'searchUrl', '/api/comic/search?wd=**&pg=fypage');
  const chapterListPath = mappings.chapterListPath || (String(input.catalogUrl || '').trim() ? 'data.chapters' : 'chapters');
  const className = input.className || input.class_name || '全部';
  const classUrl = input.classUrl || input.class_url || '0';
  const filterConfig = resolveRuleFilterConfig(input, { url, classUrl });
  const filterable = Object.prototype.hasOwnProperty.call(input, 'filterable')
    ? numberOrDefault(input.filterable, filterConfig.filterable)
    : filterConfig.filterable;
  const filterBlock = renderRuleFilterBlock({ ...filterConfig, filterable }, '  ').trimEnd();
  const recommendRule = buildJsonListRule(mappings.recommendListPath || 'data.list', mappings.titleField || 'title', mappings.imageField || 'pic', mappings.descField || 'remarks', mappings.linkField || 'id');
  const categoryRule = buildJsonListRule(mappings.categoryListPath || 'data.list', mappings.titleField || 'title', mappings.imageField || 'pic', mappings.descField || 'remarks', mappings.linkField || 'id');
  const searchRule = buildJsonListRule(mappings.searchListPath || 'data.list', mappings.titleField || 'title', mappings.imageField || 'pic', mappings.descField || 'remarks', mappings.linkField || 'id');
  return [
    ...buildHeaderLines({ siteName, type: '漫画', searchable, filterable, quickSearch }),
    'var rule = {',
    `  类型: ${q('漫画')},`,
    `  title: ${q(siteName)},`,
    `  version: ${q(version)},`,
    `  host: ${q(host)},`,
    `  homeUrl: ${q(input.homeUrl || '')},`,
    `  url: ${q(url)},`,
    `  searchUrl: ${q(searchUrl)},`,
    `  headers: ${jsonToJs(headers)},`,
    `  searchable: ${searchable},`,
    `  quickSearch: ${quickSearch},`,
    `  filterable: ${filterable},`,
    `  class_name: ${q(className)},`,
    `  class_url: ${q(classUrl)},`,
    ...(filterBlock ? filterBlock.split('\n') : []),
    `  detailUrl: ${q(input.detailUrl || '')},`,
    `  catalogUrl: ${q(input.catalogUrl || '')},`,
    `  readerUrl: ${q(input.readerUrl || '')},`,
    '  play_parse: true,',
    '  play_json: [],',
    '  _pick: function (obj, path, fallback) {',
    '    if (!path) return fallback;',
    '    const value = String(path).split(".").filter(Boolean).reduce((acc, key) => acc && typeof acc === "object" ? acc[key] : undefined, obj);',
    '    return value === undefined ? fallback : value;',
    '  },',
    '  _url: function (value, template) {',
    '    const text = String(value || "").trim();',
    '    if (!text) return "";',
    '    if (/^https?:\\/\\//i.test(text)) return text;',
    '    const base = String(rule.host || "").endsWith("/") ? String(rule.host).slice(0, -1) : String(rule.host || "");',
    '    const pattern = String(template || "");',
    '    if (pattern) {',
    '      const target = pattern.replace(/fyid/g, encodeURIComponent(text));',
    '      return /^https?:\\/\\//i.test(target) ? target : base + (target.startsWith("/") ? target : "/" + target);',
    '    }',
    '    return base + (text.startsWith("/") ? text : "/" + text);',
    '  },',
    '  _abs: function (baseUrl, value) {',
    '    const text = String(value || "").trim();',
    '    if (!text || /^data:/i.test(text)) return text;',
    '    return text.startsWith("http://") || text.startsWith("https://") ? text : urljoin(baseUrl || rule.host, text);',
    '  },',
    `  _detailPath: ${q(mappings.detailPath || 'data')},`,
    `  _detailTitleField: ${q(mappings.detailTitleField || 'title')},`,
    `  _detailImageField: ${q(mappings.detailImageField || 'pic')},`,
    `  _detailRemarksField: ${q(mappings.detailRemarksField || 'remarks')},`,
    `  _detailContentField: ${q(mappings.detailContentField || 'content')},`,
    `  _chapterListPath: ${q(chapterListPath)},`,
    `  _chapterTitleField: ${q(mappings.chapterTitleField || 'title')},`,
    `  _chapterUrlField: ${q(mappings.chapterUrlField || 'url')},`,
    `  _imageListPath: ${q(mappings.imageListPath || 'data.images')},`,
    `  _imageFieldPath: ${q(mappings.imageItemField || 'url')},`,
    `  推荐: ${q(recommendRule === categoryRule ? '*' : recommendRule)},`,
    `  一级: ${q(categoryRule)},`,
    '  二级: async function (ids) {',
    '    const workId = String(this.detailUrl || this.vid || ids[0] || "");',
    '    const json = JSON.parse(await getHtml(this.input));',
    '    const detail = rule._pick(json, rule._detailPath, {});',
    '    const catalog = rule.catalogUrl ? JSON.parse(await getHtml(rule._url(workId, rule.catalogUrl))) : detail;',
    '    const chapters = rule._pick(catalog, rule._chapterListPath, []);',
    '    return {',
    '      vod_id: ids[0],',
    '      vod_name: String(rule._pick(detail, rule._detailTitleField, "")),',
    '      vod_pic: rule._abs(this.input, rule._pick(detail, rule._detailImageField, "")),',
    '      vod_remarks: String(rule._pick(detail, rule._detailRemarksField, "")),',
    '      vod_content: String(rule._pick(detail, rule._detailContentField, "")),',
    '      vod_play_from: "图片",',
    '      vod_play_url: (Array.isArray(chapters) ? chapters : []).map((it) => {',
    '        const name = String(rule._pick(it, rule._chapterTitleField, "")).replace(/[#$]/g, " ").trim();',
    '        const url = rule._url(rule._pick(it, rule._chapterUrlField, ""), rule.readerUrl);',
    '        return name && url ? name + "$" + url : "";',
    '      }).filter(Boolean).join("#")',
    '    };',
    '  },',
    `  搜索: ${q(searchRule)},`,
    '  lazy: async function (flag, id) {',
    '    const readerUrl = rule._url(id, rule.readerUrl);',
    '    const json = JSON.parse(await getHtml(readerUrl));',
    '    const imageItems = rule._pick(json, rule._imageListPath, []);',
    '    const images = (Array.isArray(imageItems) ? imageItems : []).map((it) => typeof it === "string" ? it : String(rule._pick(it, rule._imageFieldPath, ""))).filter(Boolean).map((url) => /^https?:\\/\\//i.test(url) || /^data:/i.test(url) ? url : urljoin(readerUrl, url));',
    '    return { parse: 0, url: "pics://" + images.join("&&"), header: rule.headers };',
    '  },',
    '};',
    '',
  ].join('\n');
}

function buildListRuleString(list, title, image, desc, link) {
  return [list, title, image, desc, link].map((item) => String(item || '')).join(';');
}

function buildJsonListRule(listPath, titleField, imageField, descField, linkField) {
  return `json:${[listPath, titleField, imageField, descField, linkField].map((item) => String(item || '')).join(';')}`;
}

function buildHeaderLines({ siteName, type, searchable, filterable, quickSearch }) {
  return [
    '/*',
    '@header({',
    `  类型: ${q(type)},`,
    `  title: ${q(siteName)},`,
    "  lang: 'ds',",
    `  searchable: ${searchable},`,
    `  filterable: ${filterable},`,
    `  quickSearch: ${quickSearch}`,
    '})',
    '*/',
    '',
  ];
}

function collectMatches(text, pattern, limit = 10) {
  return [...String(text || '').matchAll(pattern)].map((item) => item[0]).slice(0, limit);
}

function countMatches(text, pattern) {
  return [...String(text || '').matchAll(pattern)].length;
}

function collectObjectKeys(value, depth = 0, bucket = []) {
  if (depth > 4 || value === null || value === undefined) {
    return bucket;
  }
  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item) => collectObjectKeys(item, depth + 1, bucket));
    return bucket;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      bucket.push(key);
      collectObjectKeys(child, depth + 1, bucket);
    }
  }
  return bucket;
}

function extractReaderContent(html) {
  const source = String(html || '');
  const match = source.match(/<(?:div|article|section|p)[^>]*(?:content|chapter|reader)[^>]*>([\s\S]*?)<\/(?:div|article|section|p)>/i);
  return match ? stripHtml(match[1]).slice(0, 5000) : '';
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickContentGuess(scores) {
  const entries = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  return entries[0] && entries[0][1] > 0 ? entries[0][0] : 'video';
}

function stringOption(input, key, fallback = '') {
  return Object.prototype.hasOwnProperty.call(input || {}, key)
    ? String(input[key] ?? '')
    : fallback;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function q(value) {
  const safe = String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `'${safe}'`;
}

function jsonToJs(value) {
  const compact = JSON.stringify(value).replace(/"([A-Za-z_$][A-Za-z0-9_$]*)":/g, '$1:');
  if (compact.length <= 80 && !compact.includes('},{')) {
    return compact;
  }
  return JSON.stringify(value, null, 2).replace(/"([A-Za-z_$][A-Za-z0-9_$]*)":/g, '$1:');
}
