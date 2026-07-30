import fs from 'node:fs';
import path from 'node:path';

export function createKnowledgeBase(rootDir) {
  const resources = [
    {
      uri: 'aibox://knowledge/drpy-rule-playbook',
      name: 'drpy-rule-playbook',
      description: 'drpy-node 写源核心字段、页面处理函数与常见结构约定。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'drpy-rule-playbook.md'),
    },
    {
      uri: 'aibox://knowledge/source-writing-workflow',
      name: 'source-writing-workflow',
      description: 'skill 内置的标准写源流程。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'source-writing-workflow.md'),
    },
    {
      uri: 'aibox://knowledge/comic-image-proxy-playbook',
      name: 'comic-image-proxy-playbook',
      description: '漫画源图片代理、防盗链、AES 解密与 live-check 图片探测经验。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'comic-image-proxy-playbook.md'),
    },
    {
      uri: 'aibox://knowledge/comic-source-development-playbook',
      name: 'comic-source-development-playbook',
      description: '漫画源分类筛选、动态 API、鉴权、详情目录、章节 ID、图片协议、回退与 Android 真机验收手册。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'comic-source-development-playbook.md'),
    },
    {
      uri: 'aibox://knowledge/comic-app-api-scramble-retrospective',
      name: 'comic-app-api-scramble-retrospective',
      description: '漫画 App API + WebP 切片还原复盘：分类筛选、AES 加解密、scramble 算法、webp-wasm/jpeg-js 真机解码与引擎打包验收。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'comic-app-api-scramble-retrospective.md'),
    },
    {
      uri: 'aibox://knowledge/content-type-runtime-validation',
      name: 'content-type-runtime-validation',
      description: '影视、小说、漫画在 App 中的详情目录、正文、图片协议和分类型 full live-check 验收标准。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'content-type-runtime-validation.md'),
    },
    {
      uri: 'aibox://knowledge/magnet-bt-source-playbook',
      name: 'magnet-bt-source-playbook',
      description: '磁力 / BT 站点写源、magnet/torrent lazy 直返、本地 Go BT 引擎播放下载对接经验。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'magnet-bt-source-playbook.md'),
    },
    {
      uri: 'aibox://knowledge/selector-cheatsheet',
      name: 'selector-cheatsheet',
      description: '选择器、字段映射与抓包分析速查。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'selector-cheatsheet.md'),
    },
    {
      uri: 'aibox://knowledge/drpy-basic-format-grammar',
      name: 'drpy-basic-format-grammar',
      description: 'drpy 最基础的字符串规则格式、选择器语法、全局函数与 Guardrails。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'drpy-basic-format-grammar.md'),
    },
    {
      uri: 'aibox://knowledge/source-quality-checklist',
      name: 'source-quality-checklist',
      description: '生成规则后的自检清单。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'source-quality-checklist.md'),
    },
    {
      uri: 'aibox://knowledge/captcha-ocr-playbook',
      name: 'captcha-ocr-playbook',
      description: '验证码 / 安全验证场景下的 drpy-node 内置 OCR 处理策略。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'captcha-ocr-playbook.md'),
    },
    {
      uri: 'aibox://knowledge/dynamic-host-playbook',
      name: 'dynamic-host-playbook',
      description: '发布页 / 动态域名 / 多候选域名自动切换的 drpy 写法。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'dynamic-host-playbook.md'),
    },
    {
      uri: 'aibox://knowledge/app-template-notes',
      name: 'app-template-notes',
      description: 'APP 模板源的使用说明。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'knowledge', 'app-template-notes.md'),
    },
    {
      uri: 'aibox://knowledge/external-resources',
      name: 'external-resources',
      description: 'zyfun 等外部写源资料索引，仅在本地知识不足或需要交叉核对 T1-T4 概念时读取。',
      mimeType: 'text/markdown',
      filePath: path.join(rootDir, 'references', 'external-resources.md'),
    },
    {
      uri: 'aibox://template/ds-template',
      name: 'ds-template',
      description: '最终 ds 源输出骨架，优先按模板填空。',
      mimeType: 'application/javascript',
      filePath: path.join(rootDir, 'template', 'ds_template.js'),
    },
  ];

  resources.push(...discoverUnregisteredResources(rootDir, resources));

  const resourceTemplates = [
    {
      uriTemplate: 'aibox://knowledge/{name}',
      name: 'knowledge-by-name',
      description: '按名称读取 Aibox 知识文档，例如 aibox://knowledge/drpy-rule-playbook。',
      mimeType: 'text/markdown',
    },
    {
      uriTemplate: 'aibox://template/{name}',
      name: 'template-by-name',
      description: '按名称读取 canonical 模板，例如 aibox://template/ds-template。',
      mimeType: 'application/javascript',
    },
  ];

  return {
    listResources() {
      return resources.map(({ filePath, ...item }) => item);
    },
    listResourceTemplates() {
      return resourceTemplates;
    },
    readResource(uri) {
      const resource = resources.find((item) => item.uri === uri);
      if (!resource) {
        throw new Error(`资源不存在: ${uri}`);
      }
      const text = fs.readFileSync(resource.filePath, 'utf8');
      return {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text,
      };
    },
    listPrompts() {
      return [
        {
          name: 'auto_write_drpy_source',
          description: '生成本地 skill 版自动写源提示词，串起知识资源、内容分析、规则生成与校验命令。',
          arguments: [
            { name: 'site_name', description: '站点名称', required: true },
            { name: 'host', description: '站点域名或接口根地址', required: true },
            { name: 'content_type', description: 'video/novel/comic', required: false },
            { name: 'source_kind', description: 'html/json/app', required: false },
            { name: 'dynamic_host', description: '是否存在发布页 / 动态域名 / 备用网址页', required: false },
          ],
        },
        {
          name: 'repair_drpy_source',
          description: '生成写源调试 / 修复提示词。',
          arguments: [
            { name: 'site_name', description: '站点名称', required: true },
            { name: 'error_log', description: '错误日志或报错信息', required: true },
            { name: 'dynamic_host', description: '是否怀疑旧域失效或发布页跳转', required: false },
          ],
        },
      ];
    },
    getPrompt(name, args = {}) {
      if (name === 'auto_write_drpy_source') {
        return buildAutoWritePrompt(args);
      }
      if (name === 'repair_drpy_source') {
        return buildRepairPrompt(args);
      }
      throw new Error(`Prompt 不存在: ${name}`);
    },
  };
}

