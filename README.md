<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="bilibili-subtitles：把破碎的 B 站字幕整理为结构清晰、忠实原话的 Markdown 全文">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@fukangz/pi-bilibili-subtitles"><img src="https://img.shields.io/npm/v/@fukangz/pi-bilibili-subtitles?style=flat-square&label=pi%20plugin&color=fb7299" alt="pi version"></a>
  <a href="https://www.npmjs.com/package/@fukangz/dsh-bilibili-subtitles"><img src="https://img.shields.io/npm/v/@fukangz/dsh-bilibili-subtitles?style=flat-square&label=dsh%20plugin&color=00aeec" alt="dsh version"></a>
  <a href="https://www.npmjs.com/package/@fukangz/cli-bilibili-subtitles"><img src="https://img.shields.io/npm/v/@fukangz/cli-bilibili-subtitles?style=flat-square&label=cli%20%2B%20skill&color=52525b" alt="cli version"></a>
</p>

`bilibili-subtitles` 把哔哩哔哩（B 站）视频现有的中文字幕下载到本地；当你明确要求润色时，再通过大模型按讲述脉络**切分章节**、**修顺零散错乱的台词**，并附上每个章节对应的原视频跳转链接，生成一篇像文章一样好读的 Markdown 全文。无论你想自己快速通读长视频，还是把干净的一手文稿交给 AI Agent 继续分析，都可以直接拿来用。

> **使用边界**：仅处理视频已有的中文字幕；**默认只下载原始字幕（零模型开销）**，仅在执行润色时调用大模型。不下载音视频、不做本地语音识别、不翻译外语字幕，也不支持 `b23.tv` 短链。

---

## 你能拿到什么：从碎台词到可读文章

输入一个 **BV 号**或 **B 站视频链接**，工具默认在当前目录的 `.subtitles/` 下按视频标题建好文件夹。下载生成 `transcript.md`，按需润色后在旁边生成 `transcript.polished.md`：

```text
.subtitles/<BV号>-<视频标题>/
├── transcript.md           # 原始字幕：YAML 元数据头 + 逐行时间戳台词
└── transcript.polished.md  # 精校全文：YAML 元数据头 + 多级章节段落 + [▶ 分:秒] 跳转链接
```

<p align="center">
  <img src="./assets/readme/subtitle-comparison.svg" width="100%" alt="原始字幕 transcript.md 与精校文章 transcript.polished.md 的结构与内容对比示意图">
</p>

两份文件都是**“YAML 元数据头（记录标题、UP 主、发布时间与播放/点赞等统计快照）+ Markdown 正文”**的自包含单文件。从一串没有重点的流水账字幕到精校文章，核心完成了四件事：

1. **按讲述脉络切分多级章节**：自动识别开场铺垫、主干议题与子话题（生成导语、`##` 二级标题与 `###` 三级标题），并拟定贴合原意的章节标题，一眼就能扫清整支视频的骨架。
2. **合拢碎句，修正同音错字**：B 站 AI 字幕常把一句话拆成三四行，还夹杂口头禅和语音识别同音错字（例如把“算术强度”听成`算术墙度`、把“Token”听成`托肯`、把“显存带宽”听成`显存带款`）。润色会把碎句合拢成自然段，清理口水词，并结合上下文还原专业术语。
3. **完整保留原话细节，不做缩水摘要**：作者的观点、推导过程与具体举例全部保留，不会像摘要工具那样把干货压缩成几条空洞的要点。
4. **每个章节自带原视频跳转点**：每个章节标题旁都会附上形如 `[▶ 0:35]` 的视频时间链接。先扫读目录和文字定位到感兴趣的部分，需要看演示画面或图表时，点击该节标题旁的链接就能直接跳回原片对应时刻。

想查看文件结构与正文润色效果，可以展开下方示例。`BV1example`、作者、统计与字幕均为合成演示数据，不代表真实下载或性能保证。原始字幕示例完整可解析，由文档测试与测试夹具通过真实 core 入口验证；文章仅展示排版效果，完整元数据约束见 [Core 文档](packages/core/README.md)。

<details>
<summary>查看原始字幕样例（<code>transcript.md</code>）</summary>

