import fs from 'node:fs';
import path from 'node:path';

import { analyzePageContent, checkDrpyRuleSyntax, validateDrpyRule } from './rule-utils.mjs';
import {
  createSession,
  ensureRuntimeRunning,
  mountSourceIntoSession,
  readStateFile,
  resolveEmbeddedDrpyConfig,
  resolveModuleNameFromPath,
  resolveSourceByModuleName,
  stopManagedRuntime,
  writeJsonFile,
  writeTextFile,
} from './embedded-drpy-manager.mjs';
import { detectCaptchaMarkers } from './embedded-drpy-runtime-core.mjs';
import { buildFilterTestCases, encodeCategoryExt } from './filter-support.mjs';
import {
  parseComicReaderPayload,
  parseNovelReaderPayload,
  parsePlayCatalog,
} from './content-contracts.mjs';

export async function runLiveCheck({
  skillRoot,
  config = {},
  codeFile,
  moduleName,
  depth,
  keepTemp = false,
}) {
  const runtimeConfig = resolveEmbeddedDrpyConfig(skillRoot, config);
  const effectiveDepth = String(depth || runtimeConfig.defaultDepth || 'smoke').toLowerCase() === 'full'
    ? 'full'
    : 'smoke';
  const session = createSession(skillRoot, config, 'live-check');

  const sourcePath = codeFile
    ? path.resolve(process.cwd(), codeFile)
    : resolveSourceByModuleName(skillRoot, config, moduleName);
  const sourceCode = fs.readFileSync(sourcePath, 'utf8');
  const mounted = mountSourceIntoSession(
    session,
    sourcePath,
    codeFile ? undefined : moduleName,
  );

  const syntax = checkDrpyRuleSyntax(sourceCode);
  const validation = validateDrpyRule(sourceCode);

  let runtime = null;
  let report;
  try {
    runtime = await ensureRuntimeRunning(session, {
      skillRoot,
      port: runtimeConfig.port,
      nodeCommand: runtimeConfig.nodeCommand,
    });
    report = await executeCheckSteps({
      session,
      runtime,
      sourcePath,
      sourceCode,
      mounted,
      depth: effectiveDepth,
      syntax,
      validation,
    });
  } finally {
    if (runtime) {
      await stopManagedRuntime({ ...runtime, stateFile: runtime.stateFile });
    }
  }

  if (!keepTemp && report.passed && runtimeConfig.cleanupOnSuccess) {
    // 保留报告目录与工作副本，便于回查；只清理状态文件和进程，由 stopManagedRuntime 完成。
  }

  return report;
}

