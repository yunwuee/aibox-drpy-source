import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const defaultConfig = {
  name: 'Aibox',
  version: '0.2.0',
  outputDir: './output',
  maxFetchChars: 240000,
  clipboardShare: {
    baseUrl: 'https://textdb.online',
    provider: '云1',
    groupProvider: '云G1',
    keyLength: 24,
    timeoutMs: 15000,
  },
  embeddedDrpy: {
    enabled: true,
    port: 5757,
    nodeCommand: 'node',
    sessionRoot: '../output/live-sessions',
    reportRoot: '../output/live-check',
    stateFile: '../output/embedded-drpy.state.json',
    sourceDirs: ['../output', './output'],
    defaultDepth: 'smoke',
    cleanupOnSuccess: true,
    maxHealRounds: 8,
    ocr: {
      mode: 'http',
      endpoint: 'https://api.nn.ci/ocr/b64/text',
      command: '',
      args: [],
      cwd: '',
      env: {},
      headers: {},
      timeoutMs: 15000,
      bodyMode: 'auto',
      responsePath: '',
      retry: 3,
    },
    crypto: {
      enableRequireShim: true,
      requireAllowList: ['crypto-js', 'crypto', 'node:crypto', 'buffer', 'url'],
      preferNodeCrypto: true,
    },
    report: {
      stdoutMode: 'compact',
      keepVerboseJson: true,
    },
  },
  downstream: {
    browser: {
      enabled: false,
      command: '',
      args: [],
      cwd: '',
      env: {},
      toolMap: {
        navigate: 'playwright_navigate',
        html: 'playwright_get_visible_html',
        text: 'playwright_get_visible_text',
        screenshot: 'playwright_screenshot',
      },
      defaultNavigateArgs: {
        waitUntil: 'load',
        headless: true,
        timeout: 30000,
      },
      defaultHtmlArgs: {
        cleanHtml: true,
        removeComments: true,
        removeMeta: false,
        removeScripts: false,
        maxLength: 180000,
      },
    },
    search: {
      enabled: false,
      command: '',
      args: [],
      cwd: '',
      env: {},
      toolMap: {
        search: 'tavily-search',
      },
      defaultSearchArgs: {
        search_depth: 'advanced',
        include_raw_content: true,
        max_results: 6,
        topic: 'general',
      },
    },
  },
};

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config' || token === '-c') {
      args.config = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--output-dir') {
      args.outputDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--debug') {
      args.debug = true;
      continue;
    }
  }
  return args;
}

export function loadConfig(cliArgs = parseArgs()) {
  const configPath = cliArgs.config
    ? path.resolve(process.cwd(), cliArgs.config)
    : null;

  let fileConfig = {};
  if (configPath && fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  const merged = deepMerge(defaultConfig, fileConfig);
  merged.configPath = configPath;
  merged.configDir = configPath ? path.dirname(configPath) : process.cwd();
  merged.outputDir = path.resolve(
    merged.configDir,
    cliArgs.outputDir || merged.outputDir,
  );
  merged.debug = Boolean(cliArgs.debug || merged.debug);

  for (const key of ['browser', 'search']) {
    const item = merged.downstream?.[key];
    if (item?.cwd) {
      item.cwd = path.resolve(merged.configDir, item.cwd);
    }
  }

  if (merged.embeddedDrpy) {
    merged.embeddedDrpy.sessionRoot = path.resolve(merged.configDir, merged.embeddedDrpy.sessionRoot);
    merged.embeddedDrpy.reportRoot = path.resolve(merged.configDir, merged.embeddedDrpy.reportRoot);
    merged.embeddedDrpy.stateFile = path.resolve(merged.configDir, merged.embeddedDrpy.stateFile);
    merged.embeddedDrpy.sourceDirs = (merged.embeddedDrpy.sourceDirs || []).map((item) => path.resolve(merged.configDir, item));
    if (merged.embeddedDrpy.ocr?.cwd) {
      merged.embeddedDrpy.ocr.cwd = path.resolve(merged.configDir, merged.embeddedDrpy.ocr.cwd);
    }
  }

  return merged;
}

export function sanitizeFilename(filename) {
  const cleaned = String(filename || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || `source-${Date.now()}.js`;
}

export function ensureSafeChildPath(rootDir, targetName) {
  const safeName = sanitizeFilename(targetName);
  const targetPath = path.resolve(rootDir, safeName);
  const normalizedRoot = path.resolve(rootDir);
  if (!targetPath.startsWith(normalizedRoot)) {
    throw new Error(`输出路径越界: ${targetPath}`);
  }
  return targetPath;
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override ?? base;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (key in base) {
        merged[key] = deepMerge(base[key], value);
      } else {
        merged[key] = value;
      }
    }
    return merged;
  }

  return override ?? base;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
