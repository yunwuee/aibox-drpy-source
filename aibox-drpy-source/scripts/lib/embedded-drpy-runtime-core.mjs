import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import * as cheerio from 'cheerio';
import crypto from 'node:crypto';

import {
  createCryptoHelpers,
  createOcrApi,
  createRequireShim,
  DEFAULT_OCR_API,
  DEFAULT_OCR_RETRY,
  getWebCrypto,
} from './drpy-sandbox-capabilities.mjs';
import { normalizeRuntimeFilterState } from './filter-support.mjs';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_CAPTCHA_RE = /(系统安全验证|输入验证码|安全验证|验证码|captcha|verify|btwaf)/i;
const DEFAULT_CATE_EXCLUDE = '首页|留言|APP|下载|资讯|新闻|动态';
const SPECIAL_PLAY_URL = /^(ftp|magnet|thunder|ws|push):/i;

export async function runEmbeddedDrpyServer({ skillRoot, runtimeRoot, port }) {
  fs.mkdirSync(path.join(runtimeRoot, 'spider', 'js'), { recursive: true });
  const ownership = {
    token: String(process.env.AIBOX_RUNTIME_TOKEN || crypto.randomUUID()),
    pid: process.pid,
    startedAt: String(process.env.AIBOX_RUNTIME_STARTED_AT || new Date().toISOString()),
    runtimeRoot: path.resolve(runtimeRoot),
  };
  const engine = new EmbeddedDrpyEngine({ skillRoot, runtimeRoot, port, ownership });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/__aibox_health') {
        const suppliedToken = String(req.headers['x-aibox-runtime-token'] || '');
        if (!suppliedToken || suppliedToken !== ownership.token) {
          return writeJson(res, 403, { error: 'Forbidden' });
        }
        return writeJson(res, 200, engine.getOwnership());
      }
      if (req.method === 'GET' && url.pathname === '/config') {
        return writeJson(res, 200, engine.getConfig());
      }

      if (req.method === 'POST' && url.pathname === '/http') {
        const body = await readJsonBody(req);
        const payload = await engine.httpProxy(body || {});
        return writeJson(res, 200, payload);
      }

      if (req.method === 'GET' && url.pathname.startsWith('/proxy/')) {
        const proxyTarget = parseProxyPath(url.pathname);
        if (!proxyTarget.moduleName) {
          return writeProxyResponse(res, [404, 'text/plain', 'missing proxy module']);
        }
        const params = Object.fromEntries(url.searchParams.entries());
        const payload = await engine.handleProxy(proxyTarget.moduleName, params, proxyTarget.proxyPath);
        return writeProxyResponse(res, payload);
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
        const moduleName = decodeURIComponent(url.pathname.slice('/api/'.length));
        const params = Object.fromEntries(url.searchParams.entries());
        const result = await engine.handleApi(moduleName, params);
        return writeJson(res, 200, result);
      }

      return writeJson(res, 404, { error: 'Not Found', path: url.pathname });
    } catch (error) {
      return writeJson(res, 500, {
        error: error.message,
        stack: error.stack,
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  process.stdout.write(`Aibox embedded drpy listening on http://127.0.0.1:${port}\n`);

  const close = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

class EmbeddedDrpyEngine {
  constructor({ skillRoot, runtimeRoot, port, ownership }) {
    this.skillRoot = skillRoot;
    this.runtimeRoot = runtimeRoot;
    this.port = Number(port || 5757);
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.moduleCache = new Map();
    this.ownership = ownership;
  }

  get modulesDir() {
    return path.join(this.runtimeRoot, 'spider', 'js');
  }

  getConfig() {
    const modules = listModuleFiles(this.modulesDir).map((filePath) => {
      const moduleName = path.basename(filePath, '.js');
      const title = readRuleTitle(filePath) || moduleName;
      return {
        key: moduleName,
        name: title,
        moduleName,
        jsPath: filePath,
      };
    });

    return {
      server: 'AiboxEmbeddedDrpy',
      version: '0.2.0',
      runtimeRoot: this.runtimeRoot,
      modules,
    };
  }

  getOwnership() {
    return {
      server: 'AiboxEmbeddedDrpy',
      version: '0.2.0',
      ...this.ownership,
    };
  }

  async httpProxy(input = {}) {
    const url = String(input.url || '').trim();
    if (!url) {
      throw new Error('缺少 url');
    }
    const method = String(input.method || 'GET').toUpperCase();
    const headers = normalizeHeaders(input.headers || {});
    const params = input.params && typeof input.params === 'object'
      ? new URLSearchParams(flattenObject(input.params)).toString()
      : '';
    const finalUrl = params
      ? `${url}${url.includes('?') ? '&' : '?'}${params}`
      : url;

    let body;
    if (input.data !== undefined && method !== 'GET' && method !== 'HEAD') {
      if (typeof input.data === 'string' || input.data instanceof Uint8Array) {
        body = input.data;
      } else {
        body = JSON.stringify(input.data);
        if (!hasHeader(headers, 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    const response = await fetch(finalUrl, {
      method,
      headers,
      body,
      redirect: 'follow',
    });

    const wantsBinary = String(input.responseType || '').toLowerCase() === 'arraybuffer';
    const data = wantsBinary
      ? Buffer.from(await response.arrayBuffer()).toString('base64')
      : await response.text();

    return {
      status: response.status,
      headers: responseHeadersToObject(response.headers),
      data,
      url: response.url,
    };
  }

  async handleProxy(moduleName, query = {}, proxyPath = '') {
    if (!moduleName) {
      return [404, 'text/plain', 'missing proxy module'];
    }
    const moduleRuntime = await this.loadModule(moduleName);
    const runner = moduleRuntime.createRunner();
    return await runner.proxy(query, proxyPath);
  }

  async handleApi(moduleName, query = {}) {
    if (!moduleName) {
      throw new Error('缺少 moduleName');
    }

    if (Number(query.refresh) === 1) {
      this.moduleCache.delete(moduleName);
      return { code: 1, msg: 'refreshed', module: moduleName };
    }

    const moduleRuntime = await this.loadModule(moduleName);
    const runner = moduleRuntime.createRunner();

    if (query.play !== undefined) {
      return await runner.play(String(query.flag || ''), String(query.play || ''));
    }
    if (query.ac === 'detail') {
      return await runner.detail(String(query.ids || ''));
    }
    if (query.wd !== undefined) {
      return await runner.search(String(query.wd || ''), Number(query.pg || 1) || 1);
    }
    if (query.ac === 'videolist' || query.t !== undefined) {
      return await runner.category(String(query.t || ''), Number(query.pg || 1) || 1, decodeExt(query.ext));
    }
    return await runner.home(Number(query.filter || 1) === 1);
  }

  async loadModule(moduleName) {
    const filePath = path.join(this.modulesDir, `${moduleName}.js`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`模块不存在: ${moduleName}`);
    }

    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
    const cached = this.moduleCache.get(moduleName);
    if (cached && cached.cacheKey === cacheKey) {
      return cached;
    }

    const code = fs.readFileSync(filePath, 'utf8');
    const moduleRuntime = new ModuleRuntime({
      moduleName,
      filePath,
      code,
      baseUrl: this.baseUrl,
    });
    await moduleRuntime.initialize();
    moduleRuntime.cacheKey = cacheKey;
    this.moduleCache.set(moduleName, moduleRuntime);
    return moduleRuntime;
  }
}

class ModuleRuntime {
  constructor({ moduleName, filePath, code, baseUrl }) {
    this.moduleName = moduleName;
    this.filePath = filePath;
    this.code = code;
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:5757').replace(/\/+$/g, '');
    this.store = new Map();
    this.logs = [];
    this.sandbox = null;
    this.rule = null;
    this.ruleSnapshot = null;
    this.cryptoHelpers = createCryptoHelpers(findSkillRootFromRulePath(filePath));
    this.ocrApi = createOcrApi(findSkillRootFromRulePath(filePath), (message) => {
      this.logs.push(String(message || ''));
    });
    this.requireShim = createRequireShim(findSkillRootFromRulePath(filePath), (message) => {
      this.logs.push(String(message || ''));
    });
    this.webcrypto = getWebCrypto();
  }

  async initialize() {
    this.sandbox = this.createSandbox();
    vm.createContext(this.sandbox);
    new vm.Script(this.code, {
      filename: this.filePath,
      displayErrors: true,
    }).runInContext(this.sandbox, { timeout: 2000 });

    if (!this.sandbox.rule || typeof this.sandbox.rule !== 'object') {
      throw new Error('执行规则后未生成 rule 对象');
    }

    this.rule = this.sandbox.rule;
    if (!Object.prototype.hasOwnProperty.call(this.rule, 'play_json')) {
      this.rule.play_json = [];
    }
    this.ruleSnapshot = {
      title: this.rule.title || this.moduleName,
      host: this.rule.host || '',
      class_name: this.rule.class_name || '',
      class_url: this.rule.class_url || '',
      searchable: this.rule.searchable ?? 0,
      quickSearch: this.rule.quickSearch ?? 0,
      filterable: this.rule.filterable ?? 0,
      type: this.rule['类型'] || this.rule.type || '影视',
      play_parse: this.rule.play_parse ?? true,
    };
  }

  createSandbox() {
    const runtime = this;
    const sandbox = {
      console,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      fetch,
      AbortController,
      crypto: this.webcrypto,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      MOBILE_UA: DEFAULT_UA,
      PC_UA: DEFAULT_UA,
      UA: 'Mozilla/5.0',
      UC_UA: 'Mozilla/5.0 (Linux; U; Android 9; zh-CN; MI 9 Build/PKQ1.181121.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.108 UCBrowser/12.5.5.1035 Mobile Safari/537.36',
      IOS_UA: 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
      RULE_CK: 'cookie',
      OCR_RETRY: Number(this.ocrApi?.retry || DEFAULT_OCR_RETRY),
      OCR_API: this.ocrApi?.api || DEFAULT_OCR_API,
      rule: undefined,
      log(...args) {
        runtime.logs.push(args.map((item) => stringifyLog(item)).join(' '));
      },
      print(...args) {
        runtime.logs.push(args.map((item) => stringifyLog(item)).join(' '));
      },
      setItem(key, value) {
        runtime.store.set(String(key), String(value ?? ''));
      },
      getItem(key) {
        return runtime.store.get(String(key)) || '';
      },
      base64Encode(value) {
        return Buffer.from(String(value || ''), 'utf8').toString('base64');
      },
      base64Decode(value) {
        return Buffer.from(String(value || ''), 'base64').toString('utf8');
      },
      atob(value) {
        return Buffer.from(String(value || ''), 'base64').toString('utf8');
      },
      btoa(value) {
        return Buffer.from(String(value || ''), 'utf8').toString('base64');
      },
      urljoin(base, next = '') {
        return resolveUrl(base, next);
      },
      buildUrl(base, query = {}) {
        const target = new URL(base, 'https://example.com');
        for (const [key, value] of Object.entries(query || {})) {
          target.searchParams.set(key, `${value}`);
        }
        return target.toString();
      },
      parseQueryString(text = '') {
        const params = new URLSearchParams(String(text).replace(/^\?/, ''));
        return Object.fromEntries(params.entries());
      },
      objectToQueryString(query = {}) {
        return new URLSearchParams(flattenObject(query)).toString();
      },
      encodeUrl(value) {
        return encodeURI(String(value || ''));
      },
      urlencode(value) {
        return encodeURIComponent(String(value || ''));
      },
      encodeIfContainsSpecialChars(value) {
        return encodeURI(String(value || ''));
      },
      req: async (url, options = {}) => await runtime.reqProxy(url, options),
      post: async (url, data, options = {}) => await runtime.reqProxy(url, { ...options, method: 'POST', data }),
      setResult(value) {
        return Array.isArray(value) ? value : [];
      },
      setHomeResult(value) {
        return Array.isArray(value) ? value : [];
      },
      setResult2(value) {
        return Array.isArray(value) ? value : [];
      },
      OcrApi: this.ocrApi,
      getCryptoJS: this.cryptoHelpers.getCryptoJS,
      CryptoJS: this.cryptoHelpers.CryptoJS,
      CryptoJSW: this.cryptoHelpers.CryptoJSW,
      md5: this.cryptoHelpers.md5,
      require: this.requireShim,
      axios: async (...args) => await runtime.axiosShim(...args),
      axiosX: async (...args) => await runtime.axiosShim(...args),
      getProxyUrl() {
        return runtime.buildProxyUrl();
      },
      getProxy: () => runtime.buildProxyUrl(),
      requestHost: this.baseUrl,
      proxyUrl: this.buildProxyUrl(),
      publicUrl: `${this.baseUrl}/public/`,
      jsonUrl: `${this.baseUrl}/json/`,
      httpUrl: `${this.baseUrl}/http`,
      imageApi: `${this.baseUrl}/image`,
      mediaProxyUrl: `${this.baseUrl}/mediaProxy`,
      hostUrl: safeUrlHost(this.baseUrl),
      hostname: safeUrlHost(this.baseUrl),
      proxyPath: '',
    };

    sandbox.request = async (url, options = {}, legacyRaw = false) => {
      return await runtime.performRequest(url, options, legacyRaw);
    };
    sandbox.getHtml = async (url, options = {}) => {
      return await runtime.getHtml(url, options);
    };
    sandbox.verifyCode = async (url) => await runtime.verifyCode(url);
    sandbox.pdfa = (html, selector) => drpyPdfa(html, selector);
    sandbox.pdfh = (html, rule) => drpyPdfh(html, rule);
    sandbox.pd = (html, rule, baseUrl = '') => drpyPd(html, rule, baseUrl);
    sandbox.global = sandbox;
    sandbox.globalThis = sandbox;
    return sandbox;
  }

  createRunner() {
    return {
      home: async (includeFilters = true) => {
        this.clearLogs();
        const input = resolveUrl(this.rule.host || '', this.rule.homeUrl || '/');
        const staticClasses = splitClasses(this.rule.class_name, this.rule.class_url);
        const classResult = this.rule.class_parse !== undefined && this.rule.class_parse !== null
          ? await this.invokeHandler('class_parse', [includeFilters ? 1 : 0], input, {
              TYPE: 'home',
              classes: staticClasses,
              filters: this.rule.filter || {},
              cate_exclude: mergeExcludePatterns(this.rule.cate_exclude, DEFAULT_CATE_EXCLUDE),
              home_flag: this.rule.home_flag,
            })
          : null;
        const result = this.rule['推荐'] !== undefined && this.rule['推荐'] !== null
          ? await this.invokeHandler('推荐', [], input, { TYPE: 'home', double: Boolean(this.rule.double) })
          : [];
        const normalizedClassResult = Array.isArray(classResult)
          ? { class: classResult }
          : classResult;
        const classes = normalizedClassResult && Array.isArray(normalizedClassResult.class)
          ? normalizeClasses(normalizedClassResult.class)
          : staticClasses;
        const visibleClasses = filterExcludedClasses(
          classes,
          mergeExcludePatterns(this.rule.cate_exclude, DEFAULT_CATE_EXCLUDE),
        );
        const classUrl = visibleClasses.map((item) => item.type_id).filter(Boolean).join('&')
          || this.rule.class_url;
        const filterState = normalizeRuntimeFilterState(
          normalizedClassResult?.filters ?? this.rule.filter,
          normalizedClassResult?.filter_def ?? this.rule.filter_def,
          classUrl,
        );
        return {
          class: visibleClasses,
          list: Array.isArray(result) ? result : [],
          filters: includeFilters ? filterState.filter : undefined,
          filter_def: includeFilters ? filterState.filterDef : undefined,
          type: this.rule['类型'] || this.rule.type || '影视',
          _debug: this.debugBlock(input),
        };
      },
      category: async (tid, page, ext) => {
        this.clearLogs();
        const input = buildCategoryUrl(this.rule, tid, page, ext);
        const result = await this.invokeHandler('一级', [tid, page, ext || {}, ext || {}], input, {
          TYPE: 'cate',
          MY_CATE: tid,
          MY_PAGE: page,
          MY_FL: ext || {},
        });
        return {
          page,
          pagecount: Array.isArray(result) && result.length > 0 ? page : 0,
          total: Array.isArray(result) ? result.length : 0,
          list: Array.isArray(result) ? result : [],
          _debug: this.debugBlock(input),
        };
      },
      detail: async (ids) => {
        this.clearLogs();
        const detailRequest = buildDetailRequest(this.rule, ids);
        const input = detailRequest.input;
        const result = await this.invokeHandler('二级', [[detailRequest.orId]], input, {
          TYPE: 'detail',
          vid: detailRequest.vid,
          orId: detailRequest.orId,
          fyclass: detailRequest.fyclass,
          detailUrl: detailRequest.detailUrl,
        });
        return {
          list: result ? [normalizeVod(result)] : [],
          _debug: this.debugBlock(input),
        };
      },
      search: async (wd, page) => {
        this.clearLogs();
        const input = buildSearchUrl(this.rule, wd, page);
        const result = this.rule['搜索'] !== undefined && this.rule['搜索'] !== null
          ? await this.invokeHandler('搜索', [wd, false, page], input, {
              TYPE: 'search',
              KEY: wd,
              MY_PAGE: page,
              detailUrl: this.rule.detailUrl || '',
            })
          : [];
        return {
          page,
          pagecount: Array.isArray(result) && result.length > 0 ? page : 0,
          total: Array.isArray(result) ? result.length : 0,
          list: Array.isArray(result) ? result : [],
          _debug: this.debugBlock(input),
        };
      },
      play: async (flag, playUrl) => {
        this.clearLogs();
        const input = resolveUrl(this.rule.host || '', playUrl);
        const canInvokeLazy = Boolean(this.rule.play_parse && typeof this.rule.lazy === 'function');
        const result = canInvokeLazy
          ? await this.invokeHandler('lazy', [flag, playUrl, []], input, {
              TYPE: 'play',
              MY_FLAG: flag,
              flag,
            })
          : null;
        return {
          ...normalizePlayResult(this.rule, result, playUrl, flag),
          _debug: this.debugBlock(input),
        };
      },
      proxy: async (params = {}, proxyPath = '') => {
        this.clearLogs();
        const input = String(params.url || '');
        const result = await this.invokeHandler('proxy_rule', [params || {}], input, {
          ...this.buildRuntimeEnv({ proxyPath, query: params || {} }),
          proxyPath,
        });
        return Array.isArray(result) ? result : [200, 'application/json', JSON.stringify(result ?? {})];
      },
    };
  }

  debugBlock(input) {
    return {
      module: this.moduleName,
      title: this.ruleSnapshot?.title || this.moduleName,
      input,
      cookie: this.store.get('cookie') || '',
      logs: [...this.logs],
    };
  }

  clearLogs() {
    this.logs.length = 0;
  }

  buildProxyUrl(query = {}) {
    const doValue = String(query.do || 'ds');
    const extend = encodeURIComponent(String(query.extend || ''));
    return `${this.baseUrl}/proxy/${encodeURIComponent(this.moduleName)}/?do=${encodeURIComponent(doValue)}&extend=${extend}`;
  }

  buildRuntimeEnv({ proxyPath = '', query = {} } = {}) {
    const proxyUrl = this.buildProxyUrl(query);
    const hostName = safeUrlHost(this.baseUrl);
    return {
      requestHost: this.baseUrl,
      proxyUrl,
      proxyPath,
      publicUrl: `${this.baseUrl}/public/`,
      jsonUrl: `${this.baseUrl}/json/`,
      httpUrl: `${this.baseUrl}/http`,
      imageApi: `${this.baseUrl}/image`,
      mediaProxyUrl: `${this.baseUrl}/mediaProxy`,
      webdavProxyUrl: `${this.baseUrl}/webdav/`,
      ftpProxyUrl: `${this.baseUrl}/ftp/`,
      hostUrl: hostName,
      hostname: hostName,
      wsName: hostName,
      ext: String(query.extend || ''),
      getProxyUrl: () => proxyUrl,
      getProxy: () => proxyUrl,
    };
  }

  async invokeHandler(handlerName, args, input, extraContext = {}) {
    const handler = this.rule ? this.rule[handlerName] : undefined;
    if (!this.rule || handler === undefined || handler === null) {
      throw new Error(`模块缺少处理函数: ${handlerName}`);
    }
    Object.assign(this.sandbox, {
      input,
      MY_URL: input,
      HOST: this.rule?.host || '',
      ...extraContext,
    });
    const injected = {
      ...this.buildRuntimeEnv(),
      ...extraContext,
      input,
      MY_URL: input,
      HOST: this.rule?.host || '',
      rule: this.rule,
      pdfa: this.sandbox.pdfa,
      pdfh: this.sandbox.pdfh,
      pd: this.sandbox.pd,
    };
    const context = new Proxy(injected, {
      get: (target, key) => target[key] !== undefined ? target[key] : this.rule?.[key],
      set: (target, key, value) => {
        target[key] = value;
        if (this.rule && typeof key !== 'symbol') {
          this.rule[key] = value;
        }
        return true;
      },
    });
    if (typeof handler === 'function') {
      return await handler.apply(context, args);
    }
    return await this.invokeStaticHandler(handlerName, handler, input, args, context);
  }

  async invokeStaticHandler(handlerName, handler, input, args, context) {
    if ((handlerName === '推荐' || handlerName === '搜索') && handler === '*') {
      const inherited = this.rule['一级'];
      if (typeof inherited === 'function') {
        return await inherited.apply(context, args);
      }
      handler = inherited;
    }
    if (typeof handler === 'string') {
      const resolvedHandler = resolveInheritedListRule(handlerName, handler, this.rule['一级']);
      if (handlerName === 'class_parse') {
        return await buildStaticClassResult(resolvedHandler, await this.getHtml(input), this.rule);
      }
      const listOptions = {
        categoryId: handlerName === '一级' ? String(context?.MY_CATE || '') : '',
      };
      if (/^json:/i.test(resolvedHandler)) {
        return buildJsonListFromRule(resolvedHandler, parseJsonSafely(await this.getHtml(input)), this.rule, listOptions);
      }
      return buildHtmlListFromRule(resolvedHandler, await this.getHtml(input), this.rule, listOptions);
    }
    if (handlerName === '二级' && handler && typeof handler === 'object') {
      return buildHtmlDetailFromRule(handler, await this.getHtml(input), this.rule, args?.[0]?.[0] || input);
    }
    throw new Error(`暂不支持的规则形态: ${handlerName}`);
  }

  async getHtml(url, options = {}) {
    const text = await this.fetchText(url, options);
    return text;
  }

  async performRequest(url, options = {}, legacyRaw = false) {
    const finalUrl = resolveUrl(this.rule?.host || '', url);
    const headers = mergeRequestHeaders(this.rule?.headers || {}, options.headers || {}, this.store.get('cookie') || '');
    const method = String(options.method || inferMethod(options)).toUpperCase();
    const body = buildRequestBody(options, method, headers);
    const response = await fetch(finalUrl, {
      method,
      headers,
      body,
      redirect: 'follow',
    });

    const responseHeaders = responseHeadersToObject(response.headers);
    const setCookie = responseHeaders['set-cookie'] || responseHeaders['Set-Cookie'] || '';
    const needsRaw = Boolean(legacyRaw || options.withHeaders || options.toBase64);

    let bodyValue;
    if (options.toBase64) {
      bodyValue = Buffer.from(await response.arrayBuffer()).toString('base64');
    } else {
      bodyValue = await response.text();
    }

    if (!needsRaw) {
      return bodyValue;
    }

    return JSON.stringify({
      status: response.status,
      headers: responseHeaders,
      'set-cookie': setCookie,
      body: bodyValue,
      url: response.url,
    });
  }

  async fetchText(url, options = {}) {
    const raw = await this.performRequest(url, options, false);
    if (typeof raw === 'string') {
      return raw;
    }
    return String(raw || '');
  }

  async reqProxy(url, options = {}) {
    const method = String(options.method || inferMethod(options)).toUpperCase();
    const raw = await this.performRequest(url, {
      ...options,
      method,
      headers: options.headers || {},
      data: options.data ?? options.body,
    }, false);
    return {
      code: 200,
      status: 200,
      url: resolveUrl(this.rule?.host || '', url),
      headers: {},
      content: typeof raw === 'string' ? raw : String(raw || ''),
      data: typeof raw === 'string' ? raw : String(raw || ''),
    };
  }

  async axiosShim(...args) {
    const first = args[0];
    const second = args[1] || {};
    const options = typeof first === 'string'
      ? { ...(second || {}), url: first }
      : { ...(first || {}) };
    const finalUrl = resolveUrl(this.rule?.host || '', options.url || options.href || '');
    const method = String(options.method || inferMethod(options)).toUpperCase();
    const headers = mergeRequestHeaders(this.rule?.headers || {}, options.headers || {}, this.store.get('cookie') || '');
    const controller = new AbortController();
    const timeoutMs = Number(options.timeout || 0);
    const timer = timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`axios timeout ${timeoutMs}ms`)), timeoutMs)
      : null;

    try {
      const response = await fetch(finalUrl, {
        method,
        headers,
        body: buildRequestBody(options, method, headers),
        redirect: 'follow',
        signal: controller.signal,
      });
      const responseType = String(options.responseType || '').toLowerCase();
      let data;
      if (responseType === 'arraybuffer') {
        data = Buffer.from(await response.arrayBuffer());
      } else if (responseType === 'json') {
        data = await response.json();
      } else {
        data = await response.text();
      }
      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeadersToObject(response.headers),
        data,
        config: options,
        request: { url: finalUrl },
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async verifyCode(url) {
    const target = String(url || '').trim();
    const host = getHome(target || this.rule?.host || '');
    if (!this.ocrApi?.configured) {
      this.logs.push(`[verifyCode] OCR not configured, skip captcha solve for ${host || target || 'unknown-host'}`);
      return '';
    }
    let cookie = '';
    const retry = Math.max(1, Number(this.ocrApi.retry || DEFAULT_OCR_RETRY) || DEFAULT_OCR_RETRY);
    for (let index = 0; index < retry; index += 1) {
      try {
        const verifyUrl = `${host}/index.php/verify/index.html`;
        this.logs.push(`[verifyCode] fetch captcha => ${verifyUrl}`);
        const raw = await this.performRequest(verifyUrl, {
          withHeaders: true,
          toBase64: true,
          headers: {
            'User-Agent': DEFAULT_UA,
            Referer: target || `${host}/`,
          },
        }, true);
        const payload = JSON.parse(raw || '{}');
        if (!cookie) {
          cookie = extractCookieFromPayload(payload);
        }
        const img = String(payload.body || '');
        const code = String(await this.ocrApi.classification(img)).trim();
        this.logs.push(`[verifyCode] OCR #${index + 1} => ${code || 'EMPTY'}`);
        if (!cookie || !code) {
          continue;
        }
        const submitUrl = `${host}/index.php/ajax/verify_check?type=search&verify=${encodeURIComponent(code)}`;
        const submitText = await this.performRequest(submitUrl, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'User-Agent': DEFAULT_UA,
            Referer: target || `${host}/`,
          },
        }, false);
        let submitJson = {};
        try {
          submitJson = JSON.parse(submitText || '{}');
        } catch (_) {
          submitJson = {};
        }
        this.logs.push(`[verifyCode] submit => ${JSON.stringify(submitJson)}`);
        if (submitJson.msg === 'ok' || Number(submitJson.code) === 1) {
          this.store.set('cookie', cookie);
          return cookie;
        }
      } catch (error) {
        this.logs.push(`[verifyCode] error #${index + 1} => ${error.message}`);
      }
    }
    return '';
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
  res.end(body);
}

function writeProxyResponse(res, payload) {
  const result = Array.isArray(payload)
    ? payload
    : [200, 'application/json', JSON.stringify(payload ?? {})];
  const statusCode = Number(result[0] || 200) || 200;
  const mediaType = String(result[1] || 'application/octet-stream');
  let content = result[2] ?? '';
  const headers = result[3] && typeof result[3] === 'object' ? result[3] : {};
  const toBytes = result.length > 4 ? result[4] : null;

  if (toBytes === 2 && typeof content === 'string' && /^https?:\/\//i.test(content)) {
    res.statusCode = 302;
    res.setHeader('Location', content);
    res.end('');
    return;
  }

  if (toBytes === 1) {
    try {
      if (typeof content === 'string' && content.includes('base64,')) {
        content = content.split('base64,').pop();
      }
      content = Buffer.from(String(content || ''), 'base64');
    } catch (error) {
      content = Buffer.from(`proxy toBytes decode error: ${error.message}`, 'utf8');
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(content);
      return;
    }
  } else if (content instanceof ArrayBuffer) {
    content = Buffer.from(content);
  } else if (content && content.buffer instanceof ArrayBuffer) {
    content = Buffer.from(content.buffer, content.byteOffset || 0, content.byteLength || content.length || 0);
  } else if (!Buffer.isBuffer(content)) {
    content = Buffer.from(String(content ?? ''), 'utf8');
  }

  res.statusCode = statusCode;
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      res.setHeader(key, String(value));
    }
  }
  if (!res.hasHeader('Content-Type')) {
    const suffix = /^text\//i.test(mediaType) || mediaType === 'application/json'
      ? '; charset=utf-8'
      : '';
    res.setHeader('Content-Type', `${mediaType}${suffix}`);
  }
  res.setHeader('Content-Length', content.length);
  res.end(content);
}

function parseProxyPath(pathname) {
  const rest = String(pathname || '').replace(/^\/proxy\/?/, '');
  const slashIndex = rest.indexOf('/');
  if (slashIndex < 0) {
    return {
      moduleName: decodeURIComponent(rest || ''),
      proxyPath: '',
    };
  }
  return {
    moduleName: decodeURIComponent(rest.slice(0, slashIndex)),
    proxyPath: decodeURIComponent(rest.slice(slashIndex + 1)),
  };
}

function listModuleFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs.readdirSync(dirPath)
    .filter((item) => item.toLowerCase().endsWith('.js'))
    .map((item) => path.join(dirPath, item))
    .sort();
}

function readRuleTitle(filePath) {
  try {
    const code = fs.readFileSync(filePath, 'utf8');
    const match = code.match(/title\s*:\s*['"]([^'"]+)['"]/i);
    return match?.[1] || '';
  } catch (_) {
    return '';
  }
}

function splitClasses(className, classUrl) {
  const names = String(className || '').split('&');
  const ids = String(classUrl || '').split('&');
  const result = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = String(names[index] || '').trim();
    const typeId = String(ids[index] || '').trim();
    if (!name || !typeId) {
      continue;
    }
    result.push({ type_id: typeId, type_name: name });
  }
  return result;
}

