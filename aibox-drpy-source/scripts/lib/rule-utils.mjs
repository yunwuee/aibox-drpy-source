import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as cheerio from 'cheerio';
import {
  analyzeHtmlContentType,
  analyzeJsonContentType,
  buildComicHtmlRule,
  buildComicJsonRule,
  buildNovelHtmlRule,
  buildNovelJsonRule,
} from './content-type-specialists.mjs';
import {
  renderRuleFilterBlock,
  resolveRuleFilterConfig,
} from './filter-support.mjs';
import { getEngineTemplateMetadata, listEngineTemplateNames } from './template-service.mjs';
import { analyzeRuleSource } from './rule-ast.mjs';

const contentTypeLabelMap = {
  video: '影视',
  novel: '小说',
  comic: '漫画',
};

const defaultHtmlSelectors = {
  recommendList: '.module-items .module-item',
  recommendTitle: 'a&&title',
  recommendImage: 'img&&src',
  recommendDesc: '.module-item-note&&Text',
  recommendLink: 'a&&href',
  categoryList: '.module-items .module-item',
  categoryTitle: 'a&&title',
  categoryImage: 'img&&src',
  categoryDesc: '.module-item-note&&Text',
  categoryLink: 'a&&href',
  detailTitle: 'h1&&Text',
  detailImage: '.detail-pic img&&src',
  detailType: '.detail-info&&Text',
  detailRemarks: '.detail-remarks&&Text',
  detailYear: '.detail-year&&Text',
  detailArea: '.detail-area&&Text',
  detailActor: '.detail-actor&&Text',
  detailDirector: '.detail-director&&Text',
  detailContent: '.detail-content&&Text',
  detailTabs: '.play-source a',
  detailTabName: 'a&&Text',
  detailList: '.play-list',
  detailEpisodeItem: 'a',
  detailEpisodeTitle: 'a&&Text',
  detailEpisodeLink: 'a&&href',
  chapterList: '.chapter-list a',
  chapterTitle: 'a&&Text',
  chapterLink: 'a&&href',
  readerTitle: 'h1&&Text',
  readerContent: '#content&&Text',
  imageList: '.reader-content img',
  imageAttr: 'data-src',
  searchList: '.module-search-item',
  searchTitle: 'a&&title',
  searchImage: 'img&&src',
  searchDesc: '.module-item-note&&Text',
  searchLink: 'a&&href',
};

const defaultJsonMappings = {
  recommendListPath: 'data.list',
  categoryListPath: 'data.list',
  searchListPath: 'data.list',
  titleField: 'title',
  imageField: 'pic',
  descField: 'remarks',
  linkField: 'id',
  detailPath: 'data',
  detailTitleField: 'title',
  detailImageField: 'pic',
  detailTypeField: 'type_name',
  detailRemarksField: 'remarks',
  detailYearField: 'year',
  detailAreaField: 'area',
  detailActorField: 'actor',
  detailDirectorField: 'director',
  detailContentField: 'content',
  detailPlayFromField: 'vod_play_from',
  detailPlayUrlField: 'vod_play_url',
  chapterListPath: 'data.chapters',
  chapterTitleField: 'title',
  chapterUrlField: 'url',
  readerTitlePath: 'data.title',
  readerContentPath: 'data.content',
  imageListPath: 'data.images',
  imageItemField: 'url',
};

const defaultCaptchaTag = '系统安全验证|输入验证码|安全验证|请输入验证码|验证码|captcha|verify';

const dynamicHostRecommendedInputs = ['发布页 HTML', '发布页外链脚本源码', '候选业务域首页源码', '候选业务域详情/搜索健康检查结果'];

const dynamicHostChecklist = ['发布页 URL 提取规则', '脚本 URL 提取规则', '发布页/资源域过滤规则', '业务域候选兜底列表', '页面 validator', '成功域缓存与失败刷新策略'];

const btRecommendedInputs = ['详情页磁力列表源码', 'magnet / .torrent 链接样本', '资源标题与集数命名样本', '搜索结果到详情页链路'];

const btChecklist = ['magnet / .torrent 提取规则', 'BT lazy 直返规则', '集数标题清理规则', 'vod_play_url 分隔符安全检查', '公开 torrent 可直连确认'];

const btCaptureTargets = [
  { page: '详情页磁力列表', goal: '确认 magnet、.torrent、字幕组、清晰度、文件名和发布时间字段' },
  { page: '搜索结果详情链路', goal: '确认搜索是否返回番组详情，以及是否需要进入详情页展开磁力列表' },
  { page: '周期 / 最近更新页', goal: '确认最近更新和周一到周日分类与详情链接规则' },
];

const contentTypeProfiles = {
  video: {
    htmlRecommendedInputs: ['首页源码', '分类页源码', '详情页源码', '搜索页源码', '播放页或播放器脚本源码'],
    jsonRecommendedInputs: ['首页接口返回', '分类接口返回', '详情接口返回', '搜索接口返回', '播放接口返回'],
    htmlChecklist: ['列表容器选择器', '标题选择器', '图片选择器', '描述/备注选择器', '详情标题选择器', '详情简介选择器', '线路 tabs 选择器', '剧集列表选择器'],
    jsonChecklist: ['列表数组路径', '标题字段路径', '图片字段路径', '描述字段路径', '详情对象路径', '播放线路字段', '播放地址字段'],
    htmlCaptureTargets: [
      { page: '首页', goal: '确认推荐区块结构与卡片字段' },
      { page: '分类页', goal: '确认一级列表结构、分页参数、分类参数' },
      { page: '详情页', goal: '确认详情字段、线路 tabs、剧集列表' },
      { page: '搜索页', goal: '确认搜索参数、验证码情况和结果结构' },
      { page: '播放页', goal: '确认直链、解析链或播放器脚本字段' },
    ],
    jsonCaptureTargets: [
      { page: '首页接口', goal: '确认推荐数组路径与单项字段' },
      { page: '分类接口', goal: '确认列表数组路径、分页参数和分类参数' },
      { page: '详情接口', goal: '确认详情字段和播放字段' },
      { page: '搜索接口', goal: '确认搜索参数、返回结构以及是否返回验证码页' },
      { page: '播放接口', goal: '确认真实播放地址或解析字段' },
    ],
  },
  novel: {
    htmlRecommendedInputs: ['首页源码', '分类页源码', '详情页源码', '搜索页源码', '章节正文页源码或正文接口返回'],
    jsonRecommendedInputs: ['首页接口返回', '分类接口返回', '详情接口返回', '搜索接口返回', '正文接口返回'],
    htmlChecklist: ['列表容器选择器', '标题选择器', '图片选择器', '描述/备注选择器', '章节列表选择器', '章节标题选择器', '章节链接选择器', '正文标题选择器', '正文内容选择器'],
    jsonChecklist: ['列表数组路径', '标题字段路径', '图片字段路径', '描述字段路径', '章节数组路径', '章节标题字段', '章节链接字段', '正文标题路径', '正文内容路径'],
    htmlCaptureTargets: [
      { page: '首页', goal: '确认小说列表结构与推荐卡片字段' },
      { page: '分类页', goal: '确认书目列表结构、分页参数、分类参数' },
      { page: '详情页', goal: '确认书籍详情字段与章节列表结构' },
      { page: '搜索页', goal: '确认搜索参数、验证码情况和书目结果结构' },
      { page: '正文页', goal: '确认章节标题、正文内容与阅读页反爬' },
    ],
    jsonCaptureTargets: [
      { page: '首页接口', goal: '确认书目推荐数组路径与单项字段' },
      { page: '分类接口', goal: '确认书目列表路径、分页参数和分类参数' },
      { page: '详情接口', goal: '确认详情字段与章节数组路径' },
      { page: '搜索接口', goal: '确认搜索参数、返回结构以及是否返回验证码页' },
      { page: '正文接口', goal: '确认正文标题路径、正文内容路径与章节 id 规则' },
    ],
  },
  comic: {
    htmlRecommendedInputs: ['首页源码', '分类页源码', '详情页源码', '搜索页源码', '章节图片页源码或图片接口返回'],
    jsonRecommendedInputs: ['首页接口返回', '分类接口返回', '详情接口返回', '搜索接口返回', '图片接口返回'],
    htmlChecklist: ['列表容器选择器', '标题选择器', '图片选择器', '描述/备注选择器', '章节列表选择器', '章节标题选择器', '章节链接选择器', '图片列表选择器', '图片地址属性'],
    jsonChecklist: ['列表数组路径', '标题字段路径', '图片字段路径', '描述字段路径', '章节数组路径', '章节标题字段', '章节链接字段', '图片数组路径', '图片字段'],
    htmlCaptureTargets: [
      { page: '首页', goal: '确认漫画列表结构与推荐卡片字段' },
      { page: '分类页', goal: '确认漫画列表结构、分页参数、分类参数' },
      { page: '详情页', goal: '确认漫画详情字段与章节列表结构' },
      { page: '搜索页', goal: '确认搜索参数、验证码情况和漫画结果结构' },
      { page: '图片页', goal: '确认章节图片列表、图片 API 与反爬' },
    ],
    jsonCaptureTargets: [
      { page: '首页接口', goal: '确认漫画推荐数组路径与单项字段' },
      { page: '分类接口', goal: '确认漫画列表路径、分页参数和分类参数' },
      { page: '详情接口', goal: '确认详情字段与章节数组路径' },
      { page: '搜索接口', goal: '确认搜索参数、返回结构以及是否返回验证码页' },
      { page: '图片接口', goal: '确认图片数组路径、图片字段与章节 id 规则' },
    ],
  },
};

function normalizeContentTypeKey(contentType) {
  const value = String(contentType || '').trim().toLowerCase();
  if (!value || value === 'auto') return 'auto';
  if (value === 'video' || value === '影视') return 'video';
  if (value === 'novel' || value === '小说') return 'novel';
  if (value === 'comic' || value === '漫画') return 'comic';
  return 'video';
}

function booleanLike(value) {
  return value === true || /^(1|true|yes|y|on|是|启用|动态|发布页)$/i.test(String(value || '').trim());
}

function looksLikePublishHost(host) {
  const value = String(host || '').trim().toLowerCase();
  return /(publish|release|nav|dh|url|host|domain|backup|备用网址|发布页)/i.test(value) ||
    /(^https?:\/\/)?([^/]+\.)?(ho9\.net|bcebos\.com|github\.io|pages\.dev|netlify\.app|vercel\.app)(?:[/:]|$)/i.test(value);
}

