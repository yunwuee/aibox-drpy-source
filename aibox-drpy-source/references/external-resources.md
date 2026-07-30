# 外部写源参考

只在 Skill 本地 reference 无法覆盖问题，或需要交叉核对 T1-T4 通用写源概念时读取本文件。外部文档不能替代目标 AIBOX 版本的引擎代码、真实接口证据和设备验收结果。

## zyfun

- 文档首页：[zyfun](https://zy.catni.cn/zh-CN/)
- 官方仓库：[Hiram-Wong/zyfun](https://github.com/Hiram-Wong/zyfun)
- 写源语法：[写源语法](https://zy.catni.cn/zh-CN/source/grammar.html)，用于对照 T1-T4 数据结构、字段和基础规则表达。
- 写源工具：[写源工具](https://zy.catni.cn/zh-CN/source/ide.html)，用于了解外部调试工具和人工验证入口。
- 静态筛选：[静态筛选](https://zy.catni.cn/zh-CN/source/sift.html)，用于补充筛选项组织与展示思路。
- 数据爬虫：[数据爬虫](https://zy.catni.cn/zh-CN/source/spider.html)，用于补充数据采集和调试流程。
- 常见技巧：[常见技巧](https://zy.catni.cn/zh-CN/source/skill.html)，用于排查常见写源问题和实现选择。

zyfun 官方仓库由 GitHub 标识为 AGPL-3.0。只引用公开文档进行学习和交叉核对，不复制、打包或再分发其代码和文档。

## 使用原则

1. 先读取本 Skill 对应的本地 reference，再决定是否需要外部参考。
2. 将外部结论视为候选证据，不假设 zyfun、其他 T1-T4 客户端与 AIBOX 的运行时语义完全一致。
3. 对字段、选择器、协议、模板和播放行为，回到目标站点响应及当前 AIBOX 引擎验证。
4. 引用外部代码或文档片段前，先核对原项目许可证、版权声明和允许范围。
5. 外部站点不可访问时继续使用本地知识库，不因此猜造接口、字段或测试结果。
