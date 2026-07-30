# 验证码 / OCR 处理手册

## 适用场景

当目标站点在以下页面返回验证码、安全验证或反爬页时，优先使用这套方案：
- 首页
- 分类页
- 详情页
- 搜索页
- JSON / API 接口实际返回 HTML 验证页

常见标记词：
- `系统安全验证`
- `输入验证码`
- `安全验证`
- `验证码`
- `captcha`
- `verify`

## 优先复用 drpy-node 自带能力

这套 skill 生成规则时，优先复用 drpy-node 已有实现，而不是重新发明一套 OCR 流程：

- `getHtml(url)`：按规则请求页面，自动带入历史 `cookie`，并复用通用取页逻辑。
- `verifyCode(url)`：调用站点验证码图片接口，走 OCR 识别，再提交校验，成功后返回新的会话 `cookie`。
- `setItem(RULE_CK, cookie)`：把通过验证后的 `cookie` 持久化到规则上下文。
- `OcrApi.classification(img)`：将验证码图片 `base64` 发送到 OCR 接口并返回识别文本。
- `OCR_API`：默认对齐 drpy-node 原项目，为 `https://api.nn.ci/ocr/b64/text`。
- `OCR_RETRY`：默认对齐 drpy-node 原项目，为 `3` 次。
- `搜索验证标识`：给字符串型 `搜索` 规则提供验证码命中标记，便于 drpy-node 通用搜索链路自动处理。

## 默认实现链路

drpy-node 内置验证码处理链路适合老式图片验证码站点，默认思路是：

1. 请求验证码图片接口。
2. 读取响应头里的 `Set-Cookie` 作为会话凭据。
3. 把图片转成 `base64` 发给 `OcrApi` 识别。
4. 将识别结果提交到验证码校验接口。
5. 如果校验成功，保存返回的 `cookie`。
6. 使用 `getHtml(url)` 重新请求原页面。

skill 内置 runtime 已把 `OcrApi`、`OCR_API`、`OCR_RETRY`、`verifyCode` 暴露进规则沙箱；`doctor` 和 L2/L3 报告里也会显示当前 OCR 状态。默认 OCR 配置在 `config/aibox.config.example.json`：

```json
{
  "embeddedDrpy": {
    "ocr": {
      "mode": "http",
      "endpoint": "https://api.nn.ci/ocr/b64/text",
      "timeoutMs": 15000,
      "bodyMode": "auto",
      "responsePath": "",
      "retry": 3
    }
  }
}
```

如果要改成本地 OCR 或其他接口，复制到 `config/aibox.config.json` 后改 `embeddedDrpy.ocr` 即可。`mode: "command"` 时，验证码 base64 会通过 stdin 传入命令；如果 `args` 里包含 `{input}`，则会把 base64 替换到参数中。

## 生成规则时的优先级

### 1. 搜索能写成字符串规则时

优先写字符串型 `搜索`，并补：

```javascript
搜索验证标识: '系统安全验证|输入验证码|安全验证|验证码',
搜索: '.module-search-item;a&&title;img&&src;.module-item-note&&Text;a&&href'
```

这样 drpy-node 的通用搜索链路更容易直接接管验证码处理。

### 2. 首页 / 分类 / 详情 / 搜索用了自定义 async function 时

不要继续裸写：

```javascript
const html = await request(input);
```

而是统一包装成：

```javascript
搜索验证标识: '系统安全验证|输入验证码|安全验证|验证码',
_captchaRule: function () {
  return new RegExp(rule.搜索验证标识, 'i');
},
_fetchHtmlWithCaptcha: async function (url, label) {
  let html = await getHtml(url);
  if (typeof html === 'string' && rule._captchaRule().test(html)) {
    log('[captcha] ' + (label || '页面') + ' 命中验证码，尝试 OCR 自动识别');
    const cookie = await verifyCode(url);
    if (cookie) {
      setItem(RULE_CK, cookie);
      html = await getHtml(url);
    }
  }
  return html;
}
```

然后在 `推荐 / 一级 / 二级 / 搜索` 里统一使用：

```javascript
const html = await rule._fetchHtmlWithCaptcha(input, '搜索页');
```

### 3. JSON / API 站点返回的是 HTML 验证页时

先按文本抓取，再判断是否命中验证码，重试成功后再 `JSON.parse`：

```javascript
const text = await rule._fetchTextWithCaptcha(input, '搜索接口');
const payload = JSON.parse(text);
```

不要直接：

```javascript
const payload = JSON.parse(await request(input));
```

否则一旦接口实际返回 HTML 验证页，就会直接解析报错。

## 什么时候只补标识，什么时候生成 helper

- **只补 `搜索验证标识`**：搜索走字符串规则，且验证码只在搜索链路出现。
- **必须生成 helper**：
  - 首页、分类、详情、搜索任何一个页面用了自定义 `async function`
  - 搜索用了 `async function`
  - 接口站点偶发返回 HTML 验证页
  - 需要在多个页面复用验证码重试逻辑

## 建议输出

只要命中验证码场景，输出时要明确说明：
- 验证码出现在什么页面：首页 / 分类 / 详情 / 搜索 / 接口
- 采用的是“字符串搜索自动链路”还是“自定义 helper 包装链路”
- 使用的验证码标记词是什么
- 是否依赖 drpy-node 内置 `verifyCode`
- 最后是否跑过 `doctor`，并查看 L2/L3 报告中的 OCR 状态

## 限制

这套默认方案主要覆盖“老式图片验证码 + 固定校验接口”的站点，不适合：
- 极验
- 滑块
- Cloudflare 挑战
- 行为验证码
- 需要前端动态 token / 指纹校验的场景

如果站点不属于上述默认链路，应在输出里明确说明“需要自定义反爬处理”，不要误报为已支持。
