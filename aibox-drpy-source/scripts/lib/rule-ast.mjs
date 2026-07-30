import { isDeepStrictEqual } from 'node:util';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';
import {
  parseRuleHeader,
  tryEvaluateSafeLiteral,
} from './source-loader.mjs';

export const RULE_HANDLER_FIELDS = Object.freeze([
  '推荐',
  '一级',
  '二级',
  '搜索',
  'lazy',
  'proxy_rule',
]);

export const REQUIRED_HEADER_FIELDS = Object.freeze([
  'title',
  '类型',
  'lang',
  'searchable',
  'filterable',
  'quickSearch',
]);

const CORE_HANDLER_FIELDS = ['推荐', '一级', '二级', '搜索'];
const ATTRIBUTE_TERMINALS = /&&\s*(?:Text|Html|InnerHtml|OuterHtml|href|src|style|data-[\w-]+)\s*$/i;

export function analyzeRuleSource(source, options = {}) {
  const code = String(source ?? '').replace(/^\uFEFF/, '');
  const diagnostics = [];
  let ast;

  try {
    ast = parse(code, {
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
      allowReturnOutsideFunction: true,
      ecmaVersion: 'latest',
      locations: true,
      ranges: true,
      sourceType: 'script',
    });
  } catch (error) {
    addDiagnostic(diagnostics, {
      code: 'JS_SYNTAX_ERROR',
      severity: 'error',
      message: `JavaScript 语法错误：${error?.message || String(error)}`,
      loc: error?.loc ? { line: error.loc.line, column: error.loc.column } : null,
      range: typeof error?.pos === 'number' ? [error.pos, error.pos] : null,
    });
    return finalizeAnalysis({
      code,
      diagnostics,
      header: inspectHeader(code, diagnostics),
      rule: null,
      template: { checked: false, name: null, known: null },
    });
  }

  const header = inspectHeader(code, diagnostics, options.header);
  const declarations = findRuleDeclarations(ast);
  if (declarations.length === 0) {
    addDiagnostic(diagnostics, {
      code: 'RULE_DECLARATION_MISSING',
      severity: 'error',
      message: '未找到 var rule = { ... } 规则对象',
    });
    return finalizeAnalysis({
      code,
      diagnostics,
      header,
      rule: null,
      template: { checked: false, name: null, known: null },
    });
  }

  if (declarations.length > 1) {
    addDiagnostic(diagnostics, {
      code: 'RULE_DECLARATION_DUPLICATE',
      severity: 'error',
      message: `检测到 ${declarations.length} 个 rule 声明，后续声明可能覆盖前面的规则`,
      loc: locationOf(declarations[1].declarator),
      range: rangeOf(declarations[1].declarator),
    });
  }

  const declaration = declarations.at(-1);
  if (declaration.declarator.init?.type !== 'ObjectExpression') {
    addDiagnostic(diagnostics, {
      code: 'RULE_NOT_OBJECT_LITERAL',
      severity: 'error',
      message: 'rule 必须直接声明为对象字面量，静态检查不会执行工厂函数或表达式',
      loc: locationOf(declaration.declarator.init || declaration.declarator),
      range: rangeOf(declaration.declarator.init || declaration.declarator),
    });
    return finalizeAnalysis({
      code,
      diagnostics,
      header,
      rule: null,
      template: { checked: false, name: null, known: null },
    });
  }

  const ruleObject = declaration.declarator.init;
  const propertyRecords = ruleObject.properties
    .map((property, index) => describeProperty(property, index))
    .filter(Boolean);
  const duplicateFields = inspectTopLevelDuplicates(propertyRecords, diagnostics);
  inspectNestedDuplicates(ruleObject, diagnostics);

  const effectiveProperties = new Map();
  for (const property of propertyRecords) {
    if (property.key !== null) effectiveProperties.set(property.key, property);
  }
  const staticFields = createStaticFieldMap(effectiveProperties);
  const handlers = createHandlerSummary(effectiveProperties);
  const functions = propertyRecords
    .filter((property) => property.function)
    .map((property) => ({ key: property.key, ...property.function, range: property.range, loc: property.loc }));
  const implementationMode = inferImplementationMode(staticFields, handlers);

  const rule = {
    declarationKind: declaration.kind,
    declarationRange: rangeOf(declaration.declarator),
    objectRange: rangeOf(ruleObject),
    loc: locationOf(ruleObject),
    style: 'object-literal',
    implementationMode,
    properties: propertyRecords,
    duplicateFields,
    staticFields,
    functions,
    handlers,
  };

  header.consistency = inspectHeaderConsistency(header, staticFields, diagnostics);
  const template = inspectTemplate(staticFields, rule, options, diagnostics);
  inspectDetailDictionary(ruleObject, diagnostics);
  inspectAstPatterns(ruleObject, diagnostics);
  inspectUnboundHandlerInput(ast, ruleObject, diagnostics);
  inspectLazyContract(effectiveProperties, staticFields, code, diagnostics);

  return finalizeAnalysis({ code, diagnostics, header, rule, template });
}