function normalizeClasses(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      return null;
    }
    const typeId = String(item.type_id ?? item.id ?? '').trim();
    const typeName = String(item.type_name ?? item.name ?? '').trim();
    if (!typeId || !typeName) {
      return null;
    }
    return {
      ...item,
      type_id: typeId,
      type_name: typeName,
    };
  }).filter(Boolean);
}

function mergeExcludePatterns(...values) {
  return [...new Set(values
    .flatMap((value) => String(value || '').split('|'))
    .map((item) => item.trim())
    .filter(Boolean))]
    .join('|');
}

function filterExcludedClasses(classes, pattern) {
  if (!pattern) {
    return classes;
  }
  let regex;
  try {
    regex = new RegExp(pattern);
  } catch (_) {
    return classes;
  }
  return classes.filter((item) => !regex.test(String(item?.type_name || '')));
}

async function buildStaticClassResult(handler, html, rule) {
  const spec = String(handler || '').trim();
  if (/^js:/i.test(spec)) {
    throw new Error('嵌入式 runtime 暂不执行 js: 字符串 class_parse，请改用函数型 class_parse');
  }
  if (/^json:/i.test(spec)) {
    const [listPath] = splitRuleSpec(spec.replace(/^json:/i, ''));
    const payload = parseJsonSafely(html, {});
    const items = getByPath(payload, listPath, []);
    return {
      class: normalizeClasses(Array.isArray(items) ? items : []),
      filters: rule?.filter || {},
      filter_def: rule?.filter_def || {},
    };
  }

  const [listSelector, nameRule, urlRule, idPattern] = splitRuleSpec(spec.replace(/^(jsp:|jq:)/i, ''));
  const classes = drpyPdfa(html, listSelector).map((itemHtml) => {
    const typeName = sanitizeDisplayText(drpyPdfh(itemHtml, nameRule || 'body&&Text'));
    const rawUrl = drpyPd(itemHtml, urlRule || 'a&&href', rule?.host || '')
      || sanitizeDisplayText(drpyPdfh(itemHtml, urlRule || 'a&&href'));
    let typeId = rawUrl;
    if (idPattern && rawUrl) {
      try {
        const match = rawUrl.match(new RegExp(idPattern));
        typeId = match?.[1] || match?.[0] || '';
      } catch (_) {
        typeId = rawUrl;
      }
    }
    return { type_name: typeName, type_id: typeId };
  });
  return {
    class: normalizeClasses(classes),
    filters: rule?.filter || {},
    filter_def: rule?.filter_def || {},
  };
}

