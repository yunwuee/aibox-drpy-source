# 漫画 App API + 切片图复盘：以禁漫天堂（18comic / JM）为例

本文沉淀的是一次真实漫画源落地经验：**分类带筛选 → App API 加解密 → 详情章节 → `pics://` → `proxy_rule` 解切片 → Flutter 真机验收 → 云分享**。

重点不是“只记住这一站怎么写”，而是以后写同类漫画源时：

- 如何先判断站型；
- 如何拆四阶段链路；
- 分类筛选写到哪一层；
- 图片乱序到底是 CDN 问题、切片问题，还是解码库不可用；
- 为什么桌面能过、手机却失败；
- 引擎依赖该怎么打包进正式包。

适用范围：

- 有 **App API**，网页可能有 Cloudflare / 地区限制；
- 接口响应 **AES 加密**，请求需要 `token` / `tokenparam`；
- 章节图多为 **WebP**，且存在 **纵向切片打乱（scramble）**；
- 需要在 Aibox Flutter 真机内置 `libnode` 引擎中稳定阅读。

相关手册：

- [漫画开发手册](comic-source-development-playbook.md)
- [漫画图片代理](comic-image-proxy-playbook.md)
- [运行时契约](content-type-runtime-validation.md)
- [动态域](dynamic-host-playbook.md)

---

## 1. 站型判断：优先 App API，不要死磕网页 HTML

禁漫这类站常见特征：

| 线索 | 含义 |
|---|---|
| 网页 `comic.example.com` 有 CF / 地区限制 | HTML 路线不稳定 |
| 存在公开/半公开 App API 域 | 优先 `route = api` 或 `hybrid` |
| 分类、搜索、详情、章节都是 JSON | 四阶段拆接口 |
| 图片走独立 CDN 域 | 列表域成功 ≠ 图片域可用 |
| 正文图文件名像 `00001.webp` | 可能有 scramble 切片 |

结论：

```text
contentType = comic
route       = api（优先）/ hybrid（API 失败再回退 HTML）
```

**不要**因为用户给的是 `https://comic.example.com/` 就默认写 HTML 选择器。应先：

1. 探测 App API 域是否可访问；
2. 验证 `/setting`、`/categories/filter`、`/album`、`/chapter`、搜索接口；
3. 再决定是否保留 HTML 作为后备。

---

## 2. 四阶段模型（必须分开记证据）

| 阶段 | 典型接口 | 输入 | 输出 |
|---|---|---|---|
| list | `/categories/filter`、`/search` | 分类 / 筛选 / 页码 / 关键词 | 卡片 + albumId |
| detail | `/album?id=` | albumId | 标题、作者、标签、简介、series |
| catalog | 常合并在 detail 的 `series` | albumId | 章节列表 photoId |
| reader | `/chapter?id=` + CDN 图片 | photoId | 图片文件名数组 |

硬性规则：

1. 列表成功不能证明详情可用。
2. 详情成功不能证明图片可解码。
3. 单章本 `series` 可能为空，此时章节 ID = 本子 ID。
4. 组合 ID 建议：`albumId@photoId`，避免 `@` 歧义时再编码。

---

## 3. 分类要带筛选：UI 枚举与接口参数必须同源

用户要求“分类要带筛选、都包括点”时，不要只写 `class_name/class_url`。

至少覆盖：

1. **主分类**：全部/最新、同人、单本、短篇、韩漫、美漫、Cosplay、3D、其他、英文站等；
2. **排序**：最新、最多观看、最多图片、最多爱心等；
3. **时间**：全部、今天、本周、本月；
4. **排行榜**：日/周/月 + 榜内分类；
5. **副分类**（若站点有）：汉化/日语/CG/青年等。

经验：

- App API 往往 **不支持网页端副分类路径**。此时：
  - 仍可在 `filter` UI 中保留选项（与网页语义对齐）；
  - 实现层明确记录“App 不支持 sub，降级主分类”；
  - 不要为了 UI 完整而伪造过滤结果。
- 排行榜常是分类接口的一种 `order` 变形（如 `mv_t` / `mv_w` / `mv_m`），不必另起一套列表解析。
- `filterable: 1` + `filter` + `filter_def` + 可选 `class_parse` 返回 `filters`。

筛选默认值必须真实存在于枚举中，否则 App 首屏会空。

---

## 4. App API 加解密：时间戳与密钥必须同一次请求一致

以 JM 类接口为例，验证过的模式：

### 请求头

```text
token      = md5(ts + APP_TOKEN_SECRET)
tokenparam = ts + ',' + APP_VERSION
```

特殊接口（如 `chapter_view_template`）可能使用另一套 secret。

### 响应体

```text
payload.data 是 base64 密文
key           = md5(ts + APP_DATA_SECRET) 的 UTF-8 字节（32 字节）
算法          = AES-256-ECB + PKCS7
```

注意：