export const lintRuleSource = analyzeRuleSource;

function inspectHeader(code, diagnostics, suppliedHeader) {
  let parsed;
  if (suppliedHeader !== undefined) {
    parsed = {
      found: suppliedHeader !== null,
      header: suppliedHeader,
      raw: '',
      range: null,
      commentRange: null,
      error: null,
    };
  } else {
    try {
      parsed = parseRuleHeader(code, { strict: false });
    } catch (error) {
      parsed = {
        found: false,
        header: null,
        raw: '',
        range: null,
        commentRange: null,
        error: {
          code: error?.code || 'HEADER_PARSE_ERROR',
          message: error?.message || String(error),
          details: error?.details || {},
        },
      };
    }
  }

  if (parsed.error) {
    addDiagnostic(diagnostics, {
      code: parsed.error.code || 'HEADER_PARSE_ERROR',
      severity: 'error',
      message: parsed.error.message,
      range: parsed.range,
      details: parsed.error.details,
    });
  } else if (!parsed.found) {
    addDiagnostic(diagnostics, {
      code: 'HEADER_MISSING',
      severity: 'warning',
      message: '源码缺少顶部 @header({...}) 元数据',
    });
  }

  return {
    found: parsed.found,
    value: parsed.header,
    raw: parsed.raw,
    range: parsed.range,
    error: parsed.error,
    consistency: {
      checked: false,
      matches: [],
      mismatches: [],
      missing: [],
    },
  };
}

function findRuleDeclarations(ast) {
  const declarations = [];
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of statement.declarations) {
      if (declarator.id?.type === 'Identifier' && declarator.id.name === 'rule') {
        declarations.push({ kind: statement.kind, declarator });
      }
    }
  }
  return declarations;
}

function describeProperty(property, index) {
  if (property.type === 'SpreadElement') {
    return {
      index,
      key: null,
      computed: false,
      keyStyle: 'spread',
      propertyStyle: 'spread',
      valueStyle: 'spread',
      valueType: property.argument?.type || null,
      mode: 'spread',
      static: false,
      function: null,
      range: rangeOf(property),
      valueRange: rangeOf(property.argument),
      loc: locationOf(property),
    };
  }
  if (property.type !== 'Property') return null;

  const key = getPropertyKey(property);
  const evaluated = tryEvaluateSafeLiteral(property.value);
  const functionInfo = describeFunction(property);
  return {
    index,
    key,
    computed: Boolean(property.computed),
    keyStyle: property.computed
      ? 'computed'
      : (property.key.type === 'Identifier' ? 'identifier' : 'quoted'),
    propertyStyle: property.method ? 'method' : (property.shorthand ? 'shorthand' : 'key-value'),
    valueStyle: describeValueStyle(property),
    valueType: property.value.type,
    mode: describePropertyMode(key, property.value, evaluated),
    static: evaluated.known,
    ...(evaluated.known ? { staticValue: evaluated.value } : {}),
    function: functionInfo,
    range: rangeOf(property),
    valueRange: rangeOf(property.value),
    loc: locationOf(property),
  };
}

function describeFunction(property) {
  const value = property.value;
  if (!['FunctionExpression', 'ArrowFunctionExpression'].includes(value.type)) return null;
  return {
    async: Boolean(value.async),
    generator: Boolean(value.generator),
    params: value.params.length,
    style: property.method
      ? 'method'
      : (value.type === 'ArrowFunctionExpression' ? 'arrow-function' : 'function-expression'),
  };
}

function describeValueStyle(property) {
  if (property.method) return 'method';
  switch (property.value.type) {
    case 'FunctionExpression': return 'function-expression';
    case 'ArrowFunctionExpression': return 'arrow-function';
    case 'ObjectExpression': return 'object-literal';
    case 'ArrayExpression': return 'array-literal';
    case 'Literal': return 'literal';
    case 'TemplateLiteral': return 'template-literal';
    default: return 'expression';
  }
}