async function executeCheckSteps({
  session,
  runtime,
  sourcePath,
  sourceCode,
  mounted,
  depth,
  syntax,
  validation,
}) {
  const report = {
    passed: false,
    sessionId: session.id,
    sourcePath,
    moduleName: mounted.moduleName,
    mountedPath: mounted.targetPath,
    reportDir: session.reportDir,
    runtime: {
      baseUrl: runtime.baseUrl,
      port: runtime.port,
      runtimeRoot: runtime.runtimeRoot,
      logPath: runtime.logPath,
      ocr: summarizeOcrRuntime(session.runtimeConfig?.ocr || {}),
    },
    depth,
    contentType: inferContentTypeFromCode(sourceCode),
    syntax,
    validation,
    steps: {},
    derived: {},
    summary: [],
    errors: [],
    warnings: [],
  };

  fs.mkdirSync(session.reportDir, { recursive: true });

  const configStep = await callStep({
    session,
    runtime,
    stepName: 'config',
    pathName: '/config',
  });
  report.steps.config = configStep;

  const homeStep = await callStep({
    session,
    runtime,
    stepName: 'home',
    pathName: `/api/${encodeURIComponent(mounted.moduleName)}`,
    query: { filter: 1 },
  });
  report.steps.home = homeStep;

  const homeJson = homeStep.json || {};
  const firstClass = Array.isArray(homeJson.class) ? homeJson.class.find((item) => item && item.type_id) : null;
  const firstHomeVod = Array.isArray(homeJson.list)
    ? homeJson.list.find((item) => item && (item.vod_id || item.url))
    : null;
  report.derived.categoryTid = firstClass?.type_id || inferTidFromCode(sourceCode) || '';
  report.derived.homeVodId = firstHomeVod?.vod_id || firstHomeVod?.url || '';
  report.derived.filterGroupCount = countFilterGroups(homeJson.filters, report.derived.categoryTid);

  if (report.derived.categoryTid) {
    report.steps.category = await callStep({
      session,
      runtime,
      stepName: 'category',
      pathName: `/api/${encodeURIComponent(mounted.moduleName)}`,
      query: {
        ac: 'videolist',
        t: report.derived.categoryTid,
        pg: 1,
      },
    });
  } else {
    report.steps.category = skippedStep('category', '未能自动推导 tid');
  }

  const filterCases = buildFilterTestCases(homeJson.filters || {}, homeJson.filter_def || {}, report.derived.categoryTid, 4);
  const filterable = Number(validation?.ruleSummary?.filterable ?? 0) > 0;
  report.derived.filterCases = filterCases.map((item) => ({
    name: item.name,
    label: item.label,
    mode: item.mode,
    ext: item.ext,
  }));
  if (filterable && report.derived.categoryTid && filterCases.length > 0) {
    report.steps.category_filters = await runCategoryFilterCases({
      session,
      runtime,
      moduleName: mounted.moduleName,
      tid: report.derived.categoryTid,
      cases: filterCases,
    });
  } else if (!filterable) {
    report.steps.category_filters = skippedStep('category_filters', '规则已设置 filterable=0，跳过筛选测试', 'info');
  } else {
    report.steps.category_filters = skippedStep('category_filters', '未识别到可用筛选组');
  }

  const categoryJson = report.steps.category.json || {};
  const firstCategoryVod = Array.isArray(categoryJson.list)
    ? categoryJson.list.find((item) => item && (item.vod_id || item.url))
    : null;
  report.derived.detailVodId = firstCategoryVod?.vod_id || firstCategoryVod?.url || '';

  if (report.derived.detailVodId) {
    report.steps.detail = await callStep({
      session,
      runtime,
      stepName: 'detail',
      pathName: `/api/${encodeURIComponent(mounted.moduleName)}`,
      query: {
        ac: 'detail',
        ids: report.derived.detailVodId,
      },
    });
  } else {
    report.steps.detail = skippedStep('detail', '未能自动推导 vod_id', 'error');
  }

  const detailJson = report.steps.detail.json || {};
  const detailVod = Array.isArray(detailJson.list) ? detailJson.list[0] : null;
  report.contentType = report.contentType || inferContentTypeFromVod(detailVod);
  report.derived.searchKeyword = deriveSearchKeyword(detailVod?.vod_name || mounted.moduleName);

  const catalog = parsePlayCatalog(detailVod || {});
  report.derived.catalog = summarizeCatalog(catalog);
  const catalogStepName = `${report.contentType || 'video'}_catalog`;
  report.steps[catalogStepName] = buildCatalogAuditStep({
    stepName: catalogStepName,
    contentType: report.contentType || 'video',
    vod: detailVod,
    catalog,
    session,
  });

  const searchable = Number(validation?.ruleSummary?.searchable ?? 1) > 0;
  if (searchable && report.derived.searchKeyword) {
    report.steps.search = await callStep({
      session,
      runtime,
      stepName: 'search',
      pathName: `/api/${encodeURIComponent(mounted.moduleName)}`,
      query: {
        wd: report.derived.searchKeyword,
        pg: 1,
      },
    });
  } else if (!searchable) {
    report.steps.search = skippedStep('search', '规则已设置 searchable=0，跳过搜索测试', 'info');
  } else {
    report.steps.search = skippedStep('search', '未能自动推导搜索关键词', 'warning');
  }

  if (depth === 'full' && (report.contentType || '') === 'comic') {
    await enrichComicCoverProbes(report, session, runtime);
  }

  if (depth === 'full') {
    if ((report.contentType || 'video') === 'video') {
      const firstPlay = catalog.firstEpisode || deriveFirstPlay(detailVod);
      report.derived.play = firstPlay;
      if (firstPlay?.flag && firstPlay?.url) {
        report.steps.play = await callStep({
          session,
          runtime,
          stepName: 'play',
          pathName: `/api/${encodeURIComponent(mounted.moduleName)}`,
          query: {
            flag: firstPlay.flag,
            play: firstPlay.url,
          },
        });
        await enrichPlayProbe(report.steps.play, session, runtime, 'video');
      } else {
        report.steps.play = skippedStep('play', '未能自动推导播放线路与剧集', 'error');
      }
    } else {
      await runReaderContentChecks({
        report,
        session,
        runtime,
        moduleName: mounted.moduleName,
        contentType: report.contentType,
        catalog,
      });
    }
  }

  finalizeReport(report);
  writeJsonFile(path.join(session.reportDir, 'report.json'), report);
  writeJsonFile(path.join(session.reportDir, 'verbose.json'), report);
  writeTextFile(path.join(session.reportDir, 'report.md'), renderMarkdownReport(report));
  return report;
}

async function callStep({ session, runtime, stepName, pathName, query = {} }) {
  const startedAt = Date.now();
  const url = new URL(pathName, `${runtime.baseUrl}/`);
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, `${value}`);
  }

  const response = await fetch(url);
  const raw = await response.text();
  const rawPath = path.join(session.rawRoot, `${stepName}.raw.json`);
  writeTextFile(rawPath, raw);

  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    parseError = error.message;
  }

  const warnings = [];
  const errors = [];
  const responseSummary = summarizeResponse(stepName, json, raw);
  const captchaRisk = detectCaptchaRisk(raw, json);
  const cryptoRisk = detectCryptoRisk(raw, json);
  const captchaTrace = extractCaptchaTrace(json);

  if (!response.ok) {
    errors.push(`HTTP ${response.status}`);
  }
  if (parseError) {
    errors.push(`JSON 解析失败: ${parseError}`);
  }
  if (captchaRisk === 'confirmed') {
    warnings.push('响应中命中验证码/安全验证特征');
  }
  if (cryptoRisk === 'confirmed') {
    warnings.push('响应中出现加密、解密风险或 CryptoJS 特征');
  }
  if (stepName !== 'config' && json) {
    const emptiness = detectEmptiness(stepName, json);
    if (emptiness === 'error') {
      errors.push('响应结构缺少关键字段');
    } else if (emptiness === 'warning') {
      warnings.push('响应为空或无有效结果');
    }
  }

  return {
    name: stepName,
    skipped: false,
    passed: errors.length === 0,
    durationMs: Date.now() - startedAt,
    request: {
      method: 'GET',
      url: url.toString(),
      query,
    },
    rawPath,
    responseSummary,
    captchaRisk,
    cryptoRisk,
    captchaTrace,
    warnings,
    errors,
    json,
  };
}

