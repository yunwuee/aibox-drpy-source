import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectNativeEngineAvailability, runNativeEngineOperation } from './aibox-engine-adapter.mjs';
import { parseComicReaderPayload, parseNovelReaderPayload } from './content-contracts.mjs';
import { runLiveCheck } from './live-checker.mjs';
import { extractNativeList, hasNativeStageData } from './native-result-utils.mjs';
import { validateDrpyRule } from './rule-utils.mjs';
import { loadRuleSource, loadRuleSourceFile } from './source-loader.mjs';

export async function runRuleCheck(options = {}) {
  const level = normalizeLevel(options.level);
  const engine = normalizeEngine(options.engine);
  const source = await resolveCheckSource(options);
  const validation = validateDrpyRule(source.loaded.code, { engineRoot: options.engineRoot });
  const base = {
    passed: validation.passed,
    evidenceLevel: 'L1',
    engine: 'static-ast',
    fidelity: 'exact-static',
    publishGate: false,
    validation,
    source: {
      filePath: source.sourcePath,
      encrypted: source.loaded.encrypted,
      sha256: source.loaded.sha256,
      bytes: source.loaded.byteLength,
    },
    score: validation.score,
    errors: validation.issues,
    warnings: validation.warnings,
  };
  if (level === 'l1' || !validation.passed) {
    await source.cleanup();
    return base;
  }

  try {
    if (engine === 'portable') {
      return await runPortableCheck({ ...options, level, source, validation });
    }
    const availability = inspectNativeEngineAvailability(options.skillRoot, options);
    if (!availability.available) {
      if (engine === 'native') {
        return {
          ...base,
          passed: false,
          evidenceLevel: level.toUpperCase(),
          engine: 'native',
          fidelity: 'unavailable',
          errors: [`真实 Aibox 引擎不可用: ${availability.missing.map((item) => item.path).join(', ')}`],
          failureClass: 'environment_failure',
        };
      }
      return await runPortableCheck({ ...options, level, source, validation, fallbackReason: 'native-unavailable' });
    }
    if (level === 'l2') {
      return await runNativeL2({ ...options, source, validation });
    }
    return await runNativeL3({ ...options, source, validation });
  } finally {
    await source.cleanup();
  }
}

async function runNativeL2(options) {
  const stage = String(options.stage || 'homeVod');
  const result = await runNativeEngineOperation(stage, {
    skillRoot: options.skillRoot,
    engineRoot: options.engineRoot,
    sourcePath: options.source.sourcePath,
    args: options.args || {},
    timeoutMs: options.timeoutMs,
  });
  const nonEmpty = result.ok && hasNativeStageData(stage, result.data);
  return {
    passed: Boolean(options.validation.passed && nonEmpty),
    evidenceLevel: 'L2',
    engine: 'native',
    fidelity: result.fidelity,
    isolation: result.isolation,
    publishGate: false,
    validation: options.validation,
    stage,
    result,
    score: nonEmpty ? 100 : 0,
    errors: result.ok && nonEmpty ? [] : [result.error?.message || `${stage} 返回空结果`],
    warnings: options.validation.warnings,
    failureClass: result.ok && nonEmpty ? null : classifyFailure(result.error?.code),
  };
}