function describePropertyMode(key, value, evaluated) {
  if (['FunctionExpression', 'ArrowFunctionExpression'].includes(value.type)) {
    return value.async ? 'async-function' : 'function';
  }
  if (evaluated.known && typeof evaluated.value === 'string') {
    if (evaluated.value === '*') return 'inherit';
    if (evaluated.value.trimStart().startsWith('js:')) return 'js';
    if (RULE_HANDLER_FIELDS.includes(key)) return 'string-rule';
    return 'static-string';
  }
  if (value.type === 'ObjectExpression') return key === '二级' ? 'detail-dict' : 'object';
  if (value.type === 'ArrayExpression') return 'array';
  if (evaluated.known) return 'static';
  return 'expression';
}

function inspectTopLevelDuplicates(properties, diagnostics) {
  const groups = new Map();
  for (const property of properties) {
    if (property.key === null) continue;
    const items = groups.get(property.key) || [];
    items.push(property);
    groups.set(property.key, items);
  }

  const duplicates = [];
  for (const [field, occurrences] of groups) {
    if (occurrences.length < 2) continue;
    const duplicate = {
      field,
      count: occurrences.length,
      occurrences: occurrences.map((item) => ({ index: item.index, range: item.range, loc: item.loc })),
      effectiveIndex: occurrences.at(-1).index,
    };
    duplicates.push(duplicate);
    addDiagnostic(diagnostics, {
      code: 'RULE_DUPLICATE_FIELD',
      severity: 'error',
      message: `rule 顶层字段 ${field} 重复定义 ${occurrences.length} 次，JavaScript 只会保留最后一次`,
      field,
      path: `rule.${field}`,
      loc: occurrences[1].loc,
      range: occurrences[1].range,
      details: duplicate,
    });
  }
  return duplicates;
}

function inspectNestedDuplicates(ruleObject, diagnostics) {
  const objects = [];
  walk.simple(ruleObject, {
    ObjectExpression(node) {
      if (node !== ruleObject) objects.push(node);
    },
  });
  objects.sort((left, right) => left.start - right.start);

  for (const object of objects) {
    const seen = new Map();
    for (const property of object.properties) {
      if (property.type !== 'Property') continue;
      const key = getPropertyKey(property);
      if (key === null) continue;
      if (seen.has(key)) {
        addDiagnostic(diagnostics, {
          code: 'OBJECT_DUPLICATE_FIELD',
          severity: 'error',
          message: `规则内部对象字段 ${key} 重复定义，后值会静默覆盖前值`,
          field: key,
          loc: locationOf(property),
          range: rangeOf(property),
          details: { firstRange: rangeOf(seen.get(key)) },
        });
      } else {
        seen.set(key, property);
      }
    }
  }
}

function createStaticFieldMap(effectiveProperties) {
  const fields = {};
  for (const [key, property] of effectiveProperties) {
    if (!property.static) continue;
    Object.defineProperty(fields, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: property.staticValue,
    });
  }
  return fields;
}

function createHandlerSummary(effectiveProperties) {
  const handlers = {};
  for (const field of RULE_HANDLER_FIELDS) {
    const property = effectiveProperties.get(field);
    handlers[field] = property
      ? {
          present: true,
          mode: property.mode,
          style: property.valueStyle,
          async: property.function?.async ?? false,
          range: property.range,
          loc: property.loc,
        }
      : { present: false, mode: 'missing', style: null, async: false, range: null, loc: null };
  }
  return handlers;
}

function inferImplementationMode(staticFields, handlers) {
  const explicit = CORE_HANDLER_FIELDS
    .map((field) => handlers[field])
    .filter((handler) => handler.present && handler.mode !== 'inherit');
  const functions = explicit.filter((handler) => /function$/.test(handler.mode));
  const declarative = explicit.filter((handler) => !/function$/.test(handler.mode));

  if (typeof staticFields['模板'] === 'string' && explicit.length === 0) return 'template';
  if (functions.length === CORE_HANDLER_FIELDS.length) return 'full-async';
  if (functions.length > 0 && declarative.length > 0) return 'hybrid';
  if (functions.length > 0) return 'partial-async';
  if (explicit.length > 0) return 'string';
  if (typeof staticFields['模板'] === 'string') return 'template';
  return 'static';
}

