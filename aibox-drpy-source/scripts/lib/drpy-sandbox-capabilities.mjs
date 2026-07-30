import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);
const cryptoJsCache = new Map();
export const DEFAULT_OCR_API = 'https://api.nn.ci/ocr/b64/text';
export const DEFAULT_OCR_RETRY = 3;

export function readEmbeddedSkillConfig(skillRoot) {
  const envConfigPath = process.env.AIBOX_SKILL_CONFIG
    ? path.resolve(process.env.AIBOX_SKILL_CONFIG)
    : '';
  const configPath = envConfigPath && fs.existsSync(envConfigPath)
    ? envConfigPath
    : fs.existsSync(path.join(skillRoot, 'config', 'aibox.config.json'))
    ? path.join(skillRoot, 'config', 'aibox.config.json')
    : path.join(skillRoot, 'config', 'aibox.config.example.json');
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    payload = {};
  }
  let envEmbedded = {};
  try {
    envEmbedded = process.env.AIBOX_EMBEDDED_DRPY_CONFIG
      ? JSON.parse(process.env.AIBOX_EMBEDDED_DRPY_CONFIG)
      : {};
  } catch (_) {
    envEmbedded = {};
  }
  const embeddedDrpy = mergePlain(payload.embeddedDrpy || {}, envEmbedded.embeddedDrpy || envEmbedded || {});
  return {
    ocr: {
      mode: embeddedDrpy.ocr?.mode || 'http',
      endpoint: embeddedDrpy.ocr?.endpoint || DEFAULT_OCR_API,
      command: embeddedDrpy.ocr?.command || '',
      args: Array.isArray(embeddedDrpy.ocr?.args) ? embeddedDrpy.ocr.args : [],
      cwd: embeddedDrpy.ocr?.cwd || '',
      env: embeddedDrpy.ocr?.env || {},
      headers: embeddedDrpy.ocr?.headers || {},
      timeoutMs: Number(embeddedDrpy.ocr?.timeoutMs || 15000),
      bodyMode: embeddedDrpy.ocr?.bodyMode || 'auto',
      responsePath: embeddedDrpy.ocr?.responsePath || '',
      retry: Number(embeddedDrpy.ocr?.retry || DEFAULT_OCR_RETRY),
    },
    crypto: {
      enableRequireShim: embeddedDrpy.crypto?.enableRequireShim !== false,
      requireAllowList: Array.isArray(embeddedDrpy.crypto?.requireAllowList)
        ? embeddedDrpy.crypto.requireAllowList
        : ['crypto-js', 'crypto', 'node:crypto', 'buffer', 'url'],
      preferNodeCrypto: embeddedDrpy.crypto?.preferNodeCrypto !== false,
    },
    report: {
      stdoutMode: embeddedDrpy.report?.stdoutMode || 'compact',
      keepVerboseJson: embeddedDrpy.report?.keepVerboseJson !== false,
    },
  };
}

export function getCapabilityMatrixPath(skillRoot) {
  return path.join(skillRoot, 'assets', 'runtime-capability-matrix.json');
}

export function readCapabilityMatrix(skillRoot) {
  const filePath = getCapabilityMatrixPath(skillRoot);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

export function getWebCrypto() {
  return globalThis.crypto?.subtle ? globalThis.crypto : crypto.webcrypto;
}

export function loadCryptoJS(skillRoot) {
  if (cryptoJsCache.has(skillRoot)) {
    return cryptoJsCache.get(skillRoot);
  }
  const candidates = [
    path.join(skillRoot, 'vendor', 'crypto-js'),
    path.resolve(skillRoot, '..', '..', '..', 'drpy-node', 'node_modules', 'crypto-js'),
    path.resolve(skillRoot, '..', 'drpy-node', 'node_modules', 'crypto-js'),
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const loaded = localRequire(candidate);
      const cryptoJs = loaded?.default || loaded;
      if (cryptoJs?.AES && cryptoJs?.MD5 && cryptoJs?.enc) {
        cryptoJsCache.set(skillRoot, cryptoJs);
        return cryptoJs;
      }
    } catch (_) {
    }
  }
  return null;
}

export function createRequireShim(skillRoot, logger = () => {}) {
  const config = readEmbeddedSkillConfig(skillRoot);
  const allowList = new Set(config.crypto.requireAllowList || []);
  const cryptoJs = loadCryptoJS(skillRoot);
  const moduleMap = {
    'crypto-js': cryptoJs,
    crypto,
    'node:crypto': crypto,
    buffer: { Buffer },
    url: { URL, URLSearchParams },
  };

  return function requireShim(name) {
    const requestName = String(name || '').trim();
    if (!allowList.has(requestName)) {
      throw new Error(`require not allowed: ${requestName}`);
    }
    if (moduleMap[requestName]) {
      return moduleMap[requestName];
    }
    logger(`[requireShim] fallback load => ${requestName}`);
    return localRequire(requestName);
  };
}