async function runNativeL3(options) {
  const probeTimeoutMs = positiveInteger(options.timeoutMs, 15_000);
  const result = await runNativeEngineOperation('chain', {
    skillRoot: options.skillRoot,
    engineRoot: options.engineRoot,
    sourcePath: options.source.sourcePath,
    args: {
      ...(options.args || {}),
      allowEmpty: options.allowEmpty || options.args?.allowEmpty || '',
    },
    timeoutMs: options.timeoutMs || 60_000,
  });
  if (!result.ok) {
    return {
      passed: false,
      evidenceLevel: 'L3',
      engine: 'native',
      fidelity: result.fidelity,
      isolation: result.isolation,
      publishGate: true,
      validation: options.validation,
      result,
      score: 0,
      errors: [result.error?.message || '真实引擎链路失败'],
      warnings: options.validation.warnings,
      failureClass: classifyFailure(result.error?.code),
    };
  }
  const data = result.data || {};
  const steps = data.steps || {};
  const type = normalizeContentType(steps.rule?.type || options.validation.ruleSummary?.type);
  const playFirst = await auditPlayResult(steps.playFirst || steps.play, type, 'first', probeTimeoutMs, steps.proxyFirst);
  const playLast = await auditPlayResult(steps.playLast || steps.play, type, 'last', probeTimeoutMs, steps.proxyLast);
  const searchable = Number(steps.rule?.searchable ?? options.validation.ruleSummary?.searchable ?? 0) > 0;
  const filterable = Number(steps.rule?.filterable ?? options.validation.ruleSummary?.filterable ?? 0) > 0;
  const recommendable = Boolean(steps.rule?.hasRecommend ?? options.validation.ruleSummary?.hasRecommendHandler);
  const allowedEmpty = normalizeAllowEmpty(options.allowEmpty || options.args?.allowEmpty);
  const homeVodEmpty = extractNativeList(steps.homeVod).length === 0;
  const categoryEmpty = extractNativeList(steps.category).length === 0;
  const detailEmpty = extractNativeList(steps.detail).length === 0;
  const searchEmpty = extractNativeList(steps.search).length === 0;
  const filtersEmpty = !hasFilters(steps.home?.filters);
  const homeVodAllowedEmpty = allowedEmpty.has('homevod');
  const categorySkipped = type !== 'comic' && categoryEmpty && allowedEmpty.has('category');
  const searchSkipped = searchable && searchEmpty && allowedEmpty.has('search');
  const coverProbes = type === 'comic'
    ? await auditComicCoverStages({
        steps,
        searchable,
      recommendable,
      allowedEmpty,
      headers: normalizeHeaders(steps.rule?.headers),
      timeoutMs: probeTimeoutMs,
      })
    : null;
  const homePassed = hasClasses(steps.home)
    && (!recommendable || !homeVodEmpty || homeVodAllowedEmpty)
    && (!filterable || !filtersEmpty)
    && coverStagePassed(coverProbes, 'homeVod');
  const scores = {
    home: homePassed ? 20 : 0,
    category: categorySkipped ? null : (!categoryEmpty && coverStagePassed(coverProbes, 'category') ? 20 : 0),
    detail: !detailEmpty && coverStagePassed(coverProbes, 'detail') ? 25 : 0,
    content: (playFirst.passed ? 12.5 : 0) + (playLast.passed ? 12.5 : 0),
    search: searchable ? (searchSkipped ? null : (!searchEmpty && coverStagePassed(coverProbes, 'search') ? 10 : 0)) : null,
  };
  const availableScore = 25
    + 20
    + (categorySkipped ? 0 : 20)
    + (searchable && !searchSkipped ? 10 : 0)
    + 25;
  const earned = Object.values(scores).filter((value) => typeof value === 'number').reduce((sum, value) => sum + value, 0);
  const score = Math.round((earned / availableScore) * 100);
  const stageErrors = {
    home: [],
    homeVod: [...(coverProbes?.homeVod?.errors || [])],
    category: [...(coverProbes?.category?.errors || [])],
    detail: [...(coverProbes?.detail?.errors || [])],
    search: [...(coverProbes?.search?.errors || [])],
    content: [...playFirst.errors, ...playLast.errors],
  };
  if (!hasClasses(steps.home)) stageErrors.home.push('首页未返回可用分类');
  if (recommendable && homeVodEmpty && !homeVodAllowedEmpty) stageErrors.homeVod.push('推荐接口返回空列表');
  if (filterable && filtersEmpty) stageErrors.home.push('filterable>0，但首页未返回可用筛选组');
  if (categoryEmpty && (type === 'comic' || !allowedEmpty.has('category'))) stageErrors.category.push('分类接口返回空列表');
  if (detailEmpty) stageErrors.detail.push('详情接口返回空列表');
  if (searchable && searchEmpty && !allowedEmpty.has('search')) stageErrors.search.push('searchable>0，但搜索接口返回空列表');
  const errors = unique(Object.values(stageErrors).flat());
  const chainErrors = errors.filter((message) => /首页|推荐|筛选|分类|详情|搜索/.test(message));
  return {
    passed: options.validation.passed && errors.length === 0,
    evidenceLevel: 'L3',
    engine: 'native',
    fidelity: result.fidelity,
    isolation: result.isolation,
    publishGate: true,
    contentType: type,
    validation: options.validation,
    selected: data.selected,
    steps,
    probes: { first: playFirst, last: playLast, covers: coverProbes },
    stageErrors,
    scoring: { weights: { home: 20, category: 20, detail: 25, content: 25, search: 10 }, earned: scores, available: availableScore },
    score,
    errors: unique(errors),
    warnings: options.validation.warnings,
    failureClass: errors.length ? (chainErrors.length ? 'chain_failure' : (type === 'video' ? 'play_failure' : 'content_contract_failure')) : null,
  };
}

