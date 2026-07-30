import { createHash, randomInt } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const defaultShareConfig = {
  baseUrl: 'https://textdb.online',
  provider: '云1',
  groupProvider: '云G1',
  keyLength: 24,
  timeoutMs: 15000,
};

const keyChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function resolveClipboardShareConfig(config = {}, overrides = {}) {
  const source = config.clipboardShare || config || {};
  return {
    ...defaultShareConfig,
    ...source,
    ...overrides,
    baseUrl: String(overrides.baseUrl || source.baseUrl || defaultShareConfig.baseUrl).replace(/\/+$/g, ''),
    keyLength: numberOrDefault(overrides.keyLength ?? source.keyLength, defaultShareConfig.keyLength),
    timeoutMs: numberOrDefault(overrides.timeoutMs ?? source.timeoutMs, defaultShareConfig.timeoutMs),
  };
}

export function encodeShareContent(content) {
  return gzipSync(Buffer.from(String(content || ''), 'utf8')).toString('base64');
}

export function decodeShareContent(encoded) {
  return gunzipSync(Buffer.from(String(encoded || '').trim(), 'base64')).toString('utf8');
}

export function generateShareKey(length = defaultShareConfig.keyLength) {
  const size = Math.max(1, Number(length) || defaultShareConfig.keyLength);
  let out = '';
  for (let index = 0; index < size; index += 1) {
    out += keyChars[randomInt(keyChars.length)];
  }
  return out;
}