function shouldUseDynamicHostMode({
  host = '',
  dynamicHostMode = false,
  dynamicHost = false,
  publishUrls = [],
  fallbackHosts = [],
} = {}) {
  return booleanLike(dynamicHostMode) ||
    booleanLike(dynamicHost) ||
    (Array.isArray(publishUrls) && publishUrls.length > 0) ||
    (Array.isArray(fallbackHosts) && fallbackHosts.length > 1) ||
    looksLikePublishHost(host);
}

function shouldUseBtMagnetMode({
  siteName = '',
  host = '',
  url = '',
  searchUrl = '',
  notes = '',
  sourceFeatures = [],
  btMode = false,
  magnetMode = false,
} = {}) {
  if (booleanLike(btMode) || booleanLike(magnetMode)) return true;
  const text = [
    siteName,
    host,
    url,
    searchUrl,
    notes,
    ...(Array.isArray(sourceFeatures) ? sourceFeatures : []),
  ].join(' ');
  return /(magnet|torrent|\.torrent|bt\b|磁力|种子|蜜柑|mikan|nyaa|bangumi|边下边播)/i.test(text);
}

function getContentTypeProfile(sourceKind, contentType) {
  const key = normalizeContentTypeKey(contentType);
  const profile = contentTypeProfiles[key === 'auto' ? 'video' : key] || contentTypeProfiles.video;
  return {
    ...profile,
    recommendedInputs: sourceKind === 'html' ? profile.htmlRecommendedInputs : profile.jsonRecommendedInputs,
    selectorChecklist: sourceKind === 'html' ? profile.htmlChecklist : profile.jsonChecklist,
    captureTargets: sourceKind === 'html' ? profile.htmlCaptureTargets : profile.jsonCaptureTargets,
  };
}

function guessContentTypeFromComposeInput(input = {}) {
  const analysisGuess = normalizeContentTypeKey(input.analysis?.contentGuess || input.contentGuess || 'auto');
  if (analysisGuess !== 'auto') {
    return analysisGuess;
  }
  const text = JSON.stringify({
    siteName: input.siteName,
    host: input.host,
    className: input.className,
    url: input.url,
    searchUrl: input.searchUrl,
    selectors: input.selectors,
    mappings: input.mappings,
  });
  const hasComicSignals = /(漫画|comic|manga|图片|imageList|imageAttr|imageItemField|pics:\/\/)/i.test(text);
  const hasNovelSignals = /(小说|书籍|阅读|正文|readerContent|readerTitle|novel|reader|book)/i.test(text);
  if (hasComicSignals) {
    return 'comic';
  }
  if (hasNovelSignals) {
    return 'novel';
  }
  return 'video';
}

function resolveComposeContentType(input = {}) {
  const explicit = normalizeContentTypeKey(input.contentType || 'auto');
  if (explicit !== 'auto') {
    return explicit;
  }
  return guessContentTypeFromComposeInput(input);
}

function normalizeStructuredComposeInput(input, sourceKind, contentTypeKey) {
  const host = String(input.host || '').trim();
  const url = String(input.url || '').trim();
  if (!host) throw new Error(`${sourceKind} 生成需要真实 host`);
  if (!url) throw new Error(`${sourceKind} 生成需要真实分类 url，禁止使用占位路径`);

  const classes = normalizeStaticClassConfig(input, sourceKind);
  const search = normalizeSearchCapability(input, input.searchUrl || '', sourceKind);
  if (sourceKind === 'html') {
    const common = ['categoryList', 'categoryTitle', 'categoryLink'];
    const detail = contentTypeKey === 'video'
      ? ['detailTitle', 'detailTabs', 'detailList', 'detailEpisodeTitle', 'detailEpisodeLink']
      : ['chapterList', 'chapterTitle', 'chapterLink'];
    const reader = contentTypeKey === 'novel'
      ? ['readerContent']
      : (contentTypeKey === 'comic' ? ['imageList', 'imageAttr'] : []);
    const searchFields = search.searchable > 0 ? ['searchList', 'searchTitle', 'searchLink'] : [];
    requireEvidenceFields(input.selectors, [...common, ...detail, ...reader, ...searchFields], 'HTML selectors');
  } else {
    const homeUrl = String(input.homeUrl || '').trim();
    if (!homeUrl || /fyclass|fypage|\*\*/i.test(homeUrl)) {
      throw new Error('JSON 生成需要不含 fyclass/fypage/** 的真实 homeUrl，推荐接口不能依赖分类上下文');
    }
    const common = ['categoryListPath', 'titleField', 'linkField', 'detailPath', 'detailTitleField'];
    const detail = contentTypeKey === 'video'
      ? ['detailPlayFromField', 'detailPlayUrlField']
      : ['chapterListPath', 'chapterTitleField', 'chapterUrlField'];
    const reader = contentTypeKey === 'novel'
      ? ['readerContentPath']
      : (contentTypeKey === 'comic' ? ['imageListPath'] : []);
    const searchFields = search.searchable > 0 ? ['searchListPath'] : [];
    requireEvidenceFields(input.mappings, [...common, ...detail, ...reader, ...searchFields], 'JSON mappings');
    if (!String(input.detailUrl || '').trim() && input.detailIdsAreUrls !== true) {
      throw new Error(`JSON ${getContentTypeLabel(contentTypeKey)}生成需要 detailUrl；仅当列表字段已返回真实详情 URL 时才能显式设置 detailIdsAreUrls:true`);
    }
  }

  return {
    ...input,
    host,
    url,
    searchUrl: search.searchUrl,
    searchable: search.searchable,
    className: classes.className,
    classUrl: classes.classUrl,
  };
}

function normalizeStaticClassConfig(input, context = '规则') {
  let names = [];
  let ids = [];
  if (Array.isArray(input.classes) && input.classes.length > 0) {
    for (const item of input.classes) {
      const name = String(item?.name ?? item?.title ?? '').trim();
      const id = String(item?.id ?? item?.url ?? item?.value ?? '').trim();
      names.push(name);
      ids.push(id);
    }
  } else {
    names = String(input.className ?? input.class_name ?? '').split('&').map((item) => item.trim());
    ids = String(input.classUrl ?? input.class_url ?? '').split('&').map((item) => item.trim());
  }
  if (!names.length || !ids.length || names.some((item) => !item) || ids.some((item) => !item)) {
    throw new Error(`${context} 生成需要真实 classes 或 className/classUrl，禁止生成只有推荐没有分类入口的源`);
  }
  if (names.length !== ids.length) {
    throw new Error(`${context} 的 className/classUrl 分段数不一致：${names.length} != ${ids.length}`);
  }
  return { className: names.join('&'), classUrl: ids.join('&') };
}

function normalizeSearchCapability(input, searchUrlValue, context = '规则') {
  const searchUrl = String(searchUrlValue || '').trim();
  const searchable = Object.prototype.hasOwnProperty.call(input, 'searchable')
    ? numberOrDefault(input.searchable, 0)
    : (searchUrl ? 1 : 0);
  if (searchable > 0 && !searchUrl) {
    throw new Error(`${context} 声明 searchable>0，但没有真实 searchUrl/stages.search.url`);
  }
  return { searchUrl, searchable };
}

function requireEvidenceFields(value, fields, label) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const missing = [...new Set(fields)].filter((field) => !String(source[field] ?? '').trim());
  if (missing.length > 0) {
    throw new Error(`${label} 缺少已验证字段：${missing.join(', ')}`);
  }
}

export function listReferenceExamples(knowledgeBase) {
  return knowledgeBase.listResources().filter((item) => item.uri.startsWith('aibox://examples/'));
}

export function buildRuleBlueprint({
  siteName = '',
  sourceKind = 'html',
  contentType = 'video',
  templateHint = 'custom',
  host = '',
  url = '',
  searchUrl = '',
  notes = '',
  sourceFeatures = [],
  btMode = false,
  magnetMode = false,
  dynamicHostMode = false,
  dynamicHost = false,
  publishUrls = [],
  fallbackHosts = [],
}) {
  const resolvedContentType = normalizeContentTypeKey(contentType);
  const profile = getContentTypeProfile(sourceKind, resolvedContentType);
  const effectiveContentType = resolvedContentType === 'auto' ? 'video' : resolvedContentType;
  const typeLabel = getContentTypeLabel(effectiveContentType);
  const hasDynamicHost = shouldUseDynamicHostMode({
    host,
    dynamicHostMode,
    dynamicHost,
    publishUrls,
    fallbackHosts,
  });
  const hasBt = shouldUseBtMagnetMode({
    siteName,
    host,
    url,
    searchUrl,
    notes,
    sourceFeatures,
    btMode,
    magnetMode,
  });
  const requiredFields = ['类型', 'title', 'host'];
  if (templateHint === 'custom' || sourceKind !== 'app') {
    requiredFields.push('url', 'searchUrl', 'headers', 'searchable', 'quickSearch', 'filterable');
  }

  const pageHandlers = sourceKind === 'app'
    ? ['模板']
    : ['推荐', '一级', '二级', '搜索', 'lazy'];
  if (hasDynamicHost && sourceKind !== 'app') {
    pageHandlers.unshift('动态域名发现/候选域切换');
  }
  if (hasBt && sourceKind !== 'app') {
    pageHandlers.push('磁力/torrent 链接提取与 lazy 直返');
  }

  return {
    sourceKind,
    contentType: effectiveContentType,
    typeLabel,
    templateHint,
    dynamicHostMode: hasDynamicHost,
    btMode: hasBt,
    requiredFields,
    pageHandlers,
    recommendedInputs: [
      ...(hasDynamicHost ? dynamicHostRecommendedInputs : []),
      ...profile.recommendedInputs,
      ...(hasBt ? btRecommendedInputs : []),
    ],
    selectorChecklist: [
      ...(hasDynamicHost ? dynamicHostChecklist : []),
      ...profile.selectorChecklist,
      ...(hasBt ? btChecklist : []),
    ],
  };
}