function inspectHeaderConsistency(headerInfo, staticFields, diagnostics) {
  const result = {
    checked: Boolean(headerInfo.found && headerInfo.value && !headerInfo.error),
    matches: [],
    mismatches: [],
    missing: [],
  };
  if (!result.checked) return result;

  const header = headerInfo.value;
  for (const field of REQUIRED_HEADER_FIELDS) {
    const present = field === '类型'
      ? hasOwn(header, '类型') || hasOwn(header, 'type')
      : hasOwn(header, field);
    if (!present) {
      result.missing.push(field);
      addDiagnostic(diagnostics, {
        code: 'HEADER_FIELD_MISSING',
        severity: 'warning',
        message: `@header 缺少字段：${field}`,
        field,
        range: headerInfo.range,
      });
    }
  }

  if (hasOwn(header, 'lang') && header.lang !== 'ds') {
    result.mismatches.push({ field: 'lang', headerValue: header.lang, ruleValue: 'ds' });
    addDiagnostic(diagnostics, {
      code: 'HEADER_LANG_INVALID',
      severity: 'error',
      message: `@header.lang 应为 'ds'，当前为 ${JSON.stringify(header.lang)}`,
      field: 'lang',
      range: headerInfo.range,
    });
  }

  const comparisons = new Map();
  for (const field of ['title', 'searchable', 'filterable', 'quickSearch', 'version']) {
    if (hasOwn(header, field)) comparisons.set(field, { headerKey: field, ruleKey: field });
  }
  if (hasOwn(header, '类型')) comparisons.set('类型', { headerKey: '类型', ruleKey: '类型' });
  if (hasOwn(header, 'type')) comparisons.set('类型', { headerKey: 'type', ruleKey: '类型' });
  for (const field of Object.keys(header)) {
    if (field === 'lang' || comparisons.has(field) || !hasOwn(staticFields, field)) continue;
    comparisons.set(field, { headerKey: field, ruleKey: field });
  }

  for (const [field, mapping] of comparisons) {
    if (!hasOwn(staticFields, mapping.ruleKey)) {
      if (!staticFields['模板']) {
        const mismatch = { field, headerValue: header[mapping.headerKey], ruleValue: undefined };
        result.mismatches.push(mismatch);
        addDiagnostic(diagnostics, {
          code: 'HEADER_RULE_FIELD_MISSING',
          severity: 'error',
          message: `@header.${mapping.headerKey} 已声明，但非模板 rule 缺少 ${mapping.ruleKey}`,
          field,
          details: mismatch,
          range: headerInfo.range,
        });
      }
      continue;
    }
    const headerValue = header[mapping.headerKey];
    const ruleValue = staticFields[mapping.ruleKey];
    if (isDeepStrictEqual(headerValue, ruleValue)) {
      result.matches.push(field);
      continue;
    }
    const mismatch = { field, headerValue, ruleValue };
    result.mismatches.push(mismatch);
    addDiagnostic(diagnostics, {
      code: 'HEADER_RULE_MISMATCH',
      severity: 'error',
      message: `@header.${mapping.headerKey} 与 rule.${mapping.ruleKey} 不一致`,
      field,
      details: mismatch,
      range: headerInfo.range,
    });
  }
  return result;
}

function inspectTemplate(staticFields, rule, options, diagnostics) {
  const name = typeof staticFields['模板'] === 'string' ? staticFields['模板'] : null;
  const result = { checked: false, name, known: null, suggestion: null };
  if (!name) return result;
  if (name === '自动') {
    result.checked = true;
    result.known = true;
    result.dynamic = true;
    result.requiresL2 = true;
    addDiagnostic(diagnostics, {
      code: 'RULE_AUTO_TEMPLATE_REQUIRES_L2',
      severity: 'warning',
      message: '`模板: 自动` 由真实引擎联网匹配，L1 只能确认语法，必须继续执行 L2/L3',
      field: '模板',
    });
    return result;
  }

  let verdict;
  const validator = options.isKnownTemplate || options.templateValidator;
  try {
    if (typeof validator === 'function') {
      verdict = validator(name, { staticFields, rule });
    } else if (options.knownTemplates) {
      const known = options.knownTemplates;
      verdict = typeof known.has === 'function'
        ? known.has(name)
        : Array.from(known).includes(name);
    } else {
      return result;
    }
  } catch (error) {
    result.checked = true;
    result.known = null;
    addDiagnostic(diagnostics, {
      code: 'TEMPLATE_VALIDATOR_ERROR',
      severity: 'warning',
      message: `模板校验回调执行失败：${error?.message || String(error)}`,
      field: '模板',
    });
    return result;
  }

  if (verdict && typeof verdict.then === 'function') {
    result.checked = true;
    addDiagnostic(diagnostics, {
      code: 'TEMPLATE_VALIDATOR_ASYNC_UNSUPPORTED',
      severity: 'warning',
      message: '模板校验回调必须同步返回 boolean 或 { known, suggestion }',
      field: '模板',
    });
    return result;
  }

  result.checked = true;
  if (typeof verdict === 'object' && verdict !== null) {
    result.known = Boolean(verdict.known);
    result.suggestion = verdict.suggestion || null;
  } else {
    result.known = Boolean(verdict);
  }
  if (!result.known) {
    addDiagnostic(diagnostics, {
      code: 'RULE_UNKNOWN_TEMPLATE',
      severity: 'error',
      message: `当前 Aibox 引擎不存在模板：${name}`,
      field: '模板',
      suggestion: result.suggestion,
    });
  }
  return result;
}

