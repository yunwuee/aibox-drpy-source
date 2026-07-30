# 选择器与字段映射速查表

## HTML 模式常见目标

### 列表卡片

- 卡片容器选择器
- 标题选择器
- 图片选择器
- 描述/备注选择器
- 详情链接选择器

### 详情页

- 标题
- 海报
- 类型
- 年份
- 地区
- 演员
- 导演
- 简介
- 播放线路 tabs
- 剧集列表容器
- 剧集项

## 搜索页要额外关注

- 搜索参数名，如 `wd` / `keyword` / `q`
- 搜索 form 的 `action`
- 搜索结果是否与一级页结构相同

## 播放页要额外关注

- 页面里是否直接出现 `m3u8/mp4/flv`
- 是否有播放器配置对象
- 是否有 `player_`、`play_url`、`url:` 之类字段
- 是否需要再请求一次接口

## JSON 模式常见目标

### 列表数组路径

常见形态：

- `data.list`
- `data.rows`
- `data.items`
- `result.list`
- `list`

### 单项字段

常见字段名：

- 标题：`title` / `name` / `vod_name`
- 图片：`pic` / `cover` / `vod_pic`
- 描述：`remarks` / `desc` / `note`
- id：`id` / `vod_id`
- url：`url` / `jump_url`

### 详情字段

常见字段名：

- `type_name`
- `vod_remarks`
- `vod_year`
- `vod_area`
- `vod_actor`
- `vod_director`
- `vod_content`
- `vod_play_from`
- `vod_play_url`

## 自动写源时的判断建议

- 如果页面主体靠服务端直接返回 HTML，优先按 HTML 源写。
- 如果列表和详情都是接口返回 JSON，优先按 JSON 源写。
- 如果明显是标准 APP 接口，先试模板源。

## 高风险点

- 图片字段可能是 `data-src`、`data-original`、`src`
- 标题可能藏在 `title` 属性而不是文本节点
- 详情页的剧集列表常常分多组，需要先抓线路 tabs 再抓每组剧集
- 搜索页经常与分类页不是同一套结构

## 来自 zyfun 文档的筛选提取提醒

### 分类提取常见输入项

- 类名：通常对应 `title`
- 类标识：通常对应 `id`
- 大类：规则顺序通常为 `title | id | surl | match`
- 链接模板：分类占位符一般替换成 `fyclass`

### 筛选提取常见输入项

- 父元素：筛选组容器
- 子元素：规则顺序通常为 `key | name | type | title | url`

### 当前筛选常见维度

- 年份
- 语言
- 字母
- 类型
- 剧情
- 地区
- 排序

这些字段在很多站点并不是直接标准化输出，而是需要先从静态页面里抽，再映射成最终筛选结构。