```markdown
---
schemaVersion: 1
kind: bilibili-subtitle
bvid: BV1example
page: 1
pageCount: 1
pageTitle: 合成演示分P
language: zh-CN
languageName: 简体中文
trackId: synthetic-zh
videoTitle: 为什么显卡算力没跑满，大模型推理却卡住了？
authorName: 硬件科普示例
publishedAt: "2024-01-01T12:00:00.000Z"
viewCount: 123456
likeCount: 6789
sourceUrl: https://www.bilibili.com/video/BV1example/?p=1
trackKind: ai
---

00:00 哈喽大家好，呃今天我们聊一个很多朋友在评论区问的问题。
00:05 就是为什么我们在本地跑大模型推理的时候，打开监控一看，
00:10 显卡的计算核心利用率才百分之三十多，明明算力还没吃满，
00:15 那个生成文字的速度却已经卡得不行了呢？
00:35 大家看右边这张架构对比图，这里有一个非常核心的概念叫算术墙度。
00:42 简单来说，就是每从显存里搬运一字节的数据，你能顺便做多少次浮点运算。
00:49 大模型在逐个生成托肯的解码阶段，每次只算一个词，却要把几百兆甚至几十G的模型权重，
00:57 从显存完整搬到计算单元里走一遍。
01:02 你看图上这根红色的柱子，计算单元算完只要零点几毫秒，剩下的时间全在干等数据搬运，
01:09 所以这时候的瓶颈根本不是计算慢，而是显存带款不够用，也就是常说的访存受限。
01:42 那工程上怎么缓解这个问题呢？目前主流有两个方向，大家注意看屏幕上标黄的这两条折线。
01:48 第一个方向是做权重量化，既然瓶颈在搬运数据，那我们就给权重瘦身。
01:55 比如把原本 16 位的浮点数压缩到 4 位整数，模型体积和单次搬运量直接降到原来的四分之一，
02:03 在几乎不怎么损失精度的前提下，单卡生成速度能直接翻两到三倍。
02:15 第二个方向就是服务端常用的连续批处理，对吧，既然搬一次权重这么贵，
02:22 只服务一个用户太亏了，不如把十几个用户的请求攒成一捆同时算，
02:29 这样搬一次权重就能同时吐出十几个托肯，整个系统的总吞吐亮立刻就提上来了。
```

</details>

<details>
<summary>查看润色文章样例（<code>transcript.polished.md</code>）</summary>

```markdown
---
title: 为什么显卡算力未跑满，大模型推理却受限于显存带宽
videoTitle: 为什么显卡算力没跑满，大模型推理却卡住了？
authorName: 硬件科普示例
publishedAt: "2024-01-01T12:00:00.000Z"
viewCount: 123456
likeCount: 6789
source: https://www.bilibili.com/video/BV1example/?p=1
model: opus-5-5
# ... 其余继承的统计快照与生成元数据省略
---

# 为什么显卡算力未跑满，大模型推理却受限于显存带宽

大家好，今天我们聊一个很多朋友在评论区问的问题：为什么我们在本地跑大模型推理的时候，打开监控一看，显卡的计算核心利用率才 30% 多，明明算力还没吃满，生成文字的速度却已经卡得不行了呢？

## 推理卡顿的真正瓶颈：算术强度与显存带宽 [▶ 0:35](https://www.bilibili.com/video/BV1example/?p=1&t=35)

大家看右边这张架构对比图，这里有一个非常核心的概念叫“算术强度”。简单来说，就是每从显存里搬运一字节的数据，你能顺便做多少次浮点运算。

大模型在逐个生成 Token 的解码阶段，每次只算一个词，却要把几百兆甚至几十 G 的模型权重从显存完整搬到计算单元里走一遍。你看图上这根红色的柱子，计算单元算完只要零点几毫秒，剩下的时间全在干等数据搬运。所以这时候的瓶颈根本不是计算慢，而是显存带宽不够用，也就是常说的“访存受限”。

## 工程上的两个缓解方向 [▶ 1:42](https://www.bilibili.com/video/BV1example/?p=1&t=102)

那工程上怎么缓解这个问题呢？目前主流有两个方向，大家注意看屏幕上标黄的这两条折线。

### 方向一：权重量化 [▶ 1:48](https://www.bilibili.com/video/BV1example/?p=1&t=108)

第一个方向是做权重量化。既然瓶颈在搬运数据，那我们就给权重瘦身。比如把原本 16 位的浮点数压缩到 4 位整数，模型体积和单次搬运量直接降到原来的四分之一，在几乎不怎么损失精度的前提下，单卡生成速度能直接翻两到三倍。

### 方向二：连续批处理 [▶ 2:15](https://www.bilibili.com/video/BV1example/?p=1&t=135)

第二个方向就是服务端常用的连续批处理。既然搬一次权重这么贵，只服务一个用户太亏了，不如把十几个用户的请求攒成一捆同时算。这样搬一次权重就能同时吐出十几个 Token，整个系统的总吞吐量立刻就提上来了。
```

