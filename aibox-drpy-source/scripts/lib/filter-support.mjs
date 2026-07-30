import zlib from 'node:zlib';
import * as cheerio from 'cheerio';

const FILTER_LABELS = [
  { key: 'cateId', pattern: /(分类|栏目|频道|主类|大类|cate|catid|cateid|cid|tid|type_id)/i },
  { key: 'class', pattern: /(类型|题材|剧情|风格|子类|子分类|tag|genre|class|cate)/i },
  { key: 'area', pattern: /(地区|国家|区域|area|region)/i },
  { key: 'year', pattern: /(年份|年代|year)/i },
  { key: 'lang', pattern: /(语言|lang|language)/i },
  { key: 'letter', pattern: /(字母|首字母|letter|alpha)/i },
  { key: 'by', pattern: /(排序|order|sort|rank|by)/i },
  { key: 'state', pattern: /(状态|连载|完结|更新|state|status)/i },
  { key: 'version', pattern: /(版本|version)/i },
  { key: 'quality', pattern: /(画质|清晰度|quality)/i },
];

const FILTER_HINT_RE = /(filter|screen|sift|select|classify|筛选|类型|地区|年份|排序|字母|状态|题材|频道|分类)/i;
const FILTER_ALL_RE = /^(全部|全部分类|全部类型|全部地区|全部年份|全部语言|全部字母|全部状态|全部题材|不限|所有)$/;
const QUERY_SKIP_KEYS = new Set(['page', 'pg', 'p', 'pageno', 'wd', 'q', 's', 'search', 'keyword']);
const OPTION_ARRAY_KEYS = ['list', 'options', 'values', 'children', 'items', 'optionList'];
const OPTION_NAME_KEYS = ['name', 'title', 'label', 'text'];
const OPTION_VALUE_KEYS = ['value', 'id', 'key', 'code', 'slug', 'type', 'url'];

export function analyzeHtmlFilterSignals(html, pageUrl = '') {
  const source = String(html || '');
  if (!source.trim()) {
    return emptyFilterSignals('html');
  }

  const $ = cheerio.load(source);
  const roots = findCandidateRoots($);
  const groups = [];
  const seen = new Set();

  for (const root of roots) {
    const candidates = findCandidateGroups($, root);
    for (const candidate of candidates) {
      const group = extractHtmlFilterGroup($, candidate, pageUrl, groups.length);
      if (!group || group.options.length < 2) continue;
      const signature = `${group.key}:${group.options.map((item) => `${item.name}:${item.value}`).join('|')}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      groups.push(group);
      if (groups.length >= 8) break;
    }
    if (groups.length >= 8) break;
  }

  const filterUrlTemplate = inferFilterUrlTemplate(groups, pageUrl);
  const filterDef = buildDefaultFilterDef([], groups, filterUrlTemplate);
  return buildFilterSignals('html', groups, filterUrlTemplate, filterDef);
}

export function analyzeJsonFilterSignals(payload) {
  const candidates = [];
  walkJsonCandidates(payload, '', candidates, 0);
  const groups = [];
  const seen = new Set();

  for (const candidate of candidates) {
    for (const group of candidate.groups) {
      const signature = `${group.key}:${group.options.map((item) => `${item.name}:${item.value}`).join('|')}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      groups.push({
        ...group,
        sourcePath: candidate.path,
      });
      if (groups.length >= 8) break;
    }
    if (groups.length >= 8) break;
  }

  return buildFilterSignals('json', groups, '', buildDefaultFilterDef([], groups, ''));
}

