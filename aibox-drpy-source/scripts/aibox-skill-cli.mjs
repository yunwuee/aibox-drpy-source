#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { inspectNativeEngineAvailability, runNativeEngineOperation } from './lib/aibox-engine-adapter.mjs';
import { findAiboxEngineRoot } from './lib/aibox-paths.mjs';
import { ensureSafeChildPath, loadConfig } from './lib/config.mjs';
import { createKnowledgeBase } from './lib/knowledge-base.mjs';
import {
  createSession,
  ensureRuntimeRunning,
  readStateFile,
  resolveEmbeddedDrpyConfig,
  runDrpyDoctor,
  stopManagedRuntime,
  writeJsonFile,
} from './lib/embedded-drpy-manager.mjs';
import {
  analyzePageContent,
  buildRuleBlueprint,
  checkDrpyRuleSyntax,
  composeDrpyRule,
  debugDrpyRule,
  listReferenceExamples,
  planSourceWorkflow,
  saveRuleToFile,
  validateDrpyRule,
} from './lib/rule-utils.mjs';
import { runRuleCheck } from './lib/rule-checker.mjs';
import { analyzeRuleSource } from './lib/rule-ast.mjs';
import { createSafeRulePatch } from './lib/safe-rule-fixer.mjs';
import { fetchSource, guessTemplateCandidates, triageSite } from './lib/site-triage.mjs';
import { loadRuleSource, loadRuleSourceFile } from './lib/source-loader.mjs';
import {
  resolveClipboardShareConfig,
  uploadGroup,
  uploadSingleSource,
} from './lib/source-share-service.mjs';
import {
  listEngineTemplateNames,
  loadEngineTemplates,
  mergeTemplateRule,
  summarizeResolvedRule,
} from './lib/template-service.mjs';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const skillRoot = path.resolve(currentDir, '..');
const defaultOutputDir = path.join(skillRoot, 'output');
const knowledgeBase = createKnowledgeBase(skillRoot);

function knownTemplateSet(engineRoot) {
  return new Set([...listEngineTemplateNames({ engineRoot }), '自动']);
}

const aliases = new Map([
  ['drpy-doctor', ['doctor']],
  ['compose-rule', ['compose']],
  ['validate-rule', ['lint']],
  ['check-syntax', ['lint', '--syntax-only']],
  ['save-rule', ['save']],
  ['upload-clipboard', ['share']],
  ['debug-rule', ['debug-selector']],
  ['live-check', ['check']],
  ['live-heal', ['heal']],
  ['drpy-start', ['runtime', 'start']],
  ['drpy-stop', ['runtime', 'stop']],
  ['list-resources', ['resources', 'list']],
  ['read-resource', ['resources', 'read']],
]);

const capabilityMap = {
  primary: {
    doctor: '环境、原生引擎、OCR 与分享配置检查',
    triage: '站型、内容类型、风险与最低复杂度路线分析',
    templates: '真实 Aibox 模板 list/guess',
    resolved: '源码解密与模板继承展开',
    compose: '生成紧凑 DS 源',
    lint: 'L1 AST 静态校验',
    check: 'L1/L2/L3 真实链路校验',
    heal: 'AST 安全候选补丁',
    save: '校验后原子保存',
    share: '云1/云G1 上传与回读校验',
  },
  resources: ['resources list', 'resources read', 'render-prompt'],
  legacyAliases: Object.fromEntries([...aliases.entries()].map(([name, target]) => [name, target.join(' ')])),
};