async function auditComicCoverStages({ steps, searchable, recommendable, allowedEmpty, headers, timeoutMs }) {
  const proxyResults = Array.isArray(steps.coverProxies) ? steps.coverProxies : [];
  const configs = [
    { key: 'homeVod', label: '推荐', enabled: recommendable, allowEmpty: allowedEmpty.has('homevod') },
    { key: 'category', label: '分类', enabled: true, allowEmpty: false },
    { key: 'detail', label: '详情', enabled: true, allowEmpty: false },
    { key: 'search', label: '搜索', enabled: searchable, allowEmpty: allowedEmpty.has('search') },
  ];
  const audits = {};
  for (const config of configs) {
    audits[config.key] = await auditComicCoverStage({
      ...config,
      value: steps[config.key],
      proxyResults,
      headers,
      timeoutMs,
    });
  }
  return audits;
}

async function auditComicCoverStage({ key, label, enabled, allowEmpty, value, proxyResults, headers, timeoutMs }) {
  if (!enabled) {
    return {
      stage: key,
      label,
      passed: true,
      skipped: true,
      reason: 'capability-disabled',
      url: '',
      errors: [],
    };
  }

  const item = extractNativeList(value)[0];
  if (!item) {
    if (allowEmpty) {
      return {
        stage: key,
        label,
        passed: true,
        skipped: true,
        reason: 'allow-empty',
        url: '',
        errors: [],
      };
    }
    const error = `${label}阶段没有可验证的漫画条目，无法检查封面`;
    return {
      stage: key,
      label,
      passed: false,
      skipped: false,
      reason: 'stage-empty',
      url: '',
      errors: [error],
      error,
    };
  }

  const url = String(item.vod_pic || '').trim();
  if (!url) {
    const error = `${label}结果缺少 vod_pic，无法显示漫画封面`;
    return {
      stage: key,
      label,
      passed: false,
      skipped: false,
      reason: 'cover-empty',
      url: '',
      errors: [error],
      error,
    };
  }

  const proxyResult = proxyResults.find((entry) => entry?.url === url);
  const probe = proxyResult
    ? probeProxyImage(url, proxyResult.response)
    : { ...(await probeImage(url, headers, timeoutMs)), via: 'direct' };
  const errors = probe.passed ? [] : [`${label}封面不可读: ${url} ${probe.error}`];
  return {
    stage: key,
    label,
    ...probe,
    skipped: false,
    reason: probe.passed ? '' : 'probe-failed',
    errors,
  };
}

function coverStagePassed(coverProbes, stage) {
  return !coverProbes || coverProbes[stage]?.passed !== false;
}

async function runPortableCheck(options) {
  const report = await runLiveCheck({
    skillRoot: options.skillRoot,
    config: options.config,
    codeFile: options.source.sourcePath,
    moduleName: options.moduleName,
    depth: options.level === 'l3' ? 'full' : 'smoke',
    keepTemp: Boolean(options.keepTemp),
  });
  return {
    passed: Boolean(report.passed),
    evidenceLevel: options.level.toUpperCase(),
    engine: 'portable',
    fidelity: 'approximate',
    publishGate: false,
    fallbackReason: options.fallbackReason || null,
    validation: options.validation,
    report,
    score: report.passed ? 100 : 0,
    errors: report.errors || [],
    warnings: unique([...(options.validation.warnings || []), ...(report.warnings || []), '便携 runtime 仅为近似实现，不能单独作为正式分享门禁']),
    failureClass: report.passed ? null : 'rule_failure',
  };
}