export async function uploadToTextdb(content, options = {}) {
  const config = {
    ...defaultShareConfig,
    ...options,
    baseUrl: String(options.baseUrl || defaultShareConfig.baseUrl).replace(/\/+$/g, ''),
    keyLength: numberOrDefault(options.keyLength, defaultShareConfig.keyLength),
    timeoutMs: numberOrDefault(options.timeoutMs, defaultShareConfig.timeoutMs),
  };
  const key = String(options.key || generateShareKey(config.keyLength));
  const encoded = encodeShareContent(content);
  const payload = new URLSearchParams({
    key,
    value: encoded,
  });

  if (options.dryRun) {
    return {
      key,
      encodedLength: encoded.length,
      rawLength: Buffer.byteLength(String(content || ''), 'utf8'),
      dryRun: true,
      baseUrl: config.baseUrl,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: payload.toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    let result = {};
    try {
      result = JSON.parse(text || '{}');
    } catch (_) {
      result = {};
    }
    if (!response.ok || Number(result.status) !== 1) {
      const message = result && result.message ? result.message : `HTTP ${response.status}`;
      throw new Error(`上传失败: ${message}`);
    }
    return {
      key,
      encodedLength: encoded.length,
      rawLength: Buffer.byteLength(String(content || ''), 'utf8'),
      dryRun: false,
      baseUrl: config.baseUrl,
      status: result.status,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadFromTextdb(key, options = {}) {
  const config = resolveClipboardShareConfig(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/${encodeURIComponent(String(key || ''))}`, {
      headers: { 'User-Agent': 'Aibox-Skill/1.0' },
      signal: controller.signal,
    });
    const encoded = (await response.text()).trim();
    if (!response.ok || !encoded) {
      throw new Error(`云剪切板回读失败: HTTP ${response.status}`);
    }
    return decodeShareContent(encoded);
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadSingleSource({
  sourceName,
  sourceCode,
  category = '',
  groupTag = '',
  config = {},
  dryRun = false,
  verify = true,
} = {}) {
  const shareConfig = resolveClipboardShareConfig(config, { dryRun });
  const name = String(sourceName || '').trim();
  if (!name) throw new Error('uploadSingleSource 需要 sourceName');
  if (typeof sourceCode !== 'string' || !sourceCode.trim()) {
    throw new Error('uploadSingleSource 需要非空 sourceCode');
  }

  const upload = await uploadToTextdb(sourceCode, {
    ...shareConfig,
    dryRun,
  });
  const verification = verify
    ? await verifyUploadedContent({ key: upload.key, content: sourceCode, config: shareConfig, dryRun })
    : { verified: false, skipped: true, reason: 'disabled' };
  const cat = String(category || '').trim();
  const group = String(groupTag || '').trim();
  const shareCode = buildSingleShareCode({
    provider: shareConfig.provider,
    sourceName: name,
    key: upload.key,
    category: cat,
    groupTag: group,
  });

  return {
    provider: shareConfig.provider,
    type: 'single',
    shareCode,
    key: upload.key,
    uploadedCount: 1,
    failedCount: 0,
    baseUrl: shareConfig.baseUrl,
    sourceName: name,
    category: cat,
    groupTag: group,
    encodedLength: upload.encodedLength,
    rawLength: upload.rawLength,
    sha256: sha256(sourceCode),
    verification,
    dryRun,
  };
}

export async function uploadGroup({
  entries = [],
  groupTag = '',
  category = 'video',
  config = {},
  dryRun = false,
  verify = true,
} = {}) {
  const shareConfig = resolveClipboardShareConfig(config, { dryRun });
  const group = String(groupTag || '').trim();
  const cat = String(category || 'video').trim() || 'video';
  if (!group) throw new Error('uploadGroup 需要 groupTag');
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('uploadGroup 需要 entries');
  }

  const invalidEntries = entries
    .map((entry, index) => ({ index, name: String(entry.name || entry.displayName || '').trim(), sourceCode: String(entry.sourceCode || '') }))
    .filter((entry) => !entry.name || !entry.sourceCode.trim());
  if (invalidEntries.length) {
    throw new Error(`分组预检失败: ${invalidEntries.map((entry) => `#${entry.index + 1} 缺少名称或源码`).join('; ')}`);
  }

  const sourceEntries = [];
  const failures = [];

  for (const entry of entries) {
    try {
      const sourceCode = String(entry.sourceCode || '');
      if (!sourceCode.trim()) throw new Error('源码内容为空');
      const upload = await uploadToTextdb(sourceCode, {
        ...shareConfig,
        dryRun,
      });
      const verification = verify
        ? await verifyUploadedContent({ key: upload.key, content: sourceCode, config: shareConfig, dryRun })
        : { verified: false, skipped: true, reason: 'disabled' };
      sourceEntries.push({
        name: String(entry.name || entry.displayName || '').trim(),
        key: upload.key,
        category: String(entry.category || cat).trim() || cat,
        groupTag: String(entry.groupTag || group).trim() || group,
        displayName: String(entry.displayName || entry.name || '').trim(),
        sort: Number(entry.sort) || 0,
        sha256: sha256(sourceCode),
        verification,
      });
    } catch (error) {
      failures.push({
        index: sourceEntries.length + failures.length,
        name: String(entry.name || entry.displayName || '').trim(),
        message: error.message,
      });
    }
  }

  if (failures.length) {
    const error = new Error(`分组上传失败 ${failures.length}/${entries.length}: ${failures.map((item) => `${item.name || `#${item.index + 1}`}: ${item.message}`).join('; ')}`);
    error.failures = failures;
    throw error;
  }

  const manifest = {
    version: 1,
    groupTag: group,
    category: cat,
    createdAt: new Date().toISOString(),
    sources: sourceEntries,
  };
  const manifestUpload = await uploadToTextdb(JSON.stringify(manifest), {
    ...shareConfig,
    dryRun,
  });
  const manifestVerification = verify
    ? await verifyUploadedContent({ key: manifestUpload.key, content: JSON.stringify(manifest), config: shareConfig, dryRun })
    : { verified: false, skipped: true, reason: 'disabled' };
  const shareCode = `${shareConfig.groupProvider} ${group}@${cat}\n${manifestUpload.key}`;

  return {
    provider: shareConfig.groupProvider,
    type: 'group',
    shareCode,
    manifestKey: manifestUpload.key,
    uploadedCount: sourceEntries.length,
    failedCount: 0,
    baseUrl: shareConfig.baseUrl,
    groupTag: group,
    category: cat,
    manifest,
    encodedLength: manifestUpload.encodedLength,
    rawLength: manifestUpload.rawLength,
    sha256: sha256(JSON.stringify(manifest)),
    verification: manifestVerification,
    dryRun,
  };
}

async function verifyUploadedContent({ key, content, config, dryRun }) {
  const expected = String(content || '');
  const actual = dryRun
    ? decodeShareContent(encodeShareContent(expected))
    : await downloadFromTextdb(key, config);
  const expectedHash = sha256(expected);
  const actualHash = sha256(actual);
  if (Buffer.byteLength(expected, 'utf8') !== Buffer.byteLength(actual, 'utf8') || expectedHash !== actualHash) {
    throw new Error(`云剪切板回读不一致: expected=${expectedHash} actual=${actualHash}`);
  }
  return {
    verified: true,
    bytes: Buffer.byteLength(actual, 'utf8'),
    sha256: actualHash,
    tail: actual.slice(-80),
    dryRun,
  };
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function buildSingleShareCode({
  provider,
  sourceName,
  key,
  category,
  groupTag,
}) {
  const lines = [`${provider} ${sourceName}`, key];
  if (category || groupTag) {
    lines.push(`${category || ''}|${groupTag || ''}`);
  }
  return lines.join('\n');
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
