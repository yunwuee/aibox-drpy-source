# aibox-drpy-source Agent Instructions

## 入口

- 公开 Skill 位于 `./aibox-drpy-source`。
- 处理写源、修源、规则分析或验收任务前，完整读取 `./aibox-drpy-source/SKILL.md`。
- 将包含 `SKILL.md` 的目录作为 `skill-root`，不要依赖仓库在本机的绝对路径。

## 启动顺序

1. 在 `skill-root` 执行 `npm ci`，除非依赖已经安装且 lockfile 未变化。
2. 执行 `node ./scripts/aibox-skill-cli.mjs help`。
3. 执行 `node ./scripts/aibox-skill-cli.mjs resources list`。
4. 只读取 `SKILL.md` 路由到的必要 reference。
5. 先取得目标页面或接口证据，再生成或修改规则。
6. 使用真实 ID 完成任务需要的 L1/L2/L3 验收。

## 输出边界

- 本仓库没有内置站点源。
- 不把 `assets/*.example.json`、`template/ds_template.js` 或测试 fixture 当作可交付站点源。
- 将生成结果写到用户指定目录；未指定时写到当前工作区的 `output/`。
- 不把生成结果写入 Skill 的 `assets/`、`references/`、`template/`、`scripts/` 或 `vendor/`。
- 不提交 Cookie、Token、Authorization、设备标识、私有域名和本机绝对路径。

## 外部写操作

- `heal` 默认只输出 diff；只有用户要求实施修复时才使用 `--apply`。
- 只有用户明确要求上传或分享时才运行 `share`。
- 遇到登录墙、缺失凭据、Cloudflare、滑块、DRM 或强风控时停止猜测并报告条件。