async function auditPlayResult(play, contentType, label, timeoutMs, proxyResults = []) {
  const errors = [];
  const result = play && typeof play === 'object' ? play : { url: String(play || ''), parse: 1 };
  if (contentType === 'novel') {
    if (Number(result.parse) !== 0) errors.push(`${label} 章节最终响应必须为 parse:0`);
    const payload = parseNovelReaderPayload(result.url);
    if (payload.mode === 'http') {
      const probe = await probeHttpText(payload.url, normalizeHeaders(result.header), timeoutMs);
      if (!probe.passed) errors.push(`${label} 章节 HTTP 正文不可读: ${probe.error}`);
      return { passed: errors.length === 0, protocol: payload, probe, errors };
    }
    if (payload.status !== 'ok') errors.push(`${label} 章节正文无效: ${payload.error}`);
    return { passed: errors.length === 0, protocol: payload, errors };
  }
  if (contentType === 'comic') {
    if (Number(result.parse) !== 0) errors.push(`${label} 章节最终响应必须为 parse:0`);
    if (!/^pics:\/\//i.test(String(result.url || ''))) errors.push(`${label} 漫画最终响应必须使用 pics://`);
    const payload = parseComicReaderPayload(result.url);
    if (payload.status !== 'ok') {
      errors.push(`${label} 章节图片协议无效: ${payload.error}`);
      return { passed: false, protocol: payload, errors };
    }
    const samples = payload.images.length > 1 ? [payload.images[0], payload.images.at(-1)] : payload.images;
    const imageProbes = [];
    for (const imageUrl of samples) {
      const proxyResult = Array.isArray(proxyResults) ? proxyResults.find((item) => item?.url === imageUrl) : null;
      imageProbes.push(proxyResult
        ? probeProxyImage(imageUrl, proxyResult.response)
        : await probeImage(imageUrl, normalizeHeaders(result.header), timeoutMs));
    }
    for (const probe of imageProbes) if (!probe.passed) errors.push(`${label} 章节图片不可读: ${probe.url} ${probe.error}`);
    return { passed: errors.length === 0, protocol: payload, imageProbes, errors };
  }
  const url = String(result.url || '');
  if (Number(result.parse) !== 0) return { passed: Boolean(url), mode: 'sniff', errors: url ? [] : [`${label} 播放地址为空`] };
  if (/^(?:magnet:|ftp:|thunder:|push:)/i.test(url)) return { passed: true, mode: 'special', errors: [] };
  if (!/^https?:\/\//i.test(url)) return { passed: false, mode: 'direct', errors: [`${label} parse:0 不是可识别直链: ${url}`] };
  const probe = await probeMedia(url, normalizeHeaders(result.header), timeoutMs);
  if (!probe.passed) errors.push(`${label} 媒体直链探测失败: ${probe.error}`);
  return { passed: probe.passed, mode: 'direct', probe, errors };
}

async function probeMedia(url, headers, timeoutMs) {
  try {
    const response = await fetch(url, { headers: { ...headers, Range: 'bytes=0-65535' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') || '';
    const head = buffer.subarray(0, 512).toString('utf8');
    if (!response.ok && response.status !== 206) return { passed: false, status: response.status, contentType: type, error: `HTTP ${response.status}` };
    if (/text\/html/i.test(type) || /^\s*</.test(head)) return { passed: false, status: response.status, contentType: type, error: '返回 HTML，不是媒体直链' };
    const m3u8 = /mpegurl|\.m3u8(?:\?|$)/i.test(`${type} ${url}`);
    if (m3u8 && !/#EXTM3U/i.test(head)) return { passed: false, status: response.status, contentType: type, error: 'M3U8 缺少 #EXTM3U' };
    return { passed: buffer.length > 0, status: response.status, contentType: type, bytes: buffer.length, error: buffer.length ? '' : '响应为空' };
  } catch (error) {
    return { passed: false, status: 0, contentType: '', error: error.message };
  }
}

async function probeImage(url, headers, timeoutMs) {
  try {
    const response = await fetch(url, { headers: { ...headers, Range: 'bytes=0-1023' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') || '';
    const signature = detectImageSignature(buffer);
    const passed = (response.ok || response.status === 206) && Boolean(signature) && !/text\/html/i.test(type);
    return { passed, url, status: response.status, contentType: type, signature, bytes: buffer.length, error: passed ? '' : `HTTP ${response.status}, type=${type || 'unknown'}, signature=${signature || 'unknown'}` };
  } catch (error) {
    return { passed: false, url, status: 0, contentType: '', signature: '', bytes: 0, error: error.message };
  }
}

function probeProxyImage(url, response) {
  const result = Array.isArray(response) ? response : [];
  const status = Number(result[0] || 0);
  const contentType = String(result[1] || '');
  const buffer = proxyBodyToBuffer(result[2], result[4]);
  const signature = detectImageSignature(buffer);
  const passed = status >= 200 && status < 300 && Boolean(signature);
  return {
    passed,
    via: 'proxy_rule',
    url,
    status,
    contentType,
    signature,
    bytes: buffer.length,
    error: passed ? '' : `proxy HTTP ${status || 'unknown'}, type=${contentType || 'unknown'}, signature=${signature || 'unknown'}`,
  };
}

function proxyBodyToBuffer(body, toBytes) {
  if (body?.type === 'bytes' && typeof body.base64 === 'string') return Buffer.from(body.base64, 'base64');
  let text = String(body ?? '');
  if (/^data:[^,]+;base64,/i.test(text)) text = text.slice(text.indexOf(',') + 1);
  if (Number(toBytes) === 1) return Buffer.from(text, 'base64');
  let buffer = Buffer.from(text, 'latin1');
  if (!detectImageSignature(buffer) && /^[A-Za-z0-9+/=\s]+$/.test(text) && text.length >= 8) {
    const decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64');
    if (detectImageSignature(decoded)) buffer = decoded;
  }
  return buffer;
}

async function probeHttpText(url, headers, timeoutMs) {
  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    const passed = response.ok && text.trim().length > 0 && !/(验证码|captcha|cloudflare)/i.test(text.slice(0, 2000));
    return { passed, status: response.status, contentType: response.headers.get('content-type') || '', length: text.length, error: passed ? '' : `HTTP ${response.status} 或正文为空/命中验证页` };
  } catch (error) {
    return { passed: false, status: 0, contentType: '', length: 0, error: error.message };
  }
}

async function resolveCheckSource(options) {
  if (options.codeFile) {
    const sourcePath = path.resolve(options.codeFile);
    return { sourcePath, loaded: await loadRuleSourceFile(sourcePath), cleanup: async () => {} };
  }
  if (typeof options.code === 'string') {
    const loaded = await loadRuleSource(options.code);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-rule-check-'));
    const sourcePath = path.join(tempRoot, 'rule.js');
    fs.writeFileSync(sourcePath, options.code, 'utf8');
    return { sourcePath, loaded, cleanup: async () => fs.rmSync(tempRoot, { recursive: true, force: true }) };
  }
  throw new Error('check 需要 codeFile 或 code');
}

function hasClasses(home) {
  return Array.isArray(home?.class) && home.class.length > 0;
}

function hasFilters(filters) {
  if (Array.isArray(filters)) return filters.some(hasUsableFilterGroup);
  if (!filters || typeof filters !== 'object') return false;
  return Object.values(filters).some((groups) => Array.isArray(groups) && groups.some(hasUsableFilterGroup));
}

function hasUsableFilterGroup(group) {
  if (!group || typeof group !== 'object' || !String(group.key || '').trim()) return false;
  return Array.isArray(group.value) && group.value.some((item) => String(item?.v ?? '').trim());
}

function normalizeAllowEmpty(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return new Set(values.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeHeaders(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function detectImageSignature(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.subarray(4, 12).toString('ascii').includes('ftypavif')) return 'avif';
  const textHead = buffer.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)*<svg(?:\s|>)/i.test(textHead)) return 'svg';
  return '';
}

function normalizeLevel(value) {
  const level = String(value || 'l3').toLowerCase();
  if (!['l1', 'l2', 'l3'].includes(level)) throw new Error(`不支持的 evidence level: ${value}`);
  return level;
}

function normalizeEngine(value) {
  const engine = String(value || 'auto').toLowerCase();
  if (!['auto', 'native', 'portable'].includes(engine)) throw new Error(`不支持的 engine: ${value}`);
  return engine;
}

function normalizeContentType(value) {
  const type = String(value || '').toLowerCase();
  if (type.includes('小说') || type === 'novel') return 'novel';
  if (type.includes('漫画') || type === 'comic') return 'comic';
  if (type.includes('bt') || type.includes('磁力')) return 'bt';
  return 'video';
}

function classifyFailure(code) {
  if (/CATEGORY|SEARCH|VOD|DETAIL|CLASS|FILTER/.test(String(code || ''))) return 'chain_failure';
  if (/CATALOG/.test(String(code || ''))) return 'content_contract_failure';
  if (/PLAY/.test(String(code || ''))) return 'play_failure';
  if (/UNAVAILABLE|SPAWN|TIMEOUT|OUTPUT/.test(String(code || ''))) return 'environment_failure';
  return 'rule_failure';
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}