function discoverUnregisteredResources(rootDir, registered) {
  const knownPaths = new Set(registered.map((item) => path.resolve(item.filePath).toLowerCase()));
  const knownUris = new Set(registered.map((item) => item.uri));
  const candidates = [
    ...walkFiles(path.join(rootDir, 'references'), (filePath) => /\.md$/i.test(filePath)).map((filePath) => ({ namespace: 'knowledge', filePath })),
  ];
  const discovered = [];
  for (const candidate of candidates) {
    const resolvedPath = path.resolve(candidate.filePath);
    if (knownPaths.has(resolvedPath.toLowerCase())) continue;
    const baseName = path.basename(candidate.filePath, path.extname(candidate.filePath));
    let name = baseName;
    let uri = `aibox://${candidate.namespace}/${name}`;
    if (knownUris.has(uri)) {
      const relative = path.relative(path.join(rootDir, candidate.namespace === 'knowledge' ? 'references' : path.join('assets', 'examples')), candidate.filePath);
      name = relative.slice(0, -path.extname(relative).length).split(path.sep).join('-');
      uri = `aibox://${candidate.namespace}/${name}`;
    }
    knownPaths.add(resolvedPath.toLowerCase());
    knownUris.add(uri);
    discovered.push({
      uri,
      name,
      description: `自动发现的 Aibox ${candidate.namespace === 'knowledge' ? '写源知识文档' : '规则示例'}：${name}`,
      mimeType: mimeTypeFor(candidate.filePath),
      filePath: candidate.filePath,
    });
  }
  return discovered;
}

