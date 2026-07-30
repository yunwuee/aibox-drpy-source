# 影视、小说、漫画运行时契约与验收

## 目录

1. 总体原则
2. 详情目录契约
3. 小说正文契约
4. 漫画图片契约
5. 分类型 L3 检查
6. 常见失败定位

## 1. 总体原则

- 以 App 内置 `third_party/aibox-engine` 的 `/api/:module` 返回结构和 Flutter 阅读器实际解析行为为准。
- L1 负责解密、语法、AST、模板展开与明显协议错误；L2/L3 使用原生 Aibox 引擎真实执行首页、分类、详情、目录和内容。
- 不要用“详情接口返回了对象”代替“App 能显示目录并打开章节”的验证。
- 小说和漫画必须验证详情目录，再验证至少首章；完整验收同时抽查末章，防止分页目录、倒序目录或末尾章节结构不同。

## 2. 详情目录契约

App 使用以下分隔符解析 `vod_play_from` 与 `vod_play_url`：

```text
线路分组: $$$
章节分隔: #
标题/地址: $
```

单线路示例：

```javascript
vod_play_from: '正文',
vod_play_url: '第一章$/chapter/1#第二章$/chapter/2'
```

多线路示例：

```javascript
vod_play_from: '主线$$$备用',
vod_play_url: '第一章$/a/1#第二章$/a/2$$$第一章$/b/1'
```

硬性要求：

- `vod_play_from` 和 `vod_play_url` 的 `$$$` 分组数量必须一致。
- 每章必须包含 `$`，且 `$` 后必须有章节地址；只有章节名没有地址时，App 会生成空 `Episode.url`。
- 章节标题和地址中不要写未经处理的 `#`；标题中如有 `$` 也应先替换，App 使用第一个 `$` 切分。
- 小说、漫画详情没有有效目录时，L3 应判定失败，而不是只给空列表警告。

## 3. 小说正文契约

推荐格式：

```javascript
play_parse: true,
play_json: [],

return {
  parse: 0,
  url: 'novel://' + JSON.stringify({
    title: chapterTitle,
    content: chapterContent
  })
};
```

不要这样写：

```javascript
url: 'novel://' + encodeURIComponent(JSON.stringify({ title, content }))
```

Aibox 阅读器会直接截取 `novel://` 后的字符串并执行 `jsonDecode`，不会先执行 `decodeURIComponent`。错误编码会让 `%7B%22...` 被当作正文显示。

兼容格式：

- `novel://` + 原始 JSON：首选。
- `novel://` + 纯文本：阅读器 JSON 解析失败后会回退为纯文本。
- `http://` / `https://` 正文地址：阅读器会再请求正文；不要依赖只有源侧才知道的请求头。
- 非 HTTP 的纯文本：阅读器会直接显示，但不适合返回章节 id 或待解析标识。

L3 对小说执行：

- 审查详情目录线路数和章节数。
- 调用首章 `lazy` 并验证正文非空。
- 调用末章 `lazy` 并验证正文非空。
- 明确拦截经过 `encodeURIComponent` 的 `novel://` JSON。
- 正文少于 20 字符时给出警告，正文为空或协议不可解析时判定失败。

小说使用函数型或 `js:` lazy 时同样遵守通用播放契约：显式 `play_parse: true` 让引擎使用 lazy 结果，`play_json: []` 保留 `parse/url/header`，不能把它们误写成漫画专属字段。

## 4. 漫画图片契约

推荐格式：

```javascript
play_parse: true,
play_json: [],

return {
  parse: 0,
  url: 'pics://' + images.join('&&'),
  header: rule.headers
};
```

App 阅读器兼容以下图片列表：

- `pics://img1&&img2`
- `img1|||img2`
- 每行一个图片 URL
- JSON 字符串数组
- 单个 `http://`、`https://` 或 `//` 图片地址

