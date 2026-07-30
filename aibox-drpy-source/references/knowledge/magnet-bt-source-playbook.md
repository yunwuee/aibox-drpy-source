# 磁力 / BT 写源与 Aibox 本地播放下载对接手册

## 目标

这篇文档沉淀 Aibox 这次新增的磁力播放与下载链路，专门服务于蜜柑、Nyaa、动漫种子索引、资源发布页这类站点。

核心结论：

- drpy 源只负责稳定抽取 `magnet:` 或公开可直连的 `.torrent` 地址。
- 源里不要实现 BT 协议，不要用 JS 下载分片，不要把 magnet 交给网页嗅探。
- Aibox App 会在播放阶段识别 `magnet:` / `.torrent`，交给本地 Go BT 引擎解析成 HTTP Range 流。
- 下载阶段复用同一个解析结果，优先使用 `/bt/download/:taskId/:fileIndex` 保存到本地。

## 当前 Aibox BT 架构

Aibox 现在有两套 BT 相关实现：

- 旧 Node WebTorrent fallback：`third_party/aibox-engine/controllers/bt.js`
- 新默认本地 Go 引擎：`third_party/aibox-bt-engine`

写源时按新 Go 引擎理解：

- Flutter 通过 `BtEngineService` 启动本地服务，桌面是 sidecar，可执行文件为 `aibox-bt-engine`。
- 移动端通过 `gomobile` 绑定，MethodChannel 为 `com.aibox.aibox/bt_engine`。
- `BtApiClient` 调用本地服务的 `/bt/resolve`、`/bt/status/:taskId`、`/bt/remove/:taskId`。
- `VideoPlayService.resolvePlayUrl` 和 `resolveExternalUrl` 都会先判断 `VideoPlayService.isBtLink(url)`。
- 只要 `lazy` 返回的 `url` 是 `magnet:` 或 HTTP `.torrent`，播放器会走 BT 引擎，而不是普通嗅探。

Go 引擎接口：

```text
POST /bt/resolve
GET  /bt/status/:taskId
GET  /bt/stream/:taskId/:fileIndex
GET  /bt/download/:taskId/:fileIndex
POST /bt/remove/:taskId?deleteFiles=1
DELETE /bt/remove/:taskId?deleteFiles=1
```

`/bt/resolve` 入参：

```json
{
  "url": "magnet:?xt=urn:btih:...",
  "fileIndex": 0,
  "preloadBytes": 16777216
}
```

`/bt/resolve` 关键返回字段：

```json
{
  "ok": true,
  "taskId": "infohash",
  "metadataReady": true,
  "readyToPlay": true,
  "preloadedBytes": 4194304,
  "minPreloadBytes": 4194304,
  "files": [],
  "fileIndex": 0,
  "fileName": "video.mkv",
  "fileExt": "mkv",
  "mimeType": "video/x-matroska",
  "streamUrl": "http://127.0.0.1:port/bt/stream/infohash/0",
  "downloadUrl": "http://127.0.0.1:port/bt/download/infohash/0",
  "statusUrl": "http://127.0.0.1:port/bt/status/infohash"
}
```

## 写源职责边界

磁力站源应该做到：

- `类型: '影视'`
- 使用函数型 `lazy` 时显式声明 `play_parse: true` 和 `play_json: []`，并对 BT 直返 `{ parse: 0, url }`
- `二级` 输出 `vod_play_from` 和 `vod_play_url`
- 每个播放项形如 `集数标题$magnet:?xt=urn:btih:...`
- 保留 magnet 自带 `tr` tracker 参数，不要为了短而截断
- 搜索正常实现，结果进入详情页后再列出磁力资源
- 分类可以按站点实际结构映射，比如最近更新、周一、周二、周三、周四、周五、周六、周日

磁力站源不应该做：

- 不要在 `lazy` 里自己调用 `/bt/resolve`
- 不要继续走 Node `/bt/resolve` 旧基地址
- 不要把 magnet 包成解析 URL 或网页 URL
- 不要把 magnet 丢给嗅探工具
- 不要在源里解析 torrent 文件列表并自行选文件
- 不要对私有 tracker 或需要登录的 `.torrent` 盲目追加公共 tracker

## lazy 推荐写法

最小稳定写法：

```javascript
play_parse: true,
play_json: [],

lazy: async function (flag, id) {
  const url = String(id || '').trim();
  const lower = url.toLowerCase();
  if (lower.startsWith('magnet:') ||
      lower.endsWith('.torrent') ||
      lower.includes('.torrent?') ||
      lower.includes('.torrent&')) {
    return { parse: 0, url };
  }
  return { parse: 1, url };
}
```