export function resolveRuleFilterConfig(input = {}, fallback = {}) {
  const hasExplicitFilterable = Object.prototype.hasOwnProperty.call(input, 'filterable');
  const analysisSignals = input.analysis?.filterSignals || input.filterSignals || {};
  const filterUrl = String(
    input.filterUrl
      ?? input.filter_url
      ?? input.filterUrlTemplate
      ?? analysisSignals.filterUrlTemplate
      ?? ''
  ).trim();
  const classIds = splitClassIds(input.classUrl || input.class_url || fallback.classUrl || '');
  const groups = normalizeFilterGroups(
    input.filterGroups
      ?? input.filters
      ?? analysisSignals.groups
      ?? []
  );

  const fallbackFilterUrl = filterUrl || buildFallbackFilterUrl(input.url || fallback.url || '', groups);
  const explicitFilterValue = decodeMaybeCompressedJson(input.filter || '');
  const explicitFilterDefValue = decodeMaybeCompressedJson(input.filterDef || input.filter_def || '');
  const filter = normalizeFilterObject(
    explicitFilterValue,
    classIds,
    groups,
  );
  const filterDef = normalizeFilterDefObject(
    explicitFilterDefValue,
    classIds,
    groups,
    fallbackFilterUrl,
  );

  const hasExplicitFilterSource = Boolean(
    String(input.filterUrl ?? input.filter_url ?? input.filterUrlTemplate ?? '').trim()
    || (explicitFilterValue && typeof explicitFilterValue === 'object' && Object.keys(explicitFilterValue).length > 0)
    || (explicitFilterDefValue && typeof explicitFilterDefValue === 'object' && Object.keys(explicitFilterDefValue).length > 0)
    || Array.isArray(input.filterGroups)
  );
  const shouldEnable = hasExplicitFilterSource
    ? Object.keys(filter).length > 0
    : Boolean(fallbackFilterUrl && groups.length > 0 && Object.keys(filter).length > 0);
  const requestedFilterable = hasExplicitFilterable ? numberOrDefault(input.filterable, 0) : null;
  if (requestedFilterable > 0 && !shouldEnable) {
    throw new Error('filterable>0 需要真实 filter/filterGroups 选项；只有 filter_url 或空 filter_def 不能生成筛选入口');
  }
  const filterable = hasExplicitFilterable ? requestedFilterable : (shouldEnable ? 1 : 0);

  if (!filterable) {
    return {
      filterable: 0,
      filterUrl: '',
      filter: {},
      filterDef: {},
      groups,
      enabled: false,
    };
  }

  return {
    filterable,
    filterUrl: fallbackFilterUrl,
    filter,
    filterDef,
    groups,
    enabled: true,
  };
}

export function renderRuleFilterBlock(config = {}, indent = '  ') {
  if (!config || !config.filterable) {
    return '';
  }
  const lines = [];
  if (config.filterUrl) {
    lines.push(`${indent}filter_url: ${quoteString(config.filterUrl)},`);
  }
  if (config.filter && Object.keys(config.filter).length > 0) {
    lines.push(renderObjectProperty('filter', config.filter, indent));
  }
  lines.push(renderObjectProperty('filter_def', config.filterDef || {}, indent));
  return `${lines.join('\n')}\n`;
}

export function normalizeRuntimeFilterState(filterValue, filterDefValue, classUrl = '') {
  const classIds = splitClassIds(classUrl);
  const groups = normalizeFilterGroups([]);
  return {
    filter: normalizeFilterObject(decodeMaybeCompressedJson(filterValue), classIds, groups),
    filterDef: normalizeFilterDefObject(decodeMaybeCompressedJson(filterDefValue), classIds, groups, ''),
  };
}

export function buildFilterTestCases(filters = {}, filterDef = {}, tid = '', maxCases = 4) {
  const groups = getFilterGroupsByTid(filters, tid);
  if (!groups.length) {
    return [];
  }
  const defaults = getFilterDefByTid(filterDef, tid);
  const cases = [];
  const dedupe = new Set();

  pushFilterCase(cases, dedupe, {
    name: 'default',
    label: '默认筛选',
    ext: defaults,
    groups: [],
  });

  const optionCases = groups
    .map((group) => ({ group, option: pickFirstUsableOption(group, defaults) }))
    .filter((item) => item.option);

  for (const item of optionCases.slice(0, Math.max(1, maxCases - 2))) {
    pushFilterCase(cases, dedupe, {
      name: `single-${item.group.key}`,
      label: `${item.group.name}:${item.option.name}`,
      ext: { ...defaults, [item.group.key]: item.option.value },
      groups: [item.group.key],
    });
  }

  if (optionCases.length >= 2) {
    const combo = optionCases.slice(0, 2);
    pushFilterCase(cases, dedupe, {
      name: `combo-${combo.map((item) => item.group.key).join('-')}`,
      label: combo.map((item) => `${item.group.name}:${item.option.name}`).join(' + '),
      ext: combo.reduce((acc, item) => {
        acc[item.group.key] = item.option.value;
        return acc;
      }, { ...defaults }),
      groups: combo.map((item) => item.group.key),
      mode: hasParentChildLike(combo.map((item) => item.group)) ? 'parent-child' : 'combo',
    });
  }

  return cases.slice(0, maxCases);
}

