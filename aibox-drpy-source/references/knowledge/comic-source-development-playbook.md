# 漫画与 App API 源开发手册

本文把 CopyManga 等真实修源过程中的经验抽象为通用方法。目标是让列表、分类、详情、目录、章节图片、Aibox 引擎后处理和 Android 阅读器形成一条可验证链路，而不是只让推荐页出现卡片。

## 目录

1. 四阶段数据模型
2. 列表与分类
3. 详情
4. 目录与章节 ID
5. 阅读器与图片协议
6. 签名、设备头和动态域
7. 图片代理
8. 分阶段回退
9. 故障分层
10. L3 真机验收

## 1. 四阶段数据模型

先把站点拆成四个独立阶段：

| 阶段 | 输入 | 预期输出 | 必查项 |
|---|---|---|---|
| `list` | 分类、筛选、页码、关键词 | 漫画卡片与 `comicId` | 分类入口、offset、封面 |
| `detail` | `comicId` | 元数据和目录分组信息 | 详情域、字段层级、简介 |
| `catalog` | `comicId`、group、分页 | 有序章节与 `chapterId` | 全部分组、分页结束条件 |
| `reader` | `comicId`、`chapterId` | 有序图片 URL | 签名、图片头、解密/代理 |

对每个阶段分别记录 URL、method、headers、body/data、分页、JSON 路径、输入 ID 来源和失败特征。不要因为 `list` 返回成功，就复用它的域名、请求头或响应路径去解析 `detail`、`catalog`、`reader`。

声明式 App API 的 `responseType` 默认使用 `json`。漫画只有 `reader` 可使用 `text`，并且文本必须能解析为 JSON 图片对象/数组、嵌套 JSON 字符串、换行或 `&&` 分隔的图片地址；`home/category/search/detail/catalog` 需要结构化字段，不能用 `text` 静默退成空数据。

四阶段可能分别来自：

- 静态 HTML。
- 网页 JSON/XHR。
- 官方 App API。
- 网页内嵌或加密数据。

优先用最低复杂度：HTML 选择器或 `json:` 能解决时不写全 async；只有签名、动态域、POST、Cookie、分页聚合或解密阶段函数化。

## 2. 列表与分类

推荐有内容但分类为空，通常不是详情问题。分别验证：

- `推荐`：最近更新、热门或首页列表。
- `class_parse` 或 `class_name/class_url`：提供真实分类入口。
- `一级`：使用 `tid`、`pg`、`filter`、`extend` 请求分类。
- `filter/filter_def/filter_url`：使用接口真实枚举，不只写显示文本。

动态分类可返回：

```javascript
return {
  class: [{ type_name: '全部漫画', type_id: 'all' }],
  filters: { all: rule._buildFilters() }
};
```

检查：

- `type_id` 能被 `一级` 转成接口真实参数。
- `filter_def` 的默认值确实存在。
- offset 按接口定义计算，常见是 `(pg - 1) * limit`。
- 分类、排序、状态和地区的枚举与抓包一致。
- 分类接口为空时不要拿推荐列表冒充分类成功。

## 3. 详情

详情必须从真实 `comicId` 请求，至少返回：

```javascript
{
  vod_id,
  vod_name,
  vod_pic,
  vod_remarks,
  vod_content,
  vod_play_from,
  vod_play_url
}
```

App API 常把作品元数据、分组列表和章节摘要放在不同层级或不同接口。先保存原始响应样本，再按实际字段映射；不要用列表卡片的 `desc` 和封面拼成“伪详情”。

如果详情接口返回空对象或极短响应：

1. 核对 ID 是否来自当前列表响应，而不是手填 slug。
2. 核对详情 API 域是否与列表域不同。
3. 核对请求路径是否参与签名。
4. 核对设备头、时间戳、版本和区域参数是否配套。
5. 核对错误响应是否被宽泛 `catch` 吞掉。

## 4. 目录与章节 ID

目录协议：

```text
线路分组: $$$
章节分隔: #
标题/地址: $
```

漫画可按主线、单行本、卷、番外、语言等分组。必须保证 `vod_play_from` 与 `vod_play_url` 的 `$$$` 数量一致。

目录接口常使用 `limit/offset` 或 cursor 分页。循环到“返回为空、数量小于 limit、next 为空或服务端明确结束”，不能固定只取第一页或前 100 章。

下游正文同时需要作品和章节上下文时，使用可逆组合 ID：

```text
comicId@chapterId
```

若原始 ID 可能包含 `@`，改用 URL 编码、JSON/Base64 或长度前缀。不要多次 `split('@')` 后猜哪一段是 ID。

组合 ID 使 reader 能：

- 请求同时要求作品 ID 与章节 UUID 的接口。
- API 失败时定位对应网页详情/阅读页。
- 在日志里准确标识失败作品与章节。

章节标题和地址中的 `#`、`$` 要替换或编码，避免破坏 App 目录分隔。

## 5. 阅读器与图片协议

函数型漫画 lazy 使用完整契约：

```javascript
play_parse: true,
play_json: [],

lazy: async function (flag, id) {
  const images = await rule._loadChapterImages(id);
  return {
    parse: 0,
    url: images.length ? 'pics://' + images.join('&&') : '',
    header: rule.imageHeaders
  };
}
```

- `pics://` 后按阅读顺序使用 `&&` 拼接。
- `parse: 0` 表示结果已可由阅读器消费。
- `play_parse: true` 让 Aibox 使用函数型 lazy 结果。
- `play_json: []` 防止通用播放配置覆盖 `parse/url/header`。
- 图片为空时保留可定位错误，不把章节 ID 或详情页地址当正文返回。

