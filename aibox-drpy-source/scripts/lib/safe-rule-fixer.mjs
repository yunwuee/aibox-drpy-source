import { isDeepStrictEqual } from 'node:util';
import MagicString from 'magic-string';
import { analyzeRuleSource } from './rule-ast.mjs';

const PLAY_PARSE_CODES = new Set(['LAZY_REQUIRES_PLAY_PARSE']);
const PLAY_JSON_CODES = new Set(['LAZY_PLAY_JSON_REQUIRED', 'LAZY_PLAY_JSON_OVERRIDE']);

export function createSafeRulePatch(source, options = {}) {
  const code = String(source ?? '');
  const beforeAnalysis = options.analysis || analyzeRuleSource(code, options.analysisOptions);
  if (!beforeAnalysis.rule) {
    return {
      changed: false,
      code,
      diff: '',
      changes: [],
      patches: [],
      skipped: ['规则对象无法静态定位，未生成任何补丁'],
      analysis: beforeAnalysis,
      beforeAnalysis,
      afterAnalysis: beforeAnalysis,
    };
  }

  const magic = new MagicString(code);
  const changes = [];
  const patches = [];
  const skipped = [];
  const properties = [...beforeAnalysis.rule.properties].sort((left, right) => left.index - right.index);

  if (options.removeDuplicateFields !== false) {
    removeShadowedTopLevelFields({ code, magic, analysis: beforeAnalysis, properties, changes, patches, skipped });
  }

  const requestedFields = new Map();
  if (options.fixLazyContract !== false) {
    const codes = new Set(beforeAnalysis.diagnostics.map((item) => item.code));
    if ([...PLAY_PARSE_CODES].some((codeName) => codes.has(codeName))) {
      requestedFields.set('play_parse', true);
    }
    if ([...PLAY_JSON_CODES].some((codeName) => codes.has(codeName))) {
      requestedFields.set('play_json', []);
    }
  }
  for (const key of Reflect.ownKeys(options.setFields || {})) {
    if (typeof key !== 'string') continue;
    requestedFields.set(key, options.setFields[key]);
  }

  const insertions = [];
  for (const [field, value] of requestedFields) {
    const expression = serializeJsValue(value);
    const existing = properties.filter((property) => property.key === field).at(-1);
    if (existing) {
      if (existing.static && isDeepStrictEqual(existing.staticValue, value)) continue;
      const [start, end] = existing.valueRange || [];
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        skipped.push(`无法定位 rule.${field} 的值范围`);
        continue;
      }
      const previous = code.slice(start, end);
      magic.overwrite(start, end, expression);
      changes.push(`更新 rule.${field}`);
      patches.push({ type: 'replace-value', field, range: [start, end], before: previous, after: expression });
    } else {
      insertions.push({ field, expression });
    }
  }

  if (insertions.length > 0) {
    insertTopLevelFields({ code, magic, analysis: beforeAnalysis, properties, insertions, changes, patches, skipped });
  }

  const nextCode = magic.toString();
  const afterAnalysis = nextCode === code
    ? beforeAnalysis
    : analyzeRuleSource(nextCode, options.analysisOptions);
  return {
    changed: nextCode !== code,
    code: nextCode,
    diff: nextCode === code
      ? ''
      : createUnifiedDiff(code, nextCode, { fileName: options.fileName || 'rule.js' }),
    changes,
    patches,
    skipped,
    analysis: afterAnalysis,
    beforeAnalysis,
    afterAnalysis,
  };
}

export const buildSafeRuleFix = createSafeRulePatch;

export function createUnifiedDiff(before, after, { fileName = 'rule.js', context = 3 } = {}) {
  if (before === after) return '';
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const leadingContextStart = Math.max(0, prefix - context);
  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const trailingContextCount = Math.min(context, suffix);
  const oldHunkEnd = oldChangeEnd + trailingContextCount;
  const newHunkEnd = newChangeEnd + trailingContextCount;
  const oldStartLine = leadingContextStart + 1;
  const newStartLine = leadingContextStart + 1;
  const output = [
    `--- a/${fileName}`,
    `+++ b/${fileName}`,
    `@@ -${oldStartLine},${oldHunkEnd - leadingContextStart} +${newStartLine},${newHunkEnd - leadingContextStart} @@`,
  ];

  for (let index = leadingContextStart; index < prefix; index += 1) {
    output.push(` ${oldLines[index]}`);
  }
  for (let index = prefix; index < oldChangeEnd; index += 1) {
    output.push(`-${oldLines[index]}`);
  }
  for (let index = prefix; index < newChangeEnd; index += 1) {
    output.push(`+${newLines[index]}`);
  }
  for (let index = 0; index < trailingContextCount; index += 1) {
    output.push(` ${oldLines[oldChangeEnd + index]}`);
  }
  return `${output.join('\n')}\n`;
}

