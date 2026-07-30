import fs from 'node:fs';
import path from 'node:path';

import { runLiveCheck, renderMarkdownReport } from './live-checker.mjs';
import { resolveEmbeddedDrpyConfig, sha1, writeJsonFile, writeTextFile } from './embedded-drpy-manager.mjs';
import { buildHealPromptArtifact } from './source-fixer.mjs';
import { createSafeRulePatch } from './safe-rule-fixer.mjs';
import { saveRuleToFile } from './rule-utils.mjs';

export async function runLiveHeal({
  skillRoot,
  config = {},
  codeFile,
  depth,
}) {
  if (!codeFile) {
    throw new Error('live-heal 需要 --code-file');
  }

  const sourcePath = path.resolve(process.cwd(), codeFile);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`源文件不存在: ${sourcePath}`);
  }

  const runtimeConfig = resolveEmbeddedDrpyConfig(skillRoot, config);
  const healSessionId = `live-heal-${Date.now()}`;
  const healRoot = path.join(runtimeConfig.reportRoot, healSessionId);
  const workPath = path.join(healRoot, path.basename(sourcePath));
  fs.mkdirSync(healRoot, { recursive: true });
  fs.copyFileSync(sourcePath, workPath);

  const history = [];
  let previousHash = sha1(fs.readFileSync(workPath, 'utf8'));
  let stagnantRounds = 0;
  let sameFailureRounds = 0;
  let previousFailureCategory = '';
  let lastReport = null;

  for (let round = 1; round <= runtimeConfig.maxHealRounds; round += 1) {
    const roundDir = path.join(healRoot, `round-${round}`);
    fs.mkdirSync(roundDir, { recursive: true });

    const report = await runLiveCheck({
      skillRoot,
      config,
      codeFile: workPath,
      depth,
      keepTemp: true,
    });
    lastReport = report;
    writeJsonFile(path.join(roundDir, 'live-check.report.json'), report);
    writeTextFile(path.join(roundDir, 'live-check.report.md'), renderMarkdownReport(report));

    const currentCode = fs.readFileSync(workPath, 'utf8');
    if (report.passed) {
      saveRuleToFile({
        outputDir: path.dirname(sourcePath),
        filePath: sourcePath,
        code: currentCode,
        overwrite: true,
      });
      return {
        passed: true,
        sourcePath,
        workPath,
        healRoot,
        rounds: round,
        history,
        finalReport: report,
      };
    }

    const failureCategory = detectFailureCategory(report);
    if (failureCategory === previousFailureCategory) {
      sameFailureRounds += 1;
    } else {
      sameFailureRounds = 0;
      previousFailureCategory = failureCategory;
    }

    if (failureCategory === 'runtime') {
      history.push({ round, changed: false, failureCategory, reason: 'runtime-error-stop' });
      break;
    }

    const fixed = createSafeRulePatch(currentCode, { fileName: path.basename(sourcePath) });
    writeJsonFile(path.join(roundDir, 'deterministic-fix.json'), fixed);

    if (!fixed.changed) {
      writeTextFile(path.join(roundDir, 'heal-prompt.md'), buildHealPromptArtifact({ code: currentCode, report }));
      history.push({ round, changed: false, failureCategory, reason: 'no-deterministic-change' });
      stagnantRounds += 1;
    } else {
      fs.writeFileSync(workPath, fixed.code, 'utf8');
      writeTextFile(path.join(roundDir, 'work.after.js'), fixed.code);
      history.push({ round, changed: true, failureCategory, changes: fixed.changes });
      const nextHash = sha1(fixed.code);
      if (nextHash === previousHash) {
        stagnantRounds += 1;
      } else {
        stagnantRounds = 0;
      }
      previousHash = nextHash;
    }

    if (stagnantRounds >= 2 || sameFailureRounds >= 2) {
      break;
    }
  }

  return {
    passed: false,
    sourcePath,
    workPath,
    healRoot,
    rounds: history.length,
    history,
    finalReport: lastReport,
  };
}

function detectFailureCategory(report) {
  if (!report?.syntax?.passed) {
    return 'syntax';
  }
  if (!report?.validation?.passed) {
    return 'validate';
  }
  if (report?.steps?.config?.errors?.length) {
    return 'runtime';
  }
  for (const name of [
    'home',
    'category',
    'detail',
    'video_catalog',
    'novel_catalog',
    'comic_catalog',
    'search',
    'play',
    'novel_chapter_first',
    'novel_chapter_last',
    'comic_chapter_first',
    'comic_chapter_last',
  ]) {
    const step = report?.steps?.[name];
    if (!step || step.skipped) {
      continue;
    }
    if ((step.errors || []).length > 0) {
      if (step.captchaRisk === 'confirmed') {
        return `${name}-captcha`;
      }
      return `${name}-error`;
    }
  }
  return 'unknown';
}
