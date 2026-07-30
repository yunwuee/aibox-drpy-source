import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  createOcrApi,
  DEFAULT_OCR_API,
  DEFAULT_OCR_RETRY,
  loadCryptoJS,
  readCapabilityMatrix,
  readEmbeddedSkillConfig,
} from './drpy-sandbox-capabilities.mjs';

export function resolveEmbeddedDrpyConfig(skillRoot, config = {}) {
  const base = config.embeddedDrpy || {};
  const outputDir = config.outputDir || path.join(skillRoot, 'output');
  const embeddedConfig = readEmbeddedSkillConfig(skillRoot);
  const ocrConfig = mergePlain(embeddedConfig.ocr || {}, base.ocr || {});
  const cryptoConfig = mergePlain(embeddedConfig.crypto || {}, base.crypto || {});
  const reportConfig = mergePlain(embeddedConfig.report || {}, base.report || {});
  return {
    enabled: base.enabled !== false,
    nodeCommand: String(base.nodeCommand || 'node'),
    port: Number(base.port || 5757),
    defaultDepth: String(base.defaultDepth || 'smoke'),
    cleanupOnSuccess: base.cleanupOnSuccess !== false,
    maxHealRounds: Number(base.maxHealRounds || 8),
    sessionRoot: path.resolve(config.configDir || skillRoot, base.sessionRoot || path.join(outputDir, 'live-sessions')),
    reportRoot: path.resolve(config.configDir || skillRoot, base.reportRoot || path.join(outputDir, 'live-check')),
    vendorRuntimeRoot: path.join(skillRoot, 'vendor', 'embedded-drpy'),
    stateFile: path.resolve(config.configDir || skillRoot, base.stateFile || path.join(outputDir, 'embedded-drpy.state.json')),
    sourceDirs: (Array.isArray(base.sourceDirs) ? base.sourceDirs : [outputDir]).map((item) => path.resolve(config.configDir || skillRoot, item)),
    configPath: config.configPath || '',
    ocr: ocrConfig,
    crypto: cryptoConfig,
    report: reportConfig,
  };
}

export async function runDrpyDoctor(skillRoot, config = {}, options = {}) {
  const runtimeConfig = resolveEmbeddedDrpyConfig(skillRoot, config);
  const matrix = readCapabilityMatrix(skillRoot);
  const checks = [];

  checks.push(await checkNode(runtimeConfig.nodeCommand));
  checks.push(checkPathExists('vendor runtime', runtimeConfig.vendorRuntimeRoot));
  checks.push(checkPathExists('vendor index.js', path.join(runtimeConfig.vendorRuntimeRoot, 'index.js')));
  checks.push(checkPathExists('vendor crypto-js', path.join(skillRoot, 'vendor', 'crypto-js')));
  checks.push(checkWritableDir('sessionRoot', runtimeConfig.sessionRoot));
  checks.push(checkWritableDir('reportRoot', runtimeConfig.reportRoot));
  checks.push(checkPortPolicy());
  checks.push(await checkStateFile(runtimeConfig.stateFile));
  checks.push(checkCryptoReady(skillRoot));
  checks.push(checkVerifyRuntime(runtimeConfig));
  checks.push(checkOcrConfig(runtimeConfig.ocr));
  checks.push(await checkOcrSmoke(skillRoot, runtimeConfig.ocr, options));

  return {
    passed: checks.every((item) => item.passed || item.level === 'warning'),
    runtime: runtimeConfig,
    capabilityMatrix: matrix,
    checks,
  };
}