如果站点详情已经直接把 magnet 放进 `vod_play_url`，这里不需要做任何额外网络请求。播放器会自动调用本地 Go 引擎。

## 二级播放列表组织

磁力站经常一部番有很多发布组、清晰度、字幕版本。建议把线路按资源类型分组，不要所有内容塞进一个巨长线路。

常见分组：

- `磁力`
- `1080P`
- `720P`
- `简繁`
- `字幕组名`

如果站点只有一个资源列表，可以统一：

```javascript
vod.vod_play_from = '磁力';
vod.vod_play_url = episodes.join('#');
```

其中 `episodes` 是：

```javascript
[
  '[01][1080P][简繁内封]$magnet:?xt=urn:btih:...',
  '[02][1080P][简繁内封]$magnet:?xt=urn:btih:...'
]
```

多线路：

```javascript
vod.vod_play_from = tabs.join('$$$');
vod.vod_play_url = playGroups.map(group => group.join('#')).join('$$$');
```

注意：

- `#` 是 drpy 集数分隔符，`$$$` 是线路分隔符。
- 标题里如果出现 `#` 或 `$`，要替换为空格或全角符号，避免破坏 `vod_play_url`。
- magnet URL 本身通常不会包含未编码的 `#`，但可能包含很多 `&tr=`，必须完整保留。

## 集数标题清理

磁力站的标题往往很长，例如：

```text
[桜都字幕组] JOJO的奇妙冒险：飙马野郎 / Steel Ball Run: JoJo no Kimyou na Bouken [01][1080P][简繁内封]
```

详情页和播放器集数列表里建议只保留主要集数尾部：

```text
[01][1080P][简繁内封]
```

推荐清理策略：

1. 优先识别标题尾部连续标签：`[01][1080P][简繁内封]`。
2. 如果有 `S01E11`、`s011`、`EP11`、`E11`、`第11集`、`第11话`，从该集数标记开始保留到结尾。
3. 如果没有集数标记，保留清晰度和字幕信息，不要返回空。
4. 清理后仍要去掉 `#` 和 `$`。

可复用 helper：

```javascript
function cleanBtEpisodeTitle(raw, fallback) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback || 'BT 文件';

  const tailTags = text.match(/((?:\[[^\]]{1,40}\]\s*){2,})$/);
  if (tailTags) return safeEpisodeName(tailTags[1]);

  const markers = [
    /S\d{1,2}E\d{1,3}[\s\S]*$/i,
    /s\d{2,4}[\s\S]*$/i,
    /(?:EP?|第)\s*0?\d{1,3}\s*(?:集|话|話)?[\s\S]*$/i,
    /\[\s*0?\d{1,3}\s*\][\s\S]*$/i
  ];
  for (const pattern of markers) {
    const match = text.match(pattern);
    if (match && match[0]) return safeEpisodeName(match[0]);
  }

  return safeEpisodeName(text);
}

function safeEpisodeName(value) {
  return String(value || '')
    .replace(/[#\$]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'BT 文件';
}
```

## magnet 提取与归一化

常见页面形态：

- `<a href="magnet:?xt=urn:btih:...">`
- `<a data-clipboard-text="magnet:?xt=urn:btih:...">`
- JS 里写了 magnet 字符串
- 只有 `.torrent` 下载链接

建议优先级：

1. 先抓 `href` 和 `data-clipboard-text` 中的 `magnet:`
2. 再从页面文本中正则提取 `magnet:?xt=urn:btih:` 到空白或引号结束
3. 最后才使用 `.torrent` HTTP 链接

可复用 helper：

```javascript
function normalizeBtUrl(raw, baseUrl) {
  let url = String(raw || '').replace(/&amp;/g, '&').trim();
  if (!url) return '';
  if (url.startsWith('magnet:')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, baseUrl || rule.host).toString();
  } catch (e) {
    return url;
  }
}

function isBtUrl(url) {
  const lower = String(url || '').trim().toLowerCase();
  return lower.startsWith('magnet:') ||
    lower.endsWith('.torrent') ||
    lower.includes('.torrent?') ||
    lower.includes('.torrent&');
}
```

如果 `.torrent` 链接必须带 Cookie、Referer 或登录态，当前 Go 引擎的 `torrentReader` 不会自动继承 drpy `lazy` 的 headers。遇到这种站点优先找页面里的 magnet。只有公开可直连的 `.torrent` 才适合作为播放 URL。

## 分类与搜索建议

动漫 BT 站点常见分类：

- 最近更新
- 周一
- 周二
- 周三
- 周四
- 周五
- 周六
- 周日

示例：

