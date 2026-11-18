# @fukangz/cli-bilibili-subtitles

![bilibili-subtitles：把 B 站长视频整理为结构清晰、忠实原话的 Markdown 全文](https://cdn.jsdelivr.net/gh/FukangZ/bilibili-subtitles@main/assets/readme/hero.svg)

[![npm version](https://img.shields.io/npm/v/@fukangz/cli-bilibili-subtitles)](https://www.npmjs.com/package/@fukangz/cli-bilibili-subtitles)

独立的命令行工具 `bili-subs`（附带通用 Agent Skill）：把哔哩哔哩（B 站）长视频整理成一篇忠实原话、像文章一样好读的 Markdown 全文。它基于视频已有的中文字幕，按讲述脉络切分章节、修顺零散错乱的台词，并在每个章节旁附上原视频跳转链接。

- **两步完成**：`bili-subs download` 下载原始字幕，`bili-subs polish` 把它润色成文。只需要原始字幕时可以停在第一步。
- **独立运行**：只需 Node.js 22.19+，不依赖 Pi Agent 或 dsh。
- **模型调用**：下载字幕不调用模型；只有 `polish` 和 `config test` 会请求你配置的模型并产生费用。支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 三种接口。
- **效果预览**：原始字幕与润色文章的完整对比示例见[项目主 README](https://github.com/FukangZ/bilibili-subtitles/blob/main/README.md#你能拿到什么从碎台词到可读文章)。

## 快速开始

### 1. 安装并扫码登录

```sh
npm install -g @fukangz/cli-bilibili-subtitles

# 用手机 B 站 App 扫描终端里的二维码（获取 AI 字幕通常需要登录）
bili-subs login
```

### 2. 第一步：下载原始字幕

```sh
# 传入 BV 号或 B 站视频链接
bili-subs download BV1EXAMPLE01

# 下载第 2 分 P，保存到当前目录下的 notes/
bili-subs download "https://www.bilibili.com/video/BV1EXAMPLE01/" --page 2 --out notes
```

字幕默认保存为 `.subtitles/<BV号>-<视频标题>/transcript.md`；多分 P 视频的目录名带 `-p1`、`-p2` 等后缀。

### 3. 第二步：润色成文

```sh
# 填写接口类型、地址、模型名和 API Key（隐藏输入），字段说明见「配置模型」
bili-subs config

# 可选：发一个很小的请求，确认配置可用
bili-subs config test

# 把原始字幕润色成文章
bili-subs polish ".subtitles/<视频目录>/transcript.md"
```

文章默认生成在原始字幕旁，文件名为 `transcript.polished.md`。

### 4. 交给 Coding Agent 使用

如果你使用 **Claude Code、Codex、Cursor** 等 Agent，把随包附带的 `bilibili-subtitles` Skill 复制到 Agent 的 skills 目录：

```sh
# 通用目录；Claude Code 可改为 ~/.claude/skills/
mkdir -p ~/.agents/skills
cp -R "$(npm root -g)/@fukangz/cli-bilibili-subtitles/skills/bilibili-subtitles" ~/.agents/skills/
```

先在终端完成登录和模型配置，然后在对话中说 *“把示例视频 BV1EXAMPLE01 整理成 Markdown 文章”*，Agent 就会调用 `bili-subs` 先下载、再润色。按 Skill 约定，Agent 只在你明确要求时才会润色。

## 命令一览

| 命令 | 说明 |
| :--- | :--- |
| `bili-subs login` | 在终端显示二维码，用手机 B 站 App 扫码登录 |
| `bili-subs download <BV号或链接> [--page N] [--out DIR]` | 下载原始字幕；分 P 默认取链接中的 `p` 参数，否则为第 1 P；`--out` 指定输出目录 |
| `bili-subs polish <字幕路径> [--out FILE]` | 把原始字幕润色成 Markdown 文章；`--out` 指定文章路径 |
| `bili-subs config` | 交互式配置润色用的模型 |
| `bili-subs config show` | 查看当前配置（API Key 已隐藏） |
| `bili-subs config test` | 发送一个最小请求，检查模型配置是否可用（会产生少量费用） |

- 路径参数都相对当前目录，不能是绝对路径，也不能指向当前目录之外。
- 输出文件已存在时自动编号（如 `transcript-2.md`），不会覆盖旧文件。
- 只处理视频已有的中文字幕；不支持 `b23.tv` 短链、音视频下载、语音识别或外语翻译。

## 配置模型

推荐用 `bili-subs config` 按提示填写。配置保存在 `~/.config/bili-subs/config.json`（设置了 `XDG_CONFIG_HOME` 时为 `$XDG_CONFIG_HOME/bili-subs/config.json`），也可以手动编辑：

```json
{
  "polish": {
    "api": "openai-completions",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-v4.1-flash",
    "apiKey": "sk-...",
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "timeoutMs": 300000
  }
}
```

| 字段 | 必填 | 说明 |
| :--- | :--- | :--- |
| `polish.api` | 是 | 接口类型：`openai-completions`、`openai-responses` 或 `anthropic-messages`，见下表。 |
| `polish.baseUrl` | 是 | 服务商基础地址，不含接口路径。必须是 HTTPS；本机服务（`localhost`）可以用 HTTP。 |
| `polish.model` | 是 | 服务商的模型名称。 |
| `polish.apiKey` | 是 | 模型 API Key。只从本配置文件读取，不读取环境变量。 |
| `polish.contextWindow` | 是 | 模型的上下文窗口（token 数），按服务商文档填写。 |
| `polish.maxTokens` | 是 | 单次请求的最大输出 token 数，不能大于 `contextWindow`。整篇文章在一次请求中生成，长视频需要较大的值。 |
| `polish.reasoningEffort` | 否 | 思考强度：`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`；可用档位取决于模型。 |
| `polish.timeoutMs` | 否 | 每次模型请求的超时时间（毫秒），默认 `120000`。 |

`baseUrl` 只需填到接口路径之前，CLI 会按 `api` 补全路径：

| `api` | 适用接口 | `baseUrl` 示例 | 实际请求地址 |
| :--- | :--- | :--- | :--- |
| `openai-completions` | OpenAI Chat Completions，以及兼容该格式的服务（如 DeepSeek） | `https://api.deepseek.com` | `<baseUrl>/chat/completions` |
| `openai-responses` | OpenAI Responses | `https://api.openai.com/v1` | `<baseUrl>/responses` |
| `anthropic-messages` | Anthropic Messages | `https://api.anthropic.com` | `<baseUrl>/v1/messages` |

## 输出与退出码

命令结果以 `key: value` 行写到 stdout，例如下载后的 `transcriptPath`、润色后的 `outputPath` 和 `usage`；进度、警告和错误信息写到 stderr。这是面向人和 Agent 阅读的文本格式，不是稳定的程序接口；需要类型化结果时，请直接使用 [core 库](https://github.com/FukangZ/bilibili-subtitles/blob/main/packages/core/README.md)。

| 退出码 | 含义 |
| :--- | :--- |
| `0` | 成功（包括显示帮助） |
| `2` | 需要你处理的问题：参数、输入文件或配置有误，B 站未登录或登录失效，扫码超时，模型认证失败，模型不存在或拒绝请求，待润色的字幕不是中文 |
| `1` | 其他失败：视频没有中文字幕、网络错误、限流、超时、输出被截断、模型输出不合格、任务被取消等 |

## 常见问题

- **提示需要登录或登录已失效**：运行 `bili-subs login` 重新扫码。
- **提示没有中文字幕**：该视频或分 P 没有中文字幕；本工具不做语音识别或翻译。
- **模型认证失败或请求失败**：用 `bili-subs config show` 检查 `api`、`baseUrl`、`model` 是否与服务商一致，修改后用 `bili-subs config test` 验证。
- **提示字幕超出模型上下文**：换用上下文更大的模型，并把 `contextWindow` 改成该模型的实际值。
- **提示输出被截断**：在模型允许的范围内调大 `maxTokens`，或换用输出上限更高的模型。
- **长视频请求超时**：调大 `timeoutMs`，例如 `300000`。