</details>

---

## 快速开始

我们为 **Pi Agent** 和 **DeepSeek Harness (dsh)** 提供了专门的原生插件版本；对于 **Claude Code、Codex、Cursor** 等其他 Coding Agent（以及直接在终端手动使用），则提供了通用的 **CLI + Skill** 版本。三个版本均内置手机 B 站 App 扫码登录，免去翻浏览器手动抠 Cookie：

| 版本 | 适用环境 | 登录与模型来源 | 安装命令 |
| :--- | :--- | :--- | :--- |
| **[Pi 扩展](packages/pi/README.md)** | **Pi Agent** | `/bilibili-login` 终端扫码；直接复用当前 Pi 会话模型 | `pi install npm:@fukangz/pi-bilibili-subtitles` |
| **[dsh 插件](packages/dsh/README.md)** | **DeepSeek Harness** | dsh Web 插件设置页弹窗扫码；直接复用当前 dsh 会话模型 | `dsh plugin --profile <profile> add @fukangz/dsh-bilibili-subtitles` |
| **[通用 CLI + Skill](packages/cli/README.md)** | **其他 Coding Agent**（Claude Code / Codex / Cursor 等）或终端直接使用 | `bili-subs login` 终端扫码；`bili-subs config` 配置 OpenAI 或 Anthropic 模型接口 | 见下方 CLI 与 Skill 安装步骤 |

### 1. Pi / DeepSeek Harness 插件用法

安装对应插件并完成扫码登录后，直接在对话里告诉 Agent 即可：
- 只下原始字幕：*“帮我下载 `BV1xx411c7mD` 的字幕”*
- 下载并润色成文：*“把 `BV1xx411c7mD` 的字幕下载下来并润色成 Markdown 文章”*

### 2. 通用 CLI + Skill 安装与用法（适用于其他 Coding Agent）

需要 Node.js 22.19+。先全局安装命令行工具并完成扫码与模型配置：

```sh
# 1. 全局安装 CLI
npm install -g @fukangz/cli-bilibili-subtitles

# 2. 手机 B 站 App 扫码登录（获取 AI 字幕通常需要登录态）
bili-subs login

# 3. 配置用于润色的大模型接口（若只需下载原始字幕可跳过）
bili-subs config
```

然后把随包附带的 `bilibili-subtitles` Skill 目录复制到你所用 Agent 的 skills 目录中（以 `~/.agents/skills/` 为例；Claude Code 可改为 `~/.claude/skills/`）：

```sh
mkdir -p ~/.agents/skills
cp -R "$(npm root -g)/@fukangz/cli-bilibili-subtitles/skills/bilibili-subtitles" ~/.agents/skills/
```

装好后，你的 Coding Agent 就会按需调用 `bili-subs` 下载或润色字幕；你也可以随时在终端手动执行 `bili-subs download <BV号>` 与 `bili-subs polish <transcriptPath>`。详细参数见 [CLI 文档](packages/cli/README.md)。

---

## 设计初衷：为什么做“精校全文”，而不是“AI 摘要笔记”？

对人类读者来说，从头到尾线性观看长视频获取信息的效率太低；对 AI Agent 来说，B 站视频更是无法直接阅读的黑盒。想要高效掌握视频内容，最自然的桥梁就是先拿到视频的**字幕文字**。

但 B 站直接导出的原始字幕（尤其是语音识别自动生成的 AI 字幕）很难直接拿来读：它没有章节层次，只是一串按播放时间切碎的流水账——完整的一句话常被拆成三四行，中间还充斥着口头禅、断句错乱，以及把专业术语听成日常词的同音错字。因此，原始字幕必须经过一轮整理。

至于“整理成什么样”，社区现有方案大多走向了 **AI 学习笔记 / 摘要**——直接把视频浓缩成大纲、概念卡或几条要点。但这会带来两个问题：
1. **二手摘要会不可逆地丢失细节**：一旦替你压缩改写，原本严密的推导链条、边界前提和鲜活举例就被删没了，想深究时无从查证。
2. **纯文字替代不了视频画面**：技术讲解、教程和评测里有大量架构图、代码操作与曲线演示，脱离原片画面很难单靠文字看懂。

因此，本项目选择做一份**忠实于原话、带多级章节与原片跳转点的“精校全文”**——先帮你把碎字幕理成一篇结构清晰、没有错别字的文章，让你和 Agent 都能快速通读全貌；遇到感兴趣的段落或需要看图表的地方，再点章节标题旁的链接跳回原视频观看：