export function planSourceWorkflow({
  siteName = '未命名站点',
  host = '',
  sourceKind = 'html',
  contentType = 'video',
  url = '',
  searchUrl = '',
  notes = '',
  sourceFeatures = [],
  btMode = false,
  magnetMode = false,
  dynamicHostMode = false,
  dynamicHost = false,
  publishUrls = [],
  fallbackHosts = [],
}) {
  const resolvedContentType = normalizeContentTypeKey(contentType);
  const effectiveContentType = resolvedContentType === 'auto' ? 'video' : resolvedContentType;
  const hasDynamicHost = shouldUseDynamicHostMode({
    host,
    dynamicHostMode,
    dynamicHost,
    publishUrls,
    fallbackHosts,
  });
  const hasBt = shouldUseBtMagnetMode({
    siteName,
    host,
    url,
    searchUrl,
    notes,
    sourceFeatures,
    btMode,
    magnetMode,
  });
  const blueprint = buildRuleBlueprint({
    siteName,
    sourceKind,
    contentType: effectiveContentType,
    host,
    url,
    searchUrl,
    notes,
    sourceFeatures,
    btMode: hasBt,
    dynamicHostMode: hasDynamicHost,
    publishUrls,
    fallbackHosts,
  });
  const profile = getContentTypeProfile(sourceKind, effectiveContentType);
  const dynamicCaptureTargets = hasDynamicHost
    ? [
        { page: '发布页/备用网址页', goal: '确认是否能提取真实业务域、备用网址和跳转脚本' },
        { page: '发布页外链脚本', goal: '确认 document.write/location.href/混淆脚本是否写出候选域' },
        { page: '候选业务域健康检查', goal: '用首页/分类/搜索/详情 validator 判断候选域是否可用' },
      ]
    : [];

  const nextActions = [
    ...(hasDynamicHost
      ? [
          '先阅读 dynamic-host-playbook，并抓发布页 HTML、发布页脚本和候选业务域首页。',
          '为候选业务域设计健康检查 validator，成功后缓存当前业务域，失败时刷新并切换下一个候选。',
        ]
      : []),
    '先抓首页、分类、详情、搜索以及对应的播放页/正文页/图片页源码或接口返回。',
    ...(hasBt
      ? [
          '磁力站要额外抓详情页资源列表，确认 magnet / .torrent 字段、标题、字幕组、清晰度和 tracker 是否完整。',
          'BT 源 lazy 必须对 magnet / .torrent 返回 { parse: 0, url }，不要在源里调用 /bt/resolve。',
        ]
      : []),
    '对 HTML/JSON 运行 analyze-content，整理选择器、字段路径和搜索参数。',
    ...(hasDynamicHost
      ? ['动态域名站要先确定业务域，再进入验证码或页面解析链路。']
      : []),
    '如果发现验证码或安全验证，优先接入 getHtml + verifyCode + setItem(RULE_CK) 链路。',
    '对不确定的 DOM 片段运行 debug-rule。',
    '最后再运行 compose-rule、validate-rule 和 check-syntax。',
  ];

  return {
    siteName,
    host,
    sourceKind,
    contentType: effectiveContentType,
    dynamicHostMode: hasDynamicHost,
    btMode: hasBt,
    publishUrls,
    fallbackHosts,
    blueprint,
    captureTargets: [...dynamicCaptureTargets, ...profile.captureTargets, ...(hasBt ? btCaptureTargets : [])],
    knowledgeHints: [
      'aibox://template/ds-template',
      'aibox://knowledge/drpy-rule-playbook',
      'aibox://knowledge/source-writing-workflow',
      ...(hasDynamicHost ? ['aibox://knowledge/dynamic-host-playbook'] : []),
      ...(hasBt ? ['aibox://knowledge/magnet-bt-source-playbook'] : []),
      'aibox://knowledge/source-quality-checklist',
    ],
    nextActions,
    summary: `写源流程已规划：站点=${siteName}，内容类型=${effectiveContentType}${hasDynamicHost ? '，已启用动态域名流程' : ''}${hasBt ? '，已启用磁力 / BT 流程' : ''}，建议先抓 ${[...dynamicCaptureTargets, ...profile.captureTargets, ...(hasBt ? btCaptureTargets : [])].map((item) => item.page).join('、')}`,
  };
}
export function analyzePageContent({
  content,
  url = '',
  contentTypeHint = '',
}) {
  if (typeof content !== 'string') {
    return {
      mode: 'unknown',
      summary: '未提供可分析内容',
    };
  }

  const trimmed = content.trim();
  const hasJsonHint = String(contentTypeHint || '').toLowerCase().includes('json');
  if (!trimmed) {
    return hasJsonHint
      ? analyzeJsonFragment('', new Error('JSON 响应为空'))
      : { mode: 'unknown', summary: '未提供可分析内容' };
  }
  const shouldTryJson =
    hasJsonHint || trimmed.startsWith('{') || trimmed.startsWith('[');

  if (shouldTryJson) {
    try {
      const payload = JSON.parse(trimmed);
      return analyzeJsonContent(payload);
    } catch (error) {
      return analyzeJsonFragment(trimmed, error);
    }
  }

  return analyzeHtmlContent(content, url);
}

export async function debugDrpyRule({
  html,
  url,
  rule,
  mode,
  baseUrl,
  options = {},
  maxItems = 30,
}) {
  if (!rule || !mode) {
    throw new Error('缺少 rule 或 mode');
  }

  let content = html;
  let finalBaseUrl = baseUrl || url || '';
  let responseMeta = null;

  if (!content && url) {
    const fetched = await fetchDebugSource(url, options);
    content = fetched.body;
    finalBaseUrl = baseUrl || fetched.finalUrl || url;
    responseMeta = fetched.meta;
  }

  if (!content) {
    throw new Error('请提供 html 或 url');
  }

  if (!['pdfa', 'pdfh', 'pd'].includes(mode)) {
    throw new Error(`不支持的 mode: ${mode}`);
  }

  let result;
  if (mode === 'pdfa') {
    result = drpyPdfa(content, rule, maxItems);
  } else if (mode === 'pdfh') {
    result = drpyPdfh(content, rule);
  } else {
    result = drpyPd(content, rule, finalBaseUrl);
  }

  return {
    mode,
    rule,
    baseUrl: finalBaseUrl,
    responseMeta,
    count: Array.isArray(result) ? result.length : (result ? 1 : 0),
    result,
  };
}

export function composeDrpyRule(input) {
  const sourceKind = input.sourceKind || 'html';
  const implementationMode = input.implementationMode || 'auto';
  const resolvedInput = {
    ...input,
    contentType: resolveComposeContentType(input),
    implementationMode,
  };
  if (implementationMode === 'template') {
    return composeTemplateRule(resolvedInput);
  }
  if (sourceKind === 'json') {
    return composeJsonRule(resolvedInput);
  }
  if (sourceKind === 'app') {
    throw new Error('`sourceKind: app` 已废弃；模板站请使用 implementationMode=template，纯接口站请使用 sourceKind=app-api');
  }
  if (sourceKind === 'app-api') {
    return composeAppApiRule(resolvedInput);
  }
  return composeHtmlRule(resolvedInput);
}

export function checkDrpyRuleSyntax(code) {
  const analysis = analyzeRuleSource(code);
  const syntaxError = analysis.diagnostics.find((item) => item.code === 'JS_SYNTAX_ERROR');
  return {
    passed: !syntaxError,
    errorMessage: syntaxError?.message || null,
    location: syntaxError?.loc || null,
  };
}

