# 架构与数据流

本项目把 B 站视频已有的中文字幕保存为可编辑文件，再按需生成带原片跳转链接的忠实全文。不下载媒体，不做语音识别、摘要或外语翻译。本文说明系统如何组成；为什么这样划分、接受什么代价，见 [架构决策](adr/README.md)；术语见 [GLOSSARY](../GLOSSARY.md)，使用与效果见 [主 README](../README.md)。

## 一条工作流，两种持久产物

```text
BV 号 / 视频链接 + 分 P
  │
  └─ 下载：视频信息 → 字幕轨道 → 中文字幕正文
       │ 零模型调用
       ▼
     原始字幕 Markdown（YAML 元数据 + 逐行时间文本）
       │ 可检查、编辑、跨会话或跨入口复用
       │ 用户按需发起润色
       ▼
     结构阶段：全文 → 文章标题、章节标题与字幕 id 起点
       │ 校验并计算章节范围
       ▼
     正文阶段：章节结构 + 按章组织的全文 → 各章正文
       │ 一次全文请求覆盖全部章节
       ▼
     代码校验、计算时间链接、组装 Markdown
       │ 复核输入字节未变，原子非覆盖保存
       ▼
     润色文章 Markdown
```

下载与润色是两个独立操作，只有润色调用模型。下载保存来源元数据与当时的统计快照，润色直接继承这份快照，不再重新抓取。文件格式与字段约束只有一份规范：[Core README](../packages/core/README.md#原始字幕格式)；示例集中在 [主 README](../README.md#你能拿到什么从碎台词到可读文章)。

章节按从 1 开始的字幕 id 划分，同一秒可以有多条字幕。结构阶段只返回边界，正文阶段返回与边界对应的文本；结束边界、章节 id、时间链接、文章标题与元数据都由代码计算。每阶段在 JSON 解析或结构校验失败时最多做一次格式修复，所以一次润色通常调用两次 core 阶段、最多四次。网络或上游失败直接报错，不进入格式修复；跨运行不保留阶段缓存，也不支持续跑。

结构校验检查范围、顺序与结果形状；正文是否忠实、有无遗漏由生成过程与人工复核负责，字幕本身也不包含画面信息。两阶段全文请求受上下文长度、输出上限和费用约束。相关取舍见 [0001 工作流分离](adr/0001-separate-download-and-polish.md)、[0002 两阶段全文处理](adr/0002-two-stage-full-transcript-polishing.md) 与 [0003 原片跳转](adr/0003-video-links-from-subtitle-boundaries.md)。

## 一个 core，三个入口

多 Agent 指同一套 core 同时服务三个宿主入口，core 内部只跑一条工作流。

```text
Pi 工具 / 扫码命令      dsh 工具 / Web 配置      独立 bili-subs / 通用 Skill
          │                    │                         │
          └──────────── 各自适配宿主能力 ──────────────────┘
                         │
              配置、模型认证与流、文件权限、凭据、交互
                         │
                         ▼
       core：下载、格式解析、两阶段编排、校验、渲染、产物保存
```

| 包 | 负责什么 | 运行与依赖边界 |
| --- | --- | --- |
| [core](../packages/core/README.md) | 宿主无关的工作流与数据规则 | 编译 ESM 与声明；对外只暴露包根及 `./prompts/*`；不依赖宿主 SDK |
| [Pi](../packages/pi/README.md) | 工具、命令、会话模型与认证、终端交互 | 宿主直接加载 `src/index.ts`，通过 peer 使用 Pi 能力 |
| [dsh](../packages/dsh/README.md) | 工具、服务端模型 / 凭据 / 文件权限、Web 扫码配置 | 服务端编译，Web 客户端为 `client.js`；秘密与写盘权限留在服务端 |
| [CLI](../packages/cli/README.md) | 独立命令、用户配置、终端交互与模型协议 | 编译 `dist/main.js`；依赖 core 与 pi-ai，不需要 Pi Agent 宿主 |

core 通过 `StageClient` 接收模型文本与用量，通过 `ModelInfo` 接收展示信息，通过 `FileStore`、`MutationQueue` 适配文件能力；模型选择、密钥读取和思考等级解释都在适配层。相对源码导入写 `.js` 后缀，因为 Node 只剥离项目内的 TypeScript，不处理已安装包里的。monorepo 统一维护契约与回归测试，各包独立版本、独立发布；详见 [0004 共享 core](adr/0004-host-independent-core.md) 与 [0005 包组织](adr/0005-monorepo-with-independent-packages.md)。

各入口的差异与理由见 [0007 Pi](adr/0007-pi-host-integration.md)、[0008 dsh](adr/0008-dsh-server-owned-capabilities.md)、[0009 CLI](adr/0009-standalone-cli-with-protocol-adapters.md)。参数与命令见各包 README。

## 模型与信任边界

- Pi / dsh 可以继承会话模型，也可以单独配置；CLI 使用自己的模型连接。两个阶段和格式修复共用一个客户端，请求只带字幕、元数据与提示词，不带主对话历史，见 [0006 独立模型](adr/0006-independent-polishing-model.md)。
- 润色会把字幕全文、相关元数据与提示词发送给所选模型提供方；B 站 Cookie 只用于 B 站请求。字幕和文章里的指令按数据处理，不构成执行工具的授权。
- Cookie 由各入口自己的用户级存储管理：下载请求只发往 B 站 API，字幕 CDN 请求不带 Cookie，重定向逐跳校验。精确目标、凭据路径、文件权限与安全限制以 [SECURITY](../SECURITY.md) 为准；[协议调研](research/bilibili-subtitle-protocol.md) 记录接口的实测行为，接口本身由 B 站控制。
- 原始字幕与文章都走原子非覆盖保存，保存前复核输入字节。复核不锁住输入，也不构成跨文件事务；路径检查限于相对工作目录的字面越界，符号链接逃逸需要外层沙箱，见 [0013](adr/0013-atomic-non-overwriting-artifacts.md)。

## 失败与资源消耗

适配器把不完整流、截断、工具调用和异常终态统一转换为公共错误，只有完整结果才算正文成功。对外只提供固定安全消息与受控诊断，原始上游异常留在本地，见 [0011](adr/0011-public-errors-and-safe-diagnostics.md)。

失败、取消和格式修复同样累计已报告用量。`unknown` / `partial` / `complete` 只描述 core 从适配器收到的报告，供应商账单可能更完整；CLI 经 pi-ai 把缺报用量规范化为零，还会抹掉“未报告”与“真实为零”的区别。费用未知不代表免费，见 [0012](adr/0012-reported-usage-and-unknown-cost.md)。

core 的格式修复与上游重试是两套机制：CLI 显式关闭自动重试，dsh 适配器不额外重试；Pi 向宿主传 `maxRetries: 1`，含义由宿主解释。供应商实际请求次数与计费以供应商和宿主为准。

## 继续阅读

- [文档导航](README.md)：按使用、设计、维护目标查找资料。
- [架构决策索引](adr/README.md)：从整体到细节阅读当前设计的理由与代价。
- [贡献指南](../CONTRIBUTING.md)：代码入口、测试方法和修改约束。
- [发布指南](publishing.md)：唯一的按包发布操作说明。