async function runCategoryFilterCases({ session, runtime, moduleName, tid, cases }) {
  const results = [];
  const warnings = [];
  const errors = [];
  let durationMs = 0;

  for (const item of cases) {
    const step = await callStep({
      session,
      runtime,
      stepName: `category-filter-${item.name}`,
      pathName: `/api/${encodeURIComponent(moduleName)}`,
      query: {
        ac: 'videolist',
        t: tid,
        pg: 1,
        ext: encodeCategoryExt(item.ext),
      },
    });
    durationMs += step.durationMs || 0;
    results.push({
      name: item.name,
      label: item.label,
      mode: item.mode,
      ext: item.ext,
      passed: step.passed,
      summary: step.responseSummary?.summary || '',
      listCount: step.responseSummary?.listCount || 0,
      rawPath: step.rawPath,
      requestUrl: step.request?.url || '',
      warnings: step.warnings || [],
      errors: step.errors || [],
    });
    for (const warning of step.warnings || []) {
      warnings.push(`${item.label}: ${warning}`);
    }
    for (const error of step.errors || []) {
      errors.push(`${item.label}: ${error}`);
    }
  }

  if (results.length > 0 && results.every((item) => Number(item.listCount || 0) === 0)) {
    errors.push('所有已测试筛选组合均返回空列表');
  }

  return {
    name: 'category_filters',
    skipped: false,
    passed: errors.length === 0,
    durationMs,
    request: null,
    rawPath: null,
    responseSummary: {
      summary: `专项筛选 ${results.filter((item) => item.passed).length}/${results.length} 通过`,
      caseCount: results.length,
    },
    captchaRisk: results.some((item) => item.warnings.some((warning) => /验证码|captcha|verify/i.test(warning))) ? 'suspected' : 'none',
    cryptoRisk: 'none',
    captchaTrace: [],
    warnings,
    errors,
    cases: results,
    json: null,
  };
}

function buildCatalogAuditStep({ stepName, contentType, vod, catalog, session }) {
  const warnings = [...(catalog.warnings || [])];
  const errors = [...(catalog.errors || [])];
  const typeLabel = contentType === 'novel' ? '小说' : contentType === 'comic' ? '漫画' : '影视';

  if (!vod || typeof vod !== 'object') {
    errors.push(`${typeLabel}详情结果为空`);
  } else {
    if (!String(vod.vod_name || '').trim()) {
      errors.push(`${typeLabel}详情缺少 vod_name`);
    }
    if (!String(vod.vod_content || '').trim()) {
      warnings.push(`${typeLabel}详情简介 vod_content 为空`);
    }
  }

  if ((contentType === 'novel' || contentType === 'comic') && catalog.episodeCount === 0) {
    errors.push(`${typeLabel}详情没有可供阅读器使用的章节目录`);
  }
  if (contentType === 'novel' && catalog.sources.length > 0
      && !catalog.sources.some((source) => /正文|目录|小说|阅读/i.test(source.name))) {
    warnings.push('小说目录线路名未包含“正文/目录/小说/阅读”，建议使用清晰的阅读线路名称');
  }
  if (contentType === 'comic' && catalog.sources.length > 0
      && !catalog.sources.some((source) => /漫画|图片|章节|阅读/i.test(source.name))) {
    warnings.push('漫画目录线路名未包含“漫画/图片/章节/阅读”，建议使用清晰的阅读线路名称');
  }

  const rawPath = path.join(session.rawRoot, `${stepName}.raw.json`);
  writeJsonFile(rawPath, { contentType, vod, catalog });
  return {
    name: stepName,
    skipped: false,
    passed: errors.length === 0,
    durationMs: 0,
    request: null,
    rawPath,
    responseSummary: {
      sourceCount: catalog.sourceCount,
      episodeCount: catalog.episodeCount,
      summary: `type=${contentType} sources=${catalog.sourceCount} chapters=${catalog.episodeCount}`,
    },
    captchaRisk: 'none',
    cryptoRisk: 'none',
    captchaTrace: [],
    warnings: uniqueStrings(warnings),
    errors: uniqueStrings(errors),
    catalog,
    json: null,
  };
}

async function runReaderContentChecks({ report, session, runtime, moduleName, contentType, catalog }) {
  const first = catalog.firstEpisode;
  const last = catalog.lastEpisode;
  report.derived.readerSamples = {
    first: first ? summarizeEpisode(first) : null,
    last: last ? summarizeEpisode(last) : null,
  };

  if (!first?.flag || !first?.url) {
    report.steps[`${contentType}_chapter_first`] = skippedStep(
      `${contentType}_chapter_first`,
      '目录中没有可测试的首章地址',
      'error',
    );
    report.steps[`${contentType}_chapter_last`] = skippedStep(
      `${contentType}_chapter_last`,
      '目录中没有可测试的末章地址',
      'info',
    );
    return;
  }

  const samples = [{ label: 'first', episode: first }];
  if (last?.flag && last?.url && (last.flag !== first.flag || last.url !== first.url)) {
    samples.push({ label: 'last', episode: last });
  }

  for (const sample of samples) {
    const stepName = `${contentType}_chapter_${sample.label}`;
    const step = await callStep({
      session,
      runtime,
      stepName,
      pathName: `/api/${encodeURIComponent(moduleName)}`,
      query: {
        flag: sample.episode.flag,
        play: sample.episode.url,
      },
    });
    step.chapter = summarizeEpisode(sample.episode);
    report.steps[stepName] = step;
    await enrichPlayProbe(step, session, runtime, contentType);
  }

  if (samples.length === 1) {
    report.steps[`${contentType}_chapter_last`] = skippedStep(
      `${contentType}_chapter_last`,
      '目录只有一个章节，首章已覆盖末章测试',
      'info',
    );
  }
}

