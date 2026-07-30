# aibox-drpy-source

[![CI](https://github.com/yunwuee/aibox-drpy-source/actions/workflows/ci.yml/badge.svg)](https://github.com/yunwuee/aibox-drpy-source/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yunwuee/aibox-drpy-source?display_name=tag)](https://github.com/yunwuee/aibox-drpy-source/releases/latest)
[![License: Source Available](https://img.shields.io/badge/License-Source--Available-orange.svg)](LICENSE)

面向 Aibox 内置 drpy-node 引擎的公开 AI Skill。它把写源经验、规则语法、诊断流程、真实链路验收和配套 CLI 放在一起，让 Codex 或其他支持 `SKILL.md` 的 Agent 能按证据生成、修复和验证影视、小说、漫画及磁力/BT DS 源。

- 作者与维护者：[yunwuee](https://github.com/yunwuee)
- 授权联系：[yunwuee@gmail.com](mailto:yunwuee@gmail.com)
- AIBOX：[yunwuee/AIBOX-public](https://github.com/yunwuee/AIBOX-public)
- 重点参考：[hjdhnx/drpy-node-skill](https://github.com/hjdhnx/drpy-node-skill)、[zyfun 写源文档](https://zy.catni.cn/zh-CN/)
- 许可证：AIBOX DRPY Source Skill Source-Available License 1.0
- 当前版本：v0.1.2

## 直接下载

推荐从 GitHub Release 下载已经整理好的 Skill 安装包：

- [下载最新版 aibox-drpy-source-skill.zip](https://github.com/yunwuee/aibox-drpy-source/releases/latest/download/aibox-drpy-source-skill.zip)
- [下载 SHA-256 校验文件](https://github.com/yunwuee/aibox-drpy-source/releases/latest/download/aibox-drpy-source-skill.zip.sha256)
- [查看全部版本](https://github.com/yunwuee/aibox-drpy-source/releases)

Release ZIP 不包含 `node_modules`、站点源、用户配置、Cookie、Token、抓取结果或运行日志。解压后会看到：

~~~text
README.md
INSTALL.txt
LICENSE
THIRD_PARTY_NOTICES.md
PACKAGE_MANIFEST.json
aibox-drpy-source/
~~~

也可以直接下载仓库源码：

- [下载 main 分支源码 ZIP](https://github.com/yunwuee/aibox-drpy-source/archive/refs/heads/main.zip)

## 这个 Skill 能做什么

| 场景 | AI 会做什么 |
|---|---|
| 按网址写新源 | 抓取真实页面或 API 证据，判断站型，生成 `var rule = {}` |
| 修复已有源 | 保留有效逻辑，定位分类、详情、搜索、播放或正文断点 |
| 影视源 | 验证分类、详情、线路、播放地址和 lazy 后处理 |
| 小说源 | 验证目录、首末章正文和 `novel://` 协议 |
| 漫画源 | 验证目录、图片文件头、`pics://`、防盗链、代理和切片 |
| App API | 分析签名、时间戳、设备 ID、POST body、加解密和动态 API 域 |
| 动态域名 | 发现发布页、候选域、缓存、刷新和失败回退 |
| 验证码 | 处理简单图片验证码和 OCR；遇到滑块、Cloudflare、登录墙时停止猜测 |
| 磁力/BT | 返回完整 magnet 或公开 torrent，交给 Aibox 本地 BT 引擎 |
| 规则验收 | 提供 L1 静态检查、L2 单接口检查和 L3 真实链路检查 |
| 安全分享 | 分享前检查外部依赖、源码完整性、字节数和 SHA-256 |

它不是“输入域名后盲猜选择器”的模板生成器。AI 必须先获得真实响应证据，再决定使用模板、字符串规则、函数混合还是全 async。

## 安装

需要本机安装 Node.js。当前开发和 CI 使用 Node.js 22，普通用户直接使用自己的当前 LTS 即可，不要求为了这个 Skill 单独切换多个 Node 版本。

### Windows

1. 下载并解压 Release ZIP。
2. 将其中的 `aibox-drpy-source` 目录复制到 Codex Skills 目录。
3. 安装运行依赖。

~~~powershell
Copy-Item .\aibox-drpy-source "$env:USERPROFILE\.codex\skills\aibox-drpy-source" -Recurse -Force
npm ci --prefix "$env:USERPROFILE\.codex\skills\aibox-drpy-source"
~~~

### macOS / Linux

~~~bash
cp -R ./aibox-drpy-source ~/.codex/skills/aibox-drpy-source
npm ci --prefix ~/.codex/skills/aibox-drpy-source
~~~

### 从 Git 仓库安装

Windows：

~~~powershell
git clone https://github.com/yunwuee/aibox-drpy-source.git
Copy-Item .\aibox-drpy-source\aibox-drpy-source "$env:USERPROFILE\.codex\skills\aibox-drpy-source" -Recurse -Force
npm ci --prefix "$env:USERPROFILE\.codex\skills\aibox-drpy-source"
~~~

macOS / Linux：

~~~bash
git clone https://github.com/yunwuee/aibox-drpy-source.git
cp -R ./aibox-drpy-source/aibox-drpy-source ~/.codex/skills/aibox-drpy-source
npm ci --prefix ~/.codex/skills/aibox-drpy-source
~~~

安装后重启 Codex 或重新加载 Skills。

## 安装检查

在 Skill 目录执行：

~~~powershell
node .\scripts\aibox-skill-cli.mjs help
node .\scripts\aibox-skill-cli.mjs doctor
node .\scripts\aibox-skill-cli.mjs resources list
~~~

`doctor` 中原生 AIBOX 引擎显示 `available: false` 并不代表安装失败。独立安装默认可以使用便携运行时；只有需要完全复现特定 AIBOX 版本的模板、密文或真机差异时，才需要提供原生引擎目录。

## 让 AI 直接使用

### Codex 最短调用

安装完成后，在对话中明确提到 Skill：

~~~text
使用 $aibox-drpy-source，为 https://example.com 编写一个影视 DS 源。
先分析站点和真实接口，再生成规则，并完成 L1/L2/L3 验收。
把最终源码写到当前工作区 output/source.js，不要上传或分享。
~~~

只要提示词里出现 `$aibox-drpy-source`，Codex 就会读取该 Skill 的 `SKILL.md`，再按任务需要渐进读取 references，而不是一次加载全部知识文件。

### 在克隆仓库中直接让 Agent 使用

如果还没有安装 Skill，但 AI 已经打开本仓库，可以这样说：

~~~text
请先读取 ./aibox-drpy-source/SKILL.md，并把它作为本任务的强制工作流。
目标网址：https://example.com
目标：生成一个可在 Aibox 使用的影视 DS 源。
要求：先取证，再写规则；完成 L1/L2/L3；输出到 ./output/source.js；不要分享。
~~~

仓库根目录的 `AGENTS.md` 也会告诉支持项目指令的 Agent 从哪里开始。

### 通用任务模板

把下面内容中的占位项替换后直接发给 AI：

~~~text
使用 $aibox-drpy-source 完成这个任务。

任务类型：新建源 / 修复源 / 只分析 / 只验收
目标网址：https://example.com
内容类型：video / novel / comic / bt / 自动判断
已有源码：没有；或者位于 ./source.js
已知问题：填写日志、空数据阶段或真机现象
输出目录：./output

执行要求：
1. 先运行 Skill CLI help 和 resources list。
2. 只读取当前任务需要的 reference。
3. 获取首页、分类、详情、搜索、播放或正文的真实证据。
4. 选择最低复杂度实现，不猜接口和字段。
5. 使用真实 class_id、vod_id、play_url 或章节 ID 串联测试。
6. 完成任务需要的 L1/L2/L3 验收。
7. 输出源码、验证结果、失败阶段和剩余风险。
8. 未经允许不要 share、上传或覆盖已有文件。
~~~

## AI 实际执行顺序

| 步骤 | 行为 | 常用命令 |
|---|---|---|
| 1. 找到 Skill | 将 `SKILL.md` 所在目录作为 `skill-root` | 无 |
| 2. 检查环境 | 检查 Node、便携运行时、原生引擎和配置 | `doctor` |
| 3. 读取知识 | 列出资源，只读取当前任务需要的内容 | `resources list/read` |
| 4. 判断站型 | 判断 template、html、hybrid 或 api | `triage` |
| 5. 检查模板 | 只使用当前引擎真实存在的模板 | `templates list/guess` |
| 6. 获取证据 | 请求真实列表、详情、搜索、播放或正文 | 站点请求工具 |
| 7. 生成规则 | 使用结构化规格生成最小可运行源码 | `compose` |
| 8. 静态检查 | 检查语法、AST、重复字段和协议契约 | `lint` |
| 9. 真实验收 | 用真实 ID 串联 L2/L3 | `check` |
| 10. 修复问题 | 先输出 diff，得到允许后才写回 | `heal` |
| 11. 保存交付 | 原子保存源码并报告证据 | `save` |
| 12. 可选分享 | 仅用户明确要求时上传并回读验证 | `share` |

AI 不需要死记所有命令。每次先执行：

~~~text
node <skill-root>/scripts/aibox-skill-cli.mjs help
~~~

以当前版本实际输出为准。

## 给 AI 的输入越完整，结果越可靠

建议至少提供：

- 目标网址或 API 根地址。
- 内容类型，或者允许 AI 自动判断。
- 新建源还是修复已有源。
- 已有源码的路径。
- Aibox 日志、错误信息或空数据阶段。
- 是否允许联网访问目标站点。
- 是否存在登录凭据、验证码或地区限制。
- 期望输出目录。
- 是否需要真机验收。
- 是否允许保存、覆盖或分享。

只有一个网址也可以开始，但 AI 可能需要先做更多站点取证。

## 常用提示词

### 写影视源

~~~text
使用 $aibox-drpy-source 分析 https://example.com，生成影视 DS 源。
必须验证首页、分类、详情、搜索和播放链路。
优先模板或字符串规则，只有证据证明需要时才使用 async。
最终保存到 ./output/video-source.js，不要分享。
~~~

### 修复已有源

~~~text
使用 $aibox-drpy-source 修复 ./source.js。
现象：推荐有数据，但分类页为空。
先保留现有详情和播放逻辑，使用真实 class_id 复现问题。
输出修复 diff、L1/L2/L3 结果，确认后再覆盖文件。
~~~

### 写小说源

~~~text
使用 $aibox-drpy-source 为 https://example.com 编写小说源。
验证详情目录、首章和末章正文，确保最终返回 novel:// 协议。
不要用假章节 ID，不要只做静态 lint。
~~~

### 写漫画 App API 源

~~~text
使用 $aibox-drpy-source 分析这个漫画 App API。
拆分 list、detail、catalog、reader 四个阶段，记录 method、headers、body、签名和 ID 来源。
验证首末章首尾图片文件头；如存在 WebP 切片，在 proxy_rule 内完成解码重排。
~~~

### 只审计，不改文件

~~~text
使用 $aibox-drpy-source 审计 ./source.js，只运行分析、lint 和必要的只读检查。
列出重复字段、模板风险、播放协议问题和缺少的验收证据。
不要 heal --apply，不要覆盖，不要 share。
~~~

## L1、L2、L3 是什么

| 级别 | 证明什么 | 不能证明什么 |
|---|---|---|
| L1 | 源码可解析，字段、AST、模板和协议契约基本正确 | 不能证明站点当前可访问 |
| L2 | 首页、分类、详情、搜索、播放或正文等单接口真实返回有效 | 不能证明完整上下游 ID 串联正确 |
| L3 | 使用真实 ID 跑通分类到详情再到播放或正文的完整链路 | 仍不能替代所有设备和网络环境 |

影视通常验证真实播放结果；小说验证首末章正文；漫画验证首末章首尾图片及真实文件头。

## 主要 CLI

在 `aibox-drpy-source` 目录运行：

~~~text
node ./scripts/aibox-skill-cli.mjs <command> [options]
~~~

| 命令 | 用途 |
|---|---|
| `help` | 显示当前命令和参数 |
| `doctor` | 检查环境、便携运行时、原生引擎、OCR 和配置 |
| `resources list/read` | 渐进列出或读取知识资源 |
| `triage` | 判断站点路线 |
| `templates list/guess` | 查看真实模板或按证据推荐模板 |
| `resolved` | 解密并展开模板后的规则摘要 |
| `compose` | 从 JSON 规格生成规则 |
| `lint` | 执行 L1 静态检查 |
| `check` | 执行 L1/L2/L3 运行检查 |
| `heal` | 生成修复 diff；`--apply` 才写入 |
| `save` | 校验后原子保存 |
| `share` | 上传云剪切板并回读验证 |
| `debug-selector` | 调试 `pdfa/pdfh/pd` 选择器 |

完整参数和示例见：

- [command-examples.md](aibox-drpy-source/references/command-examples.md)
- [capability-map.md](aibox-drpy-source/references/capability-map.md)

## 原生引擎与便携运行时

Skill 可以独立运行，不要求用户同时克隆完整 AIBOX 仓库。

原生引擎查找顺序：

1. CLI 的 `--engine-root <dir>`。
2. 环境变量 `AIBOX_ENGINE_ROOT`。
3. 环境变量 `AIBOX_ROOT` 下的 `third_party/aibox-engine`。
4. 从当前目录和 Skill 目录向上查找。

未发现原生引擎时，静态分析、规则生成、便携检查和大部分诊断仍然可用。涉及 AIBOX 私有模板、密文解密或真机差异时，应提供目标版本的原生引擎，并以设备最终响应为准。

## 输出与交付

正常交付至少应包含：

- 最终 `var rule = {}` 源码文件。
- 站型与内容类型。
- 使用的实现阶梯。
- 首页、分类、详情、搜索、播放或正文证据。
- 真实 ID 串联过程。
- L1/L2/L3 结果。
- 动态域、验证码、签名、代理或切片处理说明。
- 尚未验证的能力和剩余风险。

默认把生成结果写到用户指定的工作目录；未指定时写到当前任务工作区的 `output/`。AI 不应把生成的站点源写回 Skill 的 `assets/`、`references/`、`template/` 或 `scripts/`。

## 无内置源

本仓库不分发任何可直接导入的站点源。

- `template/ds_template.js` 只是使用 `example.com` 的空白骨架。
- `assets/compose-rule.*.example.json` 是生成器结构化测试规格。
- `scripts/tests/fixtures` 只用于自动测试。
- 知识库不提供 `aibox://examples/*` 成品源资源。
- Release ZIP 不包含 `output/`、`temp/`、`sources/`、`spider/` 或 `assets/examples/`。

## 安全边界

- 只处理用户有权访问和测试的内容。
- 不把 Cookie、Token、Authorization、设备标识或私有路径提交到仓库。
- 登录墙、缺失凭据、Cloudflare、滑块、DRM 和强风控属于停止条件。
- `heal --apply` 会修改文件，必须得到用户允许。
- `share` 会产生外部写操作，只有用户明确要求上传时执行。
- 分享前检查外部 `$.require()` 依赖和源码完整性。
- 不用伪造数据把失败阶段包装成通过。

## 版权与授权

本项目采用自定义的 [AIBOX DRPY Source Skill Source-Available License 1.0](LICENSE)，不是 MIT，也不是 OSI 认定的开源许可证。简要说明如下：

- 允许从本项目官方仓库或 Release 下载、安装和运行 Skill，用于个人、学习、学术研究及其他非商业用途。
- 允许为上述用途修改自己的本地副本，也允许保留必要的私人备份。
- 可以分享官方仓库或 Release 的原始链接；未经书面许可，不得镜像、转载、重新打包、公开分发原版或修改版。
- 未经书面许可，不得用于付费产品、付费服务、商业咨询、托管服务或其他营利活动。
- 使用 Skill 生成的 DS 源、分析、报告或补丁，不会仅因使用本 Skill 就自动归本项目作者所有；但直接复制或改编的项目代码仍受许可证约束。
- 随仓库分发的第三方代码继续适用各自许可证，本项目许可证不会覆盖或替换第三方许可证。

完整且具有优先效力的条款以 [LICENSE](LICENSE) 英文原文为准。商业授权、转载、再分发或其他额外许可请联系 [yunwuee@gmail.com](mailto:yunwuee@gmail.com)。

## 配置

默认不需要配置文件。需要自定义输出目录、OCR、云分享或桥接服务时：

~~~powershell
npm run init:config
~~~

该命令从 `config/aibox.config.example.json` 创建本地 `config/aibox.config.json`。本地配置已被 Git 忽略。

OCR、云分享和目标站点请求可能访问第三方网络服务，使用前应确认授权、隐私和服务条款。

## 更新与卸载

更新时下载新 Release，替换 Skill 目录后重新执行：

~~~powershell
npm ci --prefix "$env:USERPROFILE\.codex\skills\aibox-drpy-source"
~~~

卸载时删除 Codex Skills 目录中的 `aibox-drpy-source`，然后重新加载 Codex。

## 仓库结构

~~~text
.
├── AGENTS.md
├── README.md
├── LICENSE
├── THIRD_PARTY_NOTICES.md
└── aibox-drpy-source/
    ├── SKILL.md
    ├── agents/openai.yaml
    ├── assets/
    ├── config/
    ├── references/
    ├── scripts/
    ├── template/
    └── vendor/
~~~

## 开发与校验

~~~powershell
npm ci --prefix .\aibox-drpy-source
npm run validate:public --prefix .\aibox-drpy-source
npm test --prefix .\aibox-drpy-source
npm run package:zip --prefix .\aibox-drpy-source
~~~

公开校验会检查 frontmatter、元数据、Markdown 链接、JSON、UTF-8 BOM、本机绝对路径、疑似敏感值、未批准外部主机、运行产物和内置源目录。

## 参考与致谢

本项目重点参考：

- [hjdhnx/drpy-node-skill](https://github.com/hjdhnx/drpy-node-skill)：drpy-node Skill 工作流、证据分层和写源经验参考。
- [hjdhnx/drpy-node](https://github.com/hjdhnx/drpy-node)：drpy-node 规则语义、模板与运行时能力参考。
- [yunwuee/AIBOX-public](https://github.com/yunwuee/AIBOX-public)：AIBOX 公开版本、客户端发行与实际集成参考。
- [zyfun 写源文档](https://zy.catni.cn/zh-CN/)：T1-T4 数据源与跨平台播放器生态参考，包含[写源语法](https://zy.catni.cn/zh-CN/source/grammar.html)、[写源工具](https://zy.catni.cn/zh-CN/source/ide.html)、[静态筛选](https://zy.catni.cn/zh-CN/source/sift.html)、[数据爬虫](https://zy.catni.cn/zh-CN/source/spider.html)和[常见技巧](https://zy.catni.cn/zh-CN/source/skill.html)。
- [Hiram-Wong/zyfun](https://github.com/Hiram-Wong/zyfun)：zyfun 官方源码仓库，GitHub 标识许可证为 AGPL-3.0。
- [laugh0608/Radish](https://github.com/laugh0608/Radish)：本项目 Source-Available License 的条款结构参考。
- [brix/crypto-js](https://github.com/brix/crypto-js)：随 Skill 分发的第三方加密库。

完整版权与第三方许可证声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
