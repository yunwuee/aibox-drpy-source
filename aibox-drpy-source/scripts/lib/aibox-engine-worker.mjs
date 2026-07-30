import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parsePlayCatalog } from './content-contracts.mjs';
import { extractNativeList } from './native-result-utils.mjs';
import { pathToFileURL } from 'node:url';

const RESULT_PREFIX = '__AIBOX_NATIVE_ENGINE_RESULT__';
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
for (const name of ['log', 'info', 'debug', 'warn']) {
  console[name] = (...args) => process.stderr.write(`${args.map(formatLogValue).join(' ')}\n`);
}

try {
  const request = JSON.parse(await readStdin());
  const result = await execute(request);
  emit({ ok: true, data: toSerializable(result) }, 0);
} catch (error) {
  emit({
    ok: false,
    error: {
      code: error.code || 'NATIVE_ENGINE_EXECUTION_FAILED',
      message: error.message || String(error),
      stack: error.stack || '',
    },
  }, 1);
}

async function execute(request) {
  const sourcePath = path.resolve(String(request.sourcePath || ''));
  const engineRoot = path.resolve(String(request.engineRoot || ''));
  const engineModulePath = path.resolve(String(request.engineModulePath || ''));
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw codedError('NATIVE_SOURCE_NOT_FOUND', `Rule source does not exist: ${sourcePath}`);
  }
  if (!engineModulePath.startsWith(engineRoot + path.sep) || !fs.existsSync(engineModulePath)) {
    throw codedError('NATIVE_ENGINE_UNAVAILABLE', `Invalid Aibox engine module: ${engineModulePath}`);
  }

  const engine = await import(pathToFileURL(engineModulePath).href);
  const operation = String(request.operation || '');
  const args = request.args && typeof request.args === 'object' ? request.args : {};
  const env = buildEngineEnv(sourcePath, request.engineEnv || {}, args);

  switch (operation) {
    case 'getRuleObject': {
      const rule = await engine.getRuleObject(sourcePath, env, true);
      if (!rule || Object.keys(rule).length === 0) {
        throw codedError('NATIVE_RULE_LOAD_FAILED', 'The native engine returned an empty rule object.');
      }
      return rule;
    }
    case 'home':
      return await engine.home(sourcePath, env, numberOr(args.filter, 1));
    case 'homeVod':
      return await engine.homeVod(sourcePath, env);
    case 'category':
      return await engine.category(
        sourcePath,
        env,
        String(args.tid || args.classId || ''),
        numberOr(args.page, 1),
        numberOr(args.filter, 1),
        objectOr(args.extend, {}),
      );
    case 'detail':
      return await engine.detail(sourcePath, env, normalizeIds(args.ids ?? args.vodId));
    case 'search':
      return await engine.search(
        sourcePath,
        env,
        String(args.keyword || args.wd || ''),
        numberOr(args.quick, 0),
        numberOr(args.page, 1),
      );
    case 'play':
      return await engine.play(
        sourcePath,
        env,
        String(args.flag || ''),
        String(args.id || args.playUrl || ''),
        Array.isArray(args.flags) ? args.flags : [],
      );
    case 'proxy':
      return await engine.proxy(sourcePath, env, objectOr(args.params, args));
    case 'chain':
      return await executeChain(engine, sourcePath, env, args);
    default:
      throw codedError('NATIVE_ENGINE_UNSUPPORTED_OPERATION', `Unsupported native engine operation: ${operation}`);
  }
}