const helpText = `Aibox 写源助手

用法:
  node ./scripts/aibox-skill-cli.mjs <command> [subcommand] [options]

主命令:
  doctor                              检查原生引擎、便携 runtime、OCR 与配置
  triage --url <url>                  判断 template/html/hybrid/api 路线
  templates list                     列出当前 Aibox 真实模板
  templates guess --url <url>        基于页面证据推荐模板
  resolved --code-file <js>          解密并展开模板后的规则摘要
  compose --input-file <json>         生成紧凑规则；--code-only 只输出源码
  lint --code-file <js>               L1 AST/header/模板/播放契约检查
  check --code-file <js>              实跑；--level l1|l2|l3 --engine auto|native|portable
  heal --code-file <js>               输出安全 diff；--apply 才写入
  save --code-file <js>               校验后原子保存；--file-name 必填
  share --code-file <js>              云1 上传并回读；分组使用 --group-file
  resources list|read                 列出或读取知识资源
  debug-selector                      调试 pdfa/pdfh/pd
  runtime start|stop                  手动管理便携 runtime，默认随机端口

关键参数:
  --input-file/--input-json            JSON 输入
  --content-file/--code-file           页面内容或规则源码文件
  --module <name>                      从配置源码目录解析模块
  --engine-root <dir>                 指定当前 Aibox 引擎目录
  --level l1|l2|l3                     证据级别，默认 l3
  --engine auto|native|portable        执行引擎，默认 auto
  --bump patch|minor|major             递增 version
  --apply                              应用 heal 补丁
  --force                              明确越过分享门禁
  --no-verify                          跳过云端回读，仅显式使用
  --copy                               把分享码复制到 Windows 剪贴板
  --verbose                            输出完整原始结果

旧命令仍可调用，但只作为 deprecated alias。
`;

main().catch((error) => {
  emit({
    ok: false,
    command: currentCommand(),
    error: serializeError(error),
  }, 2);
});

async function main() {
  let tokens = process.argv.slice(2);
  if (!tokens.length || ['help', '--help', '-h'].includes(tokens[0])) {
    process.stdout.write(`${helpText}\n`);
    return;
  }

  let deprecated = null;
  if (aliases.has(tokens[0])) {
    deprecated = { command: tokens[0], replacement: aliases.get(tokens[0]).join(' ') };
    tokens = [...aliases.get(tokens[0]), ...tokens.slice(1)];
  }
  const command = tokens.shift();
  const parsed = parseArgs(tokens);
  const config = loadCliConfig(parsed.flags);

  const result = await dispatch(command, parsed, config);
  if (result?.raw !== undefined) {
    process.stdout.write(String(result.raw));
    if (!String(result.raw).endsWith('\n')) process.stdout.write('\n');
    return;
  }
  const data = result?.data ?? result;
  const passed = result?.passed ?? data?.passed ?? true;
  const payload = passed
    ? { ok: true, command, ...(deprecated ? { deprecated } : {}), data }
    : {
        ok: false,
        command,
        ...(deprecated ? { deprecated } : {}),
        error: {
          code: result?.errorCode || firstDiagnosticCode(data) || 'CHECK_FAILED',
          message: result?.errorMessage || firstErrorMessage(data) || '命令执行完成，但验收未通过',
          suggestions: result?.suggestions || [],
        },
        data,
      };
  emit(sanitizeOutput(payload, { verbose: toBoolean(parsed.flags.verbose) }), passed ? 0 : 1);
}

async function dispatch(command, parsed, config) {
  const { flags, positionals } = parsed;
  switch (command) {
    case 'doctor':
      return commandDoctor(flags, config);
    case 'triage':
      return commandTriage(flags);
    case 'templates':
      return commandTemplates(positionals[0] || 'list', flags);
    case 'resolved':
      return commandResolved(flags, config);
    case 'compose':
      return commandCompose(flags);
    case 'lint':
      return commandLint(flags, config);
    case 'check':
      return commandCheck(flags, config);
    case 'heal':
      return commandHeal(flags, config);
    case 'save':
      return commandSave(flags, config);
    case 'share':
      return commandShare(flags, config);
    case 'resources':
      return commandResources(positionals[0] || 'list', flags);
    case 'debug-selector':
      return commandDebugSelector(flags);
    case 'runtime':
      return commandRuntime(positionals[0] || 'start', flags, config);
    case 'fetch-web-source':
      return commandFetch(flags);
    case 'analyze-content':
      return commandAnalyze(flags);
    case 'list-examples':
      return { data: { examples: listReferenceExamples(knowledgeBase) } };
    case 'build-blueprint':
      return { data: buildRuleBlueprint(readJsonArgs(flags)) };
    case 'plan-workflow':
      return { data: planSourceWorkflow(readJsonArgs(flags)) };
    case 'render-prompt':
      return commandRenderPrompt(flags);
    case 'ocr-check':
      return commandOcr(flags, config);
    case 'print-capabilities':
      return { data: capabilityMap };
    default:
      throw codedError('UNKNOWN_COMMAND', `未知命令: ${command}`);
  }
}