function removeShadowedTopLevelFields({ code, magic, analysis, properties, changes, patches, skipped }) {
  for (const duplicate of analysis.rule.duplicateFields) {
    for (const occurrence of duplicate.occurrences.slice(0, -1)) {
      const property = properties.find((item) => item.index === occurrence.index);
      const next = properties.find((item) => item.index > occurrence.index);
      if (!property?.range || !next?.range) {
        skipped.push(`无法安全删除重复字段 rule.${duplicate.field}`);
        continue;
      }
      const comma = findCommaBetween(code, property.range[1], next.range[0]);
      if (comma === -1) {
        skipped.push(`重复字段 rule.${duplicate.field} 后未找到分隔逗号`);
        continue;
      }
      const range = [property.range[0], comma + 1];
      const previous = code.slice(range[0], range[1]);
      magic.remove(range[0], range[1]);
      changes.push(`删除被后值覆盖的 rule.${duplicate.field}`);
      patches.push({ type: 'remove-shadowed-field', field: duplicate.field, range, before: previous, after: '' });
    }
  }
}

function insertTopLevelFields({ code, magic, analysis, properties, insertions, changes, patches, skipped }) {
  const objectRange = analysis.rule.objectRange;
  if (!objectRange) {
    skipped.push('无法定位 rule 对象范围，未插入字段');
    return;
  }
  const closeIndex = objectRange[1] - 1;
  const newline = code.includes('\r\n') ? '\r\n' : '\n';
  const lastProperty = properties.at(-1);
  const closingLineStart = code.lastIndexOf('\n', closeIndex - 1) + 1;
  const closingIndent = code.slice(closingLineStart, closeIndex);
  const isMultiline = closingLineStart > objectRange[0] && /^\s*$/.test(closingIndent);

  if (lastProperty) {
    const tail = code.slice(lastProperty.range[1], closeIndex);
    if (!/^\s*,/.test(tail) && !tail.trimStart().startsWith(',')) {
      magic.appendLeft(lastProperty.range[1], ',');
      patches.push({
        type: 'insert-comma',
        field: lastProperty.key,
        range: [lastProperty.range[1], lastProperty.range[1]],
        before: '',
        after: ',',
      });
    }
  }

  const propertyIndent = inferPropertyIndent(code, properties, closingIndent);
  const rendered = insertions.map(({ field, expression }) => `${renderPropertyKey(field)}: ${expression}`);
  if (isMultiline) {
    const text = `${rendered.map((item) => `${propertyIndent}${item},`).join(newline)}${newline}`;
    magic.appendLeft(closingLineStart, text);
    patches.push({ type: 'insert-fields', fields: insertions.map((item) => item.field), range: [closingLineStart, closingLineStart], before: '', after: text });
  } else {
    const tail = lastProperty ? code.slice(lastProperty.range[1], closeIndex) : '';
    const prefix = lastProperty && tail.includes(',') ? '' : (lastProperty ? ' ' : ' ');
    const text = `${prefix}${rendered.join(', ')}`;
    magic.appendLeft(closeIndex, text);
    patches.push({ type: 'insert-fields', fields: insertions.map((item) => item.field), range: [closeIndex, closeIndex], before: '', after: text });
  }
  for (const insertion of insertions) changes.push(`新增 rule.${insertion.field}`);
}

function inferPropertyIndent(code, properties, closingIndent) {
  const first = properties[0];
  if (first?.range) {
    const lineStart = code.lastIndexOf('\n', first.range[0] - 1) + 1;
    const indent = code.slice(lineStart, first.range[0]);
    if (/^\s+$/.test(indent) || indent === '') return indent || `${closingIndent}  `;
  }
  return `${closingIndent}  `;
}

function findCommaBetween(code, start, end) {
  const segment = code.slice(start, end);
  const offset = segment.indexOf(',');
  return offset === -1 ? -1 : start + offset;
}

function serializeJsValue(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError('顶层安全补丁只接受 JSON 可表达的静态值');
  }
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError('无法序列化顶层字段值');
  return serialized;
}

function renderPropertyKey(field) {
  return /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u.test(field)
    ? field
    : JSON.stringify(field);
}

function splitLines(value) {
  return String(value).replace(/\r\n/g, '\n').split('\n');
}
