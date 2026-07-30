import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findAiboxEngineRoot } from './aibox-paths.mjs';

const RESULT_PREFIX = '__AIBOX_NATIVE_ENGINE_RESULT__';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SUPPORTED_OPERATIONS = new Set([
  'getRuleObject',
  'home',
  'homeVod',
  'category',
  'detail',
  'search',
  'play',
  'proxy',
  'chain',
]);

export function resolveNativeEngineLayout(skillRoot, options = {}) {
  const normalizedSkillRoot = path.resolve(skillRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const discoveredRoot = findAiboxEngineRoot({
    explicitRoot: options.engineRoot,
    skillRoot: normalizedSkillRoot,
    requiredPaths: ['package.json'],
  });
  const engineRoot = path.resolve(
    options.engineRoot
      || process.env.AIBOX_ENGINE_ROOT
      || discoveredRoot
      || path.join(normalizedSkillRoot, 'third_party', 'aibox-engine'),
  );
  const projectRoot = discoveredRoot
    ? path.resolve(engineRoot, '..', '..')
    : path.resolve(normalizedSkillRoot, '..');
  const workerLibRoot = path.join(normalizedSkillRoot, 'scripts', 'lib');
  return {
    skillRoot: normalizedSkillRoot,
    projectRoot,
    engineRoot,
    engineModulePath: path.join(engineRoot, 'libs', 'drpyS.js'),
    packagePath: path.join(engineRoot, 'package.json'),
    nodeModulesPath: path.join(engineRoot, 'node_modules'),
    workerPath: path.join(workerLibRoot, 'aibox-engine-worker.mjs'),
    workerDependencyPaths: [
      path.join(workerLibRoot, 'native-result-utils.mjs'),
      path.join(workerLibRoot, 'content-contracts.mjs'),
    ],
  };
}

export function inspectNativeEngineAvailability(skillRoot, options = {}) {
  const layout = resolveNativeEngineLayout(skillRoot, options);
  const missing = [];
  for (const [name, targetPath] of [
    ['engineRoot', layout.engineRoot],
    ['engineModule', layout.engineModulePath],
    ['package', layout.packagePath],
    ['nodeModules', layout.nodeModulesPath],
    ['worker', layout.workerPath],
    ...layout.workerDependencyPaths.map((targetPath, index) => [`workerDependency${index + 1}`, targetPath]),
  ]) {
    if (!fs.existsSync(targetPath)) {
      missing.push({ name, path: targetPath });
    }
  }
  return {
    available: missing.length === 0,
    engine: 'native',
    fidelity: missing.length === 0 ? 'native' : 'unavailable',
    layout,
    missing,
  };
}

export async function runNativeEngineOperation(operation, options = {}) {
  const command = String(operation || '').trim();
  if (!SUPPORTED_OPERATIONS.has(command)) {
    return failure(command, 'NATIVE_ENGINE_UNSUPPORTED_OPERATION', `Unsupported native engine operation: ${command || '<empty>'}`);
  }

  const availability = inspectNativeEngineAvailability(options.skillRoot, options);
  if (!availability.available) {
    return failure(command, 'NATIVE_ENGINE_UNAVAILABLE', 'The bundled Aibox engine is unavailable.', {
      missing: availability.missing,
      engineRoot: availability.layout.engineRoot,
    });
  }

  const sourcePath = path.resolve(String(options.sourcePath || ''));
  if (!options.sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    return failure(command, 'NATIVE_SOURCE_NOT_FOUND', `Rule source does not exist: ${sourcePath}`);
  }

  const request = {
    operation: command,
    sourcePath,
    engineRoot: availability.layout.engineRoot,
    engineModulePath: availability.layout.engineModulePath,
    engineEnv: options.engineEnv && typeof options.engineEnv === 'object' ? options.engineEnv : {},
    args: options.args && typeof options.args === 'object' ? options.args : {},
  };

  const startedAt = Date.now();
  let workspace;
  try {
    workspace = createWorkerWorkspace({
      engineRoot: availability.layout.engineRoot,
      parentPath: options.workerWorkspaceParent,
    });
  } catch (error) {
    return {
      ...failure(command, 'NATIVE_ENGINE_WORKSPACE_FAILED', error.message),
      durationMs: Date.now() - startedAt,
      isolation: options.permissionModel === false ? 'process-only' : 'node-permission',
    };
  }

  request.workspaceRoot = workspace.root;
  let response;
  let cleanupError;
  try {
    response = await invokeWorker({
      nodeCommand: String(options.nodeCommand || process.execPath),
      workerPath: availability.layout.workerPath,
      cwd: workspace.root,
      request,
      timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS),
      maxOutputBytes: positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      processEnv: buildWorkerEnvironment(options.processEnv),
      permissionModel: options.permissionModel !== false,
      readablePaths: [
        availability.layout.engineRoot,
        availability.layout.workerPath,
        ...availability.layout.workerDependencyPaths,
        sourcePath,
        workspace.root,
      ],
      writablePaths: [workspace.localRoot],
    });
  } finally {
    try {
      fs.rmSync(workspace.root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    } catch (error) {
      cleanupError = error;
    }
  }

  if (cleanupError) {
    return {
      ...failure(command, 'NATIVE_ENGINE_WORKSPACE_CLEANUP_FAILED', cleanupError.message, {
        workerError: response?.error,
      }),
      durationMs: Date.now() - startedAt,
      isolation: options.permissionModel === false ? 'process-only' : 'node-permission',
    };
  }

  return {
    ...response,
    command,
    engine: 'native',
    fidelity: resolveResponseFidelity(response),
    durationMs: Date.now() - startedAt,
    isolation: options.permissionModel === false ? 'process-only' : 'node-permission',
  };
}

export async function runNativeEngineChain(options = {}) {
  return await runNativeEngineOperation('chain', options);
}

async function invokeWorker({
  nodeCommand,
  workerPath,
  cwd,
  request,
  timeoutMs,
  maxOutputBytes,
  processEnv,
  permissionModel,
  readablePaths,
  writablePaths,
}) {
  return await new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let timer = null;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    try {
      const nodeArgs = permissionModel
        ? [
            '--experimental-permission',
            ...readablePaths.map((targetPath) => `--allow-fs-read=${path.resolve(targetPath)}`),
            ...writablePaths.map((targetPath) => `--allow-fs-write=${path.resolve(targetPath)}`),
            workerPath,
          ]
        : [workerPath];
      child = spawn(nodeCommand, nodeArgs, {
        cwd,
        env: processEnv,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(failure(request.operation, 'NATIVE_ENGINE_SPAWN_FAILED', error.message));
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch (_) {
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        try {
          child.kill('SIGTERM');
        } catch (_) {
        }
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (stderr.length < maxOutputBytes) {
        stderr += chunk.toString('utf8');
      }
      if (outputBytes > maxOutputBytes) {
        try {
          child.kill('SIGTERM');
        } catch (_) {
        }
      }
    });
    child.once('error', (error) => {
      finish(failure(request.operation, 'NATIVE_ENGINE_SPAWN_FAILED', error.message));
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(failure(request.operation, 'NATIVE_ENGINE_TIMEOUT', `Native engine worker timed out after ${timeoutMs}ms.`, {
          stderr: tail(stderr),
        }));
        return;
      }
      if (outputBytes > maxOutputBytes) {
        finish(failure(request.operation, 'NATIVE_ENGINE_OUTPUT_LIMIT', `Native engine worker exceeded ${maxOutputBytes} output bytes.`));
        return;
      }
      const markerIndex = stdout.lastIndexOf(RESULT_PREFIX);
      if (markerIndex < 0) {
        finish(failure(request.operation, 'NATIVE_ENGINE_INVALID_OUTPUT', 'Native engine worker did not return structured JSON.', {
          exitCode: code,
          signal,
          stdout: tail(stdout),
          stderr: tail(stderr),
        }));
        return;
      }
      const jsonText = stdout.slice(markerIndex + RESULT_PREFIX.length).trim();
      try {
        const payload = JSON.parse(jsonText);
        if (!payload.ok && stderr.trim() && !payload.error?.stderr) {
          payload.error = { ...(payload.error || {}), stderr: tail(stderr) };
        }
        finish(payload);
      } catch (error) {
        finish(failure(request.operation, 'NATIVE_ENGINE_INVALID_JSON', error.message, {
          exitCode: code,
          signal,
          stdout: tail(stdout),
          stderr: tail(stderr),
        }));
      }
    });

    child.stdin.end(JSON.stringify(request));
  });
}