async function commandDoctor(flags, config) {
  const native = inspectNativeEngineAvailability(skillRoot, { engineRoot: flags['engine-root'] });
  const portable = await runDrpyDoctor(skillRoot, config, { ocrImageBase64: resolveOcrImageBase64(flags) });
  const passed = Boolean(portable.passed);
  return {
    data: {
      passed,
      native,
      portable,
      node: process.version,
      dependencies: ['acorn', 'acorn-walk', 'magic-string', 'iconv-lite', 'tough-cookie'],
    },
    passed,
    errorCode: passed ? null : 'DOCTOR_PORTABLE_FAILED',
  };
}

async function commandTriage(flags) {
  const input = readJsonArgs(flags);
  if (flags.url) input.url = String(flags.url);
  if (flags['engine-root']) input.engineRoot = String(flags['engine-root']);
  if (flags['content-file']) input.content = readText(resolveUserPath(flags['content-file']));
  if (!input.url && !input.content) throw codedError('TRIAGE_INPUT_REQUIRED', 'triage 需要 --url 或 --content-file');
  return { data: await triageSite(input) };
}

async function commandTemplates(subcommand, flags) {
  if (subcommand === 'list') {
    const names = listEngineTemplateNames({ engineRoot: flags['engine-root'] });
    return { data: { templates: names, count: names.length, source: 'third_party/aibox-engine/libs_drpy/template.js' } };
  }
  if (subcommand !== 'guess') throw codedError('TEMPLATE_SUBCOMMAND_INVALID', `templates 不支持 ${subcommand}`);
  let html = flags['content-file'] ? readText(resolveUserPath(flags['content-file'])) : '';
  let url = flags.url ? String(flags.url) : '';
  if (!html && url) {
    const fetched = await fetchSource({ url });
    html = fetched.body;
    url = fetched.url;
  }
  if (!html) throw codedError('TEMPLATE_GUESS_INPUT_REQUIRED', 'templates guess 需要 --url 或 --content-file');
  return { data: { url, candidates: await guessTemplateCandidates({ html, url, engineRoot: flags['engine-root'] }) } };
}

async function commandResolved(flags, config) {
  const codeFile = resolveCodeFile(flags, config);
  const loaded = await loadRuleSourceFile(codeFile);
  const engineRoot = flags['engine-root'];
  const analysis = analyzeRuleSource(loaded.code, { knownTemplates: knownTemplateSet(engineRoot) });
  const native = await runNativeEngineOperation('getRuleObject', {
    skillRoot,
    engineRoot,
    sourcePath: codeFile,
    timeoutMs: numberOr(flags['timeout-ms'], 45_000),
  });
  const verbose = toBoolean(flags.verbose);
  if (native.ok) {
    return { data: sanitizeOutput({ source: sourceMeta(loaded, verbose), engine: 'native', fidelity: native.fidelity, isolation: native.isolation, resolved: native.data, summary: summarizeResolvedRule(native.data), analysis: verbose ? analysis : compactAnalysis(analysis) }, { verbose }) };
  }
  const templateName = analysis.rule?.staticFields?.['模板'];
  let resolved = analysis.rule?.staticFields || {};
  if (templateName) {
    const templates = await loadEngineTemplates({ engineRoot });
    resolved = mergeTemplateRule(templates[templateName], resolved);
  }
  return { data: sanitizeOutput({ source: sourceMeta(loaded, verbose), engine: 'static', fidelity: 'static-template', nativeError: native.error, resolved, summary: summarizeResolvedRule(resolved), analysis: verbose ? analysis : compactAnalysis(analysis) }, { verbose }) };
}

async function commandCompose(flags) {
  const input = readJsonArgs(flags);
  if (flags['engine-root']) input.engineRoot = flags['engine-root'];
  const code = composeDrpyRule(input);
  if (toBoolean(flags['code-only'])) return { raw: code };
  const validation = validateDrpyRule(code, { engineRoot: input.engineRoot });
  return { data: { code, validation: compactValidation(validation, toBoolean(flags.verbose)), contentType: detectContentType(code), sourceKind: input.sourceKind || 'html', implementationMode: input.implementationMode || 'auto' }, passed: validation.passed };
}

