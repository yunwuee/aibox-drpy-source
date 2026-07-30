import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'acorn';
import * as walk from 'acorn-walk';

import { findAiboxEngineRoot } from './aibox-paths.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(currentDir, '..', '..');

export function resolveAiboxEngineRoot(explicitRoot = '') {
  return findAiboxEngineRoot({
    explicitRoot,
    skillRoot,
    requiredPaths: [path.join('libs_drpy', 'template.js')],
  });
}

export function listEngineTemplateNames(options = {}) {
  const engineRoot = resolveAiboxEngineRoot(options.engineRoot);
  if (!engineRoot) return [];
  const source = fs.readFileSync(path.join(engineRoot, 'libs_drpy', 'template.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let templateObject = null;
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id?.type === 'Identifier' && node.id.name === 'mubanDict' && node.init?.type === 'ObjectExpression') {
        templateObject = node.init;
      }
    },
  });
  if (!templateObject) return [];
  return templateObject.properties
    .map((property) => propertyName(property))
    .filter(Boolean);
}

export function getEngineTemplateMetadata(templateName, options = {}) {
  const engineRoot = resolveAiboxEngineRoot(options.engineRoot);
  if (!engineRoot) return null;
  const source = fs.readFileSync(path.join(engineRoot, 'libs_drpy', 'template.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let templateObject = null;
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id?.type === 'Identifier' && node.id.name === 'mubanDict' && node.init?.type === 'ObjectExpression') templateObject = node.init;
    },
  });
  const templateProperty = templateObject?.properties?.find((property) => propertyName(property) === templateName);
  if (templateProperty?.value?.type !== 'ObjectExpression') return null;
  const fields = Object.fromEntries(templateProperty.value.properties.map((property) => [propertyName(property), literalValue(property.value)]).filter(([key, value]) => key && value !== undefined));
  return {
    searchable: Number.isFinite(Number(fields.searchable)) ? Number(fields.searchable) : 0,
    filterable: Number.isFinite(Number(fields.filterable)) ? Number(fields.filterable) : 0,
    quickSearch: Number.isFinite(Number(fields.quickSearch)) ? Number(fields.quickSearch) : 0,
    double: typeof fields.double === 'boolean' ? fields.double : undefined,
  };
}

export async function loadEngineTemplates(options = {}) {
  const engineRoot = resolveAiboxEngineRoot(options.engineRoot);
  if (!engineRoot) {
    throw new Error('未找到 third_party/aibox-engine，无法读取真实模板');
  }
  const moduleUrl = pathToFileURL(path.join(engineRoot, 'libs_drpy', 'template.js')).href;
  const imported = await import(moduleUrl);
  const definitions = imported.default?.getMubans?.();
  if (!definitions || typeof definitions !== 'object') {
    throw new Error('Aibox template.getMubans() 未返回模板字典');
  }
  return definitions;
}

export function mergeTemplateRule(templateRule, explicitRule) {
  return {
    ...(templateRule || {}),
    ...(explicitRule || {}),
  };
}

export function summarizeResolvedRule(rule = {}) {
  const keys = [
    '类型', 'title', 'version', 'host', '模板', 'url', 'searchUrl', 'class_parse', 'double',
    '推荐', '一级', '二级', '搜索', 'lazy', 'play_parse', 'play_json', 'sniffer', 'isVideo',
    'searchable', 'filterable', 'quickSearch',
  ];
  return Object.fromEntries(keys.map((key) => [key, previewValue(rule[key])]).filter(([, value]) => value !== undefined));
}

function propertyName(property) {
  if (!property || property.type !== 'Property' || property.computed) return '';
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal') return String(property.key.value ?? '');
  return '';
}

function previewValue(value) {
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'string' && value.length > 240) return `${value.slice(0, 237)}...`;
  return value;
}

function literalValue(node) {
  if (!node) return undefined;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'UnaryExpression' && node.argument?.type === 'Literal') {
    if (node.operator === '-') return -node.argument.value;
    if (node.operator === '+') return +node.argument.value;
    if (node.operator === '!') return !node.argument.value;
  }
  return undefined;
}
