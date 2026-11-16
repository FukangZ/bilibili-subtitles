---
status: accepted
---

# 用宿主无关 core 支持多个 Agent 入口

## 为什么不只提供一个宿主插件

字幕收集和全文阅读既可能发生在 Pi，也可能发生在 DeepSeek Harness（dsh）或其他 Coding Agent 中。业务规则不应随着用户选择的宿主变化，因此项目提供 Pi、dsh 原生适配与独立 CLI；其他 Agent 可以调用 CLI，不必各自复制字幕处理代码。

这里的“多 Agent 支持”是**同一能力接入不同宿主**，不是在 core 中运行多个协作 Agent。项目也不承担主 Agent 的规划、批量调度或后续阅读任务。

## 为什么抽出 core，而不是复制插件

各入口统一调用 core 的下载与润色流程。core 拥有字幕格式、章节校验、两阶段编排、文章渲染和产物保存规则；适配器拥有模型选择、认证、流协议、文件权限和界面。复制插件容易让格式和失败行为分叉；反过来让 core 依赖某个宿主 SDK，会迫使其他入口携带无关运行环境。

依赖通过窄接口注入：`StageClient` 返回完整文本和可选用量，`ModelInfo` 只描述已选择的模型，`FileStore` 与 `MutationQueue` 接入存储和写入协调。core 不读取模型密钥、不解释思考能力，也不自行取得宿主权限。

## 代价与边界

需要维护公共契约，并在适配器中转换不同宿主的结果与失败。各端能观测的上游信息不完全一致，统一接口不代表能力完全相同。

core 是 Node.js ESM 库，不是浏览器通用库；默认文件实现可以使用 Node 文件系统。宿主有文件策略时必须显式注入实现，不能失败后退回直接写盘。只公开包根和提示词资源，避免适配器依赖内部 helper 后绕过流程约束。

包关系见 [架构总览](../architecture.md)，公共接口见 [Core README](../../packages/core/README.md)。关键边界由 `packages/core/src/index.ts`、`packages/core/src/model.ts` 和 `packages/core/tests/boundary.test.ts` 表达。