function summarizeCatalog(catalog) {
  return {
    sourceCount: catalog.sourceCount,
    episodeCount: catalog.episodeCount,
    firstEpisode: catalog.firstEpisode ? summarizeEpisode(catalog.firstEpisode) : null,
    lastEpisode: catalog.lastEpisode ? summarizeEpisode(catalog.lastEpisode) : null,
    errors: catalog.errors,
    warnings: catalog.warnings,
  };
}

function summarizeEpisode(episode) {
  return {
    flag: episode.flag || '',
    name: episode.name || '',
    url: episode.url || '',
    sourceIndex: episode.sourceIndex,
    episodeIndex: episode.episodeIndex,
  };
}

async function enrichPlayProbe(step, session, runtime, contentType = 'video') {
  if (!step?.json || step.errors.length > 0) {
    return;
  }
  const payload = step.json;
  const probePath = path.join(session.rawRoot, `${step.name}-media-probe.raw.json`);

  if (contentType === 'novel') {
    let novel = parseNovelReaderPayload(payload.url);
    let textProbe = null;
    if (novel.mode === 'http' && novel.url) {
      textProbe = await probeTextResource({ url: novel.url, timeoutMs: 15000 });
      novel = {
        ...novel,
        status: textProbe.status,
        contentLength: textProbe.contentLength,
        error: textProbe.status === 'ok' ? '' : textProbe.error || textProbe.diagnosis || '小说正文 URL 不可读取',
      };
    }
    step.mediaProbe = {
      mode: 'novel',
      status: novel.status,
      contentType: novel.mode,
      url: payload.url || '',
      contentLength: novel.contentLength || 0,
      textProbe,
    };
    step.responseSummary = {
      ...step.responseSummary,
      playKind: 'novel',
      contentLength: novel.contentLength || 0,
      summary: `parse=${payload.parse ?? 'n/a'} novel=${novel.status} mode=${novel.mode} contentLength=${novel.contentLength || 0}`,
    };
    if (novel.status !== 'ok') {
      step.errors.push(novel.error || '小说章节正文不可用');
    } else if ((novel.contentLength || 0) < 20) {
      step.warnings.push(`小说章节正文过短: ${novel.contentLength || 0} 字符`);
    }
    writeJsonFile(probePath, {
      mode: 'novel',
      parse: payload.parse,
      url: payload.url,
      parsed: {
        mode: novel.mode,
        status: novel.status,
        title: novel.title,
        contentLength: novel.contentLength,
        error: novel.error,
        encodedJson: novel.encodedJson,
      },
      textProbe,
    });
    step.passed = step.errors.length === 0;
    return;
  }

  if (contentType === 'comic') {
    const comic = parseComicReaderPayload(payload.url);
    const headers = payload.header && typeof payload.header === 'object' ? payload.header : {};
    const firstImageProbe = comic.images[0]
      ? await probeImageResource({ url: comic.images[0], runtime, headers })
      : null;
    const lastImageUrl = comic.images[comic.images.length - 1];
    const lastImageProbe = lastImageUrl && lastImageUrl !== comic.images[0]
      ? await probeImageResource({ url: lastImageUrl, runtime, headers })
      : null;
    const imagesOk = comic.imageCount > 0
      && (!firstImageProbe || firstImageProbe.status === 'ok')
      && (!lastImageProbe || lastImageProbe.status === 'ok');
    step.mediaProbe = {
      mode: 'comic',
      status: imagesOk ? 'ok' : 'invalid',
      contentType: comic.format,
      url: payload.url || '',
      imageCount: comic.imageCount,
      firstImageProbe,
      lastImageProbe,
    };
    step.responseSummary = {
      ...step.responseSummary,
      playKind: 'comic',
      imageCount: comic.imageCount,
      firstImageKind: firstImageProbe?.imageKind || '',
      lastImageKind: lastImageProbe?.imageKind || '',
      summary: `parse=${payload.parse ?? 'n/a'} comic=${comic.status} format=${comic.format} pics=${comic.imageCount}${firstImageProbe ? ` first=${firstImageProbe.status}/${firstImageProbe.imageKind || 'unknown'}` : ''}${lastImageProbe ? ` last=${lastImageProbe.status}/${lastImageProbe.imageKind || 'unknown'}` : ''}`,
    };
    if (comic.imageCount === 0) {
      step.errors.push(comic.error || '漫画章节没有图片地址');
    }
    if (firstImageProbe && firstImageProbe.status !== 'ok') {
      step.errors.push(`漫画章节首图不可解码: ${describeImageProbeFailure(firstImageProbe)}`);
    }
    if (lastImageProbe && lastImageProbe.status !== 'ok') {
      step.errors.push(`漫画章节末图不可解码: ${describeImageProbeFailure(lastImageProbe)}`);
    }
    writeJsonFile(probePath, {
      mode: 'comic',
      parse: payload.parse,
      url: payload.url,
      format: comic.format,
      imageCount: comic.imageCount,
      images: comic.images.slice(0, 8),
      firstImageProbe,
      lastImageProbe,
    });
    step.passed = step.errors.length === 0;
    return;
  }

  if (Number(payload.parse) === 0 && payload.url) {
    if (isBtPlayableUrl(payload.url)) {
      step.mediaProbe = {
        mode: 'bt',
        status: 'ok',
        contentType: 'application/x-bittorrent',
        url: payload.url,
      };
      step.responseSummary = {
        ...step.responseSummary,
        playKind: 'bt',
        summary: `parse=${payload.parse} bt=yes`,
      };
      writeJsonFile(probePath, {
        mode: 'bt',
        parse: payload.parse,
        url: payload.url,
      });
      return;
    }
    step.mediaProbe = {
      mode: 'link-only',
      status: 'skipped',
      contentType: '',
      url: payload.url,
    };
    step.responseSummary = {
      ...step.responseSummary,
      playKind: 'video',
    };
    writeJsonFile(probePath, {
      skipped: true,
      reason: 'link-only-check',
      parse: payload.parse,
      url: payload.url,
      header: payload.header && typeof payload.header === 'object' ? payload.header : {},
    });
    if (!looksLikePlayableUrl(payload.url, '')) {
      step.warnings.push('播放返回 parse=0，但 url 看起来不像直链');
    }
  } else if (Number(payload.parse) === 1) {
    step.warnings.push('播放结果仍需解析 parse=1');
  } else if (!payload.url) {
    step.errors.push('播放结果缺少 url');
  }
  step.passed = step.errors.length === 0;
}

