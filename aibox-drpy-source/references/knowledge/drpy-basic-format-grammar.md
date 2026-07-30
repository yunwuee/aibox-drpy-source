# Aibox DS 核心语法与运行契约

本文记录当前 `third_party/aibox-engine` 已核实的规则语义。上游 drpy 文档、历史源或便携 runtime 与本文冲突时，以仓库内引擎代码和原生实跑结果为准。

## 目录

1. 输出与最小覆盖
2. 字符串规则
3. 继承与 fallback
4. 二级字典
5. 函数输入与请求
6. 搜索输入
7. 播放与正文
8. 结构性错误

## 1. 输出与最小覆盖

最终交付 JavaScript，不交付普通 JSON：

```javascript
var rule = {
  类型: '影视',
  title: '站点名称',
  host: 'https://example.com',
  url: '/list/fyclass-fypage.html',
  searchUrl: '/search?wd=**&page=fypage'
};
```

模板源只覆盖真实差异：

```javascript
var rule = {
  模板: 'mxpro',
  title: '目标站',
  host: 'https://example.com'
};
```

不要为了“字段齐全”把模板已有字段重复展开。先读取当前引擎模板表并查看展开后的规则；不存在的模板名必须报错，不能猜测 `appapi` 等名字。

## 2. 字符串规则

一级、推荐、搜索的常见 HTML 格式：

```text
列表选择器;标题;图片;描述;链接
```

```javascript
一级: '.list .item;a&&title;img&&data-src||src;.remarks&&Text;a&&href'
```

含义：

- 第 1 槽定位列表节点。
- 第 2 槽提取标题。
- 第 3 槽提取图片。
- 第 4 槽提取描述。
- 第 5 槽提取详情地址。

常用语法：

- `&&`：分隔节点选择器与最终属性，或表达层级定位。
- `Text`：提取文本。
- `Html`：提取内部 HTML。
- `href`、`src`、`style`、`data-*`：提取属性。
- `:eq(n)`：选择第 `n` 个匹配项。
- `json:`：让字符串列表规则按 JSON 路径解析。

优先选择稳定的容器、语义属性和链接结构，避免随机 class、构建 hash 和仅对单个样本成立的索引。

## 3. 继承与 fallback

### 整体继承

```javascript
推荐: '*',
搜索: '*'
```

这里的 `*` 表示整个规则继承 `一级`。推荐整体继承时，引擎还会按规则逻辑关闭双层推荐解析。

### 按槽继承

```javascript
一级: '.items;.name&&Text;img&&src;.note&&Text;a&&href',
搜索: '.search;*;img&&data-src||src;*;*'
```

搜索字符串中的每个 `*` 只继承 `一级` 对应分号槽位。不要把它解释成“选取所有节点”。

### HTML 属性 fallback

Aibox `htmlParser` 在同一个已定位节点上依次尝试属性：

```text
img&&data-src||src
```

含义是先对 `img` 取 `data-src`，为空时仍对同一 `img` 取 `src`。

不要写成：

```text
img&&data-src||img&&src
```

`||` 右侧不是第二条完整 HTML 选择器。JSONPath 解析器允许 `path1||path2` 表达候选路径，这是另一套语义。

## 4. 二级字典

二级字典把“定位节点”和“从节点取值”分开：

```javascript
二级: {
  title: 'h1&&Text;.tag&&Text',
  img: '.cover img&&src',
  desc: '.remark&&Text;.year&&Text;.area&&Text;.actor&&Text;.director&&Text',
  content: '.content&&Text',
  tabs: '.play-tabs .tab',
  tab_text: 'body&&Text',
  lists: '.play-list:eq(#id) a',
  list_text: 'body&&Text',
  list_url: 'a&&href'
}
```

硬约束：

- `tabs` 只写线路节点选择器。
- `tab_text` 负责从单个线路节点取名称。
- 禁止 `tabs: '.tab&&Text'`，否则 `$pdfa` 无法得到线路节点。
- `title` 的第二槽用于类型等附属信息。
- `desc` 保持“备注;年份;地区;演员;导演”五槽，不把类型挤进备注槽。
- `vod_play_from` 与 `vod_play_url` 的 `$$$` 组数一致，每项为 `标题$地址`。

## 5. 函数输入与请求

`this.input` 是引擎为当前阶段准备的请求输入，通常是 URL，不是响应正文：

```javascript
一级: async function () {
  const text = await request(this.input, { headers: this.headers });
  const data = JSON.parse(text);
  return data.list.map(item => ({
    title: item.name,
    pic_url: item.cover,
    desc: item.remark,
    url: item.id
  }));
}
```

错误写法：

```javascript
const data = JSON.parse(this.input);
```

除非当前阶段明确约定把 JSON 字符串作为 input，否则它只是在解析 URL。

当前 Aibox `request(url, options)` 同时接受 `body` 和 `data`，内部优先使用非空 `body`：

```javascript
await request(url, { method: 'POST', body: formText });
await request(url, { method: 'POST', data: jsonText });
```

不要把 `data` 一律判错。应核对 `Content-Type`、目标接口和实际请求载荷；同一请求不要同时给出含义不同的 `body` 与 `data`。

需要 Cookie、验证码、动态域、签名、POST、聚合或解密时再升级到 async。静态 HTML 和简单 JSON 列表优先字符串规则。

## 6. 搜索输入

- `searchUrl` 中的 `**` 用于把关键词写入请求 URL。
- 搜索函数运行时会注入 `this.KEY`；不能仅因 `searchUrl` 没有 `**` 就断言 KEY 不存在。
- POST 搜索可在函数中使用 `this.KEY` 构造 body。
- 搜索响应若可能是验证码 HTML，先识别和处理验证页，再执行 `JSON.parse`。
- `searchable: 0` 表示源明确不提供搜索，不应生成虚假搜索地址。

## 7. 播放与正文

函数型或 `js:` lazy 需要显式启用：

```javascript
play_parse: true,
play_json: [],
lazy: async function (flag, id) {
  return { parse: 0, url: id };
}
```

- `play_parse: true` 让引擎采用函数或 `js:` lazy 的结果。
- `play_json: []` 明确不对结果叠加通用解析配置，保留 lazy 的 `parse`、`jx`、`url` 和 `header`。
- 验收最终 `playParseAfter` 输出，不只看 lazy 内部日志。

内容协议：

- 影视直链、magnet、公开 torrent：`{ parse: 0, url }`。
- 需要通用解析的网页：`{ parse: 1, url }`。
- 小说：`{ parse: 0, url: 'novel://' + JSON.stringify({ title, content }) }`。
- 漫画：`{ parse: 0, url: 'pics://' + images.join('&&'), header }`。

不要对 `novel://` JSON 额外执行 `encodeURIComponent`。漫画图片必须探测真实文件头；需要补头、解密或切片时使用 `proxy_rule`。

## 8. 结构性错误

- 禁止对象内出现重复键；JavaScript 会让后一个字段静默覆盖前一个字段。
- `try` 必须跟 `catch` 或 `finally`，上传后再次做完整语法检查以发现截断。
- 不要让 helper 名称覆盖引擎注入变量，也不要依赖父进程环境变量或任意文件访问。
- 不要用静态字段数量代替模板展开、真实接口和完整链路验证。
- 不要让修复工具猜测不存在的 `searchUrl`、headers、分类或详情接口。