function buildCategoryUrl(rule, tid, page, ext) {
  const filterState = normalizeRuntimeFilterState(rule.filter, rule.filter_def, rule.class_url);
  const mergedExt = {
    ...getFilterDefForTid(filterState.filterDef, tid),
    ...(ext && typeof ext === 'object' ? ext : {}),
  };

  let url = String(rule.url || '').trim() || '/';
  const filterUrl = String(rule.filter_url || '').trim();
  if (filterUrl) {
    const rendered = renderFilterUrl(filterUrl, tid, page, mergedExt);
    url = url.includes('fyfilter') ? url.replace(/fyfilter/g, rendered) : rendered;
  }

  url = renderFilterUrl(url, tid, page, mergedExt);
  return resolveUrl(rule.host || '', url);
}

function getFilterDefForTid(filterDef, tid) {
  if (!filterDef || typeof filterDef !== 'object') {
    return {};
  }
  return filterDef[tid] || filterDef['*'] || {};
}

function renderFilterUrl(template, tid, page, ext) {
  let url = String(template || '').trim();
  url = url.replace(/fyclass/g, encodeURIComponent(String(tid || '')));
  url = url.replace(/fypage/g, `${Number(page || 1) || 1}`);
  url = url.replace(/\{\{fl\.([^}]+)\}\}/g, (_, rawKey) => encodeURIComponent(resolveFilterExtValue(rawKey, ext, tid)));
  return url;
}