export function createSession(skillRoot, config = {}, hint = 'live') {
  const runtimeConfig = resolveEmbeddedDrpyConfig(skillRoot, config);
  const sessionId = `${hint}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sessionRoot = path.join(runtimeConfig.sessionRoot, sessionId);
  const runtimeRoot = path.join(sessionRoot, 'runtime');
  const spiderJsDir = path.join(runtimeRoot, 'spider', 'js');
  const rawRoot = path.join(runtimeConfig.reportRoot, sessionId, 'raw');

  fs.mkdirSync(spiderJsDir, { recursive: true });
  fs.mkdirSync(rawRoot, { recursive: true });
  fs.cpSync(runtimeConfig.vendorRuntimeRoot, runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(spiderJsDir, { recursive: true });

  return {
    id: sessionId,
    skillRoot: path.resolve(skillRoot),
    root: sessionRoot,
    runtimeRoot,
    spiderJsDir,
    rawRoot,
    reportDir: path.join(runtimeConfig.reportRoot, sessionId),
    runtimeConfig,
  };
}

export function resolveModuleNameFromPath(filePath) {
  return normalizeModuleName(path.basename(filePath, path.extname(filePath)));
}

export function normalizeModuleName(name) {
  return String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[\u4e00-\u9fa5]/g, (char) => `_${char.charCodeAt(0).toString(16)}`)
    .replace(/[^A-Za-z0-9_\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || `source_${Date.now()}`;
}

export function mountSourceIntoSession(session, sourcePath, requestedName) {
  const moduleName = requestedName
    ? normalizeModuleName(requestedName)
    : `__aibox_probe__${resolveModuleNameFromPath(sourcePath)}_${Date.now()}`;
  const targetPath = path.join(session.spiderJsDir, `${moduleName}.js`);
  fs.copyFileSync(sourcePath, targetPath);
  return {
    moduleName,
    sourcePath,
    targetPath,
  };
}

export function resolveSourceByModuleName(skillRoot, config = {}, moduleName) {
  const runtimeConfig = resolveEmbeddedDrpyConfig(skillRoot, config);
  const candidates = [
    ...runtimeConfig.sourceDirs.map((dir) => path.join(dir, `${moduleName}.js`)),
    path.join(skillRoot, 'assets', 'examples', `${moduleName}.js`),
    path.join(process.cwd(), `${moduleName}.js`),
    path.join(process.cwd(), 'output', `${moduleName}.js`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`未找到模块文件: ${moduleName}.js`);
}

export async function ensureRuntimeRunning(session, options = {}) {
  const runtimeConfig = session.runtimeConfig;
  const requestedPort = Number(options.port || runtimeConfig.port || 0);
  const fixedPort = options.fixedPort === true;
  const stateFilePath = options.stateFile || runtimeConfig.stateFile;
  await cleanupStaleStateFile(stateFilePath);
  if (options.detached && readStateFile(stateFilePath)) {
    throw new Error(`已有内置 drpy runtime 状态未清理，拒绝覆盖: ${stateFilePath}`);
  }
  const port = fixedPort
    ? await requireAvailableFixedPort(requestedPort)
    : await pickRandomAvailablePort();
  const stateFile = path.join(session.runtimeRoot, '.embedded-drpy.state.json');
  const logPath = path.join(session.root, 'runtime.log');
  const nodeCommand = String(options.nodeCommand || runtimeConfig.nodeCommand || 'node');
  const entryPath = path.join(session.runtimeRoot, 'index.js');
  const ownershipToken = randomUUID();
  const startedAt = new Date().toISOString();
  const childEnv = buildRuntimeEnvironment({
    port,
    skillRoot: options.skillRoot || session.skillRoot,
    runtimeRoot: session.runtimeRoot,
    runtimeConfig,
    ownershipToken,
    startedAt,
  });

  let child;
  try {
    if (options.detached) {
      const logFd = fs.openSync(logPath, 'a');
      try {
        child = spawn(nodeCommand, [entryPath], {
          cwd: session.runtimeRoot,
          env: childEnv,
          windowsHide: true,
          detached: true,
          stdio: ['ignore', logFd, logFd],
        });
      } finally {
        fs.closeSync(logFd);
      }
      child.unref();
    } else {
      child = spawn(nodeCommand, [entryPath], {
        cwd: session.runtimeRoot,
        env: childEnv,
        windowsHide: true,
      });
      const out = fs.createWriteStream(logPath, { flags: 'a' });
      child.stdout.pipe(out);
      child.stderr.pipe(out);
    }
  } catch (error) {
    throw new Error(`无法启动内置 drpy runtime: ${error.message}`);
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForOwnedHealth(baseUrl, {
    token: ownershipToken,
    pid: child.pid,
    startedAt,
    runtimeRoot: session.runtimeRoot,
  }, 20000);
  if (!health) {
    try {
      child.kill('SIGTERM');
    } catch (_) {
    }
    throw new Error(`内置 drpy runtime 启动失败，端口=${port}`);
  }

  const processIdentity = await waitForProcessIdentity(child.pid, 3000);
  const state = {
    stateVersion: 2,
    pid: child.pid,
    port,
    sessionId: session.id,
    runtimeRoot: path.resolve(session.runtimeRoot),
    nodeCommand,
    entryPath: path.resolve(entryPath),
    logPath,
    startedAt,
    ownershipToken,
    processStartToken: processIdentity?.startToken || '',
    processStartedAt: processIdentity?.startedAt || '',
    health: {
      server: health.server,
      version: health.version,
      pid: health.pid,
      startedAt: health.startedAt,
      runtimeRoot: health.runtimeRoot,
    },
    runtimeStateFile: stateFile,
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

  return {
    ...state,
    baseUrl,
    stateFile,
  };
}

export async function stopManagedRuntime(stateOrPath) {
  const state = typeof stateOrPath === 'string'
    ? readStateFile(stateOrPath)
    : stateOrPath;
  if (!state || !state.pid) {
    return { stopped: false, reason: 'missing-state' };
  }

  const requiredFields = ['port', 'ownershipToken', 'startedAt', 'runtimeRoot'];
  const missingFields = requiredFields.filter((key) => !state[key]);
  if (missingFields.length > 0) {
    return { stopped: false, reason: 'unsafe-legacy-state', missingFields };
  }

  const processIdentity = await inspectProcessIdentity(Number(state.pid));
  if (!processIdentity) {
    removeManagedStateFiles(state);
    return { stopped: false, reason: 'process-not-running', pid: state.pid, staleStateRemoved: true };
  }
  if (state.processStartToken && processIdentity.startToken !== state.processStartToken) {
    removeManagedStateFiles(state);
    return { stopped: false, reason: 'process-identity-mismatch', pid: state.pid, staleStateRemoved: true };
  }
  if (processIdentity.commandLine && state.entryPath && !commandLineContainsPath(processIdentity.commandLine, state.entryPath)) {
    return { stopped: false, reason: 'entry-path-mismatch', pid: state.pid };
  }

  const health = await readOwnedHealth(`http://127.0.0.1:${Number(state.port)}`, state.ownershipToken);
  if (!matchesManagedHealth(state, health)) {
    return { stopped: false, reason: 'health-ownership-mismatch', pid: state.pid, port: state.port };
  }

  try {
    process.kill(Number(state.pid), 'SIGTERM');
  } catch (error) {
    return { stopped: false, reason: 'terminate-failed', pid: state.pid, error: error.message };
  }

  const stopped = await waitForProcessExit(Number(state.pid), 8000);
  if (stopped) {
    removeManagedStateFiles(state);
  }
  return {
    stopped,
    pid: state.pid,
    port: state.port,
    reason: stopped ? 'stopped' : 'process-did-not-exit',
  };
}