async function enrichComicCoverProbes(report, session, runtime) {
  const targets = [
    ['home', report.steps.home],
    ['category', report.steps.category],
    ['detail', report.steps.detail],
    ['search', report.steps.search],
  ];

  for (const [name, step] of targets) {
    if (!step || step.skipped || !step.json || step.errors.length > 0) {
      continue;
    }
    const imageUrl = pickFirstVodImageUrl(step.json);
    if (!imageUrl) {
      continue;
    }
    const probe = await probeImageResource({ url: imageUrl, runtime });
    step.imageProbe = probe;
    writeJsonFile(path.join(session.rawRoot, `${name}-image-probe.raw.json`), probe);
    step.responseSummary = {
      ...step.responseSummary,
      imageProbe: probe.status,
      imageKind: probe.imageKind || '',
      summary: `${step.responseSummary?.summary || ''} image=${probe.status}/${probe.imageKind || 'unknown'}`,
    };
    if (probe.status !== 'ok') {
      step.errors.push(`封面图片不可解码: ${probe.error || probe.diagnosis || probe.headHex || probe.httpStatus}`);
    }
    step.passed = step.errors.length === 0;
  }
}

function finalizeReport(report) {
  const steps = Object.values(report.steps || {});
  for (const step of steps) {
    if (!step) continue;
    for (const warning of step.warnings || []) {
      report.warnings.push(`[${step.name}] ${warning}`);
    }
    for (const error of step.errors || []) {
      report.errors.push(`[${step.name}] ${error}`);
    }
  }
  if (!report.syntax.passed) {
    report.errors.unshift(`[syntax] ${report.syntax.errorMessage}`);
  }
  if (!report.validation.passed) {
    for (const issue of report.validation.issues || []) {
      report.errors.push(`[validate] ${issue}`);
    }
  }
  report.passed = report.errors.length === 0 && Object.values(report.steps).every((step) => step.skipped || step.passed);
  report.summary.push(`模块: ${report.moduleName}`);
  report.summary.push(`内容类型: ${report.contentType || 'video'}`);
  report.summary.push(`深度: ${report.depth}`);
  report.summary.push(`语法校验: ${report.syntax.passed ? '通过' : '失败'}`);
  report.summary.push(`结构校验: ${report.validation.passed ? '通过' : '失败'}`);
  report.summary.push(`OCR: ${report.runtime?.ocr?.configured ? `已配置(${report.runtime.ocr.mode})` : '未配置'}`);
  report.summary.push(`实跑结果: ${report.passed ? '通过' : '失败'}`);
}

function skippedStep(name, reason, severity = 'warning') {
  return {
    name,
    skipped: true,
    passed: false,
    durationMs: 0,
    request: null,
    rawPath: null,
    responseSummary: { summary: reason },
    captchaRisk: 'none',
    cryptoRisk: 'none',
    captchaTrace: [],
    warnings: severity === 'warning' ? [reason] : [],
    errors: severity === 'error' ? [reason] : [],
    json: null,
  };
}

function detectCaptchaRisk(raw, json) {
  if (detectCaptchaMarkers(raw)) {
    return 'confirmed';
  }
  const text = JSON.stringify(json || {});
  if (detectCaptchaMarkers(text)) {
    return 'suspected';
  }
  return 'none';
}

function detectCryptoRisk(raw, json) {
  const text = `${String(raw || '')}\n${JSON.stringify(json || {})}`;
  return /(CryptoJS unavailable|AES-CBC|token decode|decrypt failed|crypto unavailable)/i.test(text)
    ? 'confirmed'
    : 'none';
}

function extractCaptchaTrace(json) {
  const logs = json?._debug?.logs;
  if (!Array.isArray(logs)) {
    return [];
  }
  return logs
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => /(verify|captcha|ocr|cookie|btwaf)/i.test(item))
    .slice(-12);
}