对任何函数型或 `js:` lazy，`play_parse: true` 和显式空数组 `play_json: []` 都是通用运行时契约。漫画更容易暴露问题，因为一旦 `playParseAfter` 退回章节地址或覆盖为 `parse: 1`，阅读器会完全拿不到 `pics://`。因此验收必须检查引擎最终响应，而不只是 `lazy` 函数内部对象。

完整验收不能只检查字符串里有图片 URL，还必须请求图片并检查文件头。有效类型包括 JPEG、PNG、WEBP、GIF、AVIF 和 SVG。

如果图片需要 `Referer`、`User-Agent`、Cookie、AES 解密或防盗链处理：

- 在 `lazy.header` 返回阅读器请求图片所需的头。
- 远端仍无法直接解码时使用 `proxy_rule`。
- `proxy_rule` 返回二进制图片时使用 `[200, mediaType, base64, headers, 1]`。
- 不要只相信远端 `Content-Type: image/*`；文件头不是图片时仍应判定失败。

L3 对漫画执行：

- 审查详情目录线路数和章节数。
- 探测首页、分类、详情、搜索首个封面。
- 调用首章和末章 `lazy`。
- 确认引擎后处理后的章节响应仍为 `parse: 0` 且 URL 以 `pics://` 开头。
- 对每个抽查章节探测首图和末图文件头。
- 记录图片是否走 runtime `/proxy/`，方便判断 `proxy_rule` 是否真正生效。

分类和详情封面必须存在且能识别真实文件头；`allowEmpty` 不能绕过。推荐和搜索只有在能力启用但结果确实为空时，才可分别用 `allowEmpty=homevod,search` 跳过；非空结果中的空封面或伪图片仍失败。直连封面使用规则 `headers` 探测，代理封面在同一原生引擎会话内执行 `proxy_rule`。

## 5. 分类型 L3 检查

### 影视

```text
首页 -> 分类 -> 筛选 -> 详情 -> 搜索 -> 首集播放
```

检查播放直链、BT 链接或 `parse=1` 解析结果。函数型 lazy 要确认最终响应保留预期的 `parse/jx/url/header`；`parse=1` 是否成功必须结合实际解析或播放结果判断。

### 小说

```text
首页 -> 分类 -> 筛选 -> 详情 -> 小说目录 -> 搜索 -> 首章正文 -> 末章正文
```

最终报告应包含 `novel_catalog`、`novel_chapter_first`、`novel_chapter_last`。

### 漫画

```text
首页 -> 分类 -> 筛选 -> 详情 -> 漫画目录 -> 搜索 -> 封面探测 -> 首章图片 -> 末章图片
```

最终报告应包含 `comic_catalog`、`comic_chapter_first`、`comic_chapter_last`，章节步骤中应包含图片数量与文件头类型。

## 6. 常见失败定位

### 首页、分类都为空

优先判断站点不可达、动态域名失效、验证码或接口结构变化。此时无法推导详情 id，不应归因于章节解析器。

### 详情有书名，但目录为 0

检查 `vod_play_from`、`vod_play_url`、`$$$` 分组数量、章节 `$` 地址和详情页目录分页接口。

### 小说返回成功但正文显示 `%7B%22`

删除 `encodeURIComponent`，直接拼接 `JSON.stringify`。

### 漫画有 `pics://` 但图片不可解码

查看 `firstImageProbe` / `lastImageProbe` 的 `httpStatus`、`contentType`、`headHex`、`diagnosis` 和 `isProxy`，再判断是防盗链、错误页、加密图片还是代理未生效。

### `lazy` 返回 `parse: 0`，日志最终却是 `parse: 1`

对影视、小说、漫画和 BT 都先检查规则是否显式包含 `play_parse: true` 和 `play_json: []`，再通过 App 实际 `/api/{module}` 响应复测。若本地正常但设备仍异常，核对设备实际源文件和模块缓存；漫画完整流程详见 `comic-source-development-playbook.md`。

### 首章正常、末章失败

重点检查目录分页、倒序、VIP 章节、末尾章节地址格式和不同章节域名，不要只保留首章测试结果。