function resolveFilterExtValue(rawKey, ext, tid) {
  const key = String(rawKey || '').trim();
  if (Object.prototype.hasOwnProperty.call(ext || {}, key)) {
    return String(ext[key] || '');
  }
  const alias = normalizeFilterPlaceholderKey(key);
  if (alias && Object.prototype.hasOwnProperty.call(ext || {}, alias)) {
    return String(ext[alias] || '');
  }
  if ((key === 'cateId' || alias === 'cateId') && tid !== undefined) {
    return String(tid || '');
  }
  return '';
}

function normalizeFilterPlaceholderKey(key) {
  const text = String(key || '').trim();
  if (!text) return '';
  if (/(分类|栏目|频道|cate|catid|cateid|cid|tid|type_id)/i.test(text)) return 'cateId';
  if (/(类型|题材|剧情|风格|tag|genre|class)/i.test(text)) return 'class';
  if (/(地区|国家|区域|area|region)/i.test(text)) return 'area';
  if (/(年份|年代|year)/i.test(text)) return 'year';
  if (/(语言|lang|language)/i.test(text)) return 'lang';
  if (/(字母|首字母|letter|alpha)/i.test(text)) return 'letter';
  if (/(排序|order|sort|rank|by)/i.test(text)) return 'by';
  if (/(状态|连载|完结|更新|state|status)/i.test(text)) return 'state';
  return text;
}