async function executeChain(engine, sourcePath, env, args) {
  const steps = {};
  const rule = await engine.getRuleObject(sourcePath, env, true);
  if (!rule || Object.keys(rule).length === 0) {
    throw codedError('NATIVE_RULE_LOAD_FAILED', 'The native engine returned an empty rule object.');
  }
  steps.rule = summarizeRule(rule);
  steps.home = await engine.home(sourcePath, env, numberOr(args.filter, 1));
  steps.homeVod = await engine.homeVod(sourcePath, env);

  const homeClasses = Array.isArray(steps.home?.class) ? steps.home.class : [];
  const classId = String(
    args.classId
    || args.tid
    || homeClasses.find((item) => item?.type_id !== undefined)?.type_id
    || '',
  );
  if (!classId) {
    throw codedError('NATIVE_CHAIN_CLASS_NOT_FOUND', 'No class_id was returned by the native home stage.');
  }

  steps.category = await engine.category(
    sourcePath,
    env,
    classId,
    numberOr(args.page, 1),
    numberOr(args.filter, 1),
    objectOr(args.extend, {}),
  );
  const categoryList = extractNativeList(steps.category);
  if (categoryList.length === 0 && !allowEmpty(args, 'category')) {
    throw codedError('CHAIN_CATEGORY_EMPTY', `The native category stage returned no items for class_id=${classId}.`);
  }
  if (Number(rule.filterable || 0) > 0) {
    const filterCase = buildFilterProbe(rule.filter, rule.filter_def, classId);
    if (!filterCase) {
      throw codedError('CHAIN_FILTER_EMPTY', `filterable>0 but no usable filter option was returned for class_id=${classId}.`);
    }
    const filtered = await engine.category(
      sourcePath,
      env,
      classId,
      numberOr(args.filterPage, 1),
      1,
      filterCase.extend,
    );
    if (extractNativeList(filtered).length === 0) {
      throw codedError('CHAIN_FILTER_CATEGORY_EMPTY', `The native category stage returned no items for filter ${filterCase.label}.`);
    }
    steps.filterProbe = { ...filterCase, result: filtered };
  }
  const vodCandidate = args.vodId ? { vod_id: args.vodId } : categoryList[0];
  const vodId = String(vodCandidate?.vod_id ?? vodCandidate?.url ?? vodCandidate?.id ?? '');
  if (!vodId) {
    throw codedError('NATIVE_CHAIN_VOD_NOT_FOUND', 'No vod_id was returned by the native category stage.');
  }

  steps.detail = await engine.detail(sourcePath, env, [vodId]);
  const vod = extractNativeList(steps.detail)[0];
  if (!vod) {
    throw codedError('NATIVE_CHAIN_DETAIL_NOT_FOUND', `No detail item was returned for vod_id=${vodId}.`);
  }
  const catalog = parsePlayCatalog(vod);
  steps.catalog = catalog;
  if (catalog.errors.length > 0) {
    throw codedError('CHAIN_CATALOG_INVALID', catalog.errors.join('; '));
  }
  const firstEpisode = selectCatalogEpisode(catalog, { ...args, episodeIndex: args.episodeIndex ?? 0 });
  const lastEpisode = selectCatalogEpisode(catalog, { ...args, episodeIndex: args.lastEpisodeIndex ?? -1 }, true);
  if (!firstEpisode.url) {
    throw codedError('NATIVE_CHAIN_PLAY_URL_NOT_FOUND', `No play URL was returned for vod_id=${vodId}.`);
  }

  steps.playFirst = await engine.play(sourcePath, env, firstEpisode.flag, firstEpisode.url, firstEpisode.flags);
  steps.play = { ...steps.playFirst };
  steps.proxyFirst = await resolveProxyImages(engine, sourcePath, env, steps.playFirst);
  if (lastEpisode.url && lastEpisode.url !== firstEpisode.url) {
    steps.playLast = await engine.play(sourcePath, env, lastEpisode.flag, lastEpisode.url, lastEpisode.flags);
    steps.proxyLast = await resolveProxyImages(engine, sourcePath, env, steps.playLast);
  } else {
    steps.playLast = { ...steps.playFirst };
    steps.proxyLast = [...steps.proxyFirst];
  }
  const keyword = String(args.keyword ?? args.wd ?? vod.vod_name ?? '').trim();
  if (Number(rule.searchable || 0) > 0 && keyword) {
    steps.search = await engine.search(
      sourcePath,
      env,
      keyword,
      numberOr(args.quick, 0),
      numberOr(args.searchPage, 1),
    );
    if (extractNativeList(steps.search).length === 0 && !allowEmpty(args, 'search')) {
      throw codedError('CHAIN_SEARCH_EMPTY', `The native search stage returned no items for keyword=${keyword}.`);
    }
  }
  steps.coverProxies = await resolveProxyUrls(engine, sourcePath, env, collectCoverUrls(steps));
  return {
    selected: {
      classId,
      vodId,
      flag: firstEpisode.flag,
      episodeName: firstEpisode.name,
      playUrl: firstEpisode.url,
      lastFlag: lastEpisode.flag,
      lastEpisodeName: lastEpisode.name,
      lastPlayUrl: lastEpisode.url,
      keyword,
    },
    steps,
  };
}