export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export function writeTextFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value ?? ''), 'utf8');
}

export function sha1(text) {
  return createHash('sha1').update(String(text || '')).digest('hex');
}

export function readStateFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function checkNode(command) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, ['--version'], { windowsHide: true });
    } catch (error) {
      resolve({
        name: 'node',
        passed: false,
        level: 'error',
        detail: error.message,
      });
      return;
    }
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      resolve({
        name: 'node',
        passed: false,
        level: 'error',
        detail: error.message,
      });
    });
    child.on('close', (code) => {
      resolve({
        name: 'node',
        passed: code === 0,
        level: code === 0 ? 'info' : 'error',
        detail: output.trim() || `exit=${code}`,
      });
    });
  });
}

function checkPathExists(name, targetPath) {
  return {
    name,
    passed: fs.existsSync(targetPath),
    level: fs.existsSync(targetPath) ? 'info' : 'error',
    detail: targetPath,
  };
}

function checkWritableDir(name, targetPath) {
  try {
    fs.mkdirSync(targetPath, { recursive: true });
    const testFile = path.join(targetPath, `.write-test-${Date.now()}.tmp`);
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    return {
      name,
      passed: true,
      level: 'info',
      detail: targetPath,
    };
  } catch (error) {
    return {
      name,
      passed: false,
      level: 'error',
      detail: error.message,
    };
  }
}

function checkPortPolicy() {
  return {
    name: 'port',
    passed: true,
    level: 'info',
    detail: '默认使用随机空闲端口；只有调用方显式 fixedPort=true 时才使用固定端口，且绝不接管占用进程',
  };
}

function checkCryptoReady(skillRoot) {
  const cryptoJs = loadCryptoJS(skillRoot);
  return {
    name: 'crypto',
    passed: Boolean(cryptoJs?.AES && cryptoJs?.MD5),
    level: cryptoJs?.AES && cryptoJs?.MD5 ? 'info' : 'error',
    detail: cryptoJs?.AES && cryptoJs?.MD5 ? 'CryptoJS / AES-CBC / MD5 ready' : 'CryptoJS runtime unavailable',
  };
}