async function commandLint(flags, config) {
  const codeFile = resolveOptionalCodeFile(flags, config);
  const loaded = codeFile ? await loadRuleSourceFile(codeFile) : await loadRuleSource(resolveInlineCode(flags));
  if (toBoolean(flags['syntax-only'])) {
    const syntax = checkDrpyRuleSyntax(loaded.code);
    return { data: { passed: syntax.passed, syntax, source: sourceMeta(loaded, toBoolean(flags.verbose)) }, passed: syntax.passed };
  }
  const validation = validateDrpyRule(loaded.code, { engineRoot: flags['engine-root'] });
  return { data: { ...compactValidation(validation, toBoolean(flags.verbose)), source: sourceMeta(loaded, toBoolean(flags.verbose)) }, passed: validation.passed };
}

async function commandCheck(flags, config) {
  const codeFile = resolveCodeFile(flags, config);
  const level = flags.level || (flags.depth === 'smoke' ? 'l2' : 'l3');
  const result = await runRuleCheck({
    skillRoot,
    config,
    codeFile,
    moduleName: flags.module,
    engineRoot: flags['engine-root'],
    level,
    engine: flags.engine || 'auto',
    stage: flags.stage,
    timeoutMs: numberOr(flags['timeout-ms'], undefined),
    keepTemp: toBoolean(flags['keep-temp']),
    allowEmpty: flags['allow-empty'] || '',
    args: readJsonArgs(flags),
  });
  return { data: compactCheckResult(result, toBoolean(flags.verbose)), passed: result.passed, errorCode: failureCode(result) };
}

async function commandHeal(flags, config) {
  const codeFile = resolveCodeFile(flags, config);
  const loaded = await loadRuleSourceFile(codeFile);
  const setFields = {};
  if (flags.bump) setFields.version = bumpVersion(loaded.code, String(flags.bump));
  const patch = createSafeRulePatch(loaded.code, {
    fileName: path.basename(codeFile),
    setFields,
    analysisOptions: { knownTemplates: knownTemplateSet(flags['engine-root']) },
  });
  const afterValidation = validateDrpyRule(patch.code, { engineRoot: flags['engine-root'] });
  let save = null;
  if (toBoolean(flags.apply) && patch.changed) {
    save = saveRuleToFile({ outputDir: path.dirname(codeFile), filePath: codeFile, code: patch.code, overwrite: true, validationOptions: { engineRoot: flags['engine-root'] } });
  }
  const { analysis, beforeAnalysis, afterAnalysis, ...patchData } = patch;
  const verbose = toBoolean(flags.verbose);
  return {
    data: {
      ...patchData,
      validation: compactValidation(afterValidation, verbose),
      ...(verbose ? { analysis, beforeAnalysis, afterAnalysis } : {}),
      applied: Boolean(save),
      save,
    },
    passed: afterValidation.passed,
  };
}

async function commandSave(flags, config) {
  let code = await resolveLoadedCode(flags, config);
  if (flags.bump) code = setVersionWithSafePatch(code, String(flags.bump));
  const rawFileName = String(flags['file-name'] || '').trim();
  if (!rawFileName) throw codedError('SAVE_FILE_NAME_REQUIRED', 'save 需要 --file-name');
  const fileName = rawFileName.toLowerCase().endsWith('.js') ? rawFileName : `${rawFileName}.js`;
  const outputDir = resolveOutputDir(flags, config);
  const filePath = ensureSafeChildPath(outputDir, fileName);
  const save = saveRuleToFile({ outputDir, filePath, code, overwrite: toBoolean(flags.overwrite), validationOptions: { engineRoot: flags['engine-root'] } });
  return { data: save };
}

