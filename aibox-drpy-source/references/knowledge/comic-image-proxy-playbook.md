# 漫画图片代理与解密经验

## 适用场景

写漫画源时，如果首页、分类、搜索、详情封面或章节图片出现以下症状，先按本文排查：

- App 里列表有标题但封面不显示。
- `lazy` 能返回 `pics://`，但阅读器图片空白、乱码或解码失败。
- 浏览器直接打开图片需要特定 `Referer` / `User-Agent`。
- 图片接口返回 `image/*`，但文件头不是 `JPEG/PNG/WEBP/GIF/AVIF/SVG`。
- 海阔源里有 `imageDecrypt`、`AES/CBC/PKCS7Padding`、`CryptoJS.AES.decrypt`、`getBytes` 或二进制代理逻辑。

这类问题通常不是选择器问题，而是图片链路问题：CDN 防盗链、二进制加密、切片重排、接口返回包装层，或 App 端无法带上站点要求的请求头。

如果症状是「目录正常，但正文条带错位 / 上下错层」，优先阅读 [App API + 切片复盘](comic-app-api-scramble-retrospective.md)：那是禁漫天堂落地中验证过的 scramble + 真机解码库选型经验。

## 核心策略

1. 列表、搜索、详情、章节图片都先统一走规则自己的 `proxy_rule`。
2. `proxy_rule` 负责补请求头、拉二进制、必要时解密，再返回真实图片字节。
3. `lazy` 返回 `pics://` 时，图片地址应优先是 `getProxyUrl()` 拼出的本地代理地址。
4. 封面图同理，`pic_url` / `vod_pic` 也可以写成代理地址，避免 App 直接请求远端图失败。
5. `check --level l3 --engine auto` 必须能真实拉取封面和首末章图片，并识别出合法图片文件头。

## proxy_rule 返回格式

内置 runtime 支持 drpy-node 常见代理返回数组：

```js
[statusCode, mediaType, content, headers, toBytes]
```

常用写法：

```js
return [200, 'image/webp', base64Image, {
  'Cache-Control': 'public, max-age=3600',
}, 1];
```

含义：

- `statusCode`: HTTP 状态码。
- `mediaType`: 响应 `Content-Type`。
- `content`: 文本内容或 base64 字符串。
- `headers`: 附加响应头。
- `toBytes === 1`: 把 `content` 当 base64 解码成 Buffer 返回。
- `toBytes === 2` 且 `content` 是 http 地址时，runtime 会返回 302 跳转。

## 代理地址拼法

在规则函数里优先使用 runtime 注入的 `getProxyUrl()`：

```js
function comicProxyImageUrl(url) {
  const image = String(url || '').trim();
  if (!image) return '';
  const proxyBase = typeof getProxyUrl === 'function' ? getProxyUrl() : '';
  return proxyBase + '&url=' + encodeURIComponent(image);
}
```

如果站点区分模块或路径，也可以把参数放进 query，例如：

```js
return getProxyUrl() + '&type=image&url=' + encodeURIComponent(imageUrl);
```

`proxy_rule` 中读取：

```js
proxy_rule: async function (params) {
  const imageUrl = decodeURIComponent(String(params.url || ''));
  // 拉图、解密、返回图片字节
}
```

## AES 解密模式

海阔规则常见写法是 `AES/CBC/PKCS7Padding`。迁移到 Aibox ds 源时，优先用 Node `crypto`；如果运行环境不提供 `require`，再用规则内已有的 `CryptoJS` 兜底。

Node 写法：

```js
function decryptImageBuffer(buffer) {
  const crypto = require('crypto');
  const key = Buffer.from('my2ecret782ecret', 'utf8');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}
```

判断是否需要解密：

```js
function imageKind(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}

function maybeDecryptImage(buffer) {
  if (imageKind(buffer)) return buffer;
  try {
    const decoded = decryptImageBuffer(buffer);
    return imageKind(decoded) ? decoded : buffer;
  } catch (e) {
    return buffer;
  }
}
```

不要盲目对所有图片解密。普通 JPG/WEBP 封面应原样返回；只有文件头不合法或站点规则明确加密时才尝试解密。

## AES 加密图片案例模式

某类海阔漫画源的通用关键点：