function summarizeResponse(stepName, json, raw) {
  if (!json || typeof json !== 'object') {
    return {
      summary: `原始响应 ${raw.length} 字符，非 JSON`,
    };
  }
  if (stepName === 'config') {
    return {
      summary: `发现 ${(json.modules || []).length || 0} 个模块`,
    };
  }
  if (Array.isArray(json.class) || Array.isArray(json.list)) {
    return {
      classCount: Array.isArray(json.class) ? json.class.length : 0,
      listCount: Array.isArray(json.list) ? json.list.length : 0,
      summary: `class=${Array.isArray(json.class) ? json.class.length : 0} list=${Array.isArray(json.list) ? json.list.length : 0}`,
    };
  }
  if (stepName === 'play' || /_(?:chapter|content)_(?:first|last)$/.test(stepName)) {
    return {
      parse: json.parse,
      url: json.url || '',
      summary: `parse=${json.parse ?? 'n/a'} url=${json.url ? 'yes' : 'no'}`,
    };
  }
  return {
    summary: `返回对象 keys=${Object.keys(json).join(', ')}`,
  };
}

function detectEmptiness(stepName, json) {
  if (stepName === 'home') {
    if (!Array.isArray(json.class) && !Array.isArray(json.list)) {
      return 'error';
    }
    if ((json.class || []).length === 0 && (json.list || []).length === 0) {
      return 'error';
    }
    return 'ok';
  }
  if (stepName === 'category' || stepName === 'search') {
    if (!Array.isArray(json.list)) {
      return 'error';
    }
    return json.list.length === 0 ? 'error' : 'ok';
  }
  if (stepName === 'detail') {
    if (!Array.isArray(json.list)) {
      return 'error';
    }
    if (json.list.length === 0) {
      return 'error';
    }
    const first = json.list[0] || {};
    if (!first.vod_id && !first.vod_name) {
      return 'error';
    }
    return 'ok';
  }
  return 'ok';
}

function deriveSearchKeyword(title) {
  const text = String(title || '').replace(/\s+/g, '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= 4) {
    return text;
  }
  return text.slice(0, 4);
}

function deriveFirstPlay(vod) {
  const from = String(vod?.vod_play_from || '');
  const urls = String(vod?.vod_play_url || '');
  if (!from || !urls) {
    return null;
  }
  const firstFlag = from.split('$$$').find(Boolean);
  const firstGroup = urls.split('$$$').find(Boolean);
  const firstEpisode = firstGroup?.split('#').find(Boolean);
  if (!firstFlag || !firstEpisode) {
    return null;
  }
  const parts = firstEpisode.split('$');
  return {
    flag: firstFlag,
    name: parts[0] || '',
    url: parts[1] || parts[0] || '',
  };
}

function looksLikePlayableUrl(url, contentType) {
  const value = String(url || '');
  const type = String(contentType || '').toLowerCase();
  return isBtPlayableUrl(value) || /(m3u8|mp4|flv)(\?|$)/i.test(value) || /(video|mpegurl|octet-stream)/i.test(type);
}

function isBtPlayableUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  return value.startsWith('magnet:') ||
    value.endsWith('.torrent') ||
    value.includes('.torrent?') ||
    value.includes('.torrent&');
}

function inferTidFromCode(code) {
  const match = String(code || '').match(/class_url\s*:\s*['"]([^'"]+)['"]/i);
  const first = match?.[1]?.split('&').find(Boolean);
  return first || '';
}

