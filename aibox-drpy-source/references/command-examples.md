# Aibox 写源 CLI 示例

以下命令从 skill 根目录运行。先查看当前帮助，参数与输出以实际 CLI 为准：

```powershell
node .\scripts\aibox-skill-cli.mjs help
```

CLI 正常结果统一输出 JSON：

```json
{"ok":true,"command":"triage","data":{}}
```

失败结果包含结构化 `error.code/message/suggestions`；普通过程日志写入 stderr。

## 1. 环境检查

检查 Node、Aibox 原生引擎、便携 runtime、OCR、配置和云剪切板能力：

```powershell
node .\scripts\aibox-skill-cli.mjs doctor
```

有真实验证码样本时：

```powershell
node .\scripts\aibox-skill-cli.mjs doctor --ocr-image-file .\captcha.png
```

## 2. 读取知识资源

列出当前知识、空白模板和 Prompt：

```powershell
node .\scripts\aibox-skill-cli.mjs resources list
```

按短名称或完整 URI 读取单项资源：

```powershell
node .\scripts\aibox-skill-cli.mjs resources read --name comic-source-development-playbook
node .\scripts\aibox-skill-cli.mjs resources read --uri aibox://knowledge/drpy-basic-format-grammar
```

## 3. 站型判断

直接分析目标 URL：

```powershell
node .\scripts\aibox-skill-cli.mjs triage --url "https://example.com"
```

结果重点查看 `route`、`contentType`、`implementationMode`、`risks`、`evidence` 和 `nextCommand`。

## 4. 模板发现与展开

列出当前 Aibox 引擎真实模板：

```powershell
node .\scripts\aibox-skill-cli.mjs templates list
```

根据 URL 或已抓取内容推测候选模板：

```powershell
node .\scripts\aibox-skill-cli.mjs templates guess --url "https://example.com"
node .\scripts\aibox-skill-cli.mjs templates guess --content-file .\samples\home.html
```

查看源码或现有模块在模板继承后的有效规则：

```powershell
node .\scripts\aibox-skill-cli.mjs resolved --code-file .\output\source.js
node .\scripts\aibox-skill-cli.mjs resolved --module 源名称
```

## 5. 生成紧凑规则

按输入 schema 生成规则：

```powershell
node .\scripts\aibox-skill-cli.mjs compose --input-file .\source-spec.json
```

输入应明确 `sourceKind`、`contentType`、`implementationMode`，以及实际需要的 `home/category/search/detail/catalog/reader/play` 阶段。简单站优先模板或字符串规则，签名、POST、动态域、聚合、解密阶段再使用 async。

App API 至少要提供真实 `host`、推荐接口、分类接口、详情接口和分类数据。下面是可生成分类入口并串联详情、目录、正文的最小结构；字段路径必须按真实响应修改：

```json
{
  "sourceKind": "app-api",
  "contentType": "comic",
  "implementationMode": "full-async",
  "siteName": "示例漫画接口",
  "host": "https://api.example.com",
  "classes": [
    { "name": "连载", "id": "serial" },
    { "name": "完结", "id": "finished" }
  ],
  "stages": {
    "home": { "url": "/api/home", "listPath": "data.list" },
    "category": { "url": "/api/comics?type=fyclass&page=fypage", "listPath": "data.list" },
    "detail": { "url": "/api/comic/fyid", "dataPath": "data" },
    "catalog": { "url": "/api/comic/fyid/chapters", "listPath": "data.chapters" },
    "reader": { "url": "/api/chapter/fyid", "dataPath": "data", "responseType": "json" }
  }
}
```

`classes` 也可以写成分段数一致的 `className/classUrl`。`home.url` 必须能脱离 `fyclass/fypage/**` 直接请求；没有真实推荐和分类证据时，生成器会拒绝输出只有推荐或空分类的源。

POST body 中的 `fyid/fyclass/fypage/**` 默认替换为原始值，适合 JSON body：

```json
{
  "method": "POST",
  "url": "/api/chapter",
  "bodyType": "json",
  "headers": { "Content-Type": "application/json" },
  "body": { "id": "fyid" }
}
```

只有接口明确要求 URI 编码时，才设置 `"bodyEncode": true` 或 `"bodyEncoding": "uri"`。例如字符串表单 `"body": "id=fyid"` 会保留 `id=`，仅把替换进去的 ID 编码；不要对 JSON body 默认编码，否则 `/`、中文等原始 ID 会被改变。

`responseType` 默认是 `json`。声明式 App API 只允许三个可验证的文本响应分支：影视 `play` 返回媒体直链、小说 `reader` 返回正文文本、漫画 `reader` 返回 JSON 字符串/数组或按换行（也兼容 `&&`）分隔的图片地址。列表、详情、目录等需要结构化字段的阶段若声明 `responseType: "text"`，`compose` 会直接拒绝，避免静默生成空数据。