验收对象是 `playParseAfter` 后的最终 `/api/{module}` 响应。只看 lazy 内部打印的 `{ parse: 0 }` 不足以证明 Android 收到同一结果。

## 6. 签名、设备头和动态域

把请求封装为一个可审计 helper，集中处理域名、头、签名、响应判断和有限重试。

### 请求上下文一致性

同一次请求中的以下数据必须来自同一上下文：

- 时间戳和日期。
- 设备 ID、pseudo ID 或安装标识。
- HTTP method 与签名路径。
- App 版本、平台、来源、Referer、区域参数。
- 签名密钥选择和签名结果。

不能先计算签名，再刷新时间戳或切换域/路径。打印调试日志时避免输出长期 token、Cookie 或完整密钥。

### 设备信息持久化

首次生成设备信息后使用 `setItem` 保存，后续通过 `getItem` 复用。每个请求随机设备信息容易使服务端风控、token 和签名上下文失配。

### 动态域

1. 从官方网络配置、发布页或候选接口取得 API 域。
2. 过滤资源域、统计域和发布页域。
3. 按 `list/detail/catalog/reader` 分别验证候选域。
4. 缓存已成功的业务域。
5. 请求失败时刷新候选并切换，而不是永久信任一次抓到的域。

先确定业务域，再在业务域处理验证码或签名。完整策略见 `dynamic-host-playbook.md`。

## 7. 图片代理

若站点对 WebP 做 scramble 纵向切片，或真机出现“有图但条带错位”，先读 [App API + 切片复盘](comic-app-api-scramble-retrospective.md)，再继续本节通用代理策略。

封面和章节图片分别验证：

- URL 是否完整，协议相对地址是否补全到正确图片域。
- 是否依赖 Referer、User-Agent、Cookie、token 或过期时间。
- HTTP 200 响应是否真是 JPEG、PNG、WEBP、GIF、AVIF 或 SVG 文件头。
- 是否存在 AES、切片、字节打乱、混淆或防盗链错误页。

远端可直接读取时在 lazy 的 `header` 返回必要头。阅读器仍无法直接解码时使用 `proxy_rule`：

- 请求时补齐必要 headers。
- 普通图片原样返回。
- 仅在文件头不是图片且证据表明存在加密时解密。
- 二进制响应按 `[200, mediaType, base64, headers, 1]` 返回。

封面与正文图片若共享同一防盗链，应统一代理，不能只修章节图。详细实现见 `comic-image-proxy-playbook.md`。

## 8. 分阶段回退

回退应按阶段设计，不是一次性“API 失败就抓网页”：

| 阶段 | 主链路 | 可选回退 |
|---|---|---|
| list | 官方列表 API | 网页列表/搜索 |
| detail | 官方详情 API | 网页详情/内嵌 JSON |
| catalog | 官方目录 API | 网页目录/详情内分组 |
| reader | 官方章节 API | 阅读页数据/内嵌加密数据 |

只有解析出当前阶段目标结构才算回退成功。不要用空对象、旧缓存或上游卡片字段掩盖失败。

记录每次回退原因：HTTP 错误、业务错误码、鉴权失败、结构缺失、解密失败或图片文件头异常。有限次数后明确失败，避免递归重试。

## 9. 故障分层

- **规则层**：URL、参数、JSON 路径、签名、分页、组合 ID、图片数组。
- **Aibox 引擎层**：源码初始化、模板继承、模块缓存、`playParseAfter`、`proxy_rule` 响应。
- **Flutter UI 层**：阅读器状态、ScrollController、页面复用、图片组件。
- **部署层**：云分享截断、同名旧源、设备文件未覆盖、引擎未重载。

典型判断：

- 推荐正常、分类为空：先查分类入口和 `tid/filter`，不要改详情。
- 详情响应极短：查真实 ID、详情域、签名路径和设备头。
- lazy 内 `parse: 0`，最终变 `parse: 1`：查 `play_parse/play_json` 和引擎后处理。
- `Missing catch or finally after try`：先查完整语法，再比对本地、云端和设备文件是否截断。
- `ScrollController attached to multiple scroll views`：属于 Flutter UI 问题，不能靠修改漫画接口解决。
- 本地链路正常、手机仍异常：核对设备源码 SHA-256 和 Node 模块缓存。

## 10. L3 真机验收

使用真实数据串联：

```text
真实 class_id -> 分类 comicId -> 详情 -> 全目录 -> 首末章 chapterId -> 图片
```

至少检查：

- 推荐、真实分类及每类筛选的一个组合。
- 推荐、分类、详情、搜索首项封面的真实文件头；分类和详情封面是硬门禁。
- 详情元数据、全部线路、目录首章和末章。
- 首章首图/末图、末章首图/末图的真实文件头。
- Aibox 最终章节响应仍为 `parse: 0 + pics://`。
- 图片代理路径实际被使用且返回正确媒体类型。
- 云端回读、本地文件和设备文件的字节数、末尾和 SHA-256 一致。

`allowEmpty=homevod,search` 只允许已启用的推荐/搜索阶段确实返回空列表；非空条目缺封面或返回伪图片仍失败。分类和详情不能用 `allowEmpty` 绕过。直连封面探测使用规则 `headers`，仍无法读取时再统一接入 `proxy_rule`。

若任一阶段失败，报告具体断点和已取得证据；不要用推荐页的 ID 跳过分类，也不要只测试首章。中文模块名在 HTTP 路径中使用百分号编码。
