#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, '..');
const sourcePath = path.join(skillRoot, 'config', 'aibox.config.example.json');
const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter((item) => item !== '--force');
const targetPath = path.resolve(
  process.cwd(),
  positional[0] || path.join(skillRoot, 'config', 'aibox.config.json'),
);

if (!fs.existsSync(sourcePath)) {
  throw new Error('未找到示例配置文件: ' + sourcePath);
}
if (fs.existsSync(targetPath) && !force) {
  process.stdout.write('目标文件已存在，未覆盖: ' + targetPath + '\n');
  process.stdout.write('如需覆盖，请追加 --force\n');
  process.exit(0);
}

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.copyFileSync(sourcePath, targetPath);
process.stdout.write('已生成配置文件: ' + targetPath + '\n');
process.stdout.write('本地配置已被 gitignore；请按需修改 outputDir、OCR 和下游桥接设置。\n');