function inspectDetailDictionary(ruleObject, diagnostics) {
  const detail = findEffectiveProperty(ruleObject, '二级');
  if (!detail || detail.value.type !== 'ObjectExpression') return;
  const detailObject = detail.value;
  const tabs = findEffectiveProperty(detailObject, 'tabs');
  if (!tabs) return;
  const evaluated = tryEvaluateSafeLiteral(tabs.value);
  if (!evaluated.known || typeof evaluated.value !== 'string') return;
  const selector = evaluated.value.split(';')[0].trim();
  if (!ATTRIBUTE_TERMINALS.test(selector)) return;
  addDiagnostic(diagnostics, {
    code: 'DETAIL_TABS_TERMINAL_ATTRIBUTE',
    severity: 'error',
    message: '二级字典 tabs 由 pdfa 取元素，不能以 &&Text/Html/href/src 等属性结束；线路文字应写在 tab_text',
    field: 'tabs',
    path: 'rule.二级.tabs',
    loc: locationOf(tabs),
    range: rangeOf(tabs),
    details: { selector: evaluated.value },
  });
}

function inspectAstPatterns(ruleObject, diagnostics) {
  const reportedDynamicCode = new Set();
  walk.simple(ruleObject, {
    CallExpression(node) {
      if (isJsonParseThisInput(node)) {
        addDiagnostic(diagnostics, {
          code: 'JSON_PARSE_THIS_INPUT',
          severity: 'error',
          message: 'this.input 是请求 URL，不是接口响应；应先 request/getHtml(this.input) 再 JSON.parse',
          loc: locationOf(node),
          range: rangeOf(node),
        });
      }
      if (isDynamicCodeCall(node)) {
        reportDynamicCode(node, diagnostics, reportedDynamicCode);
      }
    },
    NewExpression(node) {
      if (node.callee?.type === 'Identifier' && node.callee.name === 'Function') {
        reportDynamicCode(node, diagnostics, reportedDynamicCode);
      }
    },
  });
}