只输出源代码时：

```powershell
node .\scripts\aibox-skill-cli.mjs compose --input-file .\source-spec.json --code-only
```

## 6. L1 静态检查

```powershell
node .\scripts\aibox-skill-cli.mjs lint --code-file .\output\source.js
```

`lint` 读取或解密源码，检查语法、AST、重复键、header、模板、继承、二级字典、请求输入和播放契约，不执行站点源码。

## 7. L1/L2/L3 实跑

只运行结构检查：

```powershell
node .\scripts\aibox-skill-cli.mjs check --code-file .\output\source.js --level l1
```

执行单接口真实验证：

```powershell
node .\scripts\aibox-skill-cli.mjs check --code-file .\output\source.js --level l2 --engine auto
```

执行真实 ID 完整链路：

```powershell
node .\scripts\aibox-skill-cli.mjs check --code-file .\output\source.js --level l3 --engine auto
```

引擎选项：

- `auto`：优先原生 Aibox 引擎，无法使用时再 fallback。
- `native`：只接受原生引擎结果。
- `portable`：使用近似便携 runtime，结果不能单独作为正式上传门禁。

小说 L3 检查首末章正文；漫画 L3 检查首末章首尾图片文件头；影视 L3 检查至少一条真实播放链。

## 8. 局部选择器调试

对已抓取内容调试 `pdfa/pdfh/pd`，必须同时给出 `--mode` 和 `--rule`：

```powershell
node .\scripts\aibox-skill-cli.mjs debug-selector --content-file .\samples\home.html --mode pdfa --rule ".list&&li"
node .\scripts\aibox-skill-cli.mjs debug-selector --content-file .\samples\home.html --mode pdfh --rule "h3&&Text" --base-url "https://example.com"
```

选择器局部成功只算调试证据，不能代替 L2/L3。

## 9. 生成修复补丁

默认只输出候选 diff，不改原文件：

```powershell
node .\scripts\aibox-skill-cli.mjs heal --code-file .\output\source.js
```

确认补丁后才写入：

```powershell
node .\scripts\aibox-skill-cli.mjs heal --code-file .\output\source.js --apply
```

`heal` 只修复有静态或真实响应证据的问题，不猜测搜索地址、headers、分类或模板。

## 10. 原子保存与版本递增

```powershell
node .\scripts\aibox-skill-cli.mjs save --code-file .\output\source.js --file-name source.js
```

覆盖并递增 patch：

```powershell
node .\scripts\aibox-skill-cli.mjs save --code-file .\output\source.js --file-name source.js --output-dir .\drpy-node\spider\js --overwrite --bump patch
```

`--bump` 支持 `patch`、`minor`、`major`。保存采用临时文件、回读校验和原子替换，失败时保留原文件。

## 11. 云1 单源分享

```powershell
node .\scripts\aibox-skill-cli.mjs share --code-file .\output\source.js --name 源名称 --category comic --group-tag 漫画
```

只验证编码和分享码形态：

```powershell
node .\scripts\aibox-skill-cli.mjs share --code-file .\output\source.js --name 源名称 --category comic --group-tag 漫画 --dry-run
```

上传后复制分享码：

```powershell
node .\scripts\aibox-skill-cli.mjs share --code-file .\output\source.js --name 源名称 --category comic --group-tag 漫画 --copy
```

## 12. 云G1 分组分享

```powershell
node .\scripts\aibox-skill-cli.mjs share --group-file .\group.json --name 漫画分组 --category comic --group-tag 漫画
```

默认先执行必要校验，并在上传后回读核对字节数和 SHA-256：

- `--force`：显式越过失败门禁，并在结果中标记 `forced: true`。
- `--no-verify`：显式关闭上传后回读验证，只用于受控诊断。
- 分组任一单项失败时，不能报告整组成功。

## 13. 手动便携 Runtime

正常检查优先使用 `check --engine auto`。只有排查便携 runtime 本身时才手动启动，默认选择随机空闲端口：

```powershell
node .\scripts\aibox-skill-cli.mjs runtime start
node .\scripts\aibox-skill-cli.mjs runtime stop
```

CLI 只停止由本 Skill 创建且状态信息匹配的 runtime，不接管任意现有 Node 服务。

## 旧命令

`compose-rule`、`validate-rule`、`check-syntax`、`live-check`、`live-heal`、`save-rule`、`upload-clipboard`、`drpy-doctor` 等仅作为 deprecated alias 保留。新文档和新自动化只使用本页主命令。