function buildSearchUrl(rule, wd, page) {
  let url = String(rule.searchUrl || '').trim() || '/';
  url = url.replace(/\*\*/g, encodeURIComponent(String(wd || '')));
  url = url.replace(/fypage/g, `${Number(page || 1) || 1}`);
  return resolveUrl(rule.host || '', url);
}

function decodeExt(ext) {
  if (!ext) {
    return {};
  }
  try {
    const text = Buffer.from(String(ext), 'base64').toString('utf8');
    const payload = JSON.parse(text);
    return payload && typeof payload === 'object' ? payload : {};
  } catch (_) {
    return {};
  }
}

function normalizeVod(vod) {
  if (!vod || typeof vod !== 'object') {
    return {
      vod_id: '',
      vod_name: '',
      vod_pic: '',
      vod_remarks: '',
      vod_play_from: '',
      vod_play_url: '',
    };
  }
  return vod;
}

function resolveUrl(base, target = '') {
  const value = String(target || '').trim();
  if (!value) {
    return String(base || '');
  }
  try {
    return new URL(value, String(base || 'https://example.com')).toString();
  } catch (_) {
    return value;
  }
}

function stringifyLog(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function inferMethod(options) {
  if (options.method) {
    return options.method;
  }
  return options.data !== undefined || options.body !== undefined ? 'POST' : 'GET';
}

function buildRequestBody(options, method, headers) {
  if (method === 'GET' || method === 'HEAD') {
    return undefined;
  }
  const payload = options.data ?? options.body;
  if (payload === undefined || payload === null) {
    return undefined;
  }
  if (typeof payload === 'string' || payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
    return payload;
  }
  if (!hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  return JSON.stringify(payload);
}

function mergeRequestHeaders(ruleHeaders, customHeaders, cookie) {
  const headers = normalizeHeaders(ruleHeaders || {});
  for (const [key, value] of Object.entries(normalizeHeaders(customHeaders || {}))) {
    headers[key] = value;
  }
  if (!hasHeader(headers, 'user-agent')) {
    headers['User-Agent'] = DEFAULT_UA;
  }
  if (cookie && !hasHeader(headers, 'cookie')) {
    headers['Cookie'] = cookie;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (String(value) === 'MOBILE_UA' || String(value) === 'PC_UA') {
      headers[key] = DEFAULT_UA;
    }
  }
  return headers;
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

function hasHeader(headers, name) {
  const target = String(name || '').toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === target);
}

function responseHeadersToObject(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}

function flattenObject(value) {
  const result = {};
  for (const [key, item] of Object.entries(value || {})) {
    result[key] = item === undefined || item === null ? '' : `${item}`;
  }
  return result;
}

function getHome(url) {
  const match = String(url || '').match(/^https?:\/\/[^/]+/i);
  return match ? match[0] : '';
}

function safeUrlHost(url) {
  try {
    return new URL(String(url || '')).host;
  } catch (_) {
    return '127.0.0.1';
  }
}

function extractCookieFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const key = Object.keys(payload).find((item) => item.toLowerCase() === 'set-cookie');
  const raw = key ? payload[key] : '';
  return String(Array.isArray(raw) ? raw.join('; ') : raw || '').split(';')[0].trim();
}

function findSkillRootFromRulePath(filePath) {
  const normalized = path.resolve(filePath);
  const marker = `${path.sep}skills${path.sep}aibox-drpy-source${path.sep}`;
  const index = normalized.indexOf(marker);
  if (index >= 0) {
    return normalized.slice(0, index + marker.length - 1);
  }
  return process.env.AIBOX_SKILL_ROOT
    ? path.resolve(process.env.AIBOX_SKILL_ROOT)
    : process.cwd();
}

function drpyPdfa(html, selector) {
  if (!selector) {
    return [];
  }
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  return $(selector).toArray().map((node) => $.html(node));
}

function drpyPdfh(html, rule) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const parsed = parseDrpyBranch(rule, 'pdfh');
  if (!parsed) {
    return '';
  }
  const node = findFirstNode($, parsed.selector);
  return node ? extractNodeValue($, node, parsed.attr, 'pdfh') : '';
}