- Node 里 `md5hex(...).length === 32`，作为 UTF-8 key 对应 **AES-256-ECB**，不是 AES-128。
- 签名用的 `ts` 必须是**同一次请求**生成并用于解密的 `ts`。
- Cookie 往往要先打 `/setting` 再带着走业务接口。
- App 版本号可从 `/setting` 的 `jm3_version` 动态更新。

设备/Cookie 应用 `setItem/getItem` 复用，不要每次随机。

---

## 5. 章节图片：文件名排序 + scramble 切片

### 5.1 文件名

接口常返回：

```json
["00001.webp", "00002.webp", "00003.webp"]
```

实现时：

1. 按文件名中的数字排序，不要假设数组已有序；
2. CDN URL 形如：`/media/photos/{photoId}/{file}`；
3. 封面通常是 `/media/albums/{albumId}.jpg`，**不要**对封面做章节切片算法。

### 5.2 切片数算法（验证过）

```text
若 photoId < scramble_id        → num = 0（不切片）
若 photoId < 268850             → num = 10
否则:
  x = (photoId < 421926) ? 10 : 8
  s = md5(String(photoId) + fileStem)   // fileStem 无扩展名
  num = (s 最后一字符 ASCII % x) * 2 + 2
```

关键点：

- **filename 必须去掉扩展名**（`00001.webp` → `00001`）；
- scramble_id 可从 `chapter_view_template` HTML 的 `var scramble_id = ...` 取；
- 取不到时可用站点默认阈值兜底，但应打日志。

### 5.3 像素重排算法

对 RGBA 位图做纵向条带重排（与官方客户端等价）：

```text
over = height % num
for i in 0..num-1:
  move = floor(height / num)
  ySrc = height - move * (i + 1) - over
  yDst = move * i
  if i == 0: move += over
  else: yDst += over
  把源图 [ySrc, ySrc+move) 拷到目标 [yDst, yDst+move)
```

只在 `num > 1` 时执行。

---

## 6. 最大坑：图片乱序往往不是规则算法错了，而是解码库在真机不可用

### 6.1 现象分层

| 现象 | 更可能原因 |
|---|---|
| 列表有卡、详情有目录、阅读条带错位 | scramble 未还原 |
| `lazy` 返回 `pics://` 但图空白 | 防盗链 / 代理失败 |
| HTTP 200 且 `image/webp`，但条带乱 | 解码后未重排，或重排库失败后回退原图 |
| 桌面 L3 过、手机仍乱 | 手机引擎缺解码依赖或未重部署引擎 |

### 6.2 解码库选择（Aibox 约束）

| 库 | 桌面引擎 | Flutter 真机内置 libnode | 说明 |
|---|---|---|---|
| `sharp` | 常可用 | **不可依赖** | 原生二进制按构建机 OS 安装；Android arm64 无对应包 |
| `jimp` | 视版本 | 弱 | 默认 **不支持 WebP**，JM 正文几乎全是 WebP |
| `webp-wasm` | 可用 | **推荐** | 纯 WASM，可打进 `aibox-engine.zip` |
| `jpeg-js` | 可用 | **推荐** | 纯 JS，重排后编码 JPEG 给阅读器 |

结论：

> 漫画解切片在 Aibox 真机侧，优先 `webp-wasm` 解码 + 像素重排 + `jpeg-js` 编码。
> **不要把 sharp 当移动端方案。**

### 6.3 为什么 L3 会“假通过”

L3 图片探针有时只验证：

- HTTP 成功；
- 文件头是合法 `webp/jpeg/...`。

**合法 WebP 仍然可以是“切片错乱后的合法图”**。
因此：

1. L3 过只说明“能下到图、不是 HTML 错误页”；
2. 切片对不对还要用本地抽样肉眼看，或对比还原前后条带；
3. 真机阅读才是最终门禁。

如果 L3 结果里正文仍是 `image/webp` 而你期望已还原为 `image/jpeg`，通常表示 `proxy_rule` 解混淆没真正执行成功。

---

## 7. proxy_rule 推荐写法

### 7.1 lazy 侧

```js
// 图片 URL 走代理，并带上还原参数
getProxyUrl() + '&kind=jmimg'
  + '&url=' + encodeURIComponent(remote)
  + '&sid=' + scrambleId
  + '&aid=' + photoId
  + '&file=' + encodeURIComponent(fileName)
  + '&stem=' + encodeURIComponent(fileStem)
```

`lazy` 返回：

```js
{
  parse: 0,
  url: 'pics://' + proxyUrls.join('&&'),
  header: { /* CDN 需要的 UA / Referer 等 */ }
}
```

### 7.2 proxy_rule 侧

1. 用 `axios` 拉 **arraybuffer**（不要用文本 `request` 拿二进制）；
2. 只对 `/media/photos/` 正文图做 scramble；
3. 封面 `/media/albums/` 只补头，不切片；
4. 成功后返回：

```js
[200, 'image/jpeg', base64, { 'Cache-Control': 'public, max-age=2592000' }, 1]
```