function inspectUnboundHandlerInput(ast, ruleObject, diagnostics) {
  const handlerNodes = new Map();
  for (const field of RULE_HANDLER_FIELDS) {
    const property = findEffectiveProperty(ruleObject, field);
    if (property && isFunctionNode(property.value)) {
      handlerNodes.set(property.value, field);
    }
  }
  if (handlerNodes.size === 0) return;

  const references = [];
  const rootScope = createLexicalScope(null, 'program');
  const visitors = {
    Program(node, state, visit) {
      for (const statement of node.body) visit(statement, state);
    },
    BlockStatement(node, state, visit) {
      const blockState = withScope(state, createLexicalScope(state.scope, 'block'));
      for (const statement of node.body) visit(statement, blockState);
    },
    StaticBlock(node, state, visit) {
      const blockState = withScope(state, createLexicalScope(state.scope, 'block'));
      for (const statement of node.body) visit(statement, blockState);
    },
    VariableDeclaration(node, state, visit) {
      const targetScope = node.kind === 'var' ? findVariableScope(state.scope) : state.scope;
      for (const declaration of node.declarations) {
        addPatternBindings(declaration.id, targetScope);
      }
      for (const declaration of node.declarations) {
        visitPatternExpressions(declaration.id, state, visit);
        if (declaration.init) visit(declaration.init, state);
      }
    },
    FunctionDeclaration(node, state, visit) {
      if (node.id) addPatternBindings(node.id, state.scope);
      visitFunctionScope(node, state, visit, handlerNodes);
    },
    FunctionExpression(node, state, visit) {
      visitFunctionScope(node, state, visit, handlerNodes);
    },
    ArrowFunctionExpression(node, state, visit) {
      visitFunctionScope(node, state, visit, handlerNodes);
    },
    ClassDeclaration(node, state, visit) {
      if (node.id) addPatternBindings(node.id, state.scope);
      visitClassScope(node, state, visit);
    },
    ClassExpression(node, state, visit) {
      visitClassScope(node, state, visit);
    },
    CatchClause(node, state, visit) {
      const catchState = withScope(state, createLexicalScope(state.scope, 'block'));
      if (node.param) {
        addPatternBindings(node.param, catchState.scope);
        visitPatternExpressions(node.param, catchState, visit);
      }
      visit(node.body, catchState);
    },
    ForStatement(node, state, visit) {
      const loopState = withScope(state, createLexicalScope(state.scope, 'block'));
      if (node.init) visit(node.init, loopState);
      if (node.test) visit(node.test, loopState);
      if (node.update) visit(node.update, loopState);
      visit(node.body, loopState);
    },
    ForInStatement(node, state, visit) {
      const loopState = withScope(state, createLexicalScope(state.scope, 'block'));
      visit(node.left, loopState);
      visit(node.right, loopState);
      visit(node.body, loopState);
    },
    ForOfStatement(node, state, visit) {
      const loopState = withScope(state, createLexicalScope(state.scope, 'block'));
      visit(node.left, loopState);
      visit(node.right, loopState);
      visit(node.body, loopState);
    },
    SwitchStatement(node, state, visit) {
      visit(node.discriminant, state);
      const switchState = withScope(state, createLexicalScope(state.scope, 'block'));
      for (const switchCase of node.cases) visit(switchCase, switchState);
    },
    Property(node, state, visit) {
      if (node.computed) visit(node.key, state);
      visit(node.value, state);
    },
    MemberExpression(node, state, visit) {
      visit(node.object, state);
      if (node.computed) visit(node.property, state);
    },
    MethodDefinition(node, state, visit) {
      if (node.computed) visit(node.key, state);
      if (node.value) visit(node.value, state);
    },
    PropertyDefinition(node, state, visit) {
      if (node.computed) visit(node.key, state);
      if (node.value) visit(node.value, state);
    },
    LabeledStatement(node, state, visit) {
      visit(node.body, state);
    },
    BreakStatement() {},
    ContinueStatement() {},
    MetaProperty() {},
    Identifier(node, state) {
      if (state.handler && node.name === 'input') {
        references.push({ node, scope: state.scope, field: state.handler });
      }
    },
  };

  walk.recursive(ast, { scope: rootScope, handler: null }, visitors);
  for (const reference of references) {
    if (hasLexicalBinding(reference.scope, 'input')) continue;
    addDiagnostic(diagnostics, {
      code: 'RULE_HANDLER_UNBOUND_INPUT',
      severity: 'error',
      message: `rule.${reference.field} 函数引用了未绑定的裸变量 input；Aibox 通过 this.input 注入当前阶段请求，请改用 this.input，或先用形参/局部声明绑定 input`,
      field: reference.field,
      path: `rule.${reference.field}`,
      loc: locationOf(reference.node),
      range: rangeOf(reference.node),
      suggestion: '将裸变量 input 改为 this.input，或使用 const { input } = this 显式绑定',
      details: { identifier: 'input' },
    });
  }
}

function visitFunctionScope(node, state, visit, handlerNodes) {
  const functionScope = createLexicalScope(state.scope, 'function');
  const functionState = {
    scope: functionScope,
    handler: handlerNodes.get(node) || state.handler,
  };
  if (node.id) addPatternBindings(node.id, functionScope);
  for (const parameter of node.params) addPatternBindings(parameter, functionScope);
  for (const parameter of node.params) visitPatternExpressions(parameter, functionState, visit);
  visit(node.body, functionState);
}

function visitClassScope(node, state, visit) {
  if (node.superClass) visit(node.superClass, state);
  const classScope = createLexicalScope(state.scope, 'block');
  if (node.id) addPatternBindings(node.id, classScope);
  visit(node.body, withScope(state, classScope));
}

