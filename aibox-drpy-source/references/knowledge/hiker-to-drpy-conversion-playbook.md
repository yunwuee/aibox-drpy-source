# 海阔源转换为 Aibox ds 源 Playbook

## 适用场景

当用户给出以下任一信息时，按本流程处理：

- 海阔规则标题，例如 `示例视频规则`、`示例漫画规则`
- 海阔 Web 编辑链接，例如 `http://127.0.0.1:52020/ruleEdit#/?rule=示例漫画规则`
- 明确要求“把海阔源转换成 Aibox 源 / ds 源”

目标不是把海阔 UI 代码逐行翻译成 ds 源，而是从海阔规则中还原真实数据链路，再用 Aibox 的 `var rule = {}` 格式重写。

## 1. 从 ruleEdit 链接读取海阔规则

`ruleEdit#/?rule=...` 链接中的 host 和端口就是海阔 Web 编辑服务地址，`rule` 参数就是规则标题。读取时优先使用当前环境中已有且受信任的海阔规则客户端；本 skill 不内置该客户端。没有读取工具时，让用户导出规则 JSON，不要猜测内容。

```powershell
node path/to/hiker-rule-client.mjs --action ping --rule-edit-url "http://127.0.0.1:52020/ruleEdit#/?rule=示例漫画规则"
```

```powershell
node path/to/hiker-rule-client.mjs --action get-rule --rule-edit-url "http://127.0.0.1:52020/ruleEdit#/?rule=示例漫画规则"
```

URL 编码后的标题也必须支持：

```powershell
node path/to/hiker-rule-client.mjs --action get-rule --rule-edit-url "http://127.0.0.1:52020/ruleEdit#/?rule=example-rule"
```

如果用户只给 IP 和标题，保留旧用法：

```powershell
node path/to/hiker-rule-client.mjs --ip 127.0.0.1 --action get-rule --title 示例漫画规则
```

读取结果通常是一个海阔规则 JSON，重点看 `title`、`type`、`group`、`icon`、`url`、`search_url`、`find_rule`、`detail_find_rule`、`pageList`。

## 2. 先拆海阔字段，不急着写 ds 源

先从海阔规则整理这些事实：

- 站点名称：`title`
- 内容类型：`type`，常见为 `video`、`cartoon`、`read`
- 入口地址：`url`，去掉 `hiker://empty##`、`##fypage` 等海阔包装后得到真实分类页
- 搜索地址：`search_url`，把 `**` 和 `fypage` 映射到 ds 的 `searchUrl`
- 分类逻辑：`class_name/class_url` 或 `pageList` 中的动态分类页
- 详情逻辑：`detail_find_rule` 或 `pageList` 中名为 `二级`、`详情`、`ej` 的规则
- 播放逻辑：`lazyRule`、`pageList` 中名为 `lazy`、`解析` 的规则
- 验证逻辑：是否有验证码、登录、人机验证、Cookie 保存、`fetchCookie`、`OcrApi`、`verify` 等

海阔规则里的 `d.push`、滚动按钮、折叠状态、`getMyVar/putMyVar` 多数是 UI 状态，不要直接迁移。Aibox ds 源只需要稳定输出列表、详情、搜索和播放。

## 3. 字段映射原则

常见映射如下：

```text
海阔 title        -> rule.title
海阔 type/group   -> rule.类型、分享 category/groupTag
海阔 icon         -> 可选保留为注释或图片兜底，不是 ds 必填
海阔 url          -> rule.host + rule.url，或作为分类接口 referer
海阔 search_url   -> rule.searchUrl，必要时改用更稳定的 suggest/API 搜索
海阔 find_rule    -> rule.推荐 / rule.一级
海阔 detail_find_rule 或 二级页 -> rule.二级
海阔 lazyRule 或 解析页       -> rule.lazy
海阔动态分类                 -> rule.class_name/class_url/filter/filter_def
```

如果海阔 `url` 是 `hiker://empty##https://example.com/show/1.html##fypage`，真实入口是 `https://example.com/show/1.html`。`host` 取 `https://example.com`，分类页可以写成 `/show/fyclass/page/fypage.html`，也可以绕过 HTML 直接写接口。

## 4. 转换实现策略

### 列表页

优先判断海阔一级规则是否请求 JSON/API：

- 出现 `post(...)`、`fetch(... { method: 'POST' })`、`JSON.parse(...)` 时，优先复刻接口。
- 出现 `pdfa/html` 卡片选择器时，再写 HTML 抽取。
- 动态筛选不要照抄海阔按钮 UI，要整理成 ds 的 `filter` 数组。

Aibox 列表输出只需要：

```js
{
  title: '名称',
  pic_url: '封面',
  desc: '备注',
  content: '简介',
  url: '详情页或详情 id'
}
```

### 详情页

详情页要产出标准 vod 对象：

