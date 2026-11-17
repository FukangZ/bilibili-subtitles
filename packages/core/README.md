# @fukangz/core-bilibili-subtitles

[![npm version](https://img.shields.io/npm/v/@fukangz/core-bilibili-subtitles)](https://www.npmjs.com/package/@fukangz/core-bilibili-subtitles)

宿主无关的核心库：把 B 站长视频整理成带原视频跳转链接的 Markdown 全文，分为下载已有中文字幕（`downloadSubtitle`）和通过调用方接入的大模型润色（`polishTranscript`）两步。CLI、Pi 扩展与 dsh 插件都基于它构建，也可用于二次集成。只处理已有中文字幕，不下载音视频、不做语音识别、不翻译。

效果示例与各宿主的安装入口见 [项目主 README](https://github.com/FukangZ/bilibili-subtitles/blob/main/README.md)。

## 安装与入口

```bash
npm install @fukangz/core-bilibili-subtitles
```

需要 Node.js 22 或更新版本。包入口是编译后的 ESM JavaScript 与 TypeScript 声明，不依赖宿主加载 TypeScript。公共入口为包根；提示词原文可通过 `@fukangz/core-bilibili-subtitles/prompts/*` 读取。不要依赖内部 `dist/` 路径。

## 公共 API

下表列出包根的全部运行时导出及关联类型；类型请用 `import type` 导入。

| 用途 | 运行时导出 | 关联类型 |
| --- | --- | --- |
| 下载 | `downloadSubtitle` | `DownloadResult`、`FetchLike`、`CookieConfig` |
| 润色与提示词 | `polishTranscript`、`validateStructure`、`loadPrompts` | `ModelInfo`、`StageClient`、`StageRequest`、`StageResult`、`PolishResult`、`Outline`、`OutlineSection`、`Prompts` |
| 原始字幕 | `parseTranscriptMarkdown`、`renderTranscriptMarkdown` | `Transcript`、`Segment`、`TrackKind` |
| 配置 | `loadConfig`、`updateConfigFile` | `AppConfig`、`ConfigFile`、`ConfigSources`、`LoadConfigOptions`、`PolishConfig` |
| 登录与二维码 | `loginWithQr`、`encodeQrLines`、`encodeQrModules` | `LoginCookie`、`LoginProgress` |
| 错误与脱敏 | `SubtitleError`、`isSubtitleError`、`redact` | `ErrorCode` |
| 用量 | `addUsage`、`zeroUsage`、`usageStatus` | `Usage`、`UsageCost`、`UsageStatus` |
| 文件存储与写入队列 | `passthroughQueue` | `FileStore`、`MutationQueue` |

`encodeQrLines(url)` 返回 `{ lines, width }`；`width` 是终端占用列数（含留白）。`encodeQrModules(url)` 返回 `{ rows, size }`，`rows` 为不含终端留白的 `0` / `1` 方阵，供 Web 等适配器绘制。

`usageStatus(reportedCalls, attemptedCalls)` 返回 `unknown` / `partial` / `complete`：未报告、部分请求报告、全部请求报告（有效全零也属已报告）。

`FileStore` 是可注入存储契约：`readFile(absolutePath, signal?)` 读取，`createIfAbsent(absolutePath, content, signal?)` 必须原子完整且不覆盖，已存在返回 `false`；不能以普通覆盖写入代替。

除上表外不提供其他导入入口；HTTP 请求、路径处理、字幕归一化和文章渲染等由 `downloadSubtitle` / `polishTranscript` 工作流内部完成。

## 模型适配

core 不解析模型名称、API 密钥或思考强度。适配层实现 `StageClient`，负责认证、流响应、超时、取消和模型错误分类；core 负责结构分析、正文润色、每阶段 JSON 校验与最多一次格式修复，以及非覆盖保存。两阶段均为全文请求，不逐章发起网络请求；core 不重试网络 / 上游失败，是否重试由适配层决定。

```ts
import {
  loadPrompts,
  polishTranscript,
  type StageClient,
} from "@fukangz/core-bilibili-subtitles";

const client: StageClient = {
  async complete({ system, user }, signal) {
    // 在这里接入宿主模型；不要把截断或工具调用当成完整正文。
    return callYourModel({ system, user, signal });
  },
};

const result = await polishTranscript({
  cwd: process.cwd(),
  transcriptPath: ".subtitles/example.md",
  prompts: loadPrompts(),
  client,
  model: { label: "provider/model", warnings: [] },
});
```

`callYourModel` 是需由调用方实现的示意函数，返回 `{ text, usage? }`。`complete(request, signal?)` 的每次调用都会收到取消信号，包括 JSON 修复。`model.thinking` 可选，只用于结果与文章元数据展示。

`StageRequest` 的可选字段 `context: { stage: "structure" | "body"; attempt: 1 | 2 }` 标明当前阶段与尝试次数：首请求为 `1`，格式修复为 `2`。它只供适配层诊断，发给模型的仍只有 `system` 与 `user`。

模型失败时，诊断信息放在 `SubtitleError.details.diagnostic`（没有单独导出的类型），适配层只填写校验过的字段：`stage`（`structure` / `body`）、`attempt`（`1` / `2`）、`operation`（`prepare` / `stream` / `validate`）、`reason`（`timeout` / `upstream` / `invalid_output`）。字段均可缺省；不要借此透出原始异常、任意 `details` 或 `cause`。两次 JSON/章节校验都失败时，core 抛出的 `INVALID_MODEL_OUTPUT` 带有对应 `stage`、`attempt: 2`、`operation: "validate"` 和 `reason: "invalid_output"`。安全要求见 [SECURITY](https://github.com/FukangZ/bilibili-subtitles/blob/main/SECURITY.md)。

`Usage` 的 token 基础字段必填：`input` 是非缓存输入，`cacheRead`/`cacheWrite` 是单列的缓存输入，`output` 包含推理 token，`reasoning` 是其中的可选明细，不应重复相加。`totalTokens` 保留适配层报告的总量。费用等细节可选，未报告的费用保持未知，不伪造为零。`SubtitleError.usage` 包含失败前已报告的用量，包括失败请求和 JSON 修复。宿主需要强制费用字段时，在适配边界转换。`usageStatus` 只反映适配层报告了什么，不能证明供应商的用量报告齐全。

## 配置与文件安全

- `loadConfig({ userFile, projectFile?, projectTrusted, extend? })` 处理普通配置中的 `polish.timeoutMs`；模型字段由适配层的 `extend({ user, project })` 校验。
- 不可信项目文件完全不读取；可信项目文件也不得包含 `cookie`。`CookieConfig` 由适配层传给 `downloadSubtitle`，core 不读取或持久化凭据。输出默认固定为 `.subtitles`，字幕语言轨道采用 core 内置排序。
- `updateConfigFile({ file, label, signal?, update, messages? })` 为宿主普通配置写入提供安全原子更新流程；回调接收现有 JSON 对象（文件不存在时为空对象），必须返回 JSON 对象。可通过 `messages` 定制 `notFile`、`invalidJson`、`invalidObject`、`readFailure` 和 `saveFailure` 文案；并发更新的串行化由调用方负责。
- `downloadSubtitle`、`polishTranscript` 仅接受相对传入 `cwd` 且规范化后无字面越界的输入/输出路径，重复输出自动编号，不覆盖已有文件或原始字幕。默认 Node 实现不防护工作目录内的符号链接逃逸，不构成隔离沙箱；保存前输入复核也不构成跨文件事务。
- 下载请求仅向 B 站 API 发送 Cookie；字幕正文只允许 HTTPS `hdslb.com` 及其子域，重定向逐跳验证且不携带 Cookie。
- `loginWithQr` 提供扫码协议；`encodeQrLines` 提供终端二维码行和列宽，不负责终端交互。适配层应依据错误码补充宿主自己的修复命令。

## 原始字幕格式

原始字幕是 YAML front matter 加逐行时间文本，不是 JSON。润色文章的 `kind` 不同，不能再次当作原始字幕传入。

- `schemaVersion: 1`，`kind: bilibili-subtitle`。
- `sourceUrl` 中的 BV 号、分 P 必须与 `bvid`、`page` 一致。分 P、总分 P、语言、轨道、标题等由下载代码填充；`aid`、`cid` 可选。
- `trackKind` 为 `human`、`ai` 或 `unknown`。`publishedAt`、`statsFetchedAt` 如有则为 ISO 8601 UTC（以 `Z` 结尾）。
- 作者及互动统计可缺省；统计仅在 API 返回非负安全整数时写入，保留 `0`，代表下载时的快照，不会自动刷新。
- 每条非空字幕一行，如 `65:03 台词文本`。分钟为累计分钟数，起始时间向下取整到秒，必须单调不减，允许同秒多条；不保存结束时间。
- 润色输入只接受 `kind: bilibili-subtitle` 且语言为中文。`kind: bilibili-polished-article` 或旧 JSON 都无效。

## 润色文章元数据

Pi、CLI 与 dsh 共用文章渲染器。文章采用 YAML front matter，`schemaVersion: 1`、`kind: bilibili-polished-article`。

- 保留文章标题 `title`、原视频标题 `videoTitle`、`bvid`、`page`、`pageTitle`、`language`、`trackKind`；原始字幕的 `sourceUrl` 在文章中名为 `source`。
- 原样继承作者 `authorName`、`authorMid` 和视频发布时间 `publishedAt`，以及 `viewCount`、`danmakuCount`、`replyCount`、`favoriteCount`、`coinCount`、`shareCount`、`likeCount`。字段有值才写入，缺失时省略，数值 `0` 保留；旧字幕无需补齐字段即可润色。
- `statsFetchedAt` 原样继承，说明统计快照的采集时间；润色不刷新统计、不额外请求 B 站，也不以文章生成时间替代采集时间。
- `generatedAt` 是文章渲染时生成的 ISO 8601 UTC 时间（以 `Z` 结尾），与视频发布时间、统计采集时间独立。
- `model` 与可选 `thinking` 记录适配层提供的模型信息；`sourceTranscript` 是原始字幕相对文章所在目录的路径。章节数、输入条数、警告与用量仍只通过工具结果返回。

## 错误码

core 不提供宿主命令建议；适配层按 code 补充登录、认证或配置入口。

| 错误码 | 含义 |
| --- | --- |
| `INVALID_INPUT` | BV/URL/分 P 有误、路径越界，或输入不是合法原始字幕。 |
| `PAGE_NOT_FOUND` | 视频或分 P 不存在。 |
| `AUTH_REQUIRED` | B 站凭证缺失/失效，或未授权时接口未提供可用字幕。 |
| `NO_SUBTITLE` | 当前分 P 没有字幕或正文为空。 |
| `LANGUAGE_NOT_AVAILABLE` | 有字幕但没有中文字幕轨道。 |
| `POLISH_LANGUAGE_UNSUPPORTED` | 输入字幕不是中文，不执行翻译。 |
| `SIGNATURE_REQUIRED` | B 站业务码 `-352`，当前未计算 WBI 签名。 |
| `RATE_LIMITED` | B 站或模型接口限流。 |
| `NETWORK_ERROR` | B 站请求失败或超时。 |
| `INVALID_RESPONSE` | B 站数据/时间戳不合法，或模型流结构无法识别；无效的模型用量块视为未报告，不影响正文交付。 |
| `INVALID_CONFIG` | JSON/字段无效、项目配置含 Cookie，或保存目标非普通文件。 |
| `LOGIN_EXPIRED` | 扫码二维码超时。 |
| `LOGIN_FAILED` | 登录接口拒绝请求或状态未知。 |
| `MODEL_NOT_FOUND` | 适配层所选模型不存在或不可用。 |
| `MODEL_AUTH_REQUIRED` | 模型认证缺失或接口返回 401/403。 |
| `MODEL_REQUEST_REJECTED` | 模型接口拒绝请求，例如不支持参数；只含固定安全消息和受控诊断，不回显上游错误正文。 |
| `INVALID_MODEL_OUTPUT` | 两次模型响应均未通过 JSON/章节校验，或模型尝试工具调用/拒绝回答。 |
| `OUTPUT_TRUNCATED` | 输出达到上限，或流缺少完整终态。 |
| `INPUT_TOO_LARGE` | 输入超过模型上下文。 |
| `MODEL_ERROR` | 模型服务、网络、超时或其他调用异常。 |
| `CANCELLED` | 用户或信号取消。 |

## 参与开发

本地环境、构建测试与提交约定见 [贡献指南](https://github.com/FukangZ/bilibili-subtitles/blob/main/CONTRIBUTING.md)。