export function encodeCategoryExt(ext = {}) {
  return Buffer.from(JSON.stringify(ext || {}), 'utf8').toString('base64');
}

function emptyFilterSignals(source) {
  return {
    source,
    detected: false,
    groupCount: 0,
    hasSubCategory: false,
    groups: [],
    filterUrlTemplate: '',
    filterDef: {},
    summary: '未识别到稳定筛选组',
  };
}

function buildFilterSignals(source, groups, filterUrlTemplate, filterDef) {
  const normalizedGroups = normalizeFilterGroups(groups);
  return {
    source,
    detected: normalizedGroups.length > 0,
    groupCount: normalizedGroups.length,
    hasSubCategory: hasParentChildLike(normalizedGroups),
    groups: normalizedGroups,
    filterUrlTemplate,
    filterDef,
    summary: normalizedGroups.length > 0
      ? `识别到 ${normalizedGroups.length} 个筛选组：${normalizedGroups.map((item) => item.name).join(' / ')}`
      : '未识别到稳定筛选组',
  };
}

function findCandidateRoots($) {
  const candidates = [];
  $('body *').each((index, element) => {
    const node = $(element);
    const links = node.find('a[href]');
    const linkCount = links.length;
    if (linkCount < 3 || linkCount > 60) return;
    const attrs = `${node.attr('class') || ''} ${node.attr('id') || ''}`;
    const text = normalizeSpace(node.text()).slice(0, 240);
    const score = (FILTER_HINT_RE.test(attrs) ? 6 : 0)
      + (FILTER_HINT_RE.test(text) ? 4 : 0)
      + Math.min(linkCount, 8);
    if (score < 9) return;
    candidates.push({ element, score, linkCount, index });
  });
  candidates.sort((left, right) => right.score - left.score || right.linkCount - left.linkCount || left.index - right.index);
  return candidates.slice(0, 12).map((item) => item.element);
}

function findCandidateGroups($, root) {
  const node = $(root);
  const directGroups = node.children().toArray().filter((child) => $(child).find('a[href]').length >= 2);
  if (directGroups.length > 0) {
    return directGroups.slice(0, 10);
  }
  const nestedGroups = node.find('li,dl,div,p,section,article').toArray().filter((child) => $(child).find('a[href]').length >= 2);
  if (nestedGroups.length > 0) {
    return nestedGroups.slice(0, 10);
  }
  return [root];
}

