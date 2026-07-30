import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseExpressionAt } from 'acorn';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findAiboxEngineRoot } from './aibox-paths.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let engineModulePromise;
let engineModulePath = '';
let decryptQueue = Promise.resolve();

export class SourceLoadError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SourceLoadError';
    this.code = code;
    this.details = details;
  }
}

export function parseRuleHeader(source, { strict = true } = {}) {
  const text = normalizeSourceText(source);
  let topComments;
  let invocation;
  try {
    topComments = getTopCommentRegion(text);
    invocation = findHeaderInvocation(topComments.text, topComments.start);
  } catch (error) {
    const normalized = error instanceof SourceLoadError
      ? error
      : new SourceLoadError('HEADER_PARSE_ERROR', error?.message || String(error), {}, error);
    if (strict) throw normalized;
    return {
      found: text.includes('@header'),
      header: null,
      raw: '',
      range: null,
      commentRange: null,
      error: serializeSourceError(normalized),
    };
  }

  if (!invocation) {
    return {
      found: false,
      header: null,
      raw: '',
      range: null,
      commentRange: topComments.end > topComments.start
        ? [topComments.start, topComments.end]
        : null,
      error: null,
    };
  }

  try {
    const expression = parseExpressionAt(invocation.raw, 0, {
      ecmaVersion: 'latest',
      locations: true,
      sourceType: 'script',
    });
    const trailing = invocation.raw.slice(expression.end).trim();
    if (trailing) {
      throw new SourceLoadError(
        'HEADER_TRAILING_CODE',
        '@header 对象后存在不允许的表达式',
        { trailing },
      );
    }
    if (expression.type !== 'ObjectExpression') {
      throw new SourceLoadError(
        'HEADER_NOT_OBJECT',
        '@header 必须是静态对象字面量',
        { expressionType: expression.type },
      );
    }

    const header = evaluateSafeLiteral(expression, { rejectDuplicateKeys: true });
    return {
      found: true,
      header,
      raw: invocation.raw,
      range: invocation.range,
      commentRange: [topComments.start, topComments.end],
      error: null,
    };
  } catch (error) {
    const normalized = normalizeHeaderError(error, invocation);
    if (strict) {
      throw normalized;
    }
    return {
      found: true,
      header: null,
      raw: invocation.raw,
      range: invocation.range,
      commentRange: [topComments.start, topComments.end],
      error: serializeSourceError(normalized),
    };
  }
}

export async function loadRuleSource(source, options = {}) {
  const {
    filePath = null,
    decrypt = true,
    decryptor = decryptWithAiboxEngine,
    strictHeader = true,
  } = options;
  const rawCode = normalizeSourceText(source);
  if (!rawCode.trim()) {
    throw new SourceLoadError('SOURCE_EMPTY', '规则源码不能为空');
  }

  const envelopeHeader = parseRuleHeader(rawCode, { strict: strictHeader });
  const topComments = getTopCommentRegion(rawCode);
  const body = rawCode.slice(topComments.end).trim();
  const plain = looksLikePlainJavaScript(body);

  let decryptedCode = rawCode;
  let encrypted = false;
  if (!plain) {
    if (!decrypt) {
      throw new SourceLoadError(
        'SOURCE_ENCRYPTED',
        '检测到 DS 密文，但当前调用禁用了自动解密',
      );
    }
    if (typeof decryptor !== 'function') {
      throw new SourceLoadError('DECRYPTOR_MISSING', '未提供可用的 DS 解密器');
    }

    try {
      decryptedCode = normalizeSourceText(await decryptor(body));
    } catch (error) {
      throw new SourceLoadError(
        'SOURCE_DECRYPT_FAILED',
        `DS 密文解密失败：${error?.message || String(error)}`,
        {},
        error,
      );
    }

    if (!decryptedCode.trim() || decryptedCode.trim() === body) {
      throw new SourceLoadError(
        'SOURCE_DECRYPT_EMPTY',
        'DS 密文未能还原出有效 JavaScript 源码',
      );
    }
    encrypted = true;
  }

  const decodedHeader = parseRuleHeader(decryptedCode, { strict: strictHeader });
  let code = decryptedCode;
  if (encrypted && topComments.end > topComments.start && !decodedHeader.found) {
    const leadingComments = rawCode.slice(topComments.start, topComments.end).trimEnd();
    code = `${leadingComments}\n\n${decryptedCode.trimStart()}`;
  }
  const headerInfo = parseRuleHeader(code, { strict: strictHeader });

  return {
    filePath,
    rawCode,
    code,
    decryptedCode,
    encrypted,
    sourceType: encrypted
      ? (headerInfo.found ? 'encrypted-header' : 'encrypted')
      : (headerInfo.found ? 'header' : 'plain'),
    header: headerInfo.header,
    headerInfo,
    envelopeHeader,
    decodedHeader,
    byteLength: Buffer.byteLength(code, 'utf8'),
    rawByteLength: Buffer.byteLength(rawCode, 'utf8'),
    sha256: sha256(code),
    rawSha256: sha256(rawCode),
  };
}