| 对比维度 | 原始字幕导出脚本 | AI 摘要笔记工具（如 `bili-note`） | `bilibili-subtitles`（本项目） |
| :--- | :--- | :--- | :--- |
| **产出定位** | 原样导出时间轴流水账 | 按压缩比提炼大纲、概念卡、自测题 | **忠实原话、带章节跳转的精校全文** |
| **信息完整度** | 100% 原始台词，但无章节结构、断句破碎、同音错字多 | 大幅缩写改写，容易丢失论证过程与具体细节 | **自动切分多级章节，完整保留观点、推导与举例，仅顺句分段并修错字** |
| **原片联动** | 只有逐行秒数，没有章节导航点 | 侧重离线归档，正文章节无法直跳原视频 | **每个章节标题自带 `[▶ 分:秒]` 原视频跳转点** |
| **环境门槛** | 常需手动去浏览器 F12 复制 Cookie | 常依赖 Python、FFmpeg 或本地语音识别模型 | **零外部二进制依赖，内置扫码登录即装即用** |
| **给 Agent 用时** | 口水词与同音错字拉低检索与理解质量 | 已被固化成特定笔记模板，难以二次深挖 | **高信噪比的一手文稿底座，方便继续追问、对比或按需总结** |

---

## 工作原理

从输入一个视频链接到生成最终的 Markdown 文章，流程按顺序完成下载与两步润色：

<p align="center">
  <img src="./assets/readme/workflow.svg" width="100%" alt="bilibili-subtitles 下载与两步润色流程：下载最佳中文字幕、结构生成切分章节、正文生成顺句修错并挂载原片跳转链接">
</p>

1. **下载原始字幕**：同一个视频如果有多条中文字幕，程序自动按 **“人工上传字幕优先于 AI 字幕、简体优先于繁体”** 挑出最好的一条，连同视频元信息保存为 `transcript.md`。
2. **第一步（结构生成）**：大模型先通读完整的原始字幕，拟定文章总标题，并顺着讲述者的话题切换划分章节层级（导语、二级与三级章节），标出每一节从哪条字幕开始。
3. **第二步（正文生成）与组装**：程序把已确定的章节结构和按章节组织的**完整字幕**放入同一次正文请求，由大模型合拢碎句、清理口头禅、结合语境修正同音错字；不是逐章单独调用。最后由代码根据每节起点对应的时间戳挂上 `[▶ 分:秒]` 链接，组装成 `transcript.polished.md`。

两阶段均为全文请求；每阶段仅在 JSON 解析或结构校验失败后最多格式修复一次，通常共两次、最多四次 core 阶段调用。网络或上游失败不触发格式修复；适配器与宿主重试边界见 [架构说明](docs/architecture.md)。

---

## 仓库开发与延伸文档

本仓库使用 npm workspaces 管理各子包（除了上文面向终端用户的 `cli`、`pi`、`dsh` 外，底层共用宿主无关的二次开发核心库 [`@fukangz/core-bilibili-subtitles`](packages/core/README.md)）。最低 Node.js 22，本地开发建议使用 Node.js 24。**全仓检查还需要先准备 Pi 宿主 peer**（当前发布 workflow 使用 `@earendil-works/pi-coding-agent@0.87.1`）；环境准备、自动链接位置及无宿主时的局部验证见 [贡献指南](CONTRIBUTING.md)。依赖和宿主就绪后，在根目录执行：

```sh
npm ci --legacy-peer-deps
npm run build
npm run check
npm test
```

- **文档总入口**：[按使用、设计与维护目标导航](docs/README.md)
- **贡献与维护约定**：[贡献指南](CONTRIBUTING.md) · [架构与数据流](docs/architecture.md) · [安全政策](SECURITY.md) · [领域术语](GLOSSARY.md) · [架构决策](docs/adr/) · [MIT 许可证](LICENSE)
- **使用与集成文档**：[独立 CLI 与通用 Skill](packages/cli/README.md) · [Pi 扩展](packages/pi/README.md) · [dsh 插件](packages/dsh/README.md) · [Core API 与文件格式规范](packages/core/README.md)
- **背景与维护**：[B 站字幕协议调研](docs/research/bilibili-subtitle-protocol.md) · [CLI 模型协议与结果约定](packages/cli/README.md#模型协议与结果约定) · [按包发布流程](docs/publishing.md)

<p align="center">
  <a href="https://github.com/oil-oil/beautify-github-readme"><img src="./assets/readme/made-with-beautify.svg" width="300" alt="README made with beautify-github-readme"></a>
</p>