function drpyPd(html, rule, baseUrl = '') {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const parsed = parseDrpyBranch(rule, 'pd');
  if (!parsed) {
    return '';
  }
  const node = findFirstNode($, parsed.selector);
  const value = node ? extractNodeValue($, node, parsed.attr, 'pd') : '';
  return isMeaningfulValue(value) ? resolveUrl(baseUrl, value) : '';
}

function parseDrpyBranch(branch, mode) {
  const raw = String(branch || '').trim();
  if (!raw) {
    return null;
  }
  if (mode === 'pdfa') {
    return { selector: raw, attr: null };
  }
  const parts = raw.split('&&').map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  if (parts.length === 1) {
    return {
      selector: parts[0],
      attr: mode === 'pd' ? 'href' : 'Text',
    };
  }
  return {
    selector: parts.slice(0, -1).join(' '),
    attr: parts[parts.length - 1],
  };
}

function findFirstNode($, selector) {
  if (!selector) {
    return $.root().children().first();
  }
  const nodes = $(selector);
  if (!nodes || nodes.length === 0) {
    return null;
  }
  return nodes.first();
}

function extractNodeValue($, node, attr, mode) {
  const normalizedAttr = String(attr || '').trim();
  if (!normalizedAttr) {
    return mode === 'pd' ? firstNonEmptyAttr($(node), ['href', 'src', 'data-src']) : normalizeNodeText($(node).text());
  }
  if (normalizedAttr.includes('||')) {
    for (const candidate of normalizedAttr.split('||').map((item) => item.trim()).filter(Boolean)) {
      const value = extractNodeValue($, node, candidate, mode);
      if (isMeaningfulValue(value)) {
        return value;
      }
    }
    return '';
  }
  const attrLower = normalizedAttr.toLowerCase();
  if (attrLower === 'text') {
    return normalizeNodeText($(node).text());
  }
  if (attrLower === 'html' || attrLower === 'innerhtml') {
    return $(node).html() || '';
  }
  if (attrLower === 'outerhtml') {
    return $.html(node);
  }
  if (attrLower === 'href' || attrLower === 'src' || attrLower.startsWith('data-')) {
    return $(node).attr(normalizedAttr) || $(node).attr(attrLower) || '';
  }
  const direct = $(node).attr(normalizedAttr);
  if (direct !== undefined) {
    return direct;
  }
  const lower = $(node).attr(attrLower);
  if (lower !== undefined) {
    return lower;
  }
  if (mode === 'pd') {
    return firstNonEmptyAttr($(node), ['href', 'src', 'data-src']);
  }
  return normalizeNodeText($(node).text());
}