function extractHtmlFilterGroup($, node, pageUrl, fallbackIndex) {
  const anchors = $(node).find('a[href]').toArray().slice(0, 20).map((anchor) => {
    const current = $(anchor);
    const href = current.attr('href') || '';
    return {
      name: normalizeSpace(current.text() || current.attr('title') || current.attr('alt') || ''),
      url: normalizeUrl(href, pageUrl),
    };
  }).filter((item) => item.name && item.url);

  if (anchors.length < 2) {
    return null;
  }

  const title = inferGroupTitle($, node, anchors.map((item) => item.name), fallbackIndex);
  const diff = inferUrlDifference(anchors, pageUrl, title, fallbackIndex);
  if (!diff) {
    return null;
  }

  const key = normalizeFilterKey(diff.rawKey || title, title, fallbackIndex);
  const options = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const value = readOptionValue(anchor.url, diff);
    const name = normalizeSpace(anchor.name);
    if (!name) continue;
    const signature = `${name}:${value}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    options.push({
      name,
      value,
      url: anchor.url,
      isAll: FILTER_ALL_RE.test(name) || value === '',
    });
  }

  if (!options.some((item) => item.isAll)) {
    options.unshift({ name: '全部', value: '', url: normalizeUrl(pageUrl, pageUrl), isAll: true });
  }

  return {
    key,
    name: title || fallbackFilterName(key),
    options,
    optionCount: options.length,
    valueSource: diff.mode,
    queryParam: diff.queryParam || '',
    pathIndex: Number.isInteger(diff.pathIndex) ? diff.pathIndex : null,
    sampleUrl: diff.sampleUrl || options[0]?.url || '',
    rawKey: diff.rawKey || '',
  };
}

function inferGroupTitle($, node, optionNames, fallbackIndex) {
  const current = $(node);
  const label = current.find('dt,label,strong,h3,h4,h5,b,em,span').first().text();
  const cleanLabel = cleanupTitle(label);
  if (cleanLabel && !optionNames.includes(cleanLabel)) {
    return cleanLabel;
  }

  const cloned = current.clone();
  cloned.find('a').remove();
  const rawText = cleanupTitle(cloned.text());
  if (rawText && rawText.length <= 12) {
    return rawText;
  }

  return `筛选组${fallbackIndex + 1}`;
}

function inferUrlDifference(options, pageUrl, title, fallbackIndex) {
  const metas = options.map((item) => parseUrlMeta(item.url, pageUrl)).filter(Boolean);
  if (metas.length < 2) {
    return null;
  }

  const queryCandidate = pickQueryCandidate(metas, title);
  if (queryCandidate) {
    return {
      mode: 'query',
      queryParam: queryCandidate.param,
      rawKey: queryCandidate.param,
      sampleUrl: metas[0].absolute,
    };
  }

  const pathCandidate = pickPathCandidate(metas, title, fallbackIndex);
  if (pathCandidate) {
    return {
      mode: 'path',
      pathIndex: pathCandidate.index,
      rawKey: pathCandidate.rawKey,
      sampleUrl: metas[0].absolute,
    };
  }

  return {
    mode: 'text',
    rawKey: title || `filter${fallbackIndex + 1}`,
    sampleUrl: metas[0].absolute,
  };
}

function pickQueryCandidate(metas, title) {
  const stats = new Map();
  for (const meta of metas) {
    for (const [key, value] of meta.searchParams.entries()) {
      if (QUERY_SKIP_KEYS.has(key.toLowerCase())) continue;
      if (!stats.has(key)) {
        stats.set(key, new Set());
      }
      stats.get(key).add(value);
    }
  }

  const candidates = [...stats.entries()]
    .map(([param, values]) => ({
      param,
      distinct: values.size,
      score: values.size + (normalizeFilterKey(param, title, 0) === normalizeFilterKey(title, title, 0) ? 2 : 0),
    }))
    .filter((item) => item.distinct >= 2)
    .sort((left, right) => right.score - left.score || left.param.localeCompare(right.param));

  return candidates[0] || null;
}

function pickPathCandidate(metas, title, fallbackIndex) {
  const segmentSets = [];
  const lengths = new Set(metas.map((item) => item.segments.length));
  if (lengths.size !== 1) {
    return null;
  }

  const segmentLength = metas[0].segments.length;
  for (let index = 0; index < segmentLength; index += 1) {
    const values = new Set(metas.map((item) => item.segments[index] || ''));
    if (values.size >= 2) {
      segmentSets.push({ index, distinct: values.size });
    }
  }
  if (!segmentSets.length) {
    return null;
  }

  const best = segmentSets[0];
  const prev = metas[0].segments[best.index - 1] || '';
  return {
    index: best.index,
    rawKey: prev || title || `filter${fallbackIndex + 1}`,
  };
}

function readOptionValue(url, diff) {
  if (!url) return '';
  if (diff.mode === 'query' && diff.queryParam) {
    try {
      return new URL(url).searchParams.get(diff.queryParam) || '';
    } catch (_) {
      return '';
    }
  }
  if (diff.mode === 'path' && Number.isInteger(diff.pathIndex)) {
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      return segments[diff.pathIndex] || '';
    } catch (_) {
      return '';
    }
  }
  return '';
}

function inferFilterUrlTemplate(groups, pageUrl) {
  const usableGroups = groups.filter((item) => item.sampleUrl && (item.queryParam || Number.isInteger(item.pathIndex)));
  if (!usableGroups.length) {
    return '';
  }

  const sample = normalizeUrl(usableGroups[0].sampleUrl, pageUrl);
  if (!sample) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(sample);
  } catch (_) {
    return '';
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  for (const group of usableGroups) {
    const placeholder = renderFilterPlaceholder(group.key);
    if (group.queryParam) {
      parsed.searchParams.set(group.queryParam, placeholder);
    }
    if (Number.isInteger(group.pathIndex) && group.pathIndex < segments.length) {
      segments[group.pathIndex] = placeholder;
    }
  }

  for (const key of ['tid', 't', 'type', 'catid', 'cateId', 'cid', 'id']) {
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, 'fyclass');
    }
  }
  for (const key of ['page', 'pg', 'p', 'pageno']) {
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, 'fypage');
    }
  }

  for (let index = 1; index < segments.length; index += 1) {
    if (/^(page|pg|p)$/i.test(segments[index - 1]) && /^\d+$/.test(segments[index])) {
      segments[index] = 'fypage';
    }
    if (/^(tid|t|type|catid|cateid|cid|id)$/i.test(segments[index - 1])) {
      segments[index] = 'fyclass';
    }
  }

  parsed.pathname = `/${segments.join('/')}`;
  return unescapeFilterPlaceholders(stripOrigin(parsed.toString()));
}

function buildFallbackFilterUrl(urlTemplate, groups) {
  const template = String(urlTemplate || '').trim();
  if (!template || !groups.length) {
    return '';
  }
  if (!template.includes('?') && !template.includes('&')) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(template, 'https://example.com');
  } catch (_) {
    return '';
  }

  for (const group of groups) {
    if (!parsed.searchParams.has(group.key)) {
      parsed.searchParams.set(group.key, renderFilterPlaceholder(group.key));
    }
  }
  for (const key of ['page', 'pg', 'p', 'pageno']) {
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, 'fypage');
    }
  }
  return unescapeFilterPlaceholders(stripOrigin(parsed.toString()));
}

function walkJsonCandidates(value, currentPath, candidates, depth) {
  if (depth > 5 || value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    const groups = normalizeJsonFilterGroups(value);
    if (groups.length) {
      candidates.push({ path: currentPath || '$', groups });
    }
    value.slice(0, 6).forEach((item) => walkJsonCandidates(item, `${currentPath}[*]`, candidates, depth + 1));
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      walkJsonCandidates(child, nextPath, candidates, depth + 1);
    }
  }
}

function normalizeJsonFilterGroups(items) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }
  const groups = [];
  items.slice(0, 12).forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const optionKey = OPTION_ARRAY_KEYS.find((key) => Array.isArray(item[key]));
    if (!optionKey) return;
    const options = normalizeJsonOptions(item[optionKey]);
    if (options.length < 2) return;
    const name = pickTextField(item, OPTION_NAME_KEYS) || `筛选组${index + 1}`;
    const key = normalizeFilterKey(item.key || item.id || item.type || name, name, index);
    groups.push({
      key,
      name,
      options,
      optionCount: options.length,
      valueSource: 'json',
      sampleUrl: '',
      rawKey: item.key || '',
    });
  });
  return groups;
}

function normalizeJsonOptions(items) {
  const seen = new Set();
  const options = [];
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    const name = pickTextField(item, OPTION_NAME_KEYS);
    const value = pickTextField(item, OPTION_VALUE_KEYS);
    if (!name && value === undefined) continue;
    const normalizedName = name || String(value || '').trim();
    const normalizedValue = String(value ?? '').trim();
    const signature = `${normalizedName}:${normalizedValue}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    options.push({
      name: normalizedName,
      value: normalizedValue,
      url: String(item.url || ''),
      isAll: FILTER_ALL_RE.test(normalizedName) || normalizedValue === '',
    });
  }
  if (!options.some((item) => item.isAll)) {
    options.unshift({ name: '全部', value: '', url: '', isAll: true });
  }
  return options;
}

