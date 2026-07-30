# Aibox 写源能力映射

本 Skill 将旧 Aibox MCP 和历史 CLI 的能力收口为一条本地工作流：

```text
resources -> doctor -> triage -> templates/resolved -> compose -> lint -> check -> heal -> save -> share
```

## 主能力

| 目标 | 新主命令 | 旧 MCP/CLI 来源 |
|---|---|---|
| 知识与空白模板读取 | `resources list/read` | `list-resources`、`read-resource` |
| 环境与 OCR 检查 | `doctor` | `drpy-doctor`、`ocr-check` |
| 站型与风险判断 | `triage` | `build-blueprint`、`plan-workflow`、`analyze-content` |
| 模板发现 | `templates list/guess` | 模板资源与人工比对 |
| 展开有效规则 | `resolved` | 新增原生 Aibox 模板解析能力 |
| 生成紧凑规则 | `compose` | `aibox_compose_drpy_rule`、`compose-rule` |
| 非执行静态检查 | `lint` | `aibox_check_drpy_syntax`、`check-syntax`、静态部分 `validate-rule` |
| L1/L2/L3 验收 | `check` | `aibox_validate_drpy_rule`、`validate-rule`、`live-check` |
| 候选补丁/应用 | `heal` | `live-heal`，改为默认只输出 diff |
| 原子保存与版本 | `save` | `aibox_save_rule_file`、`save-rule` |
| 云1/云G1 分享 | `share` | `aibox_upload_clipboard`、`upload-clipboard` |
| 局部选择器调试 | `debug-selector` | `aibox_debug_drpy_rule`、`debug-rule` |
| 手动便携引擎 | `runtime start/stop` | `drpy-start`、`drpy-stop` |

## 保留能力

- `resources read --name/--uri` 用于按需加载单项知识，避免一次读取整个知识库。
- `debug-selector --mode --rule` 只用于选择器局部调试，不能代替 L2/L3。
- `runtime start/stop` 仅用于手动诊断；正常 `check --engine auto` 优先直接调用原生 Aibox 引擎。
- OCR、动态域、漫画图片代理、小说/漫画首末章、BT/magnet、云剪切板均继续支持。

## Deprecated Alias

历史命令保留为兼容别名并在结果中返回替代命令提示。文档、Prompt 和新自动化不再使用旧命令名。

## 不内置的桥接

- 浏览器真实渲染、XHR 观察和交互操作使用当前环境可用的浏览器工具。
- 联网文档搜索使用当前环境可用的搜索工具。
- Cloudflare、滑块、登录墙、DRM 等强反爬只做识别和证据收集，不伪造“已自动解决”。

核心原则：能在本地稳定实现的能力进入 CLI；依赖外部运行环境的能力明确边界，不做假适配。
