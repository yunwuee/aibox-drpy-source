# 写源质量检查清单

## 目录

1. 基础字段与语义
2. 页面、二级、搜索与 lazy
3. 漫画、小说、BT 专项
4. 动态域、验证码与保存

## 基础字段

- 是否有 `var rule = {}`
- 是否有 `类型`
- 是否有 `title`
- 是否有 `host`
- 是否明确 `searchable/filterable/quickSearch`
- 是否使用当前 Aibox 引擎真实存在的模板，并在展开模板继承后检查有效规则
- 是否存在重复的 `lazy`、`二级`、`搜索` 等对象键，导致前一个字段被静默覆盖
- 是否保持模板最小覆盖，避免无证据补入 headers、搜索地址和能力开关

## 字符串与函数语义

- `推荐: '*'`、`搜索: '*'` 是否按整体继承 `一级` 理解
- 字符串分号槽位中的 `*` 是否只继承 `一级` 对应槽位
- HTML 属性 fallback 是否使用 `img&&data-src||src`，而不是把 `||` 当两条完整选择器
- 二级字典 `tabs` 是否只定位节点，文字是否单独放在 `tab_text`
- 是否避免对 URL 形式的 `this.input` 直接 `JSON.parse`
- POST 是否按真实 Content-Type 使用 `body` 或 `data`；不要把 Aibox 支持的 `data` 一律判错

## 页面函数

- `推荐` 是否可运行
- `一级` 是否能出列表
- 漫画源是否把 `推荐` 与分类入口分开实现，而不是只有首页推荐没有 `class_parse/class_name/class_url`
- 漫画动态分类返回的 `class`、`filters` 是否能被 `一级` 的 `tid` 和筛选参数真实消费
- `二级` 是否能拿到详情
- `搜索` 是否能出结果
- `lazy` 是否能正确返回直链或解析链
- 小说 `一级` 如果函数内部有列表，但接口最终返回空，是否排查过返回格式和 runtime 兼容性

## 二级重点

- 是否有 `vod_name`
- 是否有 `vod_content`
- 是否有 `vod_play_from`
- 是否有 `vod_play_url`
- `vod_play_from` 与 `vod_play_url` 的 `$$$` 分组数量是否一致
- 每个目录项是否为 `标题$地址`，而不是只有标题没有章节地址
- 小说、漫画是否同时抽查过目录首章和末章
- 漫画目录是否处理了分组和分页，而不是只读取第一组或第一页
- 漫画正文同时需要作品 ID 与章节 ID 时，目录地址是否使用了可逆组合 ID

## 搜索重点

- 搜索参数名是否正确
- 搜索页结构是否单独处理
- 搜索结果是否返回 `title/pic_url/desc/url`

## lazy 重点

- 函数型或 `js:` lazy 是否显式声明 `play_parse: true`
- 需要保留 lazy 的 `parse/jx/url/header` 时是否显式声明 `play_json: []`
- 是否检查了 Aibox `playParseAfter` 后的最终响应，而不只看 lazy 内部对象
- 直链是否能识别
- 播放器脚本是否提取到真实链接
- 需要解析时是否返回 `{ parse: 1, url }`
- 磁力 / BT 源是否对 `magnet:` 和公开 `.torrent` 返回 `{ parse: 0, url }`
- 磁力 / BT 源是否避免在规则里调用 `/bt/resolve` 或自行做 BT 分片解析
- 漫画 `lazy` 是否返回合法 `pics://img1&&img2...`
- 漫画规则是否满足上述通用 `play_parse/play_json` 契约，避免 Android 引擎后处理丢失 `pics://`
- 漫画章节首图是否能在 `check --level l3 --engine auto` 中得到成功的图片探测结果

## 漫画图片重点