function walkFiles(rootDir, predicate) {
  if (!fs.existsSync(rootDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, predicate));
    } else if (!predicate || predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md') return 'text/markdown';
  if (ext === '.js' || ext === '.mjs') return 'application/javascript';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

function buildAutoWritePrompt(args) {
  const siteName = args.site_name || '未命名站点';
  const host = args.host || '';
  const contentType = args.content_type || 'video';
  const sourceKind = args.source_kind || 'html';
  const dynamicHost = /^(1|true|yes|是|动态|发布页)$/i.test(String(args.dynamic_host || ''));

  return {
    description: 'Aibox skill 自动写源提示词',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `请为站点“${siteName}”生成一份 drpy-node 规则。站点地址：${host}，内容类型：${contentType}，源类型：${sourceKind}。

请严格按下面顺序工作：
1. 先阅读：
- aibox://template/ds-template
- aibox://knowledge/drpy-rule-playbook
- aibox://knowledge/source-writing-workflow
- aibox://knowledge/drpy-basic-format-grammar
- aibox://knowledge/selector-cheatsheet
- aibox://knowledge/source-quality-checklist
- 如果内容类型是 comic / 漫画，先额外阅读 aibox://knowledge/comic-source-development-playbook
- 如果漫画出现封面不显示、pics:// 图片空白、AES 图片解密、proxy_rule、图片防盗链，再额外阅读 aibox://knowledge/comic-image-proxy-playbook
- 如果内容类型是 novel / 小说或 comic / 漫画，再额外阅读 aibox://knowledge/content-type-runtime-validation
- 如果站点提供 magnet、.torrent、BT、磁力、动漫种子、蜜柑 / Mikan / Nyaa 资源，再额外阅读 aibox://knowledge/magnet-bt-source-playbook
- 如页面出现验证码 / 安全验证 / 反爬页，再额外阅读 aibox://knowledge/captcha-ocr-playbook
- 如入口是发布页、备用网址页、Loading 跳转壳、静态桶页面或旧域失效，再额外阅读 aibox://knowledge/dynamic-host-playbook
2. 先运行本地命令 plan-workflow，列出要抓的页面和接口。
3. 如果当前环境带浏览器工具，优先抓首页、分类页、详情页、搜索页、播放页源码；否则再用 fetch-web-source 抓静态 HTML 或接口返回。${dynamicHost ? '\n动态域名补充动作：先抓发布页 HTML、发布页脚本和候选业务域首页，规则里要实现候选域发现、缓存和失败自动切换。' : ''}
4. 对抓到的 HTML / JSON 运行 analyze-content，整理选择器、数组路径、字段路径、分页和搜索参数。
5. 如果任意页面命中“系统安全验证 / 输入验证码 / 安全验证 / 验证码 / captcha / verify”等标记：
- 优先复用 drpy-node 自带的 getHtml、verifyCode、setItem(RULE_CK) 和 OcrApi
- 搜索能写成字符串规则时，优先补 搜索验证标识
- 首页 / 分类 / 详情 / 搜索使用 async function 时，必须生成统一的验证码包装函数，不要继续裸用 request(input)
- JSON / API 规则如果返回 HTML 验证页，要先做验证码检测与重试，再 JSON.parse
6. 对不确定的选择器片段运行 debug-rule。
7. 运行 compose-rule 生成规则草稿。
8. 运行 validate-rule 和 check-syntax 检查缺失字段、语法问题和 VM 可执行性。
9. 运行 live-check --depth full：影视验证播放；小说验证详情目录与首末章正文；漫画验证详情目录、封面和首末章图片文件头。
10. full live-check 通过后再决定是否 save-rule。

输出要求：
- 先给出抓到的页面结构结论
- 再说明是否存在验证码 / 安全验证，以及你采用的处理策略
- 再给出完整规则代码
- 最后给出校验结论与剩余人工复核点`,
        },
      },
    ],
  };
}

function buildRepairPrompt(args) {
  const siteName = args.site_name || '未命名站点';
  const errorLog = args.error_log || '无';
  const dynamicHost = /^(1|true|yes|是|动态|发布页)$/i.test(String(args.dynamic_host || ''));

  return {
    description: 'Aibox skill 写源修复提示词',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `请修复站点“${siteName}”的 drpy 规则问题。当前错误信息如下：

${errorLog}

请执行：
1. 先阅读 aibox://knowledge/source-quality-checklist、aibox://knowledge/drpy-basic-format-grammar 和 aibox://knowledge/selector-cheatsheet。
2. 再阅读 aibox://template/ds-template，确认当前规则缺的是结构还是页面特化。
3. 如果日志、源码或页面表现里出现验证码 / 安全验证 / 搜索空白页，再额外阅读 aibox://knowledge/captcha-ocr-playbook。
4. 如果 host 失效、入口只返回 Loading / 发布页 / 备用网址页、旧域 404 或需要第一候选失败后自动换第二候选，再额外阅读 aibox://knowledge/dynamic-host-playbook。${dynamicHost ? '\n动态域名补充动作：优先检查是否把发布页域错误当成业务域，补候选域发现、validator 健康检查、成功域缓存和失败刷新。' : ''}
5. 如规则类型是小说或漫画，先阅读 aibox://knowledge/content-type-runtime-validation；漫画源必须再阅读 aibox://knowledge/comic-source-development-playbook，图片空白、AES 解密、proxy_rule 或防盗链时继续阅读 aibox://knowledge/comic-image-proxy-playbook。
6. 如问题涉及 magnet、.torrent、BT、磁力、种子播放或下载命名，再额外阅读 aibox://knowledge/magnet-bt-source-playbook。
7. 先运行 validate-rule 对当前规则做结构检查，再运行 check-syntax 看是否有纯语法错误。
8. 如果是页面结构变化，重新抓对应页面源码，再运行 analyze-content 和 debug-rule。
9. 如果命中验证码场景，优先检查是否仍在裸用 request(input)，并改成 drpy-node 内置 OCR 自动验证链路。
10. 如果是 BT 源，检查 lazy 是否对 magnet / .torrent 返回 { parse: 0, url }，并确认 vod_play_url 没有未转义的 # 或 $。
11. 修复后运行 live-check --depth full：小说必须通过目录与首末章正文，漫画必须通过目录、封面与首末章图片文件头。
12. 漫画还要确认最终引擎响应仍为 parse:0 + pics://；云分享或设备覆盖后核对实际源文件哈希与模块缓存。
13. 重新生成完整规则，再次校验，并明确说明本次修了哪些字段、选择器、图片代理、验证码处理或 BT 对接逻辑。`,
        },
      },
    ],
  };
}
