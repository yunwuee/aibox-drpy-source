---
name: aibox-drpy-source
description: 面向 Aibox 内置 drpy-node 引擎生成、修复、分析、调试、校验、真机验收和云分享 DS 源（var rule = {}）。当用户要求按网址编写影视、小说、漫画或磁力/BT 源，修复分类、详情、搜索、播放、正文、pics://、novel://、lazy、图片代理、动态域名、验证码、签名 App API，或要求完成 L1/L2/L3 验收时使用。
---

# Aibox DRPY 写源

## AI 启动协议

1. 将包含本文件的目录视为 `skill-root`，不要依赖固定安装路径或 AIBOX 主仓库目录。
2. 首次使用或 `package-lock.json` 变化后，在 `skill-root` 运行 `npm ci`。
3. 运行 `node <skill-root>/scripts/aibox-skill-cli.mjs help`，以当前 CLI 输出为准。
4. 运行 `resources list`，再按“任务路由”只读取当前任务需要的 reference。
5. 明确任务是新建、修复、分析还是验收，并确认目标网址、内容类型、已有源码、输出目录和允许的写操作。
6. 未指定输出目录时，把生成结果写到当前任务工作区的 `output/`。

## 发行边界

- 本 skill 不内置任何可导入站点源、用户源、抓取结果或云分享数据。
- template/ds_template.js 是 example.com 空白骨架；assets/compose-rule.*.example.json 是生成器测试规格，不代表可用源。
- 将新源和修复后的源写入用户明确指定的工作目录；未指定时写入当前任务工作区的 output/，不要写进 skill 的 assets、references、template 或 scripts。
- 不把 Cookie、Token、Authorization、设备标识、私有域名或绝对本机路径提交回 skill。
- 不将 scripts/tests 下的 fixture 当成候选源或交付物。

## 核心纪律

- 先取得页面或接口证据，再写规则；不要根据 URL 名称、日志片段或相似站点猜字段。
- 涉及 Aibox 最终行为时，以目标 AIBOX 版本的实际引擎代码和设备响应为语义真相；便携运行时用于开发验证，不替代真机结论。
- 始终选择能完成任务的最低复杂度实现，保留模板继承和已有有效逻辑，避免无证据重写。
- 使用真实 class_id -> vod_id -> play_url 或章节 ID 串联下游测试，不为通过测试伪造 ID。
- 默认交付单文件、自包含的 var rule = { ... }；分享前检查外部 $.require() 依赖。
- 只处理用户有权访问和测试的内容。遇到登录墙、缺失凭据、Cloudflare、滑块、DRM 或强风控时停止猜测并说明条件。

## 任务路由

只读取当前任务需要的 reference：

| 任务 | 必读 | 按症状追加 |
|---|---|---|
| 新建源 | [写源工作流](references/knowledge/source-writing-workflow.md)、[核心语法](references/knowledge/drpy-basic-format-grammar.md) | [规则手册](references/knowledge/drpy-rule-playbook.md)、[选择器速查](references/knowledge/selector-cheatsheet.md) |
| 修源 | [质量清单](references/knowledge/source-quality-checklist.md)、[核心语法](references/knowledge/drpy-basic-format-grammar.md) | 对应内容类型和故障手册 |
| 播放/正文 | [运行时契约](references/knowledge/content-type-runtime-validation.md) | [漫画开发](references/knowledge/comic-source-development-playbook.md)、[图片代理](references/knowledge/comic-image-proxy-playbook.md)、[App API 与切片](references/knowledge/comic-app-api-scramble-retrospective.md) |
| 特殊内容 | 对应专项手册 | [动态域](references/knowledge/dynamic-host-playbook.md)、[验证码 OCR](references/knowledge/captcha-ocr-playbook.md)、[磁力/BT](references/knowledge/magnet-bt-source-playbook.md)、[海阔转换](references/knowledge/hiker-to-drpy-conversion-playbook.md) |
| CLI/分享 | [命令示例](references/command-examples.md) | [能力映射](references/capability-map.md) |

漫画或 App API 任务必须读取漫画开发手册。涉及 WebP 切片、条带错位或真机图片乱序时，再读 App API 与切片、图片代理手册。小说和漫画完整验收必须读取运行时契约。

## 站型与实现阶梯

先判断 route 和 contentType：

- template：结构与目标 Aibox 运行时中的真实模板匹配。
- html：列表和详情主要来自静态 HTML。
- hybrid：HTML 与 API 混用，或仅个别阶段需要签名、POST、Cookie、解密。
- api：纯 JSON、App API 或 SPA，列表、详情、目录、正文分接口。
- 内容类型使用 video、novel、comic、bt。

按以下顺序选择最短实现，只有当前一级无法表达时才升级：

1. 模板继承，只覆盖站点差异。
2. 字符串规则或二级字典。
3. 字符串与函数混合。
4. 只把签名、POST、动态域、聚合或解密阶段改为 async。
5. 全 async，仅用于纯 API、SPA 或跨阶段状态复杂的站点。

不要假定模板名。先用 templates list、templates guess 或 resolved 读取当前引擎的真实模板；未知模板直接报错，禁止生成不存在的 appapi。