function normalizeFilterGroups(groups) {
  if (!Array.isArray(groups)) {
    return [];
  }
  const result = [];
  const seen = new Set();
  groups.forEach((group, index) => {
    if (!group || typeof group !== 'object') return;
    const key = normalizeFilterKey(group.key || group.name || group.rawKey || `filter${index + 1}`, group.name, index);
    const name = normalizeSpace(group.name || fallbackFilterName(key));
    const rawOptions = Array.isArray(group.options)
      ? group.options
      : Array.isArray(group.value)
        ? group.value.map((item) => ({ name: item.n || item.name || '', value: item.v || item.value || '', url: item.url || '', isAll: FILTER_ALL_RE.test(String(item.n || item.name || '')) || String(item.v || item.value || '') === '' }))
        : [];
    const options = [];
    const optionSeen = new Set();
    rawOptions.forEach((item) => {
      const nameValue = normalizeSpace(item.name || item.n || '');
      const rawValue = String(item.value ?? item.v ?? '').trim();
      if (!nameValue && rawValue === '') return;
      const signature = `${nameValue}:${rawValue}`;
      if (optionSeen.has(signature)) return;
      optionSeen.add(signature);
      options.push({
        name: nameValue || rawValue,
        value: rawValue,
        url: String(item.url || ''),
        isAll: Boolean(item.isAll) || FILTER_ALL_RE.test(nameValue) || rawValue === '',
      });
    });
    if (!options.length) return;
    if (!options.some((item) => item.isAll)) {
      options.unshift({ name: '全部', value: '', url: '', isAll: true });
    }
    const signature = `${key}:${options.map((item) => `${item.name}:${item.value}`).join('|')}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    result.push({
      key,
      name,
      options,
      optionCount: options.length,
      valueSource: group.valueSource || 'manual',
      queryParam: group.queryParam || '',
      pathIndex: Number.isInteger(group.pathIndex) ? group.pathIndex : null,
      sampleUrl: String(group.sampleUrl || ''),
      rawKey: String(group.rawKey || ''),
    });
  });
  return result;
}

function normalizeFilterObject(filterValue, classIds, groups) {
  if (filterValue && typeof filterValue === 'object' && !Array.isArray(filterValue) && Object.keys(filterValue).length > 0) {
    return Object.fromEntries(
      Object.entries(filterValue).map(([key, value]) => [key, normalizeFilterGroupEntries(value)])
    );
  }
  if (!groups.length) {
    return {};
  }
  const keys = classIds.length ? classIds : ['*'];
  const normalizedGroups = normalizeFilterGroupEntries(groups);
  return Object.fromEntries(keys.map((key) => [key, normalizedGroups]));
}

function normalizeFilterDefObject(filterDefValue, classIds, groups, filterUrl) {
  if (filterDefValue && typeof filterDefValue === 'object' && !Array.isArray(filterDefValue) && Object.keys(filterDefValue).length > 0) {
    return Object.fromEntries(
      Object.entries(filterDefValue).map(([key, value]) => [key, normalizePlainObject(value)])
    );
  }
  return buildDefaultFilterDef(classIds, groups, filterUrl);
}

function buildDefaultFilterDef(classIds, groups, filterUrl) {
  if (!classIds.length) {
    return {};
  }
  const requiresCateId = String(filterUrl || '').includes('{{fl.cateId}}') || groups.some((item) => item.key === 'cateId');
  if (!requiresCateId) {
    return {};
  }
  return Object.fromEntries(classIds.map((id) => [id, { cateId: id }]));
}

function normalizeFilterGroupEntries(groups) {
  return normalizeFilterGroups(groups).map((group) => ({
    key: group.key,
    name: group.name,
    value: group.options.map((item) => ({ n: item.name, v: item.value })),
  }));
}

function getFilterGroupsByTid(filters, tid) {
  if (!filters || typeof filters !== 'object') {
    return [];
  }
  return normalizeFilterGroups(filters[tid] || filters['*'] || Object.values(filters)[0] || []);
}

function getFilterDefByTid(filterDef, tid) {
  if (!filterDef || typeof filterDef !== 'object') {
    return {};
  }
  return normalizePlainObject(filterDef[tid] || filterDef['*'] || {});
}

function pickFirstUsableOption(group, defaults) {
  const defaultValue = String(defaults?.[group.key] ?? '').trim();
  return group.options.find((item) => item.value !== '' && item.value !== defaultValue) || null;
}

function pushFilterCase(bucket, dedupe, item) {
  const ext = normalizePlainObject(item.ext || {});
  const signature = JSON.stringify(ext);
  if (dedupe.has(signature)) {
    return;
  }
  dedupe.add(signature);
  bucket.push({
    name: item.name,
    label: item.label,
    ext,
    groups: item.groups || [],
    mode: item.mode || 'single',
  });
}

function hasParentChildLike(groups) {
  if (!Array.isArray(groups) || groups.length < 2) {
    return false;
  }
  const labels = groups.map((item) => `${item.name} ${item.key}`.toLowerCase());
  const hasPrimary = labels.some((item) => /(分类|cate|type|class|栏目|频道)/.test(item));
  const hasSecondary = labels.some((item) => /(子类|子分类|题材|剧情|风格|地区|年份|排序)/.test(item));
  return hasPrimary && hasSecondary;
}

function normalizeFilterKey(rawKey, title, fallbackIndex) {
  const raw = String(rawKey || '').trim();
  const normalizedRaw = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '');
  for (const item of FILTER_LABELS) {
    if (item.pattern.test(raw) || item.pattern.test(title || '')) {
      return item.key;
    }
  }
  if (normalizedRaw) {
    return normalizedRaw;
  }
  return `filter${fallbackIndex + 1}`;
}

function fallbackFilterName(key) {
  const match = FILTER_LABELS.find((item) => item.key === key);
  if (!match) {
    return key || '筛选';
  }
  return {
    cateId: '分类',
    class: '类型',
    area: '地区',
    year: '年份',
    lang: '语言',
    letter: '字母',
    by: '排序',
    state: '状态',
    version: '版本',
    quality: '画质',
  }[match.key] || match.key;
}

function normalizeSpace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cleanupTitle(text) {
  return normalizeSpace(text).replace(/[：:|/]+$/g, '').replace(/^(按|选|筛选)/g, '').trim();
}

function normalizeUrl(target, base) {
  const value = String(target || '').trim();
  if (!value) {
    return '';
  }
  try {
    return new URL(value, base || 'https://example.com').toString();
  } catch (_) {
    return value;
  }
}

function parseUrlMeta(target, base) {
  try {
    const url = new URL(target, base || 'https://example.com');
    return {
      absolute: url.toString(),
      searchParams: url.searchParams,
      segments: url.pathname.split('/').filter(Boolean),
    };
  } catch (_) {
    return null;
  }
}

function stripOrigin(url) {
  try {
    const parsed = new URL(url, 'https://example.com');
    const search = parsed.search || '';
    return `${parsed.pathname}${search}`;
  } catch (_) {
    return url;
  }
}

function unescapeFilterPlaceholders(text) {
  return String(text || '')
    .replace(/%7B%7B/gi, '{{')
    .replace(/%7D%7D/gi, '}}')
    .replace(/%2E/gi, '.');
}

function decodeMaybeCompressedJson(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'object') {
    return value;
  }
  const text = String(value).trim();
  if (!text) {
    return {};
  }
  const candidates = [text];
  if (/^H4sIA/i.test(text) || /^[A-Za-z0-9+/=]+$/.test(text)) {
    try {
      candidates.unshift(zlib.gunzipSync(Buffer.from(text, 'base64')).toString('utf8'));
    } catch (_) {}
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }
  return {};
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function splitClassIds(text) {
  return String(text || '').split('&').map((item) => item.trim()).filter(Boolean);
}

function renderFilterPlaceholder(key) {
  return `{{fl.${key}}}`;
}

function renderObjectProperty(key, value, indent) {
  const text = JSON.stringify(value, null, 2).split('\n');
  return text.map((line, index) => index === 0 ? `${indent}${key}: ${line}` : `${indent}${line}`).join('\n') + ',';
}

function quoteString(value) {
  const safe = String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `'${safe}'`;
}

function normalizePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && `${item}`.trim() !== '')
  );
}

function pickTextField(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null && `${value}`.trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}