- 列表、分类、搜索、详情封面是否能真实解码，而不只是返回了 URL
- 如果远端图依赖 `Referer` / `User-Agent`，是否确认规则 `headers` 足够；仍不可读时是否统一走 `proxy_rule`
- 如果海阔源或接口里出现 AES 解密逻辑，是否把解密移植到 Aibox 源
- `proxy_rule` 是否对普通 JPG/PNG/WEBP 原样返回，只对非图片文件头尝试解密
- `proxy_rule` 返回二进制图片时是否使用 `[200, mediaType, base64, headers, 1]`
- L3 报告里的 `imageProbe.imageKind` / `firstImageProbe.imageKind` 是否是 `jpeg/png/webp/gif/avif/svg`
- 原生 L3 的 `probes.covers` 是否显示推荐、分类、详情、搜索封面均通过；分类和详情是否未被 `allowEmpty` 绕过
- `comic_chapter_first` 与 `comic_chapter_last` 是否都通过，章节首图和末图是否能真实解码
- 是否检查过 App / Android 引擎处理后的最终播放响应仍为 `parse: 0` 且 `url` 以 `pics://` 开头，而不只是检查 `lazy` 内部原始返回值
- 如果 `contentType` 是 `image/*` 但 `imageKind` 为空，是否排查了加密、切片或防盗链错误页

## 小说正文重点

- `novel://` 后是否直接拼接原始 `JSON.stringify({ title, content })`
- 是否避免对 `novel://` JSON 使用 `encodeURIComponent`
- `novel_catalog` 是否能解析出有效线路和章节地址
- `novel_chapter_first` 与 `novel_chapter_last` 是否都返回非空正文
- lazy 返回 HTTP 正文地址时，是否确认 App 不附加源内私有请求头也能取到正文

## 保存前建议

- 最好至少抓一次详情页和播放页再保存
- 最好对比一个相似站点规则，确认字段命名一致
- 如果站点经常变结构，优先保留更稳的选择器或字段路径
- App API 漫画源的设备信息是否通过 `getItem/setItem` 持久化，避免每次请求随机变化
- 动态 API 域是否有发现、缓存、失效刷新和备用链路，而不是长期写死一次抓到的域名
- 主 API 失败时是否按需要保留网页详情、网页目录或内嵌加密数据回退
- 如果分类页天然无图，是否避免在源侧批量补详情封面导致接口变慢或超时
- 是否至少对真实 `/api/{module}` 最终响应做过一次验证，而不只是局部 helper
- 云分享或覆盖设备源后，是否核对云端回读、本地文件和设备实际文件的字节数、末尾内容与 SHA-256

## 磁力 / BT 补充检查

- `vod_play_url` 是否包含完整 `magnet:?xt=urn:btih:`，并保留 tracker 参数
- 如果使用 `.torrent`，是否确认该链接公开可直连，不依赖 Cookie / Referer / 登录态
- 集数标题是否清理到主要部分，例如 `[01][1080P][简繁内封]`
- 集数标题是否保留 `S01E11`、`s011`、`EP11`、`第11话` 等标记
- 集数标题中是否替换了 `#` 和 `$`
- 搜索结果是否进入详情页后再展开磁力列表，避免搜索阶段一次性请求大量 BT 详情
- 是否明确区分源侧职责和 App 侧职责：源返回 BT URL，Aibox 本地 Go BT 引擎负责播放流、下载 URL、预缓冲和状态

## 动态域名 / 发布页检查

- 如果入口是发布页、备用网址页、Loading 壳、静态桶页面或旧域 404，是否读取并套用了 `dynamic-host-playbook`
- 是否同时解析发布页 HTML 和外链脚本里的候选业务域
- 如果发布页脚本使用 `document.write`，是否用最小沙箱只收集输出，而不是依赖完整浏览器环境
- 是否过滤了发布页域、静态桶域、图片/CSS/JS 资源域和统计域
- 是否保留兜底业务域，避免发布页临时不可用时全源失效
- 是否按页面类型分别写了 validator：列表页、详情页、搜索接口、播放页
- 是否成功后缓存当前业务域，失败后刷新候选并自动换下一个
- 是否避免把发布页域当作详情链接、图片链接和播放页链接的补全根
- 搜索接口是否先判断坏页/验证码页，再做 `JSON.parse`

## 验证码 / 反爬补充检查
- 如果首页、分类、详情或搜索页出现验证码 / 安全验证，是否避免继续裸用 `request(input)`
- HTML 规则是否优先改成 `getHtml + verifyCode + setItem(RULE_CK)` 的重试链路
- JSON / API 规则是否先做验证码检测，再 `JSON.parse`
- 是否明确补充了 `搜索验证标识`
- 是否在 `doctor` 和 L2/L3 检查里看过 OCR 状态
- 如有真实验证码样本，是否跑过 `doctor --ocr-image-file <图片>` 验证当前 `OcrApi.classification` 能返回文本
