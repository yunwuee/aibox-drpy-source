import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export function findAiboxEngineRoot({
  explicitRoot = '',
  skillRoot = '',
  cwd = process.cwd(),
  requiredPaths = ['package.json'],
} = {}) {
  const candidates = [];
  addCandidate(candidates, explicitRoot);
  addCandidate(candidates, process.env.AIBOX_ENGINE_ROOT);
  if (process.env.AIBOX_ROOT) {
    addCandidate(candidates, path.join(process.env.AIBOX_ROOT, 'third_party', 'aibox-engine'));
  }
  addAncestorCandidates(candidates, skillRoot);
  addAncestorCandidates(candidates, cwd);

  for (const candidate of candidates) {
    if (requiredPaths.every((relativePath) => fs.existsSync(path.join(candidate, relativePath)))) {
      return candidate;
    }
  }
  return '';
}

function addAncestorCandidates(candidates, startPath) {
  if (!startPath) return;
  let current = path.resolve(startPath);
  while (true) {
    if (path.basename(current).toLowerCase() === 'aibox-engine') {
      addCandidate(candidates, current);
    }
    addCandidate(candidates, path.join(current, 'third_party', 'aibox-engine'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function addCandidate(candidates, value) {
  if (!value) return;
  const resolved = path.resolve(String(value));
  if (!candidates.some((item) => samePath(item, resolved))) {
    candidates.push(resolved);
  }
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