export async function loadRuleSourceFile(filePath, options = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new SourceLoadError('SOURCE_PATH_REQUIRED', '必须提供规则文件路径');
  }
  let source;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new SourceLoadError(
      'SOURCE_READ_FAILED',
      `读取规则文件失败：${error?.message || String(error)}`,
      { filePath },
      error,
    );
  }
  return loadRuleSource(source, { ...options, filePath });
}

export function stripTopComments(source) {
  const text = normalizeSourceText(source);
  const region = getTopCommentRegion(text);
  return text.slice(region.end).trimStart();
}

export function tryEvaluateSafeLiteral(node, options = {}) {
  try {
    return { known: true, value: evaluateSafeLiteral(node, options), error: null };
  } catch (error) {
    return { known: false, value: undefined, error };
  }
}

export function evaluateSafeLiteral(node, { rejectDuplicateKeys = false } = {}) {
  if (!node || typeof node.type !== 'string') {
    throw new SourceLoadError('STATIC_VALUE_INVALID', '静态值节点无效');
  }

  switch (node.type) {
    case 'Literal':
      if (node.regex || typeof node.value === 'bigint') {
        throw unsupportedStaticNode(node);
      }
      return node.value;
    case 'TemplateLiteral':
      if (node.expressions.length > 0) {
        throw unsupportedStaticNode(node);
      }
      return node.quasis.map((item) => item.value.cooked ?? item.value.raw).join('');
    case 'UnaryExpression': {
      const value = evaluateSafeLiteral(node.argument, { rejectDuplicateKeys });
      switch (node.operator) {
        case '+': return +value;
        case '-': return -value;
        case '!': return !value;
        case '~': return ~value;
        default: throw unsupportedStaticNode(node);
      }
    }
    case 'ArrayExpression':
      return node.elements.map((item) => {
        if (!item || item.type === 'SpreadElement') {
          throw unsupportedStaticNode(item || node);
        }
        return evaluateSafeLiteral(item, { rejectDuplicateKeys });
      });
    case 'ObjectExpression': {
      const result = {};
      const seen = new Set();
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.shorthand) {
          throw unsupportedStaticNode(property);
        }
        const key = getStaticPropertyKey(property);
        if (key === null) {
          throw unsupportedStaticNode(property.key);
        }
        if (rejectDuplicateKeys && seen.has(key)) {
          throw new SourceLoadError(
            'HEADER_DUPLICATE_FIELD',
            `@header 存在重复字段：${key}`,
            { field: key, line: property.loc?.start?.line },
          );
        }
        seen.add(key);
        const value = evaluateSafeLiteral(property.value, { rejectDuplicateKeys });
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      }
      return result;
    }
    default:
      throw unsupportedStaticNode(node);
  }
}

export function serializeSourceError(error) {
  return {
    code: error?.code || 'SOURCE_LOAD_ERROR',
    message: error?.message || String(error),
    details: error?.details || {},
  };
}