function createWorkerWorkspace({ engineRoot, parentPath }) {
  const requestedParent = path.resolve(String(parentPath || os.tmpdir()));
  const resolvedEngineRoot = path.resolve(engineRoot);
  if (isSameOrDescendant(requestedParent, resolvedEngineRoot)) {
    throw new Error(`Native engine workspace must be outside the engine root: ${requestedParent}`);
  }

  fs.mkdirSync(requestedParent, { recursive: true });
  const realParent = fs.realpathSync.native(requestedParent);
  const realEngineRoot = fs.realpathSync.native(resolvedEngineRoot);
  if (isSameOrDescendant(realParent, realEngineRoot)) {
    throw new Error(`Native engine workspace must be outside the engine root: ${realParent}`);
  }

  let root;
  try {
    root = fs.mkdtempSync(path.join(realParent, 'aibox-native-worker-'));
    const localRoot = path.join(root, 'local');
    fs.mkdirSync(localRoot);
    return { root, localRoot };
  } catch (error) {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    throw error;
  }
}

function isSameOrDescendant(candidatePath, parentPath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function buildWorkerEnvironment(overrides = {}) {
  const allowedNames = [
    'SystemRoot',
    'ComSpec',
    'PATH',
    'Path',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
    'TZ',
  ];
  const env = {};
  for (const name of allowedNames) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  for (const [name, value] of Object.entries(overrides || {})) {
    if (value !== undefined && value !== null) {
      env[name] = String(value);
    }
  }
  env.NODE_ENV = env.NODE_ENV || 'test';
  env.DRPY_MODULE_CACHE_MAX = env.DRPY_MODULE_CACHE_MAX || '4';
  env.DRPY_RULE_CACHE_MAX = env.DRPY_RULE_CACHE_MAX || '4';
  env.DRPY_SESSION_CACHE_MAX = env.DRPY_SESSION_CACHE_MAX || '8';
  return env;
}

function failure(command, code, message, details = undefined) {
  return {
    ok: false,
    command,
    engine: 'native',
    fidelity: 'unavailable',
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveResponseFidelity(response) {
  const unavailableCodes = new Set([
    'NATIVE_ENGINE_UNAVAILABLE',
    'NATIVE_ENGINE_SPAWN_FAILED',
    'NATIVE_ENGINE_TIMEOUT',
    'NATIVE_ENGINE_OUTPUT_LIMIT',
    'NATIVE_ENGINE_INVALID_OUTPUT',
    'NATIVE_ENGINE_INVALID_JSON',
  ]);
  return response.ok || !unavailableCodes.has(response.error?.code) ? 'native' : 'unavailable';
}

function tail(value, maxLength = 16_000) {
  const text = String(value || '');
  return text.length <= maxLength ? text : text.slice(-maxLength);
}