```javascript
class_name: '最近更新&周一&周二&周三&周四&周五&周六&周日',
class_url: 'latest&monday&tuesday&wednesday&thursday&friday&saturday&sunday',
```

分类实现要按站点实际 URL 或接口映射。对于蜜柑这类站，首页经典页通常适合作为最近更新，周期页或番组表适合作为周一到周日。

搜索建议：

- 搜索结果返回番组详情，不要直接返回单条 magnet，除非站点没有详情页。
- 结果 `desc` 可以放更新状态、字幕组、年份、最近集数。
- `quickSearch` 可以设为 `1`，但要保证搜索轻量，避免一次搜索就展开所有 magnet。

## 下载对接

源不需要自己实现下载按钮。Aibox 的下载逻辑是：

1. 用户在详情页、播放器或嗅探工具中添加下载。
2. 下载任务保存用户手动填写的资源名称、集数、备注或文件名。
3. 下载服务调用 `VideoPlayService.resolvePlayUrl` 或 `resolveExternalUrl`。
4. 如果返回 BT 结果，优先使用 `downloadUrl`。
5. 下载队列把 `mediaType == bt`、`mediaType` 以 `bt:` 开头、原始 URL 是 magnet 或结果 URL 包含 `/bt/download/` 的任务归到 BT 下载 lane。
6. 并发、线程、预缓冲、DHT、PEX、uTP、TCP、追加 tracker、做种由设置中心的下载设置控制。

对写源的影响：

- `episodeName` 要尽量干净，因为它会作为用户下载命名的初始值。
- `vod_name` 要稳定，因为它会作为资源名称初始值。
- `lazy` 返回的 BT URL 不要改写成临时短链，否则下载任务重新解析时可能失效。

## 设置项记忆

设置中心有下载分区，默认值：

```text
普通视频: 3 任务 / 8 线程
BT: 2 任务 / 16 线程 / 16MB 预缓冲 / 60 秒元数据超时
漫画: 2 任务 / 8 图片线程
小说: 4 任务
DHT/PEX/uTP/TCP/追加 tracker: 开
做种: 关
```

BT 引擎级参数保存后需要重启本地 BT 引擎才完全影响新任务。普通视频、漫画、小说并发对新排队任务立即生效。

## 排错记忆

### `/bt/resolve` 404

这通常说明 Flutter 仍把 BT 请求打到了旧 Node `DrpyApiClient` 基地址，而不是新的 `BtApiClient` 本地 Go 引擎。修 App，不要在源里绕。

### `btResolve success` 但播放黑屏

先看 `readyToPlay`、`preloadedBytes`、`numPeers` 和 `downloadSpeed`。元数据成功只代表拿到了文件列表，不代表首段已经有足够数据。弱种或无 peer 需要提示用户等待或换源。

### WebTorrent `fetch failed`

这是旧 Node WebTorrent 路线的典型问题。当前默认应走 Go `anacrolix/torrent` 引擎。不要把这个错误当作源失效。

### `.torrent` 可点但 BT 引擎解析失败

检查 `.torrent` 是否需要登录、Cookie、Referer、防盗链或 Cloudflare。当前更推荐从页面找 magnet。私有种子不要追加公共 tracker。

### 文件选错

Go 引擎默认优先最大视频文件，扩展名包括：

```text
mp4/mkv/webm/flv/avi/mov/wmv/ts/m2ts/mpg/mpeg/m4v/3gp
```

如果源能识别具体文件或站点提供多个 magnet，优先把每个资源作为独立集数，避免一个多文件种子里混杂 PV、SP、字幕包导致默认选择不符合预期。

## 验收清单

写完磁力源后至少检查：

- `二级` 返回的 `vod_play_url` 中是否存在完整 `magnet:?xt=urn:btih:` 或公开 `.torrent`。
- `lazy` 对 magnet / `.torrent` 返回 `{ parse: 0, url }`。
- 标题清理后是否保留 `[01]`、`S01E11`、`s011`、`EP11`、`第11话` 这类集数标记。
- `vod_play_url` 标题中没有未转义的 `#` 或 `$`。
- 搜索结果能进入详情页，不在搜索阶段一次性请求大量 BT 详情。
- 嗅探工具能识别输入框中的 magnet 和页面命中的 `.torrent`。
- 播放器能显示 BT 状态，`readyToPlay` 后能播放。
- 下载入口会弹出手动命名框，并能把 BT 下载加入本地下载队列。

## 适合读取本文档的触发词

只要任务里出现下面任一信号，就先读本文：

- 磁力
- BT
- torrent
- `.torrent`
- magnet
- 蜜柑
- Mikan
- Nyaa
- 动漫种子
- 种子下载
- 本地 BT 播放
- 边下边播