5. 失败时返回明确错误文本，不要静默给错位原图却假装成功（至少打日志）。

### 7.3 模块加载

规则内 `require('webp-wasm')` / `require('jpeg-js')` 应：

1. 先 `require(name)`；
2. 再尝试 `process.cwd()/node_modules`、`NODE_PATH`、`DRPY_WORK_DIR`；
3. 给 `global/globalThis` 补 `ImageData`（webp-wasm 解码需要）。

---

## 8. 引擎打包与正式包联动

图片依赖不只是“源码写了 require”，还要保证 **APK 里的 aibox-engine 含这些包**。

### 8.1 依赖落点

```text
third_party/aibox-engine/package.json
third_party/aibox-engine/node_modules/webp-wasm/**
third_party/aibox-engine/node_modules/jpeg-js/**
```

### 8.2 触发真机重解压

仅升级 App 版本不够时，必须提高：

```dart
AppConstants.bundledEngineVersion
```

并在 `BundledEngineManager._requiredBundledFiles` 增加：

```text
node_modules/webp-wasm/package.json
node_modules/webp-wasm/webp_node_dec.wasm
node_modules/jpeg-js/package.json
```

否则用户升级后仍可能沿用旧引擎目录，缺 WASM 文件，解混淆继续失败。

### 8.3 Android assets 注意

`aibox-engine.zip` 会打包 `node_modules`。`.wasm` 需在 `aaptOptions.noCompress` 中声明，避免压缩后运行时 open 失败（工程里已对 `wasm` 做过处理）。

### 8.4 正式包体积

增加 webp-wasm 后 APK 会变大（约数 MB 级），这是可接受代价；sharp 的多架构原生库反而更不适合。

---

## 9. 推荐验收顺序（漫画专用）

### L1

```powershell
node .\scripts\aibox-skill-cli.mjs lint --code-file '.\output\xxx[漫].js'
```

### L2 / L3

```powershell
node .\scripts\aibox-skill-cli.mjs check --code-file '.\output\xxx[漫].js' --level l3 --engine auto
```

检查：

- 推荐 / 分类 / 搜索非空；
- 详情目录 `标题$地址`；
- 首末章 `pics://`；
- 封面与首末图文件头合法；
- 若做了切片还原，正文代理结果是否已变成期望的 `image/jpeg`。

### 本地抽样（强烈建议）

对真实章节前 3 页：

1. 下载原始 WebP；
2. 算 `num`；
3. 解码 → 重排 → 编码；
4. 肉眼确认人物/对话框不再上下错层。

### 真机

1. 装含新引擎版本的正式包；
2. 确认引擎版本号已更新并完成重解压；
3. 重新导入源（旧源建议删除后导入）；
4. 阅读多页正文，不只看封面。

### 云分享

```powershell
node .\scripts\aibox-skill-cli.mjs share --code-file '.\output\xxx[漫].js' --name 'xxx[漫]' --copy
```

分享成功以 **回读 verified + SHA-256 一致** 为准。

---

## 10. 交付检查清单（漫画 App API + 切片）

- [ ] 站型判定为 comic + api/hybrid，并写明为何不走纯 HTML
- [ ] 分类入口完整，筛选枚举与接口参数同源
- [ ] 副分类若 App 不支持，已在实现中明确降级，不伪造结果
- [ ] 签名/解密 `ts` 与密钥同请求一致
- [ ] 详情 `series` 空时有单章回退
- [ ] 章节图按数字排序
- [ ] scramble_id + fileStem（无扩展名）计算切片数
- [ ] `proxy_rule` 只对正文图切片，不误伤封面
- [ ] 解码链路优先 `webp-wasm` + `jpeg-js`，不依赖 sharp 真机
- [ ] 引擎 `package.json` / `node_modules` 已包含依赖
- [ ] `bundledEngineVersion` 已递增，必检文件包含 wasm/jpeg-js
- [ ] L1/L3 通过，且本地/真机肉眼确认条带正确
- [ ] 云分享回读校验通过

---

## 11. 可复用模板思路（不要照抄密钥）

```text
预处理: 刷新 API 域、setting、cookie、图片解码库自检
推荐  : categories_filter(最新)
一级  : categories_filter(分类 + 排序/时间/排行)
搜索  : search(关键词)；纯数字车号可直达 album
二级  : album 详情 + series 目录；空 series → 单章
lazy  : chapter 取 images[] → 排序 → proxy 地址列表 → pics://
proxy : 拉图 → 若正文且 num>1 → webp 解码 → 重排 → jpeg 返回
```

站点密钥、域名、版本号必须以**当前抓包/公开客户端实现**为准，过期后只更新证据，不硬猜。

---

## 12. 这次踩坑的一句话总结

> 漫画源“有目录但图乱”，先别改选择器。
> 先确认：是不是 WebP 切片、是不是 `proxy_rule` 没真正解码重排、是不是真机引擎根本没有可用的解码库。
> **算法对了但库不在真机上 = 用户仍然看到错图。**