async function decryptWithAiboxEngine(source) {
  const run = decryptQueue.then(() => withEngineLog(async () => {
    const engineRoot = findAiboxEngineRoot({
      skillRoot,
      requiredPaths: [path.join('libs_drpy', 'drpyCustom.js')],
    });
    if (!engineRoot) {
      throw new SourceLoadError(
        'ENGINE_DECRYPTOR_UNAVAILABLE',
        '未找到 Aibox 原生引擎。请设置 AIBOX_ENGINE_ROOT 后再解密 DS 密文',
      );
    }
    const modulePath = path.join(engineRoot, 'libs_drpy', 'drpyCustom.js');
    if (!engineModulePromise || engineModulePath !== modulePath) {
      engineModulePath = modulePath;
      engineModulePromise = import(pathToFileURL(modulePath).href);
    }
    const module = await engineModulePromise;
    if (typeof module.getOriginalJs !== 'function') {
      throw new SourceLoadError(
        'ENGINE_DECRYPTOR_UNAVAILABLE',
        'Aibox 引擎未导出 getOriginalJs()',
      );
    }
    return module.getOriginalJs(source);
  }));
  decryptQueue = run.catch(() => undefined);
  return run;
}

async function withEngineLog(callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'log');
  const needsShim = typeof globalThis.log !== 'function';
  if (needsShim) {
    Object.defineProperty(globalThis, 'log', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => {},
    });
  }
  try {
    return await callback();
  } finally {
    if (needsShim) {
      if (descriptor) {
        Object.defineProperty(globalThis, 'log', descriptor);
      } else {
        delete globalThis.log;
      }
    }
  }
}

function getTopCommentRegion(source) {
  let index = 0;
  const length = source.length;
  while (index < length) {
    while (index < length && /\s/.test(source[index])) index += 1;
    if (source.startsWith('//', index)) {
      const lineEnd = source.indexOf('\n', index + 2);
      index = lineEnd === -1 ? length : lineEnd + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const blockEnd = source.indexOf('*/', index + 2);
      if (blockEnd === -1) {
        throw new SourceLoadError('TOP_COMMENT_UNTERMINATED', '文件顶部块注释未闭合');
      }
      index = blockEnd + 2;
      continue;
    }
    break;
  }
  return { start: 0, end: index, text: source.slice(0, index) };
}

function findHeaderInvocation(commentText, absoluteOffset) {
  let searchIndex = 0;
  while (searchIndex < commentText.length) {
    const marker = commentText.indexOf('@header', searchIndex);
    if (marker === -1) return null;
    let open = marker + '@header'.length;
    while (/\s/.test(commentText[open] || '')) open += 1;
    if (commentText[open] !== '(') {
      searchIndex = open;
      continue;
    }

    const close = findBalancedParen(commentText, open);
    if (close === -1) {
      throw new SourceLoadError(
        'HEADER_UNTERMINATED',
        '@header(...) 未闭合',
        { offset: absoluteOffset + marker },
      );
    }
    return {
      raw: commentText.slice(open + 1, close),
      range: [absoluteOffset + marker, absoluteOffset + close + 1],
    };
  }
  return null;
}

function findBalancedParen(text, openIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && next === '/') {
      const lineEnd = text.indexOf('\n', index + 2);
      if (lineEnd === -1) return -1;
      index = lineEnd;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function getStaticPropertyKey(property) {
  if (!property.computed && property.key.type === 'Identifier') {
    return property.key.name;
  }
  if (property.key.type === 'Literal' && ['string', 'number'].includes(typeof property.key.value)) {
    return String(property.key.value);
  }
  if (property.computed) {
    const evaluated = tryEvaluateSafeLiteral(property.key);
    if (evaluated.known && ['string', 'number'].includes(typeof evaluated.value)) {
      return String(evaluated.value);
    }
  }
  return null;
}

function unsupportedStaticNode(node) {
  return new SourceLoadError(
    'HEADER_UNSAFE_EXPRESSION',
    `@header 只允许静态字面量，不能使用 ${node?.type || '未知表达式'}`,
    {
      expressionType: node?.type || null,
      line: node?.loc?.start?.line || null,
      column: node?.loc?.start?.column || null,
    },
  );
}

function normalizeHeaderError(error, invocation) {
  if (error instanceof SourceLoadError) return error;
  return new SourceLoadError(
    'HEADER_PARSE_ERROR',
    `@header 解析失败：${error?.message || String(error)}`,
    { range: invocation.range },
    error,
  );
}

function looksLikePlainJavaScript(source) {
  return /\b(?:var|let|const|function|class|async|import|export)\b|(?:^|[^\w$])this\s*\./m.test(source);
}

function normalizeSourceText(source) {
  const value = Buffer.isBuffer(source) ? source.toString('utf8') : String(source ?? '');
  return value.replace(/^\uFEFF/, '');
}

function sha256(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}