- 章节图和部分封面走远端图片地址，但远端会返回加密二进制。
- 海阔规则里的 `imageDecrypt` 使用 `AES/CBC/PKCS7Padding`。
- key 和 iv 必须从用户提供的原规则或已授权抓包证据读取，不要写入公共模板。
- Aibox 源需要实现 `proxy_rule`，由代理补 `User-Agent` / `Referer`，拉取二进制，AES 解密后返回真实 `image/webp`。
- `lazy` 章节图返回 `pics://proxyUrl1&&proxyUrl2...`。
- 首页、分类、搜索、详情里的 `pic_url` / `vod_pic` 也要走同一代理，否则列表封面可能仍然不显示。

验证通过时，L3 报告摘要应接近：

```text
首页 image=ok/webp
分类 image=ok/webp
详情 image=ok/webp
搜索 image=ok/webp
播放 parse=0 pics=217 firstImage=ok/webp
```

报告里的图片探测对象应包含：

- `status: "ok"`
- `imageKind: "webp"` 或其他合法图片类型
- `isProxy: true`
- `headHex` 以合法文件头开头，例如 `52494646...57454250` 表示 `RIFF....WEBP`

## L3 真实图片检测

当前 `check --level l3 --engine auto` 对 `类型: '漫画'` 会额外执行：

- 首页首个封面探测。
- 分类首个封面探测。
- 详情首个封面探测。
- 搜索首个封面探测。
- 首章和末章 `lazy` 返回的首图、末图探测。

直连封面会使用规则 `headers`；代理封面在同一个原生引擎会话中调用 `proxy_rule`。分类和详情封面是硬门禁，推荐和搜索只有空列表才能按显式 `allowEmpty=homevod,search` 跳过，非空伪封面不会被放行。

检测逻辑会真实 `fetch` 图片，跟随跳转，并识别文件头：

- `jpeg`
- `png`
- `webp`
- `gif`
- `avif`
- `svg`

如果 HTTP 成功但不是合法图片，会给出类似诊断：

```text
image-response-not-decodable-maybe-encrypted-or-scrambled
```

这通常说明源还缺图片代理、AES 解密、切片还原或请求头补齐。

## WebP 切片（scramble）与真机解码库

部分漫画站（如禁漫 / JM 类）正文几乎全是 WebP，并按章节 ID 做纵向条带打乱：

1. `lazy` 返回的远端图即使 HTTP 200、文件头合法，**画面仍可能错位**。
2. 必须在 `proxy_rule` 中：拉二进制 → 解码 RGBA → 按官方算法重排 → 再编码返回。
3. Aibox Flutter 真机走内置 `libnode`，**不能把 sharp 当依赖**：
   - sharp 原生二进制按构建机 OS 安装；
   - Windows 开发机装到的 `win32-x64` 进不了 Android arm64；
   - jimp 默认也常读不了 WebP。
4. 真机推荐：
   - 解码：`third_party/aibox-engine` 内的 `webp-wasm`
   - 编码：`jpeg-js`（输出 JPEG 给阅读器更稳）
5. 仅改源码不够：APK 打包的 `aibox-engine.zip` 必须含上述 `node_modules`，并递增 `bundledEngineVersion` 触发重解压。

完整算法、分类筛选、AES 请求与验收清单见 [comic-app-api-scramble-retrospective.md](comic-app-api-scramble-retrospective.md)。

## 排查顺序

1. 先看 L3 报告里的 `imageProbe` / `firstImageProbe`。
2. 如果 `httpStatus` 不是 200，优先补远端请求头、Referer 或代理。
3. 如果 `contentType` 是 `image/*` 但 `imageKind` 为空，优先排查 AES 加密或切片重排。
4. 如果 `headHex` 是 HTML 开头，说明远端返回了防盗链页、验证页或错误页。
5. 如果章节首图通过但后续图片失败，再抽样章节中间页，不要默认全站都正常。
6. 如果封面通过但章节失败，重点看章节接口是否有单独的加密参数。
7. 如果章节通过但封面失败，把 `vod_pic` / `pic_url` 也接入同一 `proxy_rule`。

## 验收命令

```powershell
node .\scripts\aibox-skill-cli.mjs lint --code-file '.\output\comic-source.js'
node .\scripts\aibox-skill-cli.mjs check --code-file '.\output\comic-source.js' --level l3 --engine auto
```

L3 通过后，如果需要给 App 导入，再上传云剪切板：

```powershell
node .\scripts\aibox-skill-cli.mjs share --code-file '.\output\comic-source.js' --name '示例漫画源' --category comic --group-tag 漫画
```