function firstNonEmptyAttr(node, attrs) {
  for (const attr of attrs) {
    const value = node.attr(attr);
    if (value) {
      return value;
    }
  }
  return '';
}

function normalizeNodeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isMeaningfulValue(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return true;
}

export function buildDetailRequest(rule, ids) {
  const orId = String(ids || '').trim();
  let vid = orId;
  let fyclass = '';
  if (vid.includes('$')) {
    const separatorIndex = vid.indexOf('$');
    fyclass = vid.slice(0, separatorIndex);
    vid = vid.slice(separatorIndex + 1);
  }

  const detailUrl = vid.split('@@')[0];
  const ruleDetailUrl = String(rule?.detailUrl || '').trim();
  const homeUrl = resolveUrl(rule?.host || '', rule?.homeUrl || '/');
  let input;

  if (/^https?:\/\//i.test(detailUrl)) {
    input = detailUrl;
  } else if (detailUrl.includes('/')) {
    input = resolveUrl(homeUrl, detailUrl);
  } else if (ruleDetailUrl) {
    input = resolveUrl(
      rule?.host || '',
      ruleDetailUrl
        .replace(/fyid/g, encodeURIComponent(detailUrl))
        .replace(/fyclass/g, encodeURIComponent(fyclass)),
    );
  } else {
    input = resolveUrl(rule?.host || '', detailUrl);
  }

  return {
    input,
    vid,
    orId,
    fyclass,
    detailUrl,
  };
}

export function normalizePlayResult(rule, result, playUrl, flag) {
  const fallback = {
    parse: SPECIAL_PLAY_URL.test(String(playUrl || '')) ? 0 : 1,
    url: String(playUrl || ''),
    flag: String(flag || ''),
    jx: 0,
  };

  const lazyIsExecutable = Boolean(
    rule?.play_parse
    && rule?.lazy
    && (typeof rule.lazy === 'function' || (typeof rule.lazy === 'string' && rule.lazy.startsWith('js:'))),
  );
  let normalized = fallback;
  if (lazyIsExecutable && result && typeof result === 'object' && !Array.isArray(result)) {
    const url = String(result.url ?? playUrl ?? '');
    normalized = {
      ...fallback,
      ...result,
      url,
      parse: result.parse ?? (SPECIAL_PLAY_URL.test(url) ? 0 : 1),
      flag: result.flag ?? fallback.flag,
    };
  } else if (lazyIsExecutable) {
    const url = String(result ?? playUrl ?? '');
    normalized = {
      ...fallback,
      url,
      parse: SPECIAL_PLAY_URL.test(url) ? 0 : 1,
    };
  }
  return applyPlayJsonPolicy(rule, normalized);
}

export function applyPlayJsonPolicy(rule, playResult) {
  const normalized = { ...(playResult || {}) };
  const playJson = Object.prototype.hasOwnProperty.call(rule || {}, 'play_json')
    ? rule.play_json
    : [];
  if (Array.isArray(playJson)) {
    if (playJson.length === 0) {
      return normalized;
    }
    const webUrl = String(normalized.url || '');
    for (const item of playJson) {
      if (!item?.re) {
        continue;
      }
      let matches = item.re === '*';
      if (!matches) {
        try {
          matches = new RegExp(item.re).test(webUrl);
        } catch (_) {
          matches = false;
        }
      }
      if (matches && item.json && typeof item.json === 'object' && !Array.isArray(item.json)) {
        return { ...normalized, ...item.json };
      }
    }
    return normalized;
  }
  if (playJson) {
    return { ...normalized, jx: 1, parse: 1 };
  }
  return { ...normalized, jx: 0, parse: 1 };
}

function parseJsonSafely(text, fallback = {}) {
  try {
    return JSON.parse(String(text || ''));
  } catch (_) {
    return fallback;
  }
}

function getByPath(value, pathValue, fallback = undefined) {
  if (!pathValue) {
    return value ?? fallback;
  }
  const result = String(pathValue)
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => {
      if (Array.isArray(acc) && /^\d+$/.test(key)) {
        return acc[Number(key)];
      }
      return acc && typeof acc === 'object' ? acc[key] : undefined;
    }, value);
  return result === undefined ? fallback : result;
}

function resolveRuleValue(rule, rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return '';
  }
  if (/^(https?:\/\/|novel:\/\/|pics:\/\/)/i.test(value)) {
    return value;
  }
  if (/^[\/?#.]/.test(value) || /\.(html?|php|asp|aspx)(\?|$)/i.test(value)) {
    return resolveUrl(rule?.host || '', value);
  }
  const detailUrl = String(rule?.detailUrl || '').trim();
  if (detailUrl.includes('fyid')) {
    return resolveUrl(rule?.host || '', detailUrl.replace(/fyid/g, encodeURIComponent(value)));
  }
  return value;
}