function visitPatternExpressions(pattern, state, visit) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      return;
    case 'RestElement':
      visitPatternExpressions(pattern.argument, state, visit);
      return;
    case 'AssignmentPattern':
      visitPatternExpressions(pattern.left, state, visit);
      visit(pattern.right, state);
      return;
    case 'ArrayPattern':
      for (const element of pattern.elements) visitPatternExpressions(element, state, visit);
      return;
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') {
          visitPatternExpressions(property.argument, state, visit);
          continue;
        }
        if (property.computed) visit(property.key, state);
        visitPatternExpressions(property.value, state, visit);
      }
      return;
    default:
      visit(pattern, state);
  }
}

function addPatternBindings(pattern, scope) {
  if (!pattern || !scope) return;
  switch (pattern.type) {
    case 'Identifier':
      scope.bindings.add(pattern.name);
      return;
    case 'RestElement':
      addPatternBindings(pattern.argument, scope);
      return;
    case 'AssignmentPattern':
      addPatternBindings(pattern.left, scope);
      return;
    case 'ArrayPattern':
      for (const element of pattern.elements) addPatternBindings(element, scope);
      return;
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        addPatternBindings(property.type === 'RestElement' ? property.argument : property.value, scope);
      }
  }
}

function createLexicalScope(parent, type) {
  return { parent, type, bindings: new Set() };
}

function withScope(state, scope) {
  return { ...state, scope };
}

function findVariableScope(scope) {
  let current = scope;
  while (current && !['function', 'program'].includes(current.type)) current = current.parent;
  return current || scope;
}

function hasLexicalBinding(scope, name) {
  let current = scope;
  while (current) {
    if (current.bindings.has(name)) return true;
    current = current.parent;
  }
  return false;
}