function summarizeRule(rule) {
  return {
    title: rule.title || '',
    type: rule['类型'] || '影视',
    template: rule['模板'] || '',
    hasRecommend: Boolean(rule['推荐']),
    searchable: Number(rule.searchable || 0),
    filterable: Number(rule.filterable || 0),
    quickSearch: Number(rule.quickSearch || 0),
    headers: summarizeHeaders(rule.headers),
    playParse: rule.play_parse === true,
    hasPlayJson: Object.prototype.hasOwnProperty.call(rule, 'play_json'),
  };
}

function summarizeHeaders(value) {
  if (typeof value === 'string') {
    try {
      return summarizeHeaders(JSON.parse(value));
    } catch (_) {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([, headerValue]) => ['string', 'number', 'boolean'].includes(typeof headerValue))
    .map(([key, headerValue]) => [String(key), String(headerValue)]));
}

function allowEmpty(args, stage) {
  const values = Array.isArray(args.allowEmpty)
    ? args.allowEmpty
    : String(args.allowEmpty || '').split(',');
  return values.map((item) => String(item).trim().toLowerCase()).includes(stage);
}

function buildEngineEnv(sourcePath, overrides, args) {
  const moduleName = path.basename(sourcePath, path.extname(sourcePath));
  const requestHost = String(args.requestHost || overrides.requestHost || 'http://127.0.0.1:5757').replace(/\/+$/g, '');
  const proxyUrl = `${requestHost}/proxy/${encodeURIComponent(moduleName)}/?do=ds&extend=`;
  const hostname = new URL(requestHost).host;
  return {
    ...objectOr(overrides, {}),
    requestHost,
    proxyUrl,
    proxyPath: '',
    publicUrl: `${requestHost}/public/`,
    jsonUrl: `${requestHost}/json/`,
    httpUrl: `${requestHost}/http`,
    imageApi: `${requestHost}/image`,
    mediaProxyUrl: `${requestHost}/mediaProxy`,
    webdavProxyUrl: `${requestHost}/webdav/`,
    ftpProxyUrl: `${requestHost}/ftp/`,
    hostUrl: hostname.split(':')[0],
    hostname,
    wsName: hostname,
    ext: String(overrides.ext || ''),
    getProxyUrl: () => proxyUrl,
  };
}

function selectCatalogEpisode(catalog, args, preferLast = false) {
  const sources = Array.isArray(catalog?.sources) ? catalog.sources : [];
  const requestedFlag = String(args.flag || '');
  const hasSourceIndex = args.sourceIndex !== undefined && args.sourceIndex !== null && args.sourceIndex !== '';
  let selectedSources = sources;
  if (requestedFlag) {
    selectedSources = sources.filter((source) => source.name === requestedFlag);
  } else if (hasSourceIndex) {
    const sourceIndex = numberOr(args.sourceIndex, 0);
    selectedSources = sources.filter((source) => source.index === sourceIndex);
  }
  if (selectedSources.length === 0) selectedSources = sources;
  const episodes = selectedSources.flatMap((source) => source.episodes.map((episode) => ({
    ...episode,
    flag: source.name,
  })));
  let episodeIndex = Number.isFinite(Number(args.episodeIndex))
    ? Number(args.episodeIndex)
    : (preferLast ? -1 : 0);
  if (episodeIndex < 0) {
    episodeIndex = Math.max(episodes.length + episodeIndex, 0);
  }
  const episode = episodes[Math.min(episodeIndex, Math.max(episodes.length - 1, 0))] || {};
  return {
    flag: episode.flag || requestedFlag || '',
    flags: catalog.flags || [],
    name: episode.name || '',
    url: episode.url || '',
  };
}