function inferContentTypeFromCode(code) {
  const match = String(code || '').match(/类型\s*:\s*['"](影视|小说|漫画)['"]/);
  if (!match || !match[1]) {
    return '';
  }
  if (match[1] === '小说') return 'novel';
  if (match[1] === '漫画') return 'comic';
  return 'video';
}

function inferContentTypeFromVod(vod) {
  const from = String(vod?.vod_play_from || '');
  const urls = String(vod?.vod_play_url || '');
  if (/正文|小说/i.test(from) || /novel:\/\//i.test(urls)) {
    return 'novel';
  }
  if (/图片|漫画/i.test(from) || /pics:\/\//i.test(urls)) {
    return 'comic';
  }
  return 'video';
}

function pickFirstVodImageUrl(json) {
  const list = Array.isArray(json?.list) ? json.list : [];
  const first = list.find((item) => item && (item.vod_pic || item.pic_url || item.pic || item.img || item.image));
  return String(first?.vod_pic || first?.pic_url || first?.pic || first?.img || first?.image || '').trim();
}

async function probeImageResource({ url, runtime, headers = {}, timeoutMs = 15000 }) {
  const startedAt = Date.now();
  const targetUrl = normalizeProbeUrl(url, runtime);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`image probe timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(targetUrl, {
      headers: normalizeProbeHeaders(headers),
      redirect: 'follow',
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const imageKind = detectImageKind(buffer, response.headers.get('content-type') || '');
    const headHex = buffer.slice(0, Math.min(buffer.length, 16)).toString('hex');
    const contentType = response.headers.get('content-type') || '';
    const diagnosis = imageKind
      ? ''
      : diagnoseImageProbeFailure({ response, contentType, buffer });
    return {
      status: response.ok && Boolean(imageKind) ? 'ok' : 'invalid',
      url: targetUrl,
      isProxy: isRuntimeProxyUrl(targetUrl, runtime),
      httpStatus: response.status,
      contentType,
      contentLength: buffer.length,
      imageKind,
      headHex,
      diagnosis,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: 'error',
      url: targetUrl,
      isProxy: isRuntimeProxyUrl(targetUrl, runtime),
      httpStatus: 0,
      contentType: '',
      contentLength: 0,
      imageKind: '',
      headHex: '',
      error: error.message,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeTextResource({ url, timeoutMs = 15000 }) {
  const startedAt = Date.now();
  const targetUrl = String(url || '').startsWith('//') ? `https:${url}` : String(url || '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`text probe timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(targetUrl, {
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await response.text();
    const contentLength = text.length;
    const captcha = detectCaptchaMarkers(text);
    return {
      status: response.ok && contentLength > 0 && !captcha ? 'ok' : 'invalid',
      url: response.url || targetUrl,
      httpStatus: response.status,
      contentType: response.headers.get('content-type') || '',
      contentLength,
      captcha,
      diagnosis: captcha ? 'captcha-or-security-page' : response.ok && contentLength === 0 ? 'empty-text-response' : '',
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: 'error',
      url: targetUrl,
      httpStatus: 0,
      contentType: '',
      contentLength: 0,
      error: error.message,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeProbeUrl(url, runtime) {
  const value = String(url || '').trim();
  if (value.startsWith('//')) {
    return `https:${value}`;
  }
  if (value.startsWith('/')) {
    return new URL(value, `${runtime.baseUrl}/`).toString();
  }
  return value;
}

function isRuntimeProxyUrl(url, runtime) {
  return String(url || '').startsWith(`${String(runtime?.baseUrl || '').replace(/\/+$/g, '')}/proxy/`);
}

function normalizeProbeHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value !== undefined && value !== null && value !== '') {
      result[String(key)] = String(value);
    }
  }
  return result;
}

function detectImageKind(buffer, contentType = '') {
  if (!buffer || buffer.length < 4) {
    return '';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') {
    return 'gif';
  }
  if (buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp' && /avif/i.test(buffer.slice(8, 16).toString('ascii'))) {
    return 'avif';
  }
  const textHead = buffer.slice(0, Math.min(buffer.length, 128)).toString('utf8').trimStart();
  if (/^<svg[\s>]/i.test(textHead) || /image\/svg/i.test(contentType)) {
    return 'svg';
  }
  return '';
}

function diagnoseImageProbeFailure({ response, contentType, buffer }) {
  if (!response.ok) {
    return `http-${response.status}`;
  }
  const headText = buffer.slice(0, Math.min(buffer.length, 80)).toString('utf8');
  if (/^\s*</.test(headText)) {
    return 'html-or-xml-response';
  }
  if (/image\//i.test(contentType)) {
    return 'image-response-not-decodable-maybe-encrypted-or-scrambled';
  }
  return 'non-image-response';
}

function describeImageProbeFailure(probe) {
  return probe.error || probe.diagnosis || probe.headHex || `HTTP ${probe.httpStatus}`;
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push(`# Live Check Report`);
  lines.push('');
  lines.push(`- 模块: ${report.moduleName}`);
  lines.push(`- 会话: ${report.sessionId}`);
  lines.push(`- 深度: ${report.depth}`);
  lines.push(`- 结果: ${report.passed ? '通过' : '失败'}`);
  lines.push(`- 源文件: ${report.sourcePath}`);
  lines.push(`- 运行时: ${report.runtime.baseUrl}`);
  lines.push(`- OCR: ${report.runtime?.ocr?.configured ? `已配置(${report.runtime.ocr.mode}, retry=${report.runtime.ocr.retry})` : '未配置'}`);
  lines.push('');
  lines.push('## 静态校验');
  lines.push(`- syntax: ${report.syntax.passed ? '通过' : `失败 - ${report.syntax.errorMessage}`}`);
  lines.push(`- validate: ${report.validation.passed ? '通过' : '失败'}`);
  for (const issue of report.validation.issues || []) {
    lines.push(`- issue: ${issue}`);
  }
  for (const warning of report.validation.warnings || []) {
    lines.push(`- warning: ${warning}`);
  }
  lines.push('');
  lines.push('## 实跑步骤');
  for (const [name, step] of Object.entries(report.steps || {})) {
    lines.push(`### ${name}`);
    lines.push(`- 通过: ${step.passed ? '是' : '否'}${step.skipped ? '（跳过）' : ''}`);
    if (step.request) {
      lines.push(`- 请求: ${step.request.url}`);
    }
    lines.push(`- 耗时: ${step.durationMs}ms`);
    lines.push(`- 概要: ${step.responseSummary?.summary || ''}`);
    lines.push(`- 验证码风险: ${step.captchaRisk}`);
    if (step.imageProbe) {
      lines.push(`- 图片探测: ${step.imageProbe.status} / ${step.imageProbe.imageKind || 'unknown'} / HTTP ${step.imageProbe.httpStatus}`);
    }
    if (step.mediaProbe?.firstImageProbe) {
      const probe = step.mediaProbe.firstImageProbe;
      lines.push(`- 章节图片探测: ${probe.status} / ${probe.imageKind || 'unknown'} / HTTP ${probe.httpStatus}`);
    }
    if (step.mediaProbe?.lastImageProbe) {
      const probe = step.mediaProbe.lastImageProbe;
      lines.push(`- 章节末图探测: ${probe.status} / ${probe.imageKind || 'unknown'} / HTTP ${probe.httpStatus}`);
    }
    if (step.mediaProbe?.textProbe) {
      const probe = step.mediaProbe.textProbe;
      lines.push(`- 正文 URL 探测: ${probe.status} / ${probe.contentLength || 0} 字符 / HTTP ${probe.httpStatus}`);
    }
    for (const warning of step.warnings || []) {
      lines.push(`- warning: ${warning}`);
    }
    for (const error of step.errors || []) {
      lines.push(`- error: ${error}`);
    }
    if (step.rawPath) {
      lines.push(`- raw: ${step.rawPath}`);
    }
    if (Array.isArray(step.cases) && step.cases.length > 0) {
      for (const item of step.cases) {
        lines.push(`- case: ${item.label} => ${item.passed ? '通过' : '失败'} / ${item.summary || ''}`);
      }
    }
    lines.push('');
  }
  if (report.warnings.length > 0) {
    lines.push('## 汇总警告');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }
  if (report.errors.length > 0) {
    lines.push('## 汇总错误');
    for (const error of report.errors) {
      lines.push(`- ${error}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function buildLiveCheckStdout(report, verbose = false) {
  if (verbose) return report;
  const compactSteps = {};
  for (const [name, step] of Object.entries(report.steps || {})) {
    compactSteps[name] = {
      passed: Boolean(step?.passed),
      skipped: Boolean(step?.skipped),
      durationMs: step?.durationMs ?? 0,
      summary: step?.responseSummary?.summary || '',
      captchaRisk: step?.captchaRisk || 'none',
      cryptoRisk: step?.cryptoRisk || 'none',
      warnings: step?.warnings || [],
      errors: step?.errors || [],
      url: step?.request?.url || '',
      mediaProbe: step?.mediaProbe ? {
        mode: step.mediaProbe.mode,
        status: step.mediaProbe.status,
        contentType: step.mediaProbe.contentType,
        url: summarizeMediaUrl(step.mediaProbe.url),
        contentLength: step.mediaProbe.contentLength,
        imageCount: step.mediaProbe.imageCount,
        firstImageProbe: step.mediaProbe.firstImageProbe ? pruneImageProbe(step.mediaProbe.firstImageProbe) : undefined,
        lastImageProbe: step.mediaProbe.lastImageProbe ? pruneImageProbe(step.mediaProbe.lastImageProbe) : undefined,
        textProbe: step.mediaProbe.textProbe,
      } : undefined,
      imageProbe: step?.imageProbe ? pruneImageProbe(step.imageProbe) : undefined,
      cases: Array.isArray(step?.cases) ? step.cases.map((item) => ({
        name: item.name,
        label: item.label,
        mode: item.mode,
        ext: item.ext,
        passed: item.passed,
        summary: item.summary,
        listCount: item.listCount,
        requestUrl: item.requestUrl,
        warnings: item.warnings,
        errors: item.errors,
      })) : undefined,
    };
  }
  return {
    passed: report.passed,
    contentType: report.contentType || 'video',
    sessionId: report.sessionId,
    moduleName: report.moduleName,
    sourcePath: report.sourcePath,
    reportDir: report.reportDir,
    runtime: { baseUrl: report.runtime?.baseUrl || '', port: report.runtime?.port || 0 },
    ocr: report.runtime?.ocr || {},
    depth: report.depth,
    summary: report.summary,
    errors: report.errors,
    warnings: report.warnings,
    derived: pruneObject(report.derived || {}),
    steps: compactSteps,
  };
}

function pruneImageProbe(probe) {
  return {
    status: probe.status,
    isProxy: Boolean(probe.isProxy),
    httpStatus: probe.httpStatus,
    contentType: probe.contentType,
    contentLength: probe.contentLength,
    imageKind: probe.imageKind,
    headHex: probe.headHex,
    diagnosis: probe.diagnosis,
    error: probe.error,
    durationMs: probe.durationMs,
    url: probe.url,
  };
}

function summarizeOcrRuntime(ocrConfig = {}) {
  const configured = Boolean(
    (ocrConfig.mode === 'http' && ocrConfig.endpoint)
    || (ocrConfig.mode === 'command' && ocrConfig.command),
  );
  return {
    configured,
    mode: ocrConfig.mode || 'none',
    endpoint: ocrConfig.endpoint || ocrConfig.command || '',
    retry: Number(ocrConfig.retry || 3),
    timeoutMs: Number(ocrConfig.timeoutMs || 15000),
    bodyMode: ocrConfig.bodyMode || 'auto',
    responsePath: ocrConfig.responsePath || '',
  };
}

export function buildLiveHealStdout(result, verbose = false) {
  if (verbose) return result;
  return {
    passed: result.passed,
    sourcePath: result.sourcePath,
    healRoot: result.healRoot,
    rounds: result.rounds,
    history: result.history,
    finalReport: result.finalReport ? buildLiveCheckStdout(result.finalReport, false) : null,
  };
}

function countFilterGroups(filters, tid) {
  const source = filters?.[tid] || filters?.['*'] || Object.values(filters || {})[0] || [];
  return Array.isArray(source) ? source.length : 0;
}

function pruneObject(value) {
  const result = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === undefined || item === null || item === '') continue;
    result[key] = item;
  }
  return result;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function summarizeMediaUrl(url) {
  const value = String(url || '');
  if (value.startsWith('novel://')) {
    return `novel://[正文已省略, ${value.length - 'novel://'.length} 字符]`;
  }
  if (value.startsWith('pics://')) {
    return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  }
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}
