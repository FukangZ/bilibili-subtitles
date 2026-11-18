# @fukangz/dsh-bilibili-subtitles

![bilibili-subtitles：把 B 站长视频整理为结构清晰、忠实原话的 Markdown 全文](https://cdn.jsdelivr.net/gh/FukangZ/bilibili-subtitles@main/assets/readme/hero.svg)

[![npm version](https://img.shields.io/npm/v/@fukangz/dsh-bilibili-subtitles)](https://www.npmjs.com/package/@fukangz/dsh-bilibili-subtitles)

DeepSeek Harness（dsh）插件：把哔哩哔哩（B 站）长视频整理成一篇忠实原话、像文章一样好读的 Markdown 全文。它基于视频已有的中文字幕，按讲述脉络切分章节、修顺零散错乱的台词，并在每个章节旁附上原视频跳转链接。

- **两步完成**：先下载原始字幕，再润色成文。下载不调用模型；润色时默认复用当前 dsh 会话模型。只需要原始字幕时可以停在第一步。
- **环境要求**：Node.js 22+，dsh `>=0.2.2-rc.1 <0.3.0`。
- **效果预览**：原始字幕与润色文章的完整对比示例见[项目主 README](https://github.com/FukangZ/bilibili-subtitles/blob/main/README.md#你能拿到什么从碎台词到可读文章)。

## 快速开始

1. **安装插件**

   ```sh
   dsh plugin --profile <profile> add @fukangz/dsh-bilibili-subtitles
   ```
   安装后重启 dsh 生效。

   插件向 Agent 注册两个工具，分别对应整理的两步：`bilibili_download_subtitle` 按 BV 号或 B 站链接下载原始中文字幕，`bilibili_polish_subtitle` 将下载的字幕忠实润色成文章，并附上原片时间跳转链接。Agent 会按你的请求自行调用。

2. **扫码登录 B 站**

   在 **dsh Web 界面的插件管理页**找到本插件，点击 **“扫码登录”**，使用手机 B 站 App 扫描弹窗二维码并确认（获取 B 站 AI 自动生成字幕通常需要登录）。登录成功后，Cookie 会持久保存在 dsh 的凭据服务中（不写入项目配置，也不会发给模型）。

3. **在对话中使用**

   直接在 dsh 对话框中告诉 Agent：
   - **整理成文章**：“把示例链接 `https://www.bilibili.com/video/BV1EXAMPLE01/?p=2` 整理成 Markdown 文章”
   - **只要原始字幕**：“帮我下载示例视频 `BV1EXAMPLE01` 的字幕”
   - **润色已有字幕**：“把 `.subtitles/.../transcript.md` 润色成文章”

## 输出文件与使用边界

默认在当前会话工作目录的 `.subtitles/` 下按视频标题建立文件夹：

```text
.subtitles/<BV号>-<视频标题>/
├── transcript.md           # 原始字幕：YAML 元数据 + 逐行时间戳台词
└── transcript.polished.md  # 精校文章：YAML 元数据 + 多级章节正文 + [▶ 分:秒] 原片跳转链接
```

- **分 P 与防覆盖**：支持指定分 P（默认第 1 分 P）。重复下载或润色会自动添加 `-2` 等后缀编号，不会覆盖已有文件。
- **能力边界**：仅处理视频已有的中文字幕；不支持 `b23.tv` 短链、音视频下载、语音识别或外语翻译。

## 插件配置

扫码登录后即可直接使用。字幕默认写入当前会话工作目录下的 `.subtitles`；下载工具可按次指定输出目录。可在 **dsh Web 插件设置区**配置润色模型（即时生效）：

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `provider` / `model` | 跟随当前会话 | 固定润色使用的模型（两项需同时填写；留空则直接复用当前对话模型）。 |
| `reasoningEffort` | 跟随当前会话 | 覆盖润色模型的思考强度。 |
| `timeoutMs` | `300000` | 单阶段模型请求超时时间（毫秒，最小 `1000`）。 |

## 常见问题

- **提示需要 B 站登录或凭证失效**：打开 dsh Web 插件管理页，重新点击“扫码登录”即可。
- **提示模型未认证或不可用**：请检查 dsh 宿主的模型认证配置，或检查插件设置中覆盖的 `provider` / `model` 是否正确（无需重新登录 B 站）。
- **提示没有中文字幕**：该视频（或对应分 P）未提供中文字幕轨道；插件不支持语音转写或外语翻译。
- **长视频润色超时**：在插件设置中调大 `timeoutMs`。