## 固定工作流

1. 读取目标源、用户日志和相关 reference；已有源先保留有效详情、目录、正文、播放与代理逻辑。
2. 抓首页、列表、真实分类、真实详情、搜索、播放或正文响应；记录 URL、method、headers、body、分页和 ID 来源。
3. 执行站型判断，标记签名、动态域、验证码、图片防盗链、分页目录和密文风险。
4. 选择最低实现阶梯，先写最小可运行版本，再添加证据证明必要的兼容逻辑。
5. 分别验证每个阶段，再用真实 ID 串成完整链路。
6. 通过所需 L1/L2/L3 后再保存或分享；修复既有源时递增 version。

## 核心契约

- 推荐: '*'、搜索: '*' 表示整体继承 一级；字符串规则某个分号槽位为 * 表示该槽继承 一级 对应槽位。
- HTML 属性回退写成同节点属性链，例如 img&&data-src||src；不要写成两个完整选择器 img&&data-src||img&&src。
- JSONPath 的 || 可表达候选路径；不要把 HTML 与 JSON 的 || 语义混为一谈。
- 二级字典的 tabs 只写线路节点选择器，线路文字写 tab_text；禁止 tabs: '.tab&&Text'。
- this.input 是当前阶段请求输入，不是响应正文。先 await request(this.input, options)，再解析返回值。
- 当前 Aibox request 同时接受 body 和 data；按目标站点 Content-Type 与实际引擎契约选择，不机械套用上游旧结论。
- 禁止重复对象键；后一个 lazy、二级等字段会静默覆盖前一个字段。
- 函数型或 js: lazy 显式声明 play_parse: true；需要保留 lazy 的 parse、jx、url、header 时声明 play_json: []。
- 小说返回 parse: 0 + novel://，漫画返回 parse: 0 + pics://，BT 返回原始 magnet 或公开 torrent；最终以 playParseAfter 后的接口响应为准。
- vod_play_from 与 vod_play_url 的 $$$ 分组数必须一致，每项使用 标题$地址，并清理标题中的 # 和 $。

## L1/L2/L3 验收

- L1 结构证据：读取或解密源码，做语法、AST、重复字段、header、模板展开、字符串契约和播放契约检查。L1 不等于站点可用。
- L2 单接口证据：分别真实请求首页、分类、详情、搜索、播放或正文，确认状态、结构和非空数据；记录不可用能力，不用假数据补齐。
- L3 链路证据：使用 L2 返回的真实 ID 串联首页/分类 -> 详情 -> 播放或章节；小说验证首末章正文，漫画验证首末章首尾图片文件头。

区分三类断点：规则本身失败、测试串联取错 ID、播放或正文后处理失败。只有任务必需阶段全部通过，才报告源可交付。

## 漫画与 App API

- 将链路拆成 list -> detail -> catalog -> reader 四阶段，各自保存 URL、请求方法、headers、body、分页、字段路径和 ID。
- 同一次请求生成并使用一致的时间戳、日期、设备 ID、路径和签名；确需持久化时使用 getItem/setItem，不提交真实设备值。
- 动态 API 域要发现、验证、缓存并在失败后刷新；列表成功不能证明详情、目录或正文域可用。
- 正文优先官方 API，再按证据回退网页目录、内嵌数据或解密链路；不要无条件吞错切换。
- 图片需验证真实文件头；防盗链、AES 或切片场景使用 proxy_rule，不要只相信 HTTP 200 或 Content-Type。
- WebP 纵向切片必须在 proxy_rule 内解码后重排。真机内置 libnode 不要依赖 sharp，优先选择已被目标 AIBOX 引擎实际打包并验证的实现。

## CLI 与交付

常用命令：

~~~text
node <skill-root>/scripts/aibox-skill-cli.mjs help
node <skill-root>/scripts/aibox-skill-cli.mjs resources list
node <skill-root>/scripts/aibox-skill-cli.mjs lint --code-file <source.js>
node <skill-root>/scripts/aibox-skill-cli.mjs check --code-file <source.js> --level l3
~~~

优先使用 doctor、triage、templates、resolved、compose、lint、check、heal、save、share、resources 和 debug-selector。runtime start/stop 只用于手动诊断。heal 默认只输出 diff，只有用户要求实施修复时才使用 --apply；share 是外部写操作，只有用户明确要求分享或上传时执行。

交付时说明站型、内容类型、实现阶梯、真实链路、L1/L2/L3 结果、动态域/验证码/代理处理和剩余风险。不要只贴代码，也不要把静态评分当成真机成功。

## 项目

- 维护者：[yunwuee](https://github.com/yunwuee)
- 授权联系：yunwuee@gmail.com
- 仓库：[yunwuee/aibox-drpy-source](https://github.com/yunwuee/aibox-drpy-source)
- 重点参考：[hjdhnx/drpy-node-skill](https://github.com/hjdhnx/drpy-node-skill)、[hjdhnx/drpy-node](https://github.com/hjdhnx/drpy-node)、[yunwuee/AIBOX](https://github.com/yunwuee/AIBOX)
