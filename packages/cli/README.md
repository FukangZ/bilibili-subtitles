# @fukangz/cli-bilibili-subtitles

[![npm version](https://img.shields.io/npm/v/@fukangz/cli-bilibili-subtitles)](https://www.npmjs.com/package/@fukangz/cli-bilibili-subtitles)

独立的命令行工具 `bili-subs`（附带通用 Agent Skill）：下载哔哩哔哩（B 站）视频**已有的中文字幕**；需要成文时，再通过大模型按讲述脉络切分章节、修顺零散错乱的台词，并附上每个章节对应的原视频跳转链接，生成一篇忠实原话、像文章一样好读的 Markdown 全文。

- **独立运行**：需要 Node.js 22.19+，无需 Pi Agent 或 dsh 宿主；模型请求由 `pi-ai` 适配 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。
- **效果预览**：原始字幕与润色文章的完整对比示例见[项目主 README](../../README.md#你能拿到什么从碎台词到可读文章)。

## 快速开始

### 1. 安装与扫码登录

```sh
# 全局安装
npm install -g @fukangz/cli-bilibili-subtitles

# 手机 B 站 App 扫码登录（获取 AI 字幕通常需要登录）
bili-subs login
```

### 2. 下载原始字幕（零模型开销）

```sh
# 传入 BV 号或 B 站视频链接
bili-subs download BV1EXAMPLE01

# 可选：指定第 2 分 P 与自定义输出目录
bili-subs download "https://www.bilibili.com/video/BV1EXAMPLE01/" --page 2 --out ./notes
```

下载后默认保存在 `.subtitles/<BV号>-<视频标题>/transcript.md`。

### 3. 配置模型并润色成文（按需）

润色通过 `pi-ai` 支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages API。

```sh
# 1. 运行交互式向导配置 API 地址、模型名与 API Key（密钥隐藏输入）
bili-subs config

# 2. （可选）测试模型连通性
bili-subs config test

# 3. 将原始字幕润色为 Markdown 文章
bili-subs polish .subtitles/<视频目录>/transcript.md
```

润色完成后，默认在原始字幕旁生成 `transcript.polished.md`（重复生成会自动编号，不覆盖旧文件）。

### 4. 配合 Coding Agent 使用（安装 Skill）

如果你使用 **Claude Code、Codex、Cursor** 等 Agent，可以将随包附带的 `bilibili-subtitles` Skill 复制到对应 Agent 的 skills 目录中：

```sh
# 通用 Agent 目录（Claude Code 可改为 ~/.claude/skills/）
mkdir -p ~/.agents/skills
cp -R "$(npm root -g)/@fukangz/cli-bilibili-subtitles/skills/bilibili-subtitles" ~/.agents/skills/
```

配置完成后，在 Agent 对话中说 *“帮我下载示例视频 BV1EXAMPLE01 的字幕并润色成文章”*，Agent 就会按需调用 `bili-subs`。

## 命令一览

| 命令 | 可选参数 | 说明 |
| :--- | :--- | :--- |
| `bili-subs login` | 无 | 终端显示二维码，使用手机 B 站 App 扫码保存登录态 |
| `bili-subs download <BV或链接>` | `--page N` `--out DIR` | 下载指定分 P 的原始字幕 |
| `bili-subs polish <字幕路径>` | `--out FILE` | 将原始字幕润色为 Markdown 文章；`--out` 指定文章文件路径 |
| `bili-subs config` | 无 | 交互式配置润色使用的模型接口与 API Key |
| `bili-subs config show` | 无 | 查看当前配置（敏感字段已脱敏） |
| `bili-subs config test` | 无 | 发送最小测试请求，验证模型配置是否可用 |

仅处理视频已有的中文字幕，不支持 `b23.tv` 短链、音视频下载、语音识别或外语翻译。

## 配置文件说明

配置文件默认位于 `~/.config/bili-subs/config.json`（若设置了 `XDG_CONFIG_HOME` 则位于 `$XDG_CONFIG_HOME/bili-subs/config.json`）。推荐直接通过 `bili-subs config` 交互配置，也可参考以下结构手动编辑：

```json
{
  "polish": {
    "api": "openai-completions",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "apiKey": "sk-...",
    "contextWindow": 64000,
    "maxTokens": 8192,
    "timeoutMs": 300000
  }
}
```

| 字段 | 说明 |
| :--- | :--- |
| `polish.api` | 协议：`openai-completions`、`openai-responses` 或 `anthropic-messages`。旧值 `chat-completions` 和 `responses` 仍会分别映射到前两者。 |
| `polish.baseUrl` | 服务商基础地址，如 `https://api.deepseek.com`、`https://api.openai.com/v1` 或 `https://api.anthropic.com`；填写基础地址，不要包含完整端点路径，pi-ai 会按协议追加对应路径。 |
| `polish.model` | 服务商模型名称。 |
| `polish.apiKey` | 模型接口密钥，只保存在 CLI 自己的用户级配置中，不与 Pi 凭证共享。 |
| `polish.contextWindow` | 模型上下文窗口 token 数，必填，用于 pi-ai 的请求预算与上下文溢出识别。 |
| `polish.maxTokens` | 模型最大输出 token 数，必填，作为请求输出预算；CLI 会按 pi-ai 的上下文预算收紧，`config test` 最多使用 256。 |
| `polish.reasoningEffort` | 可选，pi-ai 思考等级：`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。不同协议/模型实际支持范围不同。 |
| `polish.timeoutMs` | 可选，单阶段请求超时毫秒数，默认 `120000`。 |

`config test` 使用独立的小型预检请求，输出上限不超过 256 Token；预检与润色都可能产生费用。连接成功不保证全文长度受支持或生成质量合格。

## 模型协议与结果约定

### 请求与完成状态

CLI 使用独立的 `@earendil-works/pi-ai` 协议库，不需要 Pi Agent 宿主。`baseUrl` 去掉末尾 `/` 后，由协议适配器追加路径；Anthropic 不能仅通过替换地址当成 OpenAI 协议使用。

| 配置 `api` | API 路径 | 认证 |
| --- | --- | --- |
| `openai-completions` | `/chat/completions` | Bearer |
| `openai-responses` | `/responses` | Bearer |
| `anthropic-messages` | `/v1/messages` | `x-api-key` |

pi-ai 的 `streamSimple` 负责请求体、SSE 流解析及供应商差异。CLI 显式设置 `maxRetries: 0`、单阶段超时、取消信号、`bili-subs/<版本>` User-Agent 和 `redirect: "error"`；Responses 设置 `store: false`。认证仅取自 CLI 用户配置，不读取环境 key、项目配置或 Pi 凭证，也不支持自定义 headers / UA。

`maxTokens` 是输出预算，pi-ai 可按模型上下文收紧，但不能保证长文完整输出。CLI 仅接受正常完成的非空纯文本：取消为 `CANCELLED`，长度终态为 `OUTPUT_TRUNCATED`，上下文溢出为 `INPUT_TOO_LARGE`；认证和限流分别映射为 `MODEL_AUTH_REQUIRED`、`RATE_LIMITED`。工具调用、其他异常终态和空正文均不作为成功文章保存。公共结果使用固定安全消息，不携带上游错误正文、密钥或请求 URL。

两阶段 JSON 校验与最多一次格式修复由 core 负责，修复请求不是传输重试。完整错误码见 [Core README](../core/README.md#错误码)，协议复用的取舍见 [ADR-0009](../../docs/adr/0009-standalone-cli-with-protocol-adapters.md)。

### 用量与终端输出

CLI 将输入、输出、缓存、推理及总 token 映射为 core 用量，失败前已报告的用量也保留。**pi-ai 将供应商缺报用量规范化为零，当前 CLI 无法区分缺报与真实零。** 因此 `usageStatus: complete` 只表示每次阶段调用都产生了适配器报告，不证明供应商账单完整；取消或失败也不能推断免费。价格未配置时不报告零费用，`cost` 保持缺省。详见 [ADR-0012](../../docs/adr/0012-reported-usage-and-unknown-cost.md)。

成功结果以 `key: value` 行写入 stdout；进度、警告与失败消息写入 stderr。当前没有稳定 JSON 输出协议，自动化调用不要把展示文本当作长期 API；需要类型化结果可使用 core。退出码为：

- `0`：成功，包括帮助输出。
- `2`：输入、配置、认证、模型选择/请求配置或语言范围等需要用户处理的问题；具体包含 `INVALID_INPUT`、`INVALID_CONFIG`、`AUTH_REQUIRED`、`LOGIN_EXPIRED`、`MODEL_AUTH_REQUIRED`、`MODEL_NOT_FOUND`、`MODEL_REQUEST_REJECTED`、`POLISH_LANGUAGE_UNSUPPORTED`。
- `1`：其他失败，包括取消、截断、限流、网络和模型异常。

交互式 `config` 与 `login` 需要终端；其他命令可从脚本调用。离线测试用模拟 fetch 驱动 pi-ai 真实协议解析器，覆盖三种 API、终态、脱敏、用量和取消；不证明具体网关兼容性或真实生成质量。

协议参考：[pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai)、[OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat)、[OpenAI Responses](https://platform.openai.com/docs/api-reference/responses)、[Anthropic Messages](https://docs.anthropic.com/en/api/messages)。