async function commandShare(flags, config) {
  const input = readJsonArgs(flags);
  const shareConfig = resolveClipboardShareConfig(config, clipboardConfigOverrides(flags));
  const dryRun = toBoolean(flags['dry-run']);
  const verify = !toBoolean(flags['no-verify']);
  const force = toBoolean(flags.force);
  if (flags['group-file'] || Array.isArray(input.entries)) {
    const groupPath = flags['group-file'] ? resolveUserPath(flags['group-file']) : '';
    const group = groupPath ? readJsonFile(groupPath) : input;
    const baseDir = groupPath ? path.dirname(groupPath) : process.cwd();
    const entries = await Promise.all((group.entries || []).map(async (entry) => {
      if (String(entry.sourceCode || '').trim()) {
        const loaded = await loadRuleSource(String(entry.sourceCode));
        return { ...entry, sourceCode: loaded.code };
      }
      const codeFile = path.isAbsolute(entry.codeFile || '')
        ? entry.codeFile
        : path.resolve(baseDir, entry.codeFile || '');
      const loaded = await loadRuleSourceFile(codeFile);
      return { ...entry, sourceCode: loaded.code };
    }));
    if (!force) for (const entry of entries) enforceShareGate(entry.sourceCode, entry.name || entry.displayName, { engineRoot: flags['engine-root'] });
    const result = await uploadGroup({ entries, groupTag: flags['group-tag'] || group.groupTag, category: flags.category || group.category || 'video', config: shareConfig, dryRun, verify });
    return { data: attachClipboard({ ...result, forced: force }, flags) };
  }
  const code = await resolveLoadedCode(flags, config);
  if (!force) enforceShareGate(code, flags.name || flags['share-name'], { engineRoot: flags['engine-root'] });
  const name = String(flags.name || flags['share-name'] || input.name || '').trim();
  if (!name) throw codedError('SHARE_NAME_REQUIRED', 'share 单源需要 --name');
  const result = await uploadSingleSource({ sourceName: name, sourceCode: code, category: flags.category || input.category || '', groupTag: flags['group-tag'] || input.groupTag || '', config: shareConfig, dryRun, verify });
  return { data: attachClipboard({ ...result, forced: force }, flags) };
}

function commandResources(subcommand, flags) {
  if (subcommand === 'list') return { data: { resources: knowledgeBase.listResources(), resourceTemplates: knowledgeBase.listResourceTemplates(), prompts: knowledgeBase.listPrompts() } };
  if (subcommand !== 'read') throw codedError('RESOURCE_SUBCOMMAND_INVALID', `resources 不支持 ${subcommand}`);
  return { data: knowledgeBase.readResource(resolveResourceUri(flags)) };
}

async function commandDebugSelector(flags) {
  const input = readJsonArgs(flags);
  if (flags['content-file'] || flags['html-file']) input.html = readText(resolveUserPath(flags['content-file'] || flags['html-file']));
  if (flags.url) input.url = String(flags.url);
  if (flags.rule) input.rule = String(flags.rule);
  if (flags.mode) input.mode = String(flags.mode);
  if (flags['base-url']) input.baseUrl = String(flags['base-url']);
  if (!input.rule || !input.mode) throw codedError('DEBUG_SELECTOR_INPUT_REQUIRED', 'debug-selector 需要 --rule 和 --mode');
  return { data: await debugDrpyRule(input) };
}

async function commandRuntime(subcommand, flags, config) {
  const runtimeConfig = resolveEmbeddedDrpyConfig(skillRoot, config);
  if (subcommand === 'start') {
    const session = createSession(skillRoot, config, 'manual-start');
    const runtime = await ensureRuntimeRunning(session, {
      skillRoot,
      port: flags.port ? Number(flags.port) : 0,
      fixedPort: toBoolean(flags['fixed-port']),
      nodeCommand: runtimeConfig.nodeCommand,
      detached: true,
      stateFile: runtimeConfig.stateFile,
    });
    const state = { ...runtime, sessionId: session.id, stateFile: runtimeConfig.stateFile };
    writeJsonFile(runtimeConfig.stateFile, state);
    return { data: state };
  }
  if (subcommand !== 'stop') throw codedError('RUNTIME_SUBCOMMAND_INVALID', `runtime 不支持 ${subcommand}`);
  const state = readStateFile(runtimeConfig.stateFile);
  return { data: state ? await stopManagedRuntime({ ...state, stateFile: runtimeConfig.stateFile }) : { stopped: false, reason: 'no-state-file' } };
}

async function commandFetch(flags) {
  const input = readJsonArgs(flags);
  if (flags.url) input.url = String(flags.url);
  if (flags['body-file']) input.body = readText(resolveUserPath(flags['body-file']));
  if (!input.url) throw codedError('FETCH_URL_REQUIRED', 'fetch-web-source 需要 --url');
  return { data: await fetchSource(input) };
}

function commandAnalyze(flags) {
  const input = readJsonArgs(flags);
  if (flags['content-file']) input.content = readText(resolveUserPath(flags['content-file']));
  if (!input.content) throw codedError('ANALYZE_CONTENT_REQUIRED', 'analyze-content 需要 --content-file');
  return { data: analyzePageContent(input) };
}