export function validateDrpyRule(code, options = {}) {
  const knownTemplates = options.knownTemplates
    ? new Set(options.knownTemplates)
    : new Set([...listEngineTemplateNames({ engineRoot: options.engineRoot }), '自动']);
  knownTemplates.add('自动');
  const analysis = analyzeRuleSource(code, { knownTemplates });
  const diagnostics = [...analysis.diagnostics];
  const staticFields = analysis.rule?.staticFields || {};
  const hasTemplate = typeof staticFields['模板'] === 'string' && staticFields['模板'].trim();
  const hasClassParse = Boolean(analysis.rule?.handlers?.class_parse?.present || analysis.rule?.properties?.some((item) => item.key === 'class_parse'));
  for (const field of ['类型', 'title', 'version', 'host']) {
    if (staticFields[field] === undefined || staticFields[field] === null || String(staticFields[field]).trim() === '') {
      diagnostics.push(createValidationDiagnostic('RULE_REQUIRED_FIELD_MISSING', 'error', `rule 对象缺少必填字段 "${field}"`, field));
    }
  }
  if (!hasTemplate && !hasClassParse && !String(staticFields.url || '').trim()) {
    diagnostics.push(createValidationDiagnostic('RULE_REQUIRED_FIELD_MISSING', 'error', '非模板规则缺少 `url`', 'url'));
  }
  const className = staticFields.class_name;
  const classUrl = staticFields.class_url;
  const hasStaticClassField = className !== undefined || classUrl !== undefined;
  if (hasStaticClassField) {
    const classNames = String(className ?? '').split('&').map((item) => item.trim());
    const classUrls = String(classUrl ?? '').split('&').map((item) => item.trim());
    if (classNames.some((item) => !item) || classUrls.some((item) => !item) || classNames.length !== classUrls.length) {
      diagnostics.push(createValidationDiagnostic(
        'RULE_CLASS_CONFIG_MISMATCH',
        'error',
        '`class_name` 与 `class_url` 必须同时存在、每项非空且 `&` 分段数一致',
        'class_name',
      ));
    }
  } else if (!hasTemplate && !hasClassParse) {
    diagnostics.push(createValidationDiagnostic(
      'RULE_CLASS_SOURCE_MISSING',
      'error',
      '非模板规则必须提供 `class_name/class_url` 或 `class_parse`，否则应用只有推荐没有分类入口',
      'class_name',
    ));
  }
  if (!hasTemplate && !hasClassParse && Number(staticFields.filterable || 0) > 0) {
    const filter = staticFields.filter;
    if (!filter || typeof filter !== 'object' || Array.isArray(filter) || Object.keys(filter).length === 0) {
      diagnostics.push(createValidationDiagnostic(
        'RULE_FILTER_CONFIG_MISSING',
        'error',
        '`filterable>0` 必须提供非空 `filter` 选项；空 `filter_def` 或只有 `filter_url` 不能形成筛选入口',
        'filter',
      ));
    }
  }
  if (staticFields.version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(staticFields.version))) {
    diagnostics.push(createValidationDiagnostic('RULE_VERSION_INVALID', 'error', '`version` 必须使用语义化版本，例如 1.0.0', 'version'));
  }
  const ruleSummary = buildAstRuleSummary(analysis);
  if (analysis.rule && !hasTemplate && !hasClassParse && !ruleSummary.hasPrimaryHandlers) {
    diagnostics.push(createValidationDiagnostic('RULE_PRIMARY_HANDLERS_MISSING', 'warning', '未检测到推荐、一级、二级、搜索或 lazy 处理逻辑'));
  }
  if (!hasTemplate && !ruleSummary.hasCategoryHandler) {
    diagnostics.push(createValidationDiagnostic('RULE_CATEGORY_HANDLER_MISSING', 'error', '非模板规则缺少 `一级`，分类入口无法返回内容', '一级'));
  }
  if (!hasTemplate && !ruleSummary.hasDetailHandler) {
    diagnostics.push(createValidationDiagnostic('RULE_DETAIL_HANDLER_MISSING', 'error', '非模板规则缺少 `二级`，详情与目录无法建立', '二级'));
  }
  const normalizedType = normalizeContentTypeKey(ruleSummary.type);
  if (!hasTemplate && ['novel', 'comic'].includes(normalizedType) && !ruleSummary.hasLazyHandler) {
    diagnostics.push(createValidationDiagnostic('RULE_READER_HANDLER_MISSING', 'error', `${getContentTypeLabel(normalizedType)}规则缺少 lazy，正文或图片内容无法返回`, 'lazy'));
  }
  if (Number(ruleSummary.searchable || 0) > 0 && !hasTemplate && !ruleSummary.hasSearchHandler) {
    diagnostics.push(createValidationDiagnostic('RULE_SEARCH_HANDLER_MISSING', 'error', 'searchable>0，但未检测到 `搜索` 处理逻辑', '搜索'));
  }
  const deduped = dedupeDiagnostics(diagnostics);
  const errors = deduped.filter((item) => item.severity === 'error');
  const warnings = deduped.filter((item) => item.severity === 'warning');
  const passed = errors.length === 0;
  const score = passed ? 100 : Math.max(0, 100 - errors.length * 20);
  const styleScore = Math.max(0, 100 - warnings.length * 5);
  const syntax = checkDrpyRuleSyntax(code);
  const runtime = {
    passed,
    skipped: true,
    engine: 'static-ast',
    hasRule: Boolean(analysis.rule),
    errorMessage: errors[0]?.message || null,
    ruleSummary,
    requiredFields: hasTemplate ? ['类型', 'title', 'version', 'host', '模板'] : ['类型', 'title', 'version', 'host', 'url'],
    missingRequiredFields: errors.filter((item) => item.code === 'RULE_REQUIRED_FIELD_MISSING').map((item) => item.field).filter(Boolean),
  };
  return {
    passed,
    score,
    styleScore,
    evidenceLevel: 'L1',
    issues: errors.map((item) => item.message),
    warnings: warnings.map((item) => item.message),
    diagnostics: deduped,
    syntax,
    runtime,
    ruleSummary,
    style: buildStyleSummary(code, analysis),
    analysis,
    summary: passed
      ? `规则通过 L1 静态校验：AST、header、模板与播放契约均无硬错误，功能评分 ${score}`
      : `规则 L1 校验失败：存在 ${errors.length} 个必须修复项，功能评分 ${score}`,
  };
}

function createValidationDiagnostic(code, severity, message, field = null) {
  return { code, severity, message, field, path: field ? `rule.${field}` : null, loc: null, range: null, suggestion: null, details: {} };
}

