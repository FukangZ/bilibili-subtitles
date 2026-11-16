# 文档导航

第一次接触项目，先看 [主 README](../README.md) 的效果与安装入口。下面的文档按读者要解决的问题组织。

## 使用与集成

| 目标 | 入口 |
| --- | --- |
| 看原始字幕、润色文章和视频链接的效果 | [主 README](../README.md#你能拿到什么从碎台词到可读文章) |
| 在终端或通用 Coding Agent 中使用 | [CLI 与通用 Skill](../packages/cli/README.md) |
| 在 Pi 中使用 | [Pi 扩展](../packages/pi/README.md) |
| 在 DeepSeek Harness 中使用 | [dsh 插件](../packages/dsh/README.md) |
| 在代码中集成，或确认文件格式与公共 API | [Core README](../packages/core/README.md) |

## 理解设计

[架构与数据流](architecture.md) 说明系统由哪些部分组成，[架构决策索引](adr/README.md) 逐条说明当前选择及其代价：

1. 下载与润色为何独立，两阶段全文处理为何按章节组织，为什么保留原片跳转。
2. 为什么支持多个宿主、抽出 core、采用 monorepo，又允许独立选择润色模型。
3. Pi、dsh、CLI 各自怎样适配宿主能力，接受哪些限制。
4. 凭据、错误、用量与文件保存的安全和可靠性取舍。

术语以根目录 [GLOSSARY](../GLOSSARY.md) 为准。

## 贡献与维护

- [CONTRIBUTING](../CONTRIBUTING.md)：环境准备、代码入口、测试、修改约束与交付要求。
- [SECURITY](../SECURITY.md)：报告问题、秘密存储、网络与文件信任边界。
- [按包发布](publishing.md)：构建与发布门禁、独立版本及发布操作的唯一说明。
- [B 站字幕协议调研](research/bilibili-subtitle-protocol.md)：字幕接口当前实际行为的记录。该接口由 B 站自行控制，可能随时调整，排查时以代码和实测为准。

## 文档归属

每个事实只在一处展开，其余位置用链接引用，避免多份说明各自漂移：使用方式归对应包 README，格式与 API 归 core，整体组成归架构总览，设计理由归 ADR，安全约束归 SECURITY，操作流程归贡献与发布指南。修改前先定位该事实的归属文档。