export function createOcrApi(skillRoot, logger = () => {}, overrideConfig = null) {
  const config = normalizeOcrConfig(overrideConfig || readEmbeddedSkillConfig(skillRoot).ocr);
  const configured = Boolean(
    (config.mode === 'http' && config.endpoint)
    || (config.mode === 'command' && config.command),
  );
  return {
    api: config.endpoint || config.command || '',
    configured,
    mode: config.mode || 'none',
    retry: Number(config.retry || DEFAULT_OCR_RETRY),
    timeoutMs: Number(config.timeoutMs || 15000),
    async classification(img) {
      const image = String(img || '').trim();
      if (!image) {
        logger('[OcrApi.classification] empty image');
        return '';
      }

      if (config.mode === 'http' && config.endpoint) {
        return await runHttpOcr(config, image, logger);
      }
      if (config.mode === 'command' && config.command) {
        return await runCommandOcr(config, image, logger);
      }

      logger(`[OcrApi.classification] OCR not configured (mode=${config.mode || 'none'})`);
      return '';
    },
  };
}

export function createCryptoHelpers(skillRoot) {
  const cryptoJs = loadCryptoJS(skillRoot);
  return {
    cryptoJs,
    getCryptoJS: () => cryptoJs,
    CryptoJS: cryptoJs || {},
    CryptoJSW: cryptoJs || {},
    md5(value) {
      if (cryptoJs?.MD5) {
        return cryptoJs.MD5(String(value || '')).toString();
      }
      return crypto.createHash('md5').update(String(value || '')).digest('hex');
    },
  };
}

async function runHttpOcr(config, image, logger) {
  const headers = normalizeHeaders(config.headers || {});
  let body;
  let responsePath = config.responsePath || '';

  if (config.bodyMode === 'json' || (config.bodyMode === 'auto' && /drpy\/text$/i.test(config.endpoint))) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify({ img: image });
    if (!responsePath) {
      responsePath = 'code';
    }
  } else {
    body = image;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.timeoutMs || 15000));
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    return extractOcrText(text, responsePath, logger);
  } catch (error) {
    logger(`[OcrApi.classification] HTTP OCR failed: ${error.message}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function runCommandOcr(config, image, logger) {
  return await new Promise((resolve) => {
    let child;
    const args = (config.args || []).map((arg) => String(arg).replaceAll('{input}', image));
    try {
      child = spawn(config.command, args, {
        cwd: config.cwd || process.cwd(),
        env: {
          ...process.env,
          ...(config.env || {}),
        },
        windowsHide: true,
      });
    } catch (error) {
      logger(`[OcrApi.classification] spawn failed: ${error.message}`);
      resolve('');
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (_) {
      }
      resolve('');
    }, Number(config.timeoutMs || 15000));

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      logger(`[OcrApi.classification] command error: ${error.message}`);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (stderr.trim()) {
        logger(`[OcrApi.classification] command stderr: ${stderr.trim()}`);
      }
      resolve(extractOcrText(stdout, config.responsePath || '', logger));
    });

    const hasPlaceholder = (config.args || []).some((arg) => String(arg).includes('{input}'));
    if (!hasPlaceholder) {
      child.stdin.write(image);
    }
    child.stdin.end();
  });
}

function extractOcrText(raw, responsePath, logger = () => {}) {
  const text = String(raw || '').trim();
  if (!text) {
    return '';
  }
  if (!responsePath) {
    try {
      const parsed = JSON.parse(text);
      return String(
        pickByPath(parsed, 'code')
        || pickByPath(parsed, 'text')
        || pickByPath(parsed, 'data.code')
        || pickByPath(parsed, 'data.text')
        || pickByPath(parsed, 'result')
        || pickByPath(parsed, 'data.result')
        || '',
      ).trim();
    } catch (_) {
      return text.trim();
    }
  }
  try {
    const parsed = JSON.parse(text);
    return String(pickByPath(parsed, responsePath) || '').trim();
  } catch (error) {
    logger(`[OcrApi.classification] parse response failed: ${error.message}`);
    return text.trim();
  }
}

function pickByPath(value, pathValue) {
  return String(pathValue || '')
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc && typeof acc === 'object' && key in acc ? acc[key] : undefined), value);
}

function normalizeHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    result[String(key)] = String(value);
  }
  return result;
}

function normalizeOcrConfig(config = {}) {
  return {
    mode: config.mode || 'http',
    endpoint: config.endpoint || DEFAULT_OCR_API,
    command: config.command || '',
    args: Array.isArray(config.args) ? config.args : [],
    cwd: config.cwd || '',
    env: config.env || {},
    headers: config.headers || {},
    timeoutMs: Number(config.timeoutMs || 15000),
    bodyMode: config.bodyMode || 'auto',
    responsePath: config.responsePath || '',
    retry: Number(config.retry || DEFAULT_OCR_RETRY),
  };
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
