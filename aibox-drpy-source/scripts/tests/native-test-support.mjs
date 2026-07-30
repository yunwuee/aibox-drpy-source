import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectNativeEngineAvailability } from '../lib/aibox-engine-adapter.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, '..', '..');

export const nativeEngineAvailability = inspectNativeEngineAvailability(skillRoot);

export function nativeTest(name, callback) {
  return test(name, {
    skip: nativeEngineAvailability.available
      ? false
      : '未发现可选 AIBOX 原生引擎；便携公开包测试继续执行',
  }, callback);
}