async function resolveProxyImages(engine, sourcePath, env, play) {
  const images = extractComicImages(play?.url);
  const samples = images.length > 1 ? [images[0], images.at(-1)] : images;
  return await resolveProxyUrls(engine, sourcePath, env, samples);
}

async function resolveProxyUrls(engine, sourcePath, env, urls) {
  const proxyUrl = new URL(env.proxyUrl);
  const results = [];
  for (const imageUrl of [...new Set((urls || []).filter(Boolean))]) {
    let parsed;
    try {
      parsed = new URL(imageUrl);
    } catch (_) {
      continue;
    }
    if (parsed.origin !== proxyUrl.origin || parsed.pathname !== proxyUrl.pathname) continue;
    const params = Object.fromEntries(parsed.searchParams.entries());
    results.push({ url: imageUrl, response: await engine.proxy(sourcePath, env, params) });
  }
  return results;
}

function collectCoverUrls(steps) {
  return ['homeVod', 'category', 'detail', 'search']
    .map((stage) => extractNativeList(steps[stage])[0]?.vod_pic)
    .map((url) => String(url || '').trim())
    .filter(Boolean);
}

function extractComicImages(value) {
  let raw = String(value || '').trim();
  if (!/^pics:\/\//i.test(raw)) return [];
  raw = raw.replace(/^pics:\/\//i, '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    } catch (_) {
    }
  }
  const separator = raw.includes('&&') ? '&&' : (raw.includes('|||') ? '|||' : '\n');
  return raw.split(separator).map((item) => item.trim()).filter(Boolean);
}

function buildFilterProbe(filters, filterDef, tid) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return null;
  const groups = filters[tid] || filters['*'] || Object.values(filters)[0];
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const defaults = filterDef && typeof filterDef === 'object' && !Array.isArray(filterDef)
    ? objectOr(filterDef[tid] || filterDef['*'], {})
    : {};
  for (const group of groups) {
    const key = String(group?.key || '').trim();
    const values = Array.isArray(group?.value) ? group.value : [];
    const option = values.find((item) => {
      const value = String(item?.v ?? '').trim();
      return value && value !== String(defaults[key] ?? '').trim();
    });
    if (!key || !option) continue;
    return {
      label: `${String(group.name || key)}:${String(option.n || option.v)}`,
      extend: { ...defaults, [key]: option.v },
    };
  }
  return null;
}

function toSerializable(value, seen = new WeakSet(), depth = 0) {
  if (depth > 16) {
    return '[MaxDepth]';
  }
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value ?? null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return { type: 'function', source: String(value).slice(0, 20_000) };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: 'bytes', base64: Buffer.from(value).toString('base64') };
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = value.map((item) => toSerializable(item, seen, depth + 1));
  } else if (value instanceof Map) {
    serialized = Object.fromEntries([...value.entries()].map(([key, item]) => [String(key), toSerializable(item, seen, depth + 1)]));
  } else {
    serialized = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'context') continue;
      serialized[key] = toSerializable(item, seen, depth + 1);
    }
  }
  seen.delete(value);
  return serialized;
}

function normalizeIds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function objectOr(value, fallback) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function formatLogValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk.toString('utf8');
  }
  return text;
}

function emit(payload, exitCode) {
  originalStdoutWrite(`${RESULT_PREFIX}${JSON.stringify(payload)}\n`, () => process.exit(exitCode));
}