```js
{
  vod_id,
  vod_name,
  vod_pic,
  type_name,
  vod_remarks,
  vod_year,
  vod_area,
  vod_actor,
  vod_director,
  vod_content,
  vod_play_from,
  vod_play_url
}
```

海阔的线路 tab 和选集列表通常在 `pageList` 的 `二级` 规则中。将它们转换为：

```text
vod_play_from = 线路1$$$线路2
vod_play_url = 第1集$url1#第2集$url2$$$第1集$url3
```

### 搜索

不要强制照搬海阔 HTML 搜索页。很多站点的搜索页会 500、空白或需要额外状态，但 suggest 接口稳定。优先实测：

- `/index.php/ajax/suggest?mid=1&wd=**&limit=50`
- 站点自带搜索 JSON 接口
- 海阔规则中的 `search_url`

只要能映射到详情页，就可以用更稳定的接口替代原搜索页。

### 播放

播放转换优先级：

1. 播放页源码直接出现 `m3u8/mp4/flv`，直接 `parse: 0`。
2. 页面有 `player_aaaa` 或类似播放器对象，先按 `encrypt=1/2` 解码。
3. 解码后是直链，直接返回。
4. 解码后不是直链，读取播放器配置，例如 `static/js/playerconfig.js`。
5. 如果海阔 lazy 中有解析接口、AES、CryptoJS 逻辑，再按原逻辑移植。
6. 没有把握时先返回 `{ parse: 1, url }`，保证能交给外部解析。

### 漫画图片与解密

海阔漫画源经常把图片处理藏在 lazy、`imageDecrypt`、`getBytes`、`CryptoJS.AES.decrypt` 或 Java AES 代码里。转换时不要只复制章节 URL：

- 先确认章节图片是否能直接被浏览器和 App 解码。
- 如果海阔源对图片做 `AES/CBC/PKCS7Padding`，Aibox 源要实现等价的 `proxy_rule`，由代理拉二进制并解密后返回图片。
- 如果海阔源只是补 `Referer` / `User-Agent`，Aibox 源也建议用 `proxy_rule` 固化请求头，避免 App 图片组件裸请求失败。
- `lazy` 返回 `pics://` 时优先返回代理图：`pics://proxyImg1&&proxyImg2`。
- 首页、分类、搜索和详情里的封面图也可能要代理，不要只修章节页。

更完整的通用实现模式见：

```text
aibox://knowledge/comic-image-proxy-playbook
```

### 验证码和登录

如果海阔规则中有 `验证码`、`登录账号`、`fetchCookie`、`verify/index.html`、`Just a moment`、`DDoS防护`，转换时必须显式处理：

- 能用 drpy-node 内置 OCR 时，优先用 `getHtml`、`verifyCode`、`setItem(RULE_CK)`、`OcrApi`。
- API 返回 HTML 验证页时，不要直接 `JSON.parse`。
- 登录账号类规则如果没有账号来源，先保留清晰日志和空结果兜底，不伪造登录。

## 5. 示例视频规则案例摘要

海阔规则入口：

```text
hiker://empty##https://video.example.com/show/1.html##fypage
```

转换结论：

- `host`: `https://video.example.com`
- 分类：`连载新番&完结旧番&剧场版&美漫`
- 一级接口：`POST /index.php/ds_api/vod`
- 详情页：`/bangumi/{id}.html`
- 播放页：`/watch/{id}/{sid}/{nid}.html`
- 搜索接口：`/index.php/ajax/suggest?mid=1&wd=**&limit=50`
- 播放对象：`player_aaaa`
- 播放直链：样本为 `mp4`，可直接 `parse: 0`
- 非直链兜底：读取 `/static/js/playerconfig.js`，再按海阔原 lazy 的解析接口和 AES 逻辑处理

这类站点的关键经验是：海阔页面里有复杂动态分类 UI，但 Aibox 源可以直接走 `ds_api/vod`，把复杂 UI 状态压缩成 `filter`。

## 6. 推荐验收命令

转换完成后必须先做静态校验：

```powershell
node .\scripts\aibox-skill-cli.mjs lint --code-file .\output\目标源.js
```

有条件时跑完整实测：

```powershell
node .\scripts\aibox-skill-cli.mjs check --code-file .\output\目标源.js --level l3 --engine auto
```

需要分享给 App 时上传云剪切板：

```powershell
node .\scripts\aibox-skill-cli.mjs share --code-file .\output\目标源.js --name 源名称 --category video --group-tag 动漫
```

## 7. 交付标准

完成海阔转 Aibox 源时，最终答复应说明：

- 海阔规则读取方式：`ruleEdit` 链接或 `--ip + --title`
- 真实业务域和核心接口
- 转换后的源文件路径
- `lint` 和 `check --level l3` 结果
- 如果上传了云剪切板，给出完整 `云1` 分享码