function commandRenderPrompt(flags) {
  const name = String(flags.name || '');
  if (!name) throw codedError('PROMPT_NAME_REQUIRED', 'render-prompt 需要 --name');
  let args = flags['args-file'] ? readJsonFile(resolveUserPath(flags['args-file'])) : {};
  if (flags['args-json']) args = { ...args, ...JSON.parse(String(flags['args-json'])) };
  return { data: knowledgeBase.getPrompt(name, args) };
}

async function commandOcr(flags, config) {
  const result = await runDrpyDoctor(skillRoot, config, { ocrImageBase64: resolveOcrImageBase64(flags) });
  const checks = (result.checks || []).filter((item) => /^ocr/i.test(item.name || ''));
  const passed = checks.every((item) => item.passed || item.level === 'warning');
  return { data: { passed, ocr: result.runtime?.ocr || {}, checks }, passed };
}

function enforceShareGate(code, name = '', validationOptions = {}) {
  const validation = validateDrpyRule(code, validationOptions);
  if (!validation.passed) {
    const error = codedError('SHARE_L1_REQUIRED', `${name || '源码'} 未通过 L1，拒绝上传`);
    error.validation = validation;
    throw error;
  }
  if (/\$\.require\s*\(|\brequire\s*\(\s*['"]\.\//.test(code)) {
    throw codedError('SHARE_EXTERNAL_DEPENDENCY', '云1 单文件源码包含外部 _lib/相对依赖，手机端无法独立导入');
  }
}

function setVersionWithSafePatch(code, bump) {
  const version = bumpVersion(code, bump);
  return createSafeRulePatch(code, { setFields: { version } }).code;
}

function bumpVersion(code, kind) {
  if (!['patch', 'minor', 'major'].includes(kind)) throw codedError('VERSION_BUMP_INVALID', '--bump 仅支持 patch/minor/major');
  const analysis = analyzeRuleSource(code);
  const current = String(analysis.rule?.staticFields?.version || '0.0.0');
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw codedError('VERSION_INVALID', `当前 version 无效: ${current}`);
  let [major, minor, patch] = match.slice(1).map(Number);
  if (kind === 'major') { major += 1; minor = 0; patch = 0; }
  if (kind === 'minor') { minor += 1; patch = 0; }
  if (kind === 'patch') patch += 1;
  return `${major}.${minor}.${patch}`;
}

function compactCheckResult(result, verbose) {
  const compact = sanitizeOutput(result, { verbose });
  if (verbose) return compact;
  if (compact.validation?.analysis) compact.validation = { ...compact.validation, analysis: undefined, runtime: undefined };
  if (compact.steps?.rule?.lazy?.source) compact.steps.rule.lazy.source = '[Function]';
  return compact;
}

function compactValidation(validation, verbose) {
  if (verbose) return sanitizeOutput(validation, { verbose: true });
  return sanitizeOutput({
    passed: validation.passed,
    score: validation.score,
    styleScore: validation.styleScore,
    evidenceLevel: validation.evidenceLevel,
    issues: validation.issues,
    warnings: validation.warnings,
    diagnostics: validation.diagnostics,
    syntax: validation.syntax,
    ruleSummary: validation.ruleSummary,
    style: validation.style,
    summary: validation.summary,
  }, { verbose: false });
}

function resolveCodeFile(flags, config) {
  const filePath = resolveOptionalCodeFile(flags, config);
  if (!filePath) throw codedError('CODE_FILE_REQUIRED', '需要 --code-file 或 --module');
  return filePath;
}

function resolveOptionalCodeFile(flags, config) {
  if (flags['code-file']) return resolveUserPath(flags['code-file']);
  if (!flags.module) return '';
  const moduleName = String(flags.module).replace(/\.js$/i, '');
  if (!moduleName || moduleName === '.' || moduleName === '..' || /[\\/:\0]/.test(moduleName) || path.basename(moduleName) !== moduleName) {
    throw codedError('MODULE_NAME_INVALID', '--module 只接受模块名，不能包含路径、盘符或上级目录');
  }
  const runtimeConfig = resolveEmbeddedDrpyConfig(skillRoot, config);
  const engineRoot = findAiboxEngineRoot({
    explicitRoot: flags['engine-root'],
    skillRoot,
    requiredPaths: ['package.json'],
  });
  const candidates = [
    ...(runtimeConfig.sourceDirs || []),
    ...(engineRoot ? [path.join(engineRoot, 'spider', 'js')] : []),
  ];
  for (const dir of candidates) {
    const filePath = ensureSafeChildPath(dir, `${moduleName}.js`);
    if (fs.existsSync(filePath)) return filePath;
  }
  throw codedError('MODULE_NOT_FOUND', `未找到模块: ${moduleName}`);
}

async function resolveLoadedCode(flags, config) {
  const filePath = resolveOptionalCodeFile(flags, config);
  if (filePath) return (await loadRuleSourceFile(filePath)).code;
  return (await loadRuleSource(resolveInlineCode(flags))).code;
}

function resolveInlineCode(flags) {
  const input = readJsonArgs(flags);
  const code = String(input.code || input.sourceCode || '');
  if (!code.trim()) throw codedError('CODE_REQUIRED', '需要 --code-file、--module 或 input.code');
  return code;
}

function parseArgs(tokens) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { flags, positionals };
}

function loadCliConfig(flags) {
  const defaultPath = fs.existsSync(path.join(skillRoot, 'config', 'aibox.config.json'))
    ? path.join(skillRoot, 'config', 'aibox.config.json')
    : path.join(skillRoot, 'config', 'aibox.config.example.json');
  return loadConfig({ config: flags.config ? resolveUserPath(flags.config) : defaultPath, debug: flags.debug });
}

function readJsonArgs(flags) {
  let payload = {};
  if (flags['input-file']) payload = readJsonFile(resolveUserPath(flags['input-file']));
  if (flags['input-json']) payload = { ...payload, ...JSON.parse(String(flags['input-json'])) };
  return payload;
}

function resolveOutputDir(flags, config) {
  return flags['output-dir'] ? path.resolve(process.cwd(), String(flags['output-dir'])) : (config.outputDir || defaultOutputDir);
}

function resolveResourceUri(flags) {
  if (flags.uri) return String(flags.uri);
  if (flags.name) {
    for (const uri of [`aibox://knowledge/${flags.name}`, `aibox://template/${flags.name}`]) {
      try { knowledgeBase.readResource(uri); return uri; } catch (_) {}
    }
  }
  throw codedError('RESOURCE_NAME_REQUIRED', 'resources read 需要 --uri 或 --name');
}

function resolveOcrImageBase64(flags) {
  if (flags['ocr-image-base64']) return String(flags['ocr-image-base64']).trim();
  if (flags['ocr-image-file']) return fs.readFileSync(resolveUserPath(flags['ocr-image-file'])).toString('base64');
  return '';
}

function clipboardConfigOverrides(flags) {
  const result = {};
  if (flags['base-url']) result.baseUrl = String(flags['base-url']);
  if (flags.provider) result.provider = String(flags.provider);
  if (flags['group-provider']) result.groupProvider = String(flags['group-provider']);
  if (flags['key-length']) result.keyLength = Number(flags['key-length']);
  if (flags['timeout-ms']) result.timeoutMs = Number(flags['timeout-ms']);
  return result;
}

function attachClipboard(result, flags) {
  if (!toBoolean(flags.copy)) return result;
  const copied = process.platform === 'win32'
    ? spawnSync('clip', { input: String(result.shareCode || ''), encoding: 'utf8', windowsHide: true })
    : { status: 1, error: new Error('--copy 当前仅支持 Windows') };
  return { ...result, clipboard: { copied: !copied.error && copied.status === 0, warning: copied.error?.message || String(copied.stderr || '') } };
}

function sourceMeta(loaded, verbose = false) {
  return sanitizeOutput({ filePath: loaded.filePath, sourceType: loaded.sourceType, encrypted: loaded.encrypted, byteLength: loaded.byteLength, sha256: loaded.sha256, header: loaded.header }, { verbose });
}

function detectContentType(code) {
  const match = String(code || '').match(/类型\s*:\s*['"](影视|小说|漫画)['"]/);
  return match?.[1] === '小说' ? 'novel' : match?.[1] === '漫画' ? 'comic' : 'video';
}

function failureCode(result) {
  if (result.failureClass === 'chain_failure') return 'CHAIN_FAILED';
  if (result.failureClass === 'play_failure') return 'PLAY_FAILED';
  if (result.failureClass === 'content_contract_failure') return 'CONTENT_CONTRACT_FAILED';
  if (result.failureClass === 'environment_failure') return 'ENVIRONMENT_FAILED';
  return result.passed ? null : 'CHECK_FAILED';
}

function firstDiagnosticCode(data) {
  return data?.diagnostics?.find((item) => item.severity === 'error')?.code || data?.validation?.diagnostics?.find((item) => item.severity === 'error')?.code || null;
}

function firstErrorMessage(data) {
  return data?.errors?.[0] || data?.issues?.[0] || data?.validation?.issues?.[0] || null;
}

function serializeError(error) {
  return sanitizeOutput({
    code: error?.code || 'CLI_ERROR',
    message: error?.message || String(error),
    suggestions: error?.suggestions || [],
    ...(error?.validation ? { validation: compactValidation(error.validation, false) } : {}),
    ...(toBoolean(process.env.AIBOX_SKILL_DEBUG) ? { stack: error?.stack || '' } : {}),
  }, { verbose: toBoolean(process.env.AIBOX_SKILL_DEBUG) });
}

function compactAnalysis(analysis) {
  return {
    ok: analysis?.ok,
    diagnostics: analysis?.diagnostics || [],
    header: analysis?.header ? { header: analysis.header.header, consistency: analysis.header.consistency } : null,
    template: analysis?.template || null,
    rule: analysis?.rule ? {
      staticFields: analysis.rule.staticFields,
      duplicateFields: analysis.rule.duplicateFields,
      implementationMode: analysis.rule.implementationMode,
    } : null,
  };
}

function sanitizeOutput(value, { verbose = false } = {}, seen = new WeakSet(), key = '') {
  const normalizedKey = String(key || '').toLowerCase();
  if (isSensitiveKey(normalizedKey)) return '[REDACTED]';
  if (!verbose && ['stack', 'stderr', 'stdout'].includes(normalizedKey)) return undefined;
  if (typeof value === 'string') {
    let text = redactSensitiveText(value);
    if (!verbose) {
      text = redactAbsolutePaths(text);
      if (/(?:path|file|root)$/i.test(key) && isAbsolutePath(text)) {
        text = path.basename(text);
      }
    }
    return text;
  }
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => sanitizeOutput(item, { verbose }, seen)).filter((item) => item !== undefined);
  } else {
    result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeOutput(childValue, { verbose }, seen, childKey);
      if (sanitized !== undefined) result[childKey] = sanitized;
    }
  }
  seen.delete(value);
  return result;
}

function isSensitiveKey(key) {
  return /^(?:authorization|proxy-authorization|cookie|set-cookie|token|access_token|refresh_token|api[_-]?key|secret|password|x-auth-signature|x-auth-timestamp|umstring|device|deviceinfo|pseudoid)$/i.test(key);
}

function redactSensitiveText(value) {
  const names = 'authorization|proxy-authorization|cookie|set-cookie|token|access_token|refresh_token|api[_-]?key|secret|password|x-auth-signature|x-auth-timestamp|umstring|device|deviceinfo|pseudoid';
  return String(value || '')
    .replace(new RegExp(`(["']?(?:${names})["']?\\s*[:=]\\s*)(["'])(.*?)\\2`, 'gi'), '$1$2[REDACTED]$2')
    .replace(new RegExp(`((?:^|[\\s,{;])["']?(?:${names})["']?\\s*[:=]\\s*)(?!["']?\\[REDACTED\\])[^,}\\r\\n]+`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`([?&](?:${names})=)[^&\\s]+`, 'gi'), '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

function redactAbsolutePaths(value) {
  return String(value || '')
    .replace(/(^|[\s"'(=])([A-Za-z]:[\\/][^\r\n"'<>]*)/g, '$1[PATH]')
    .replace(/(^|[\s"'(])\/(?:Users|home|tmp|var|private|opt|workspace|mnt|data)\/[^\s"'<>]*/g, '$1[PATH]');
}

function isAbsolutePath(value) {
  return path.isAbsolute(String(value || '')) || /^[A-Za-z]:[\\/]/.test(String(value || ''));
}

function codedError(code, message, suggestions = []) {
  const error = new Error(message);
  error.code = code;
  error.suggestions = suggestions;
  return error;
}

function emit(payload, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCode;
}

function currentCommand() {
  return process.argv[2] || 'help';
}

function readJsonFile(filePath) { return JSON.parse(readText(filePath)); }
function readText(filePath) { return fs.readFileSync(filePath, 'utf8'); }
function resolveUserPath(value) { return path.resolve(process.cwd(), String(value)); }
function numberOr(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function toBoolean(value) { return value === true || (typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())); }