function checkVerifyRuntime(runtimeConfig = {}) {
  const ocrConfig = runtimeConfig.ocr || {};
  const configured = (ocrConfig.mode === 'http' && ocrConfig.endpoint) || (ocrConfig.mode === 'command' && ocrConfig.command);
  return {
    name: 'verifyCode',
    passed: true,
    level: configured ? 'info' : 'warning',
    detail: configured
      ? 'verifyCode + OcrApi chain ready'
      : 'verifyCode runtime ready, but OCR is not configured',
  };
}

function checkOcrConfig(ocrConfig = {}) {
  const configured = (ocrConfig.mode === 'http' && ocrConfig.endpoint) || (ocrConfig.mode === 'command' && ocrConfig.command);
  const endpoint = ocrConfig.endpoint || ocrConfig.command || '';
  return {
    name: 'ocr',
    passed: true,
    level: configured ? 'info' : 'warning',
    detail: configured
      ? `OCR configured: ${ocrConfig.mode}; endpoint=${endpoint}; retry=${Number(ocrConfig.retry || DEFAULT_OCR_RETRY)}`
      : 'OCR not configured; verifyCode will degrade to diagnostic mode',
    mode: ocrConfig.mode || 'none',
    endpoint,
    retry: Number(ocrConfig.retry || DEFAULT_OCR_RETRY),
    defaultEndpoint: DEFAULT_OCR_API,
  };
}

async function checkOcrSmoke(skillRoot, ocrConfig = {}, options = {}) {
  const image = String(options.ocrImageBase64 || '').trim();
  if (!image) {
    return {
      name: 'ocrSmoke',
      passed: true,
      level: 'info',
      detail: '未提供 --ocr-image-file / --ocr-image-base64，跳过真实 OCR 样本识别',
      skipped: true,
    };
  }

  const logs = [];
  const ocrApi = createOcrApi(skillRoot, (message) => logs.push(String(message || '')), ocrConfig);
  if (!ocrApi.configured) {
    return {
      name: 'ocrSmoke',
      passed: false,
      level: 'error',
      detail: 'OCR 未配置，无法执行样本识别',
      logs,
    };
  }

  const startedAt = Date.now();
  const text = String(await ocrApi.classification(image)).trim();
  return {
    name: 'ocrSmoke',
    passed: Boolean(text),
    level: text ? 'info' : 'warning',
    detail: text ? `OCR sample => ${text}` : 'OCR 样本识别返回空结果',
    durationMs: Date.now() - startedAt,
    result: text,
    logs,
  };
}

async function checkStateFile(stateFile) {
  const state = readStateFile(stateFile);
  if (!state) {
    return {
      name: 'stateFile',
      passed: true,
      level: 'info',
      detail: '无残留 state 文件',
    };
  }
  const processIdentity = state.pid ? await inspectProcessIdentity(Number(state.pid)) : null;
  const health = state.port && state.ownershipToken
    ? await readOwnedHealth(`http://127.0.0.1:${Number(state.port)}`, state.ownershipToken)
    : null;
  const owned = Boolean(processIdentity && matchesManagedHealth(state, health));
  return {
    name: 'stateFile',
    passed: true,
    level: 'warning',
    detail: owned
      ? `发现受管 runtime: pid=${state.pid} port=${state.port}`
      : `发现陈旧 state 文件: ${stateFile}`,
  };
}

async function cleanupStaleStateFile(stateFile) {
  const state = readStateFile(stateFile);
  if (!state) {
    return false;
  }
  const processIdentity = state.pid ? await inspectProcessIdentity(Number(state.pid)) : null;
  const processMatches = Boolean(
    processIdentity
    && (!state.processStartToken || processIdentity.startToken === state.processStartToken),
  );
  if (!processMatches && fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
    return true;
  }
  return false;
}

async function inspectProcessIdentity(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    return null;
  }
  if (process.platform === 'win32') {
    const info = await runPowershellJson(`$proc = Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(pid)}\" -ErrorAction SilentlyContinue; if ($proc) { [pscustomobject]@{ pid = $proc.ProcessId; name = $proc.Name; commandLine = $proc.CommandLine; executablePath = $proc.ExecutablePath; startedAt = $proc.CreationDate.ToUniversalTime().ToString('o'); startToken = $proc.CreationDate.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress }`);
    return info && typeof info === 'object' ? info : null;
  }
  if (process.platform === 'linux' && fs.existsSync(`/proc/${Number(pid)}/stat`)) {
    try {
      const statText = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8');
      const closeParen = statText.lastIndexOf(')');
      const fields = statText.slice(closeParen + 2).trim().split(/\s+/);
      const commandLine = fs.existsSync(`/proc/${Number(pid)}/cmdline`)
        ? fs.readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
        : '';
      return {
        pid: Number(pid),
        commandLine,
        startToken: fields[19] || '',
        startedAt: '',
      };
    } catch (_) {
      return null;
    }
  }
  try {
    process.kill(Number(pid), 0);
    return { pid: Number(pid), commandLine: '', startToken: '', startedAt: '' };
  } catch (_) {
    return null;
  }
}