function sanitizeDisplayText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitRuleSpec(ruleValue) {
  return String(ruleValue || '').split(';').map((item) => item.trim());
}

export function resolveInheritedListRule(handlerName, ruleValue, categoryRule) {
  const current = String(ruleValue || '').trim();
  if (!['推荐', '搜索'].includes(String(handlerName || '')) || typeof categoryRule !== 'string') {
    return current;
  }
  if (current === '*') {
    return categoryRule;
  }
  const ownParts = splitRuleSpec(current);
  const categoryParts = splitRuleSpec(categoryRule);
  return ownParts
    .map((part, index) => part === '*' && categoryParts[index] !== undefined ? categoryParts[index] : part)
    .join(';');
}

function buildListItem({ title, pic, desc, url, vodId, content }) {
  const safeTitle = sanitizeDisplayText(title);
  const safePic = String(pic || '').trim();
  const safeDesc = sanitizeDisplayText(desc);
  const safeUrl = String(url || '').trim();
  const safeContent = sanitizeDisplayText(content || desc || '');
  return {
    title: safeTitle,
    pic_url: safePic,
    desc: safeDesc,
    content: safeContent,
    url: safeUrl,
    vod_id: String(vodId ?? safeUrl),
    vod_name: safeTitle,
    vod_pic: safePic,
    vod_remarks: safeDesc,
  };
}

function buildJsonListFromRule(ruleValue, payload, rule, options = {}) {
  const spec = splitRuleSpec(String(ruleValue || '').replace(/^json:/i, ''));
  const [listPath, titleField, imageField, descField, linkField] = spec;
  const items = getByPath(payload, listPath, []);
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => {
      const rawLink = String(getByPath(item, linkField, '') || '').trim();
      const resolvedLink = rule?.detailUrl ? rawLink : resolveRuleValue(rule, rawLink);
      const vodId = options.categoryId && rule?.detailUrl
        ? `${options.categoryId}$${rawLink}`
        : resolvedLink;
      return buildListItem({
        title: getByPath(item, titleField, ''),
        pic: resolveRuleValue(rule, getByPath(item, imageField, '')),
        desc: getByPath(item, descField, ''),
        url: vodId,
        vodId,
        content: getByPath(item, descField, ''),
      });
    })
    .filter((item) => item.title || item.url);
}

function buildHtmlListFromRule(ruleValue, html, rule, options = {}) {
  const [listSelector, titleRule, imageRule, descRule, linkRule] = splitRuleSpec(ruleValue);
  if (!listSelector) {
    return [];
  }
  return drpyPdfa(html, listSelector)
    .map((itemHtml) => {
      const rawLink = drpyPdfh(itemHtml, linkRule);
      const resolvedLink = rule?.detailUrl
        ? rawLink
        : resolveRuleValue(rule, drpyPd(itemHtml, linkRule, rule?.host || ''));
      const vodId = options.categoryId && rule?.detailUrl
        ? `${options.categoryId}$${rawLink}`
        : resolvedLink;
      return buildListItem({
        title: drpyPdfh(itemHtml, titleRule),
        pic: resolveRuleValue(rule, drpyPd(itemHtml, imageRule, rule?.host || '')) || drpyPdfh(itemHtml, imageRule),
        desc: drpyPdfh(itemHtml, descRule),
        url: vodId,
        vodId,
        content: drpyPdfh(itemHtml, descRule),
      });
    })
    .filter((item) => item.title || item.url);
}

function collectDetailPieces(html, ruleValue) {
  return splitRuleSpec(ruleValue)
    .map((item) => sanitizeDisplayText(drpyPdfh(html, item)))
    .filter(Boolean);
}

function expandIndexedSelector(selector, index) {
  return String(selector || '').replace(/#id/g, `${index}`);
}

function buildHtmlDetailFromRule(detailRule, html, rule, fallbackId) {
  const vod = {
    vod_id: String(fallbackId || ''),
    vod_name: sanitizeDisplayText(drpyPdfh(html, detailRule.title || 'h1&&Text')),
    vod_pic: resolveRuleValue(rule, drpyPd(html, detailRule.img || detailRule.image || '', rule?.host || '')) || sanitizeDisplayText(drpyPdfh(html, detailRule.img || detailRule.image || '')),
    type_name: '',
    vod_remarks: collectDetailPieces(html, detailRule.desc).join(' / '),
    vod_year: '',
    vod_area: '',
    vod_actor: '',
    vod_director: '',
    vod_content: sanitizeDisplayText(drpyPdfh(html, detailRule.content || 'body&&Text')),
    vod_play_from: '',
    vod_play_url: '',
  };

  const tabNodes = detailRule.tabs ? drpyPdfa(html, detailRule.tabs) : [];
  const tabNames = tabNodes.map((itemHtml, index) => sanitizeDisplayText(drpyPdfh(itemHtml, detailRule.tab_text || 'body&&Text')) || `线路${index + 1}`);
  const listSelector = String(detailRule.lists || '').trim();
  const groups = [];
  const names = [];

  const buildEpisodeGroup = (selector, index) => {
    const nodes = drpyPdfa(html, selector);
    const items = nodes.map((nodeHtml) => {
      const episodeName = sanitizeDisplayText(drpyPdfh(nodeHtml, detailRule.list_text || detailRule.list_title || 'body&&Text')) || `第${index + 1}集`;
      const rawUrl = detailRule.list_url_prefix
        ? `${detailRule.list_url_prefix}${drpyPdfh(nodeHtml, detailRule.list_url || 'a&&href')}`
        : resolveRuleValue(rule, drpyPd(nodeHtml, detailRule.list_url || 'a&&href', rule?.host || '')) || sanitizeDisplayText(drpyPdfh(nodeHtml, detailRule.list_url || 'a&&href'));
      if (!episodeName || !rawUrl) {
        return '';
      }
      return `${episodeName}$${rawUrl}`;
    }).filter(Boolean);
    return items;
  };

  if (listSelector) {
    if (listSelector.includes('#id')) {
      const total = Math.max(tabNames.length, 1);
      for (let index = 0; index < total; index += 1) {
        const items = buildEpisodeGroup(expandIndexedSelector(listSelector, index), index);
        if (!items.length) {
          continue;
        }
        groups.push(items.join('#'));
        names.push(tabNames[index] || `线路${index + 1}`);
      }
    } else {
      const items = buildEpisodeGroup(listSelector, 0);
      if (items.length) {
        groups.push(items.join('#'));
        names.push(tabNames[0] || '默认');
      }
    }
  }

  vod.vod_play_from = names.join('$$$');
  vod.vod_play_url = groups.join('$$$');
  return vod;
}

export function detectCaptchaMarkers(text) {
  const source = String(text || '');
  return DEFAULT_CAPTCHA_RE.test(source);
}