function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  return diagnostics.filter((item) => {
    const key = `${item.code}|${item.field || ''}|${item.loc?.line || 0}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildAstRuleSummary(analysis) {
  const fields = analysis.rule?.staticFields || {};
  const handlers = analysis.rule?.handlers || {};
  const hasTemplate = typeof fields['模板'] === 'string' && fields['模板'].trim().length > 0;
  const handler = (name) => Boolean(handlers[name]?.present || hasTemplate);
  const keys = (analysis.rule?.properties || []).map((item) => item.key).filter(Boolean);
  return {
    keys: [...new Set(keys)].sort(),
    title: fields.title ?? null,
    version: fields.version ?? null,
    host: fields.host ?? null,
    url: fields.url ?? null,
    searchUrl: fields.searchUrl ?? null,
    type: fields['类型'] ?? null,
    template: fields['模板'] ?? null,
    hasTemplate,
    templateKnown: analysis.template?.known ?? null,
    hasClassParse: keys.includes('class_parse') || hasTemplate,
    hasPreprocess: keys.includes('预处理'),
    hasRecommendHandler: handler('推荐'),
    hasCategoryHandler: handler('一级'),
    hasDetailHandler: handler('二级'),
    hasSearchHandler: handler('搜索'),
    hasLazyHandler: handler('lazy'),
    hasPrimaryHandlers: ['推荐', '一级', '二级', '搜索', 'lazy'].some(handler),
    searchable: fields.searchable ?? null,
    filterable: fields.filterable ?? null,
    filterUrl: fields.filter_url ?? null,
    hasFilter: keys.includes('filter'),
    hasFilterDef: keys.includes('filter_def'),
    quickSearch: fields.quickSearch ?? null,
    playParse: fields.play_parse ?? null,
    hasExplicitPlayJson: keys.includes('play_json'),
    playJson: fields.play_json ?? null,
    playJsonIsEmptyArray: Array.isArray(fields.play_json) && fields.play_json.length === 0,
    implementationMode: analysis.rule?.implementationMode || null,
  };
}

function buildStyleSummary(code, analysis) {
  const text = String(code || '');
  const functions = analysis.rule?.functions || [];
  const helpers = functions.filter((item) => String(item.key || '').startsWith('_'));
  return {
    lines: text ? text.split(/\r?\n/).length : 0,
    bytes: Buffer.byteLength(text, 'utf8'),
    functions: functions.length,
    helpers: helpers.length,
    implementationMode: analysis.rule?.implementationMode || null,
    explicitOverrides: analysis.rule?.properties?.length || 0,
  };
}

export function saveRuleToFile({
  outputDir,
  filePath,
  code,
  overwrite = false,
  validationOptions = {},
}) {
  const syntax = checkDrpyRuleSyntax(code);
  const validation = validateDrpyRule(code, validationOptions);
  if (!syntax.passed || !validation.passed) {
    const error = new Error('规则未通过语法与结构校验，拒绝保存');
    error.validation = validation;
    throw error;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && !overwrite) {
    throw new Error(`文件已存在: ${filePath}`);
  }
  const expected = String(code || '');
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest('hex');
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = fs.openSync(tempPath, 'wx');
    try {
      fs.writeFileSync(handle, expected, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    const written = fs.readFileSync(tempPath, 'utf8');
    const actualHash = createHash('sha256').update(written, 'utf8').digest('hex');
    if (Buffer.byteLength(written, 'utf8') !== Buffer.byteLength(expected, 'utf8') || actualHash !== expectedHash) {
      throw new Error(`临时文件回读不一致: expected=${expectedHash} actual=${actualHash}`);
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return {
    filePath,
    size: Buffer.byteLength(expected, 'utf8'),
    sha256: expectedHash,
    validation: { passed: validation.passed, score: validation.score },
    outputDir,
  };
}

function composeHtmlRule(input) {
  const contentTypeKey = resolveComposeContentType(input);
  input = normalizeStructuredComposeInput(input, 'html', contentTypeKey);
  if (contentTypeKey === 'novel') {
    return buildNovelHtmlRule({ ...input, contentType: 'novel' });
  }
  if (contentTypeKey === 'comic') {
    return buildComicHtmlRule({ ...input, contentType: 'comic' });
  }
  const siteName = input.siteName || '未命名站点';
  const host = input.host || '';
  const contentType = getContentTypeLabel(contentTypeKey || 'video');
  const version = input.version || '1.0.0';
  const selectors = {
    ...defaultHtmlSelectors,
    ...(input.selectors || {}),
  };

  const searchable = numberOrDefault(input.searchable, 1);
  const quickSearch = numberOrDefault(input.quickSearch, 0);
  const playParse = input.playParse ?? true;
  const headers = input.headers || { 'User-Agent': 'MOBILE_UA' };
  const url = input.url || '/vodshow/fyclass--------fypage---/';
  const searchUrl = input.searchUrl;
  const className = input.className || '电影&电视剧&综艺&动漫';
  const classUrl = input.classUrl || '1&2&3&4';
  const filterConfig = resolveRuleFilterConfig(input, { url, classUrl });
  const filterable = Object.prototype.hasOwnProperty.call(input, 'filterable')
    ? numberOrDefault(input.filterable, filterConfig.filterable)
    : filterConfig.filterable;
  const lazyMode = input.lazyMode || 'direct';
  const mediaPattern = input.mediaPattern || 'm3u8|mp4|flv';
  const scriptPattern = input.scriptPattern || '';
  const includeCaptchaTag = Boolean(input.captchaTag || input.captchaMode === 'search-only' || input.captchaMode === 'full');
  const captchaTag = input.captchaTag || defaultCaptchaTag;
  const recommendRule = selectors.recommendList === selectors.categoryList
    && selectors.recommendTitle === selectors.categoryTitle
    && selectors.recommendImage === selectors.categoryImage
    && selectors.recommendDesc === selectors.categoryDesc
    && selectors.recommendLink === selectors.categoryLink
    ? '*'
    : buildListRuleString(
        selectors.recommendList,
        selectors.recommendTitle,
        selectors.recommendImage,
        selectors.recommendDesc,
        selectors.recommendLink,
      );
  const categoryRule = buildListRuleString(
    selectors.categoryList,
    selectors.categoryTitle,
    selectors.categoryImage,
    selectors.categoryDesc,
    selectors.categoryLink,
  );
  const searchRule = buildListRuleString(
    selectors.searchList,
    selectors.searchTitle,
    selectors.searchImage,
    selectors.searchDesc,
    selectors.searchLink,
  );
  const detailRule = buildCompactHtmlDetailRule(selectors);
  const lazyRule = buildCompactLazyRule({ lazyMode, mediaPattern, scriptPattern });
  const filterBlock = renderRuleFilterBlock({ ...filterConfig, filterable }, '  ');

  return `/*
@header({
  类型: ${q(contentType)},
  searchable: ${searchable},
  filterable: ${filterable},
  quickSearch: ${quickSearch},
  title: ${q(siteName)},
  lang: 'ds'
})
*/

var rule = {
  类型: ${q(contentType)},
  title: ${q(siteName)},
  version: ${q(version)},
  host: ${q(host)},
  homeUrl: ${q(input.homeUrl || '')},
  url: ${q(url)},
  searchUrl: ${q(searchUrl)},
  headers: ${jsonToJs(headers)},
  searchable: ${searchable},
  quickSearch: ${quickSearch},
  filterable: ${filterable},
  play_parse: ${String(playParse)},
  play_json: [],
  class_name: ${q(className)},
  class_url: ${q(classUrl)},
${filterBlock}${includeCaptchaTag ? `  搜索验证标识: ${q(captchaTag)},\n` : ''}  推荐: ${q(recommendRule)},
  一级: ${q(categoryRule)},
  二级: ${detailRule},
  搜索: ${q(searchRule)},
  lazy: ${lazyRule}
};
`;
}

function composeJsonRule(input) {
  const contentTypeKey = resolveComposeContentType(input);
  input = normalizeStructuredComposeInput(input, 'json', contentTypeKey);
  if (contentTypeKey === 'novel') {
    return buildNovelJsonRule({ ...input, contentType: 'novel' });
  }
  if (contentTypeKey === 'comic') {
    return buildComicJsonRule({ ...input, contentType: 'comic' });
  }
  const siteName = input.siteName || '未命名站点';
  const host = input.host || '';
  const contentType = getContentTypeLabel(contentTypeKey || 'video');
  const version = input.version || '1.0.0';
  const mappings = {
    ...defaultJsonMappings,
    ...(input.mappings || {}),
  };
  const headers = input.headers || { 'User-Agent': 'MOBILE_UA' };
  const searchable = numberOrDefault(input.searchable, 1);
  const quickSearch = numberOrDefault(input.quickSearch, 0);
  const url = input.url || '/api.php/provide/vod/?ac=detail&t=fyclass&pg=fypage';
  const searchUrl = input.searchUrl;
  const className = input.className || input.class_name || '全部';
  const classUrl = input.classUrl || input.class_url || '1&2&3&4';
  const filterConfig = resolveRuleFilterConfig(input, { url, classUrl });
  const filterable = Object.prototype.hasOwnProperty.call(input, 'filterable')
    ? numberOrDefault(input.filterable, filterConfig.filterable)
    : filterConfig.filterable;
  const includeCaptchaTag = Boolean(input.captchaTag || input.captchaMode === 'search-only' || input.captchaMode === 'full');
  const captchaTag = input.captchaTag || defaultCaptchaTag;
  const lazyMode = input.lazyMode || 'direct';
  const mediaPattern = input.mediaPattern || 'm3u8|mp4|flv';
  const scriptPattern = input.scriptPattern || '';
  const recommendRule = buildJsonListRule(
    mappings.recommendListPath,
    mappings.titleField,
    mappings.imageField,
    mappings.descField,
    mappings.linkField,
  );
  const categoryRule = buildJsonListRule(
    mappings.categoryListPath,
    mappings.titleField,
    mappings.imageField,
    mappings.descField,
    mappings.linkField,
  );
  const searchRule = buildJsonListRule(
    mappings.searchListPath,
    mappings.titleField,
    mappings.imageField,
    mappings.descField,
    mappings.linkField,
  );
  const detailFunction = buildCompactJsonDetailRule(mappings);
  const lazyRule = buildCompactLazyRule({ lazyMode, mediaPattern, scriptPattern });
  const filterBlock = renderRuleFilterBlock({ ...filterConfig, filterable }, '  ');

  return `/*
@header({
  类型: ${q(contentType)},
  searchable: ${searchable},
  filterable: ${filterable},
  quickSearch: ${quickSearch},
  title: ${q(siteName)},
  lang: 'ds'
})
*/

var rule = {
  类型: ${q(contentType)},
  title: ${q(siteName)},
  version: ${q(version)},
  host: ${q(host)},
  homeUrl: ${q(input.homeUrl || '')},
  url: ${q(url)},
  searchUrl: ${q(searchUrl)},
  detailUrl: ${q(input.detailUrl)},
  headers: ${jsonToJs(headers)},
  searchable: ${searchable},
  quickSearch: ${quickSearch},
  filterable: ${filterable},
  class_name: ${q(className)},
  class_url: ${q(classUrl)},
${filterBlock}  play_parse: true,
  play_json: [],
  _pick: function (obj, path, fallback) {
    if (!path) return fallback;
    const value = path.split('.').reduce((acc, key) => {
      if (acc && typeof acc === 'object' && key in acc) {
        return acc[key];
      }
      return undefined;
    }, obj);
    return value === undefined ? fallback : value;
  },
  _abs: function (baseUrl, value) {
    const text = String(value || '').trim();
    if (!text || /^data:/i.test(text)) return text;
    return text.startsWith('http://') || text.startsWith('https://') ? text : urljoin(baseUrl || rule.host, text);
  },
${includeCaptchaTag ? `  搜索验证标识: ${q(captchaTag)},\n` : ''}  推荐: ${q(recommendRule)},
  一级: ${q(categoryRule)},
  二级: ${detailFunction},
  搜索: ${q(searchRule)},
  lazy: ${lazyRule}
};
`;
}
function composeTemplateRule(input) {
  const siteName = input.siteName || '未命名站点';
  const host = input.host || '';
  const contentType = getContentTypeLabel(input.contentType || 'video');
  const version = input.version || '1.0.0';
  const templateHint = input.templateName || input.templateHint || '';
  if (!templateHint) {
    throw new Error('模板模式必须提供 templateName；不会再默认生成不存在的 appapi');
  }
  const templateNames = listEngineTemplateNames({ engineRoot: input.engineRoot });
  const isAutoTemplate = templateHint === '自动';
  if (!isAutoTemplate && !templateNames.includes(templateHint)) {
    throw new Error(`未知 Aibox 模板: ${templateHint}；可用模板: ${templateNames.join(', ') || '未找到真实引擎'}`);
  }
  const templateMetadata = isAutoTemplate ? {} : (getEngineTemplateMetadata(templateHint, { engineRoot: input.engineRoot }) || {});
  const headerSearchable = numberOrDefault(input.searchable, templateMetadata.searchable ?? 0);
  const headerFilterable = numberOrDefault(input.filterable, templateMetadata.filterable ?? 0);
  const headerQuickSearch = numberOrDefault(input.quickSearch, templateMetadata.quickSearch ?? 0);
  const overrides = [];
  if (Object.prototype.hasOwnProperty.call(input, 'searchable')) overrides.push(`  searchable: ${numberOrDefault(input.searchable, 1)},`);
  if (Object.prototype.hasOwnProperty.call(input, 'filterable')) overrides.push(`  filterable: ${numberOrDefault(input.filterable, 0)},`);
  if (Object.prototype.hasOwnProperty.call(input, 'quickSearch')) overrides.push(`  quickSearch: ${numberOrDefault(input.quickSearch, 0)},`);
  if (input.headers) overrides.push(`  headers: ${jsonToJs(input.headers)},`);
  if (input.url) overrides.push(`  url: ${q(input.url)},`);
  if (input.searchUrl) overrides.push(`  searchUrl: ${q(input.searchUrl)},`);
  if (Object.prototype.hasOwnProperty.call(input, 'double')) overrides.push(`  double: ${Boolean(input.double)},`);

  return `/*
@header({
  类型: ${q(contentType)},
  title: ${q(siteName)},
  lang: 'ds',
  searchable: ${headerSearchable},
  filterable: ${headerFilterable},
  quickSearch: ${headerQuickSearch}
})
*/

var rule = {
  类型: ${q(contentType)},
  title: ${q(siteName)},
  version: ${q(version)},
  host: ${q(host)},
  模板: ${q(templateHint)},
${overrides.length ? `${overrides.join('\n')}\n` : ''}
};
`;
}

function composeAppApiRule(input) {
  if (input.dynamicHostMode || input.captchaMode === 'full' || input.signatureHook || input.requestHook) {
    throw new Error('app-api 声明式生成器不会伪造动态域、验证码或签名逻辑；请提供已验证的阶段级请求代码并使用 partial-async/full-async 特化');
  }
  const siteName = input.siteName || '未命名接口站';
  const contentTypeKey = resolveComposeContentType(input);
  const contentType = getContentTypeLabel(contentTypeKey);
  const version = input.version || '1.0.0';
  const host = String(input.host || '').trim();
  if (!host) throw new Error('app-api 生成需要真实 host');
  const headers = input.headers || { 'User-Agent': 'MOBILE_UA' };
  const stages = normalizeAppApiStages(input.stages || {}, input);
  validateAppApiResponseTypes(stages, contentTypeKey);
  const classes = normalizeStaticClassConfig(input, 'app-api');
  const search = normalizeSearchCapability(input, stages.search.url || input.searchUrl || '', 'app-api');
  const searchable = search.searchable;
  const quickSearch = numberOrDefault(input.quickSearch, 0);
  const filterConfig = resolveRuleFilterConfig({ ...input, classUrl: classes.classUrl }, { url: stages.category.url, classUrl: classes.classUrl });
  const filterable = filterConfig.filterable;
  const filterBlock = renderRuleFilterBlock(filterConfig, '  ');
  if (!stages.home.url && !input.homeUrl) {
    throw new Error('app-api 生成需要 stages.home.url 或 homeUrl；否则推荐阶段必为空，默认 L3 无法通过');
  }
  if (/fyclass|fypage|\*\*/i.test(String(stages.home.url || input.homeUrl || ''))) {
    throw new Error('app-api home URL 必须是可直接请求的真实推荐接口，不能包含 fyclass/fypage/**');
  }
  if (!stages.category.url && !input.url) {
    throw new Error('app-api 生成需要 stages.category.url 或 url');
  }
  if (!stages.detail.url && !input.detailUrl) {
    throw new Error('app-api 生成需要 stages.detail.url 或 detailUrl');
  }
  const listFunction = `async function (stageName, target, vars) {
    const stage = rule._stages[stageName], json = await rule._fetch(stage, target, vars);
    const items = rule._pick(json, stage.listPath, []), fields = stage.fields || {};
    return setResult((Array.isArray(items) ? items : []).map((item) => ({
      title: String(rule._pick(item, fields.title, '')),
      pic_url: rule._abs(target, rule._pick(item, fields.image, '')),
      desc: String(rule._pick(item, fields.desc, '')),
      content: String(rule._pick(item, fields.desc, '')),
      url: String(rule._pick(item, fields.id, ''))
    })).filter((item) => item.title && item.url));
  }`;
  const chapterTarget = 'String(chapterId)';
  const lazyBody = buildAppApiLazyBody(contentTypeKey);

  return `/*
@header({
  类型: ${q(contentType)},
  title: ${q(siteName)},
  lang: 'ds',
  searchable: ${searchable},
  filterable: ${filterable},
  quickSearch: ${quickSearch}
})
*/

var rule = {
  类型: ${q(contentType)},
  title: ${q(siteName)},
  version: ${q(version)},
  host: ${q(host)},
  homeUrl: ${q(stages.home.url || input.homeUrl || '')},
  url: ${q(stages.category.url || input.url || '')},
  searchUrl: ${q(stages.search.url || input.searchUrl || '')},
  detailUrl: ${q(stages.detail.url || input.detailUrl || '')},
  headers: ${jsonToJs(headers)},
  searchable: ${searchable},
  quickSearch: ${quickSearch},
  filterable: ${filterable},
  class_name: ${q(classes.className)},
  class_url: ${q(classes.classUrl)},
${filterBlock}  play_parse: true,
  play_json: [],
  _stages: ${jsonToJs(stages)},
  _pick: function (value, path, fallback) {
    if (!path) return fallback;
    const result = String(path).split('.').filter(Boolean).reduce((current, key) => current && typeof current === 'object' ? current[key] : undefined, value);
    return result === undefined ? fallback : result;
  },
  _resolve: function (template, id) {
    const raw = String(template || id || '');
    const target = raw.replace(/fyid/g, encodeURIComponent(String(id || '')));
    if (target.startsWith('http://') || target.startsWith('https://')) return target;
    const base = String(rule.host || '').endsWith('/') ? String(rule.host).slice(0, -1) : String(rule.host || '');
    return base + (target.startsWith('/') ? target : '/' + target);
  },
  _abs: function (baseUrl, value) {
    const text = String(value || '').trim();
    if (!text || /^data:/i.test(text)) return text;
    return text.startsWith('http://') || text.startsWith('https://') ? text : urljoin(baseUrl || rule.host, text);
  },
  _render: function (value, vars, encodeValues) {
    const data = vars || {};
    const renderValue = (item) => encodeValues ? encodeURIComponent(String(item ?? '')) : String(item ?? '');
    if (typeof value === 'string') {
      return value
        .split('fyid').join(renderValue(data.fyid))
        .split('fyclass').join(renderValue(data.fyclass))
        .split('fypage').join(renderValue(data.fypage || '1'))
        .split('**').join(renderValue(data.wd));
    }
    if (Array.isArray(value)) return value.map((item) => rule._render(item, data, encodeValues));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rule._render(item, data, encodeValues)]));
    return value;
  },
  _isDirect: function (value) {
    const text = String(value || '').trim().toLowerCase();
    const path = text.split('?')[0].split('#')[0];
    return text.startsWith('magnet:') || text.startsWith('ftp:') || text.startsWith('thunder:')
      || ['.m3u8', '.mp4', '.flv'].some((suffix) => path.endsWith(suffix));
  },
  _fetch: async function (stage, target, vars) {
    const url = target || rule._resolve(stage.url, '');
    const options = { method: stage.method || 'GET', headers: Object.assign({}, rule.headers, stage.headers || {}) };
    if (stage.body !== undefined && stage.body !== null && stage.body !== '') {
      const encodeBody = stage.bodyEncode === true || stage.bodyEncoding === 'uri';
      const body = rule._render(stage.body, vars, encodeBody);
      options.body = stage.bodyType === 'json' && typeof body !== 'string' ? JSON.stringify(body) : body;
    }
    const response = await request(url, options);
    if (stage.responseType === 'text') return typeof response === 'string' ? response : String(response ?? '');
    return typeof response === 'string' ? JSON.parse(response) : response;
  },
  _list: ${listFunction},
  推荐: async function () {
    const stage = rule._stages.home;
    return stage.url ? rule._list('home', rule._resolve(stage.url, ''), {}) : [];
  },
  一级: async function () {
    return rule._list('category', this.input, { fyclass: this.MY_CATE, fypage: this.MY_PAGE });
  },
  二级: async function (ids) {
    const originalId = ids[0], id = String(this.detailUrl || this.vid || originalId || ''), detailStage = rule._stages.detail;
    const vars = { fyid: id, fyclass: this.fyclass };
    const detailJson = await rule._fetch(detailStage, this.input || rule._resolve(detailStage.url, id), vars);
    const detail = rule._pick(detailJson, detailStage.dataPath, detailJson), fields = detailStage.fields || {};
    const catalogStage = rule._stages.catalog;
    const chapters = catalogStage.url
      ? rule._pick(await rule._fetch(catalogStage, rule._resolve(catalogStage.url, id), vars), catalogStage.listPath, [])
      : rule._pick(detail, fields.chapters || 'chapters', []);
    const chapterFields = catalogStage.fields || {};
    return {
      vod_id: originalId,
      vod_name: String(rule._pick(detail, fields.title, '')),
      vod_pic: rule._abs(this.input, rule._pick(detail, fields.image, '')),
      vod_remarks: String(rule._pick(detail, fields.remarks, '')),
      vod_content: String(rule._pick(detail, fields.content, '')),
      vod_play_from: ${q(contentTypeKey === 'novel' ? '正文' : contentTypeKey === 'comic' ? '图片' : '默认')},
      vod_play_url: (Array.isArray(chapters) ? chapters : []).map((item) => {
        const name = String(rule._pick(item, chapterFields.title, '')).replace(/[#$]/g, ' ').trim();
        const chapterId = typeof item === 'string' ? item : rule._pick(item, chapterFields.id, '');
        const target = chapterId ? ${chapterTarget} : '';
        return name && target ? name + '$' + target : '';
      }).filter(Boolean).join('#')
    };
  },
  搜索: async function () {
    return rule._stages.search.url ? rule._list('search', this.input, { wd: this.KEY, fypage: this.MY_PAGE }) : [];
  },
  lazy: async function (flag, id) {
${lazyBody}
  }
};
`;
}

function normalizeAppApiStages(stages, input) {
  const listFields = { title: 'title', image: 'pic', desc: 'remarks', id: 'id' };
  const detailFields = { title: 'title', image: 'pic', remarks: 'remarks', content: 'content', chapters: 'chapters' };
  const chapterFields = { title: 'title', id: 'id' };
  const readerFields = { title: 'title', content: 'content', images: 'images', image: 'url', url: 'url' };
  const normalize = (name, defaults = {}) => {
    const stage = {
      method: 'GET',
      responseType: 'json',
      ...defaults,
      ...(stages[name] || {}),
      fields: { ...(defaults.fields || {}), ...(stages[name]?.fields || {}) },
    };
    stage.responseType = String(stage.responseType || 'json').trim().toLowerCase();
    return stage;
  };
  return {
    home: normalize('home', { url: input.homeUrl || '', listPath: 'data.list', fields: listFields }),
    category: normalize('category', { url: input.url || '', listPath: 'data.list', fields: listFields }),
    search: normalize('search', { url: input.searchUrl || '', listPath: 'data.list', fields: listFields }),
    detail: normalize('detail', { url: input.detailUrl || '', dataPath: 'data', fields: detailFields }),
    catalog: normalize('catalog', { url: input.catalogUrl || '', listPath: 'data.chapters', fields: chapterFields }),
    reader: normalize('reader', { url: input.readerUrl || '', dataPath: 'data', fields: readerFields }),
    play: normalize('play', { url: input.playUrl || '', dataPath: 'data', fields: { url: 'url' } }),
  };
}

function validateAppApiResponseTypes(stages, contentTypeKey) {
  const supported = new Set(['json', 'text']);
  const textStage = contentTypeKey === 'video' ? 'play' : 'reader';
  for (const [name, stage] of Object.entries(stages)) {
    if (!supported.has(stage.responseType)) {
      throw new Error(`app-api stages.${name}.responseType 只支持 json 或 text，当前为 ${stage.responseType || '(empty)'}`);
    }
    if (stage.responseType === 'text' && name !== textStage) {
      throw new Error(`app-api ${getContentTypeLabel(contentTypeKey)}仅支持 stages.${textStage}.responseType='text'；stages.${name} 需要结构化 JSON，不能静默按空数据处理`);
    }
  }
}

function buildAppApiLazyBody(contentTypeKey) {
  if (contentTypeKey === 'novel') {
    return `    const stage = rule._stages.reader, raw = String(id || '');
    const target = raw.startsWith('http://') || raw.startsWith('https://') ? raw : rule._resolve(stage.url, raw);
    const payload = await rule._fetch(stage, target, { fyid: raw });
    if (stage.responseType === 'text') {
      let content = String(payload ?? '').trim();
      if (content) {
        try {
          const decoded = JSON.parse(content);
          if (typeof decoded === 'string') content = decoded.trim();
          else throw new Error('正文文本响应解析后不是字符串');
        } catch (error) {
          if (error && error.message === '正文文本响应解析后不是字符串') throw error;
        }
      }
      if (!content) throw new Error('reader responseType=text 未返回正文文本');
      return { parse: 0, url: 'novel://' + JSON.stringify({ title: '', content: content }), js: '' };
    }
    const data = rule._pick(payload, stage.dataPath, payload), fields = stage.fields || {};
    return { parse: 0, url: 'novel://' + JSON.stringify({ title: String(rule._pick(data, fields.title, '')), content: String(rule._pick(data, fields.content, '')) }), js: '' };`;
  }
  if (contentTypeKey === 'comic') {
    return `    const stage = rule._stages.reader, raw = String(id || '');
    const target = raw.startsWith('http://') || raw.startsWith('https://') ? raw : rule._resolve(stage.url, raw);
    let payload = await rule._fetch(stage, target, { fyid: raw });
    const fields = stage.fields || {};
    if (stage.responseType === 'text') {
      const source = String(payload ?? '').trim();
      if (!source) throw new Error('reader responseType=text 未返回漫画图片');
      try { payload = JSON.parse(source); } catch (e) { payload = source; }
      if (typeof payload === 'string') {
        const nested = payload.trim();
        try { payload = JSON.parse(nested); } catch (e) { payload = nested; }
      }
    }
    const data = Array.isArray(payload) ? payload : rule._pick(payload, stage.dataPath, payload);
    let items = Array.isArray(data) || typeof data === 'string' ? data : rule._pick(data, fields.images, []);
    if (typeof items === 'string') items = items.split(/\\r?\\n|&&/).map((item) => item.trim()).filter(Boolean);
    const images = (Array.isArray(items) ? items : []).map((item) => typeof item === 'string' ? item : String(rule._pick(item, fields.image, ''))).filter(Boolean).map((url) => rule._abs(target, url));
    if (!images.length) throw new Error('reader responseType=' + stage.responseType + ' 未解析出漫画图片数组');
    return { parse: 0, url: 'pics://' + images.join('&&'), header: rule.headers };`;
  }
  return `    if (rule._isDirect(id)) return { parse: 0, url: id };
    const stage = rule._stages.play;
    if (!stage.url) return { parse: 1, url: id };
    const payload = await rule._fetch(stage, rule._resolve(stage.url, id), { fyid: id });
    if (stage.responseType === 'text') {
      let url = String(payload ?? '').trim();
      if (url) {
        try {
          const decoded = JSON.parse(url);
          if (typeof decoded === 'string') url = decoded.trim();
        } catch (e) {}
      }
      if (!url || !rule._isDirect(url)) throw new Error('play responseType=text 必须返回可识别的媒体直链');
      return { parse: 0, url: url };
    }
    const data = rule._pick(payload, stage.dataPath, payload), url = String(rule._pick(data, stage.fields.url, id));
    return rule._isDirect(url) ? { parse: 0, url } : { parse: 1, url };`;
}

function buildListRuleString(list, title, image, desc, link) {
  return [list, title, image, desc, link].map((item) => String(item || '')).join(';');
}

function buildCompactHtmlDetailRule(selectors) {
  const title = joinNonEmpty([
    selectors.detailTitle,
    selectors.detailType,
  ], ';');
  const desc = joinNonEmpty([
    selectors.detailRemarks,
    selectors.detailYear,
    selectors.detailArea,
    selectors.detailActor,
    selectors.detailDirector,
  ], ';');

  const listsSelector = selectors.detailList && selectors.detailEpisodeItem
    ? `${selectors.detailList}:eq(#id) ${selectors.detailEpisodeItem}`.trim()
    : selectors.detailList || selectors.detailEpisodeItem || '';

  return `{
    title: ${q(title)},
    img: ${q(selectors.detailImage)},
    desc: ${q(desc)},
    content: ${q(selectors.detailContent)},
    tabs: ${q(selectors.detailTabs)},
    lists: ${q(listsSelector)},
    tab_text: ${q(selectors.detailTabName || 'body&&Text')},
    list_text: ${q(selectors.detailEpisodeTitle || 'body&&Text')},
    list_url: ${q(selectors.detailEpisodeLink || 'a&&href')}
  }`;
}

function buildJsonListRule(pathValue, titleField, imageField, descField, linkField) {
  return `json:${pathValue};${titleField};${imageField};${descField};${linkField}`;
}

function buildCompactJsonDetailRule(mappings) {
  return `async function (ids) {
    const html = JSON.parse(await getHtml(this.input)), d = rule._pick(html, ${q(mappings.detailPath)}, {});
    return {
      vod_id: ids[0],
      vod_name: String(rule._pick(d, ${q(mappings.detailTitleField)}, '')),
      vod_pic: rule._abs(this.input, rule._pick(d, ${q(mappings.detailImageField)}, '')),
      type_name: String(rule._pick(d, ${q(mappings.detailTypeField)}, '')),
      vod_remarks: String(rule._pick(d, ${q(mappings.detailRemarksField)}, '')),
      vod_year: String(rule._pick(d, ${q(mappings.detailYearField)}, '')),
      vod_area: String(rule._pick(d, ${q(mappings.detailAreaField)}, '')),
      vod_actor: String(rule._pick(d, ${q(mappings.detailActorField)}, '')),
      vod_director: String(rule._pick(d, ${q(mappings.detailDirectorField)}, '')),
      vod_content: String(rule._pick(d, ${q(mappings.detailContentField)}, '')),
      vod_play_from: String(rule._pick(d, ${q(mappings.detailPlayFromField)}, '')),
      vod_play_url: String(rule._pick(d, ${q(mappings.detailPlayUrlField)}, ''))
    };
  }`;
}

function buildCompactLazyRule({ lazyMode, mediaPattern, scriptPattern }) {
  if (lazyMode === 'sniff-script' && scriptPattern) {
    return `async function (flag, id) {
    let html = await request(id.startsWith('http') ? id : rule.host + id), m = html.match(new RegExp(${q(scriptPattern)}, 'is')), url = m && m[1] ? m[1] : id;
    return new RegExp(${q(mediaPattern)}, 'i').test(url) ? { parse: 0, url } : { parse: 1, url };
  }`;
  }

  if (lazyMode === 'parse') {
    return `async function (flag, id) {
    return new RegExp(${q(mediaPattern)}, 'i').test(id) ? { parse: 0, url: id } : { parse: 1, url: id };
  }`;
  }

  return `async function (flag, id) {
    return new RegExp(${q(mediaPattern)}, 'i').test(id) ? { parse: 0, url: id } : id;
  }`;
}

function joinNonEmpty(list, separator = ';') {
  return (list || []).map((item) => String(item || '').trim()).filter(Boolean).join(separator);
}

function analyzeHtmlContent(html, url) {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const classFrequency = topClassFrequency(html);
  const linkPatterns = collectLinkPatterns(html, url);
  const forms = collectForms(html, url);
  const mediaHints = collectMatches(
    html,
    /(?:magnet:\?xt=urn:btih:[^\s'"<>]+)|(?:https?:\/\/[^\s'"<>]+\.(?:m3u8|mp4|flv|torrent)[^\s'"<>]*)/gi,
    12,
  );
  const scriptHints = collectScriptSnippets(html);
  const dynamicHostSignals = collectDynamicHostSignals(html);
  const captchaMarkers = collectMatches(
    html,
    /(系统安全验证|输入验证码|安全验证|验证码|captcha|verify|btwaf)/gi,
    12,
  );
  const keywordFlags = {
    hasSearch: /(name=["'](?:wd|keyword|search|q)["'])|(placeholder=["'][^"']*搜索[^"']*["'])|>搜索</i.test(html),
    hasPagination: /(fypage|page=|下一页|上一页|分页|pageIndex)/i.test(html),
    hasPlayer: /(player_|m3u8|videojs|dplayer|artplayer|hls|play_url|magnet:|\.torrent)/i.test(html),
    hasBt: /(magnet:\?xt=urn:btih:|\.torrent|bt下载|磁力|种子)/i.test(html),
    hasCaptcha: captchaMarkers.length > 0,
    hasBtwaf: /\?btwaf=|btwaf/i.test(html),
    hasDynamicHost: dynamicHostSignals.length > 0,
  };
  const typeMeta = analyzeHtmlContentType(html, url);

  return {
    mode: 'html',
    title: stripText(title),
    classFrequency,
    candidateSelectors: classFrequency.map((item) => `.${item.name}`),
    linkPatterns,
    forms,
    mediaHints,
    scriptHints,
    dynamicHostSignals,
    captchaMarkers,
    keywordFlags,
    contentGuess: typeMeta.contentGuess,
    novelSignals: typeMeta.novelSignals,
    comicSignals: typeMeta.comicSignals,
    filterSignals: typeMeta.filterSignals,
    summary: `HTML 页面分析完成：标题=${stripText(title) || '未知'}，类型猜测=${typeMeta.contentGuess}，筛选组=${typeMeta.filterSignals?.groupCount || 0}，高频 class=${classFrequency.slice(0, 5).map((item) => item.name).join(', ') || '无'}${dynamicHostSignals.length > 0 ? '，疑似发布页/动态域名页' : ''}${captchaMarkers.length > 0 ? '，疑似存在验证码/安全验证' : ''}`,
  };
}

function analyzeJsonContent(payload) {
  const candidateArrays = [];
  walkJson(payload, '', candidateArrays);
  const typeMeta = analyzeJsonContentType(payload);

  return {
    mode: 'json',
    partial: false,
    parseError: null,
    rootType: Array.isArray(payload) ? 'array' : typeof payload,
    topKeys: Array.isArray(payload) ? [] : Object.keys(payload).slice(0, 20),
    candidateArrays: candidateArrays.slice(0, 12),
    contentGuess: typeMeta.contentGuess,
    novelSignals: typeMeta.novelSignals,
    comicSignals: typeMeta.comicSignals,
    filterSignals: typeMeta.filterSignals,
    summary: `JSON 页面分析完成：类型猜测=${typeMeta.contentGuess}，发现 ${candidateArrays.length} 个候选数组路径，筛选组=${typeMeta.filterSignals?.groupCount || 0}`,
  };
}

function analyzeJsonFragment(content, error) {
  const trimmed = String(content || '').trim();
  const first = trimmed[0] || '';
  const rootType = first === '[' ? 'array-fragment' : first === '{' ? 'object-fragment' : 'unknown-fragment';
  const topKeys = first === '{' ? extractJsonFragmentTopKeys(trimmed) : [];
  const parseError = String(error?.message || 'JSON parse failed').slice(0, 300);
  return {
    mode: 'json',
    partial: true,
    parseError,
    rootType,
    topKeys,
    candidateArrays: [],
    contentGuess: 'unknown',
    novelSignals: { keywordHits: [], hasLongContent: false, chapterListCount: 0 },
    comicSignals: { keywordHits: [], imageUrlCount: 0, imageListCount: 0 },
    filterSignals: {
      source: 'json-fragment',
      detected: false,
      groupCount: 0,
      hasSubCategory: false,
      groups: [],
      filterUrlTemplate: '',
      filterDef: {},
      summary: 'JSON 片段不参与筛选推断',
    },
    summary: `JSON 片段分析完成：内容可能被截断或格式不完整，根类型=${rootType}，已识别顶层字段=${topKeys.join(', ') || '无'}，解析错误=${parseError}`,
  };
}

function extractJsonFragmentTopKeys(content, limit = 20) {
  const keys = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < content.length && keys.length < limit; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        if (depth === 1 && start >= 0) {
          let cursor = index + 1;
          while (/\s/.test(content[cursor] || '')) cursor += 1;
          if (content[cursor] === ':') {
            const key = content.slice(start, index);
            if (key && !keys.includes(key)) keys.push(key);
          }
        }
        start = -1;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      start = index + 1;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
    }
  }
  return keys;
}