function isFunctionNode(node) {
  return ['FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type);
}

function inspectLazyContract(effectiveProperties, staticFields, code, diagnostics) {
  const lazy = effectiveProperties.get('lazy');
  const playParse = effectiveProperties.get('play_parse');
  const playJson = effectiveProperties.get('play_json');
  const customLazy = Boolean(
    lazy && (
      lazy.function ||
      (lazy.static && typeof lazy.staticValue === 'string' && lazy.staticValue.trimStart().startsWith('js:'))
    )
  );

  if (customLazy && staticFields.play_parse !== true) {
    addDiagnostic(diagnostics, {
      code: 'LAZY_REQUIRES_PLAY_PARSE',
      severity: 'error',
      message: '函数型或 js: lazy 只有在 play_parse: true 时才会被 Aibox 引擎执行',
      field: 'play_parse',
      path: 'rule.play_parse',
      loc: playParse?.loc || lazy.loc,
      range: playParse?.range || lazy.range,
    });
  }
  if (!lazy && staticFields.play_parse === true) {
    addDiagnostic(diagnostics, {
      code: 'PLAY_PARSE_WITHOUT_LAZY',
      severity: 'warning',
      message: '配置了 play_parse: true，但规则没有 lazy',
      field: 'play_parse',
      loc: playParse?.loc,
      range: playParse?.range,
    });
  }
  if (!customLazy) return;

  const lazyText = lazy.valueRange ? code.slice(lazy.valueRange[0], lazy.valueRange[1]) : '';
  const contentType = staticFields['类型'];
  const preservesOwnResult = contentType === '小说' ||
    contentType === '漫画' ||
    /(?:pics|novel):\/\//i.test(lazyText) ||
    /(?:magnet:|\.torrent\b)/i.test(lazyText) ||
    /\bparse\s*:\s*0\b/.test(lazyText);
  const playJsonKnown = playJson?.static === true;
  const playJsonIsEmptyArray = playJsonKnown &&
    Array.isArray(playJson.staticValue) &&
    playJson.staticValue.length === 0;

  if (preservesOwnResult && !playJson) {
    addDiagnostic(diagnostics, {
      code: 'LAZY_PLAY_JSON_REQUIRED',
      severity: 'error',
      message: '该 lazy 返回自有 parse/url 协议，需显式设置 play_json: []，避免后处理覆盖结果',
      field: 'play_json',
      path: 'rule.play_json',
      loc: lazy.loc,
      range: lazy.range,
    });
  } else if (preservesOwnResult && !playJsonIsEmptyArray) {
    addDiagnostic(diagnostics, {
      code: 'LAZY_PLAY_JSON_OVERRIDE',
      severity: 'error',
      message: 'play_json 当前值会覆盖 lazy 的 parse/jx 结果；此类 lazy 应使用空数组 []',
      field: 'play_json',
      path: 'rule.play_json',
      loc: playJson?.loc || lazy.loc,
      range: playJson?.range || lazy.range,
    });
  } else if (playJson && !playJsonKnown) {
    addDiagnostic(diagnostics, {
      code: 'PLAY_JSON_DYNAMIC_VALUE',
      severity: 'warning',
      message: 'play_json 不是静态值，无法确认它是否会覆盖 lazy 结果',
      field: 'play_json',
      loc: playJson.loc,
      range: playJson.range,
    });
  } else if (playJsonKnown && !Array.isArray(playJson.staticValue)) {
    addDiagnostic(diagnostics, {
      code: 'PLAY_JSON_OVERRIDES_LAZY',
      severity: 'warning',
      message: '非数组 play_json 会强制把 lazy 结果改为 parse: 1 / jx: 1',
      field: 'play_json',
      loc: playJson.loc,
      range: playJson.range,
    });
  }
}

function findEffectiveProperty(object, key) {
  let result = null;
  for (const property of object.properties) {
    if (property.type === 'Property' && getPropertyKey(property) === key) result = property;
  }
  return result;
}

function isJsonParseThisInput(node) {
  if (node.callee?.type !== 'MemberExpression' || node.callee.computed) return false;
  if (node.callee.object?.type !== 'Identifier' || node.callee.object.name !== 'JSON') return false;
  if (node.callee.property?.type !== 'Identifier' || node.callee.property.name !== 'parse') return false;
  const argument = node.arguments?.[0];
  return argument?.type === 'MemberExpression' &&
    !argument.computed &&
    argument.object?.type === 'ThisExpression' &&
    argument.property?.type === 'Identifier' &&
    argument.property.name === 'input';
}

function isDynamicCodeCall(node) {
  if (node.callee?.type === 'Identifier' && ['eval', 'Function'].includes(node.callee.name)) return true;
  return memberPath(node.callee) === 'this.constructor.constructor';
}

function memberPath(node) {
  if (!node) return '';
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Identifier') return node.name;
  if (node.type !== 'MemberExpression') return '';
  const object = memberPath(node.object);
  const property = node.computed
    ? (node.property.type === 'Literal' ? String(node.property.value) : '')
    : (node.property.type === 'Identifier' ? node.property.name : '');
  return object && property ? `${object}.${property}` : '';
}

function reportDynamicCode(node, diagnostics, seen) {
  const key = `${node.start}:${node.end}`;
  if (seen.has(key)) return;
  seen.add(key);
  addDiagnostic(diagnostics, {
    code: 'DYNAMIC_CODE_EXECUTION',
    severity: 'error',
    message: '规则包含 eval/Function/constructor.constructor 动态代码执行，静态校验不会执行该源码',
    loc: locationOf(node),
    range: rangeOf(node),
  });
}

function getPropertyKey(property) {
  if (!property.computed && property.key.type === 'Identifier') return property.key.name;
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

function addDiagnostic(diagnostics, input) {
  diagnostics.push({
    code: input.code,
    severity: input.severity || 'warning',
    message: input.message,
    field: input.field || null,
    path: input.path || null,
    loc: input.loc || null,
    range: input.range || null,
    suggestion: input.suggestion || null,
    details: input.details || {},
  });
}

function finalizeAnalysis({ code, diagnostics, header, rule, template }) {
  const withIds = diagnostics.map((diagnostic, index) => ({
    id: `${diagnostic.code}:${diagnostic.loc?.line || 0}:${diagnostic.loc?.column || 0}:${index + 1}`,
    ...diagnostic,
  }));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of withIds) {
    if (hasOwn(counts, diagnostic.severity)) counts[diagnostic.severity] += 1;
  }
  return {
    ok: counts.error === 0,
    sourceLength: code.length,
    header,
    rule,
    template,
    diagnostics: withIds,
    summary: {
      ...counts,
      hasRule: Boolean(rule),
      implementationMode: rule?.implementationMode || null,
    },
  };
}

function locationOf(node) {
  return node?.loc?.start
    ? { line: node.loc.start.line, column: node.loc.start.column }
    : null;
}

function rangeOf(node) {
  return node && typeof node.start === 'number' && typeof node.end === 'number'
    ? [node.start, node.end]
    : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}
