#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const skillRoot = process.env.AIBOX_SKILL_ROOT
  ? path.resolve(process.env.AIBOX_SKILL_ROOT)
  : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const runtimeCoreUrl = pathToFileURL(
  path.join(skillRoot, 'scripts', 'lib', 'embedded-drpy-runtime-core.mjs'),
).href;

const { runEmbeddedDrpyServer } = await import(runtimeCoreUrl);

runEmbeddedDrpyServer({
  skillRoot,
  runtimeRoot: process.env.AIBOX_RUNTIME_ROOT
    ? path.resolve(process.env.AIBOX_RUNTIME_ROOT)
    : process.cwd(),
  port: Number(process.env.PORT || 5757),
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
