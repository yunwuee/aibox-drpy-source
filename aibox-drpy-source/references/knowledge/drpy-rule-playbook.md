# Aibox DS 规则结构速览

本文只说明规则的结构和决策边界。精确的 `*`、`||`、二级字典、请求和播放语义见 [核心语法](drpy-basic-format-grammar.md)，完整实施顺序见 [写源工作流](source-writing-workflow.md)。

## 目录

1. 规则骨架
2. 阶段职责
3. 解析方式选择
4. 模板最小覆盖
5. 内容类型
6. 专项路由

## 1. 规则骨架

```javascript
var rule = {
  类型: '影视',
  title: '站点名称',
  host: 'https://example.com',
  url: '/list/fyclass/fypage',
  searchUrl: '/search?wd=**&page=fypage',
  searchable: 1,
  filterable: 0,
  quickSearch: 0,
  class_name: '电影&剧集',
  class_url: 'movie&series',
  推荐: '*',
  一级: '.item;a&&title;img&&data-src||src;.remark&&Text;a&&href',
  二级: {},
  搜索: '*',
  play_parse: true,
  play_json: [],
  lazy: async function (flag, id) {
    return { parse: 1, url: id };
  }
};
```

这只是结构示意，不是应复制的万能模板。只声明站点真实支持的分类、搜索、筛选和播放能力。

## 2. 阶段职责

| 阶段 | 输入 | 输出 |
|---|---|---|
| 推荐 | 首页 input | 卡片列表 |
| 一级 | `tid/pg/filter/extend` | 分类列表 |
| 二级 | 真实 `vod_id` | 元数据、线路、播放/章节目录 |
| 搜索 | `KEY/pg` | 搜索卡片列表 |
| lazy | 真实播放或章节 ID | 直链、解析链接、小说正文、漫画图片或 BT URL |

推荐、分类、搜索的列表项至少保持 `title/pic_url/desc/url`。二级必须让 `vod_play_from` 与 `vod_play_url` 分组对齐，并确保每项为 `标题$地址`。

## 3. 解析方式选择

按最低复杂度选择：

1. HTML 结构稳定：使用字符串选择器。
2. 简单 JSON：使用 `json:` 路径或短函数。
3. 仅详情/搜索/lazy 特殊：字符串与函数混合。
4. 需要 POST、签名、Cookie、动态域、聚合、解密：只把对应阶段改成 async。
5. 纯 API/SPA 且跨阶段状态复杂：全 async。

函数中优先复用 Aibox 注入的 `request`、`post`、`pdfa`、`pdfh`、`pd`、`pjfa`、`pjfh`、`setResult`，不要重复造一套通用解析器。

## 4. 模板最小覆盖

只在当前 Aibox 引擎真实存在候选模板，且模板展开结果与目标站证据吻合时使用：

```javascript
var rule = {
  模板: 'mxpro',
  title: '目标站',
  host: 'https://example.com'
};
```

不要生成不存在的 `appapi`，不要手写静态模板名单，也不要把模板已经提供的字段全部复制出来。模板不匹配时回到字符串、混合或 async 路线。

## 5. 内容类型

### 影视

- 二级输出视频线路和集数。
- lazy 返回直链 `{ parse: 0, url }` 或需要解析的 `{ parse: 1, url }`。
- L3 至少验证一条真实播放链。

### 小说

- 二级把章节目录写入 `vod_play_url`。
- lazy 返回 `novel://` 原始 JSON 或可直接访问的正文地址。
- L3 验证首章和末章正文。

### 漫画

- 按 `list -> detail -> catalog -> reader` 拆分接口。
- lazy 返回 `parse: 0 + pics://img1&&img2...`。
- 图片防盗链、加密或切片时使用 `proxy_rule`。
- L3 验证首末章首尾图片文件头和 Aibox 最终响应。

### 磁力/BT

- 二级返回完整 magnet 或公开 torrent。
- 函数型 lazy 使用 `play_parse: true`、`play_json: []` 并直返 `{ parse: 0, url }`。
- BT 解析、下载和播放交给 Aibox 本地 Go 引擎，源中不要调用 `/bt/resolve`。

## 6. 专项路由

- 动态域、发布页、Loading 壳：读取 [dynamic-host-playbook.md](dynamic-host-playbook.md)。
- 验证码和简单图片 OCR：读取 [captcha-ocr-playbook.md](captcha-ocr-playbook.md)。
- 漫画/App API：读取 [comic-source-development-playbook.md](comic-source-development-playbook.md)。
- 漫画图片代理与 AES：读取 [comic-image-proxy-playbook.md](comic-image-proxy-playbook.md)。
- 小说/漫画运行时：读取 [content-type-runtime-validation.md](content-type-runtime-validation.md)。
- 磁力/BT：读取 [magnet-bt-source-playbook.md](magnet-bt-source-playbook.md)。

完成后按 L1 结构、L2 单接口、L3 真实 ID 链路验收。静态字段齐全、局部 helper 成功或评分较高都不能代替完整链路。