async function waitForProcessIdentity(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const identity = await inspectProcessIdentity(Number(pid));
    if (identity) {
      return identity;
    }
    await delay(100);
  }
  return await inspectProcessIdentity(Number(pid));
}

async function runPowershellJson(script) {
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && stderr.trim()) {
        reject(new Error(stderr.trim()));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (_) {
        resolve(text);
      }
    });
  });
}

function mergePlain(base = {}, override = {}) {
  const result = { ...(base || {}) };
  for (const [key, value] of Object.entries(override || {})) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && result[key]
      && typeof result[key] === 'object'
      && !Array.isArray(result[key])
    ) {
      result[key] = mergePlain(result[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

async function requireAvailableFixedPort(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`固定端口无效: ${port}`);
  }
  if (await isPortOpen(port)) {
    throw new Error(`端口 ${port} 已被占用；受管 runtime 不会接管或停止占用进程`);
  }
  return port;
}

async function pickRandomAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (!port) {
          reject(new Error('无法分配随机空闲端口'));
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForOwnedHealth(baseUrl, expected, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const health = await readOwnedHealth(baseUrl, expected.token);
    if (
      health
      && Number(health.pid) === Number(expected.pid)
      && health.startedAt === expected.startedAt
      && samePath(health.runtimeRoot, expected.runtimeRoot)
    ) {
      return health;
    }
    await delay(350);
  }
  return null;
}

async function readOwnedHealth(baseUrl, token) {
  try {
    const response = await fetch(`${baseUrl}/__aibox_health`, {
      headers: { 'x-aibox-runtime-token': String(token || '') },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (_) {
    return null;
  }
}

function matchesManagedHealth(state, health) {
  return Boolean(
    health
    && health.server === 'AiboxEmbeddedDrpy'
    && health.token === state.ownershipToken
    && Number(health.pid) === Number(state.pid)
    && health.startedAt === state.startedAt
    && samePath(health.runtimeRoot, state.runtimeRoot)
    && (!state.health?.server || health.server === state.health.server)
    && (!state.health?.version || health.version === state.health.version),
  );
}

async function waitForProcessExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await inspectProcessIdentity(pid))) {
      return true;
    }
    await delay(250);
  }
  return !(await inspectProcessIdentity(pid));
}

async function isPortOpen(port) {
  return await new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRuntimeEnvironment({ port, skillRoot, runtimeRoot, runtimeConfig, ownershipToken, startedAt }) {
  const env = {};
  for (const name of [
    'SystemRoot', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ',
  ]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return {
    ...env,
    PORT: `${port}`,
    AIBOX_SKILL_ROOT: path.resolve(skillRoot),
    AIBOX_RUNTIME_ROOT: path.resolve(runtimeRoot),
    AIBOX_SKILL_CONFIG: runtimeConfig.configPath || '',
    AIBOX_RUNTIME_TOKEN: ownershipToken,
    AIBOX_RUNTIME_STARTED_AT: startedAt,
    AIBOX_EMBEDDED_DRPY_CONFIG: JSON.stringify({
      ocr: runtimeConfig.ocr,
      crypto: runtimeConfig.crypto,
      report: runtimeConfig.report,
    }),
  };
}

function removeManagedStateFiles(state) {
  const candidates = [state.stateFile, state.runtimeStateFile].filter(Boolean);
  for (const candidate of new Set(candidates.map((item) => path.resolve(item)))) {
    try {
      if (fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
      }
    } catch (_) {
    }
  }
}

function commandLineContainsPath(commandLine, targetPath) {
  const normalizedCommand = normalizePathText(commandLine);
  const normalizedTarget = normalizePathText(path.resolve(targetPath));
  return normalizedCommand.includes(normalizedTarget);
}

function samePath(left, right) {
  if (!left || !right) {
    return false;
  }
  return normalizePathText(path.resolve(left)) === normalizePathText(path.resolve(right));
}

function normalizePathText(value) {
  const normalized = String(value || '').replace(/[\\/]+/g, path.sep);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