function walkJson(value, currentPath, candidateArrays, depth = 0) {
  if (depth > 4 || value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    const first = value.find((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (first) {
      const keys = Object.keys(first);
      const hasTitleLike = keys.some((key) => /(title|name|vod_name|book_name)/i.test(key));
      const hasLinkLike = keys.some((key) => /(id|url|href|vod_id)/i.test(key));
      if (hasTitleLike || hasLinkLike) {
        candidateArrays.push({
          path: currentPath || '$',
          length: value.length,
          sampleKeys: keys.slice(0, 12),
        });
      }
    }

    if (first) {
      walkJson(first, `${currentPath}[*]`, candidateArrays, depth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      walkJson(child, nextPath, candidateArrays, depth + 1);
    }
  }
}

function topClassFrequency(html) {
  const counts = new Map();
  const matches = html.matchAll(/class=["']([^"']+)["']/gi);
  for (const match of matches) {
    const classes = match[1].split(/\s+/).filter(Boolean);
    for (const className of classes) {
      counts.set(className, (counts.get(className) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 20);
}

async function fetchDebugSource(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  let body;

  if (method !== 'GET' && method !== 'HEAD' && options.data !== undefined) {
    if (typeof options.data === 'string') {
      body = options.data;
    } else {
      body = JSON.stringify(options.data);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
  });
  const text = await response.text();
  return {
    body: text,
    finalUrl: response.url,
    meta: {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      requestedUrl: url,
      finalUrl: response.url,
    },
  };
}

function drpyPdfa(html, rule, maxItems = 30) {
  const selector = pickFirstMatchedSelector(html, rule);
  if (!selector) {
    return [];
  }

  const $ = cheerio.load(html, { decodeEntities: false });
  const nodes = $(selector).toArray().slice(0, maxItems);
  return nodes.map((node, index) => ({
    index,
    tag: node.tagName,
    text: normalizeNodeText($(node).text()),
    outerHtml: $.html(node),
  }));
}

function drpyPdfh(html, rule) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const parsed = parseDrpyBranch(rule, 'pdfh');
  if (!parsed) return '';
  const node = findFirstNode($, parsed.selector);
  return node ? extractNodeValue($, node, parsed.attr, 'pdfh') : '';
}

function drpyPd(html, rule, baseUrl = '') {
  const $ = cheerio.load(html, { decodeEntities: false });
  const parsed = parseDrpyBranch(rule, 'pd');
  if (!parsed) return '';
  const node = findFirstNode($, parsed.selector);
  const value = node ? extractNodeValue($, node, parsed.attr, 'pd') : '';
  return isMeaningfulValue(value) ? resolveUrl(baseUrl, value) : '';
}

function pickFirstMatchedSelector(html, rule) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const parsed = parseDrpyBranch(rule, 'pdfa');
  if (!parsed?.selector) return '';
  return $(parsed.selector).length > 0 ? parsed.selector : '';
}

function parseDrpyBranch(branch, mode) {
  const raw = String(branch || '').trim();
  if (!raw) {
    return null;
  }

  if (mode === 'pdfa') {
    return { selector: raw, attr: null };
  }

  const parts = raw.split('&&').map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  if (parts.length === 1) {
    return {
      selector: parts[0],
      attr: mode === 'pd' ? 'href' : 'Text',
    };
  }

  return {
    selector: parts.slice(0, -1).join(' '),
    attr: parts[parts.length - 1],
  };
}

function findFirstNode($, selector) {
  if (!selector) {
    return $.root().children().first();
  }

  const nodes = $(selector);
  if (!nodes || nodes.length === 0) {
    return null;
  }
  return nodes.first();
}

function extractNodeValue($, node, attr, mode) {
  const normalizedAttr = String(attr || '').trim();
  if (!normalizedAttr) {
    return mode === 'pd' ? firstNonEmptyAttr($(node), ['href', 'src', 'data-src']) : normalizeNodeText($(node).text());
  }

  const attrLower = normalizedAttr.toLowerCase();
  if (attrLower === 'text') {
    return normalizeNodeText($(node).text());
  }
  if (attrLower === 'html' || attrLower === 'innerhtml') {
    return $(node).html() || '';
  }
  if (attrLower === 'outerhtml') {
    return $.html(node);
  }
  for (const candidate of normalizedAttr.split('||').map((item) => item.trim()).filter(Boolean)) {
    const candidateLower = candidate.toLowerCase();
    let value = $(node).attr(candidate);
    if (value === undefined && candidateLower !== candidate) value = $(node).attr(candidateLower);
    if (value && candidateLower.includes('style')) {
      const match = String(value).match(/url\((.*?)\)/i);
      if (match?.[1]) value = match[1].replace(/^['"]|['"]$/g, '');
    }
    if (isMeaningfulValue(value)) return value;
  }
  return '';
}

function firstNonEmptyAttr(node, attrs) {
  for (const attr of attrs) {
    const value = node.attr(attr);
    if (value) {
      return value;
    }
  }
  return '';
}

function normalizeNodeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningfulValue(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return true;
}

function collectLinkPatterns(html, baseUrl) {
  const patterns = new Map();
  const matches = html.matchAll(/href=["']([^"']+)["']/gi);
  for (const match of matches) {
    const href = match[1];
    const pattern = normalizeLinkPattern(href, baseUrl);
    if (!pattern) {
      continue;
    }
    const current = patterns.get(pattern) || { pattern, count: 0, samples: [] };
    current.count += 1;
    if (current.samples.length < 3) {
      current.samples.push(href);
    }
    patterns.set(pattern, current);
  }

  return [...patterns.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 12);
}

function collectForms(html, baseUrl) {
  const forms = [];
  const matches = html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi);
  for (const match of matches) {
    const attrs = match[1];
    const body = match[2];
    const action = firstMatch(attrs, /action=["']([^"']+)["']/i) || '';
    const method = firstMatch(attrs, /method=["']([^"']+)["']/i) || 'GET';
    const searchNames = [...body.matchAll(/name=["']([^"']+)["']/gi)].map((item) => item[1]);
    forms.push({
      action: resolveUrl(baseUrl, action),
      method: method.toUpperCase(),
      fieldNames: searchNames.slice(0, 12),
    });
  }
  return forms.slice(0, 6);
}

function collectScriptSnippets(html) {
  const matches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  const snippets = [];
  for (const match of matches) {
    const code = match[1];
    if (/(player_|m3u8|mp4|play_url|parse|hls)/i.test(code)) {
      snippets.push(stripText(code).slice(0, 240));
    }
  }
  return snippets.slice(0, 6);
}

function collectDynamicHostSignals(html) {
  const signals = [];
  const text = String(html || '');
  const title = stripText(firstMatch(text, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const addSignal = (type, value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    if (!signals.some((item) => item.type === type && item.value === normalized)) {
      signals.push({ type, value: normalized });
    }
  };

  if (/(发布页|最新地址|最新网址|备用网址|备用地址|永久域名|请收藏|域名发布|线路发布|Loading)/i.test(title)) {
    addSignal('title', title);
  }

  collectMatches(text, /(发布页|最新地址|最新网址|备用网址|备用地址|永久域名|请收藏|域名发布|线路发布|点击访问|进入官网)/gi, 12)
    .forEach((item) => addSignal('keyword', item));

  collectMatches(text, /(?:document\.write|document\.writeln|location\.href|window\.open|setTimeout\s*\()/gi, 12)
    .forEach((item) => addSignal('script', item));

  const externalHosts = new Set();
  for (const match of text.matchAll(/https?:\/\/([^/'"\s<>?#)]+)/gi)) {
    const host = match[1].toLowerCase();
    if (!/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|webp)$/i.test(host)) {
      externalHosts.add(host);
    }
  }
  if (externalHosts.size >= 2) {
    addSignal('candidateHosts', [...externalHosts].slice(0, 8).join(', '));
  }

  return signals.slice(0, 20);
}

function normalizeLinkPattern(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl || 'https://example.com');
    return url.pathname
      .replace(/\d+/g, '{n}')
      .replace(/[a-f0-9]{8,}/gi, '{id}')
      .replace(/\/+/g, '/');
  } catch (_) {
    return null;
  }
}

function resolveUrl(baseUrl, href) {
  if (!href) {
    return '';
  }
  try {
    return new URL(href, baseUrl || 'https://example.com').toString();
  } catch (_) {
    return href;
  }
}

function collectMatches(text, pattern, limit = 10) {
  return [...text.matchAll(pattern)].map((item) => item[0]).slice(0, limit);
}

function firstMatch(text, regex) {
  const match = regex.exec(text || '');
  return match?.[1] || '';
}

function stripText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getContentTypeLabel(contentType) {
  return contentTypeLabelMap[contentType] || '影视';
}

function q(value) {
  const safe = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `'${safe}'`;
}

function jsonToJs(value) {
  const compact = JSON.stringify(value)
    .replace(/"([A-Za-z_$][A-Za-z0-9_$]*)":/g, '$1:');
  if (compact.length <= 80 && !compact.includes('},{')) {
    return compact;
  }
  return JSON.stringify(value, null, 2)
    .replace(/"([A-Za-z_$][A-Za-z0-9_$]*)":/g, '$1:');
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildLazyBody({ lazyMode, mediaPattern, scriptPattern }) {
  if (lazyMode === 'sniff-script' && scriptPattern) {
    return `
    const html = await request(id.startsWith('http') ? id : rule.host + id);
    const match = html.match(new RegExp(${q(scriptPattern)}, 'is'));
    if (match && match[1]) {
      url = match[1];
    }
    if (new RegExp(${q(mediaPattern)}, 'i').test(url)) {
      return { parse: 0, url };
    }
    return { parse: 1, url };
    `;
  }

  if (lazyMode === 'parse') {
    return `
    if (new RegExp(${q(mediaPattern)}, 'i').test(url)) {
      return { parse: 0, url };
    }
    return { parse: 1, url };
    `;
  }

  return `
    if (new RegExp(${q(mediaPattern)}, 'i').test(url)) {
      return { parse: 0, url };
    }
    return url;
  `;
}
