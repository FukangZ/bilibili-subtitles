# @fukangz/pi-bilibili-subtitles

[![npm version](https://img.shields.io/npm/v/@fukangz/pi-bilibili-subtitles)](https://www.npmjs.com/package/@fukangz/pi-bilibili-subtitles)

Pi 扩展：下载哔哩哔哩（B 站）视频**已有的中文字幕**，并在你明确要求时，将原始字幕忠实润色为带章节视频时间链接的 Markdown 文章。

- **按需润色**：仅下载字幕不调用大模型（零模型开销）；要求润色时才调用当前 Pi 会话模型（或你指定的模型）。
- **效果预览**：原始字幕与润色文章的完整对比示例见[项目主 README](../../README.md#你能拿到什么从碎台词到可读文章)。

## 快速开始

1. **安装扩展**

   ```bash
   pi install npm:@fukangz/pi-bilibili-subtitles
   ```

2. **扫码登录 B 站**

   在 Pi 交互式终端运行 `/bilibili-login`，用手机 B 站 App 扫描终端二维码并确认（获取 B 站 AI 自动生成字幕通常需要登录）。登录状态保存在 `~/.pi/agent/bilibili-subtitles.credentials.json`，与普通配置分开，立即生效，无需重启 Pi。

3. **在对话中使用**

   直接用自然语言告诉 Pi 你的需求：
   - **只下原始字幕**：“帮我下载 `BV1xx411c7mD` 的字幕”
   - **下载并润色成文**：“把 `https://www.bilibili.com/video/BV1xx411c7mD/?p=2` 的字幕下载下来，并润色成 Markdown 文章”
   - **润色已有字幕**：“把 `.subtitles/.../transcript.md` 润色成文章”

## 输出文件与使用边界

默认在当前工作目录的 `.subtitles/` 下按视频标题建立文件夹：

```text
.subtitles/<BV号>-<视频标题>/
├── transcript.md           # 原始字幕：YAML 元数据 + 逐行时间戳台词
└── transcript.polished.md  # 精校文章：YAML 元数据 + 多级章节正文 + [▶ 分:秒] 原片跳转链接
```

- **分 P 与防覆盖**：可通过视频链接中的 `?p=2` 或在对话中指定分 P（默认第 1 分 P，多分 P 目录带 `-p1`、`-p2` 后缀）。重复下载或润色会自动编号（如 `transcript-2.md`），不会覆盖已有文件。
- **能力边界**：仅处理视频已有的中文字幕；不支持 `b23.tv` 短链、音视频下载、语音识别或外语翻译。

## 按需配置

扫码登录后即可直接使用，**通常无需手动修改配置**（润色默认跟随当前 Pi 会话的模型与思考强度）。默认输出目录为工作目录下的 `.subtitles`；下载工具仍可按次指定 `outputDir`。

如需固定润色模型，可编辑用户级配置 `~/.pi/agent/bilibili-subtitles.json`：

```json
{
  "polish": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "thinking": "medium",
    "timeoutMs": 120000
  }
}
```

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `polish.provider` + `polish.model` | 跟随当前 Pi 会话 | 固定润色使用的模型，须同时填写且已在 Pi 中注册认证。 |
| `polish.thinking` | 跟随当前 Pi 会话 | 润色思考强度：可选 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。 |
| `polish.timeoutMs` | `120000` | 单阶段模型请求超时时间（毫秒）。长视频或使用深度思考模型时可适当调高。 |

`Cookie` 由 `/bilibili-login` 写入独立的用户级凭据文件，不属于上述普通配置。

## 常见问题

- **提示需要登录或凭证过期**：在 Pi 终端重新运行 `/bilibili-login` 扫码确认即可。
- **提示没有中文字幕**：该视频（或对应分 P）未提供中文字幕轨道；本扩展不支持语音转写或外语翻译。
- **提示模型未找到或未认证**：检查 Pi 当前是否已通过 `/model` 选择可用模型，或检查用户配置中的 `polish.provider` 与 `polish.model` 是否填写正确。
- **长视频润色超时**：在配置文件中调大 `polish.timeoutMs`（例如设为 `300000`）。
