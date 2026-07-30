# aibox-drpy-source

面向 Aibox 内置 drpy-node 引擎的公开 Codex/Agent Skill，用于生成、修复、分析、校验和验收影视、小说、漫画及磁力/BT DS 源。

- 作者与维护者：[yunwuee](https://github.com/yunwuee)
- AIBOX：[yunwuee/AIBOX](https://github.com/yunwuee/AIBOX)
- 许可证：MIT
- 当前定位：0.1.0 初始公开版

## 无内置源

本仓库不分发任何可直接导入的站点源、用户源、抓取结果或云分享数据。

aibox-drpy-source/template/ds_template.js 只是使用 example.com 的空白骨架；assets/compose-rule.*.example.json 只是生成器和测试使用的结构化输入，不是可用站点源。技能生成的规则应写到用户明确指定的工作目录或本地 output/，不会回写为仓库内置源。

仓库持续排除：

- node_modules/
- output/、temp/、抓取缓存和日志
- config/aibox.config.json 本地配置
- assets/examples/ 成品规则示例目录
- 真实 Cookie、Token、Authorization 和用户私有路径

## 目录

~~~text
.
├── README.md
├── LICENSE
├── THIRD_PARTY_NOTICES.md
└── aibox-drpy-source/
    ├── SKILL.md
    ├── agents/openai.yaml
    ├── assets/                 # 生成器规格与能力矩阵，不含成品源
    ├── config/                 # 无凭据的示例配置
    ├── references/             # 按需读取的通用知识
    ├── scripts/                # CLI、校验器与测试
    ├── template/               # 空白 DS 骨架
    └── vendor/                 # 便携运行时必需代码及许可证
~~~

## 安装

要求 Node.js >= 20.18.1。PowerShell 仅用于可选的 zip 打包。

### Codex

~~~powershell
git clone https://github.com/yunwuee/aibox-drpy-source.git
Copy-Item .\aibox-drpy-source\aibox-drpy-source "$env:USERPROFILE\.codex\skills\aibox-drpy-source" -Recurse
npm ci --prefix "$env:USERPROFILE\.codex\skills\aibox-drpy-source"
~~~

macOS/Linux：

~~~bash
git clone https://github.com/yunwuee/aibox-drpy-source.git
cp -R aibox-drpy-source/aibox-drpy-source ~/.codex/skills/aibox-drpy-source
npm ci --prefix ~/.codex/skills/aibox-drpy-source
~~~

安装完成后重启 Codex，并使用 $aibox-drpy-source。

### 其他 Agent

把 aibox-drpy-source/ 复制到目标 Agent 的 skills 目录，然后在该目录执行 npm ci。目标环境需要支持标准 SKILL.md frontmatter；CLI 本身不依赖 Codex 专用 API。

## 快速检查

~~~powershell
node .\aibox-drpy-source\scripts\aibox-skill-cli.mjs help
node .\aibox-drpy-source\scripts\aibox-skill-cli.mjs resources list
npm test --prefix .\aibox-drpy-source
npm run validate:public --prefix .\aibox-drpy-source
~~~

CLI 的主流程为：

~~~text
resources -> doctor -> triage -> templates/resolved -> compose -> lint -> check -> heal -> save/share
~~~

lint 只提供 L1 静态证据；站点可用性必须继续完成 L2 单接口和 L3 真实链路验证。涉及 Aibox 真机差异时，以目标 AIBOX 版本的实际引擎和设备响应为最终依据。

## 配置与外部服务

默认无需本地配置。需要覆盖输出目录、OCR、浏览器桥接或搜索桥接时，从 config/aibox.config.example.json 创建本地 config/aibox.config.json；后者已被忽略。

只有显式执行 share 才会调用云剪切板服务。OCR、云分享及目标站点请求均可能访问第三方网络服务，使用前应确认授权、隐私和服务条款。登录墙、Cloudflare、滑块、DRM 或缺失凭据属于停止条件，不应通过写死敏感信息绕过。

## 开发与发行

~~~powershell
npm ci --prefix .\aibox-drpy-source
npm run validate:public --prefix .\aibox-drpy-source
npm test --prefix .\aibox-drpy-source
npm run package:zip --prefix .\aibox-drpy-source
~~~

公开校验会检查 frontmatter、引用链接、JSON、UTF-8 BOM、绝对路径、敏感字段、运行产物和内置源目录。GitHub Actions 在 Windows 与 Linux 上执行校验和测试。

## 参考与致谢

本项目重点参考了 [hjdhnx/drpy-node-skill](https://github.com/hjdhnx/drpy-node-skill)，并以 [hjdhnx/drpy-node](https://github.com/hjdhnx/drpy-node) 与 [yunwuee/AIBOX](https://github.com/yunwuee/AIBOX) 的实际语义为依据。完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
