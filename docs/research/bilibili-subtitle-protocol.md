# B 站现有字幕获取协议调研

本文是理解 B 站接口的背景资料，不是项目的公共 API 或当前行为规范；接口可能变化，未经本文覆盖的参数也不代表项目已经实现。当前实现以 `packages/core/src/bilibili.ts`、`packages/core/src/download.ts` 为准，请求目标与凭据边界见 [安全政策](../../SECURITY.md)，工作流选择见 [架构决策](../adr/README.md)。项目当前未计算 WBI 签名。

下文整理 B 站网页端获取视频现有字幕（包括 UP 主上传的人工字幕与系统生成的 AI 语音识别字幕）的 HTTP 协议。

注意：B 站并未公开官方的字幕下载开放接口，本文档整理自 B 站网页端实际使用的接口约定；此处所说的“字幕”是指与视频语音对齐的字幕轨（CC 字幕），不包含观众发送的弹幕。

---

## 一、协议全貌：如何从 BV 号拿到字幕正文？

在 B 站网页端看视频时，浏览器地址栏里只有一个视频 `BV 号`（如 `BV1example`）和可选的分 P 序号（如 `p=1`）。但 B 站后端并没有提供“传入 `BV 号` 直接返回字幕文本”的单步接口，而是将**视频稿件信息**、**单 P 播放器配置**与**字幕静态文件**拆成了三层存储：

1. **视频稿件层**：一个 `BV 号` 代表整个视频稿件，里面可能包含一个或多个分 P（子视频）。每个分 P 都有一个全站唯一的内部内容编号 `cid`。
2. **播放器轨道层**：B 站的播放器接口不认“第几 P”，只认 `bvid + cid`。向播放器接口传入 `bvid` 和某个分 P 的 `cid`，才能查到这个分 P 挂载了哪些语言的字幕轨道，以及每条轨道对应的 CDN 文件地址 `subtitle_url`。
3. **静态文件层**：真正的逐行字幕内容并不在 API 服务器上，而是作为静态 JSON 文件存放在 B 站的 CDN（`*.hdslb.com`）上，需要访问 `subtitle_url` 才能下载。

因此，根据一个 `BV 号` 获取某个分 P 的字幕，标准请求链路由三次 HTTP `GET` 请求串联而成：

```text
已知：视频 BV 号 + 分 P 序号 (page，默认为 1)
  │
  ├─► 第 1 步：查分 P 编号 (cid)
  │     GET https://api.bilibili.com/x/web-interface/view?bvid=<BV号>
  │     └─► 从返回的 pages[] 列表中找到目标分 P，取出它的 cid
  │
  ├─► 第 2 步：查字幕轨道与 CDN 地址 (subtitle_url)
  │     GET https://api.bilibili.com/x/player/wbi/v2?bvid=<BV号>&cid=<cid>
  │     └─► 从返回的 subtitle.subtitles[] 中挑出目标字幕轨，取出它的 subtitle_url
  │
  └─► 第 3 步：下载逐行字幕 JSON
        GET https://<subtitle_url> (位于 *.hdslb.com)
        └─► 从返回的 body[] 中读取每条字幕的起止秒数与台词文本
```

下面按顺序说明这三个接口的请求参数、响应结构与关键字段含义。

---

## 二、接口请求与响应规范

前两步请求均访问 `api.bilibili.com` 下的业务接口，响应统一使用 `{ "code": 0, "message": "0", "data": { ... } }` 的外层包装（`code === 0` 代表成功，非 `0` 代表业务报错）。第三步请求直接拉取 CDN 上的静态 JSON 文件，没有 `code/data` 外层包装。

### 第 1 步：视频稿件信息接口（用 `bvid` 换取分 P 的 `cid`）

#### 请求格式

```http
GET https://api.bilibili.com/x/web-interface/view?bvid=BV1example
```

#### 响应示例（虚构数据，仅保留与元数据和分 P 相关的核心字段）

```json
{
  "code": 0,
  "message": "0",
  "data": {
    "bvid": "BV1example",
    "aid": 10001,
    "title": "为什么显卡算力没跑满，大模型推理却卡住了？",
    "pubdate": 1704110400,
    "owner": {
      "mid": 12345,
      "name": "硬件科普示例"
    },
    "stat": {
      "view": 123456,
      "danmaku": 1234,
      "reply": 56,
      "favorite": 789,
      "coin": 321,
      "share": 45,
      "like": 6789
    },
    "cid": 20001,
    "pages": [
      {
        "cid": 20001,
        "page": 1,
        "part": "正片",
        "duration": 600
      }
    ]
  }
}
```

#### 核心字段说明

| 字段路径 | 类型 | 含义说明 |
| --- | --- | --- |
| `data.bvid` / `data.aid` | `string` / `number` | 稿件的 BV 号与数字 av 号。 |
| `data.title` | `string` | 整个视频稿件的总标题。 |
| `data.pubdate` | `number` | 稿件发布时间（Unix 秒级时间戳）。 |
| `data.owner.name` / `mid` | `string` / `number` | UP 主昵称与用户 UID。 |
| `data.stat.*` | `number` | 整个视频稿件的累计播放（`view`）、弹幕（`danmaku`）、评论（`reply`）、收藏（`favorite`）、投币（`coin`）、分享（`share`）、点赞（`like`）总数。注意：这是整个稿件的汇总数据，不按单个分 P 拆分。 |
| `data.pages[]` | `array` | 分 P 列表。其中 `page` 是从 `1` 开始的分 P 序号（对应网页链接里的 `?p=1`），`part` 是该分 P 的子标题，`duration` 是时长（秒），**`cid` 是该分 P 的唯一内容编号**。 |
| `data.cid` | `number` | 顶层默认 `cid`（通常等于第 1 分 P 的 `cid`）。注意：**请求多 P 视频时，必须按分 P 序号从 `data.pages[]` 中查找对应项的 `cid`，不能直接用顶层 `data.cid`。** |

---

### 第 2 步：播放器接口（用 `bvid + cid` 换取字幕轨道列表）

拿到目标分 P 的 `cid` 后，继续调用播放器接口查询该分 P 下挂载的所有字幕轨道。

#### 请求格式

```http
GET https://api.bilibili.com/x/player/wbi/v2?bvid=BV1example&cid=20001
```

*注：虽然路径中包含 `wbi`，但在目前的实际接口表现中，仅传入 `bvid` 和 `cid` 而不附带 `w_rid` / `wts` 签名参数，服务端依然会正常返回字幕列表；若触发风控或强制签名校验，接口会返回业务码 `-352`。*

#### 响应示例（虚构数据，仅保留字幕相关字段）

```json
{
  "code": 0,
  "message": "0",
  "data": {
    "need_login_subtitle": false,
    "subtitle": {
      "subtitles": [
        {
          "id": 123,
          "lan": "ai-zh",
          "lan_doc": "中文（自动生成）",
          "subtitle_url": "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/example.json",
          "author_mid": 0,
          "ai_type": 1,
          "ai_status": 2
        }
      ]
    }
  }
}
```

#### 核心字段与协议现象说明

| 字段路径 | 类型 | 含义说明 |
| --- | --- | --- |
| `data.need_login_subtitle` | `boolean` | 标识该分 P 的字幕是否需要登录才能获取。**关键现象**：对于许多带有 AI 字幕的视频，若请求时未携带登录态 Cookie，服务端会将 `subtitles` 返回为空数组 `[]`，同时把 `need_login_subtitle` 设为 `true`。因此，收到空数组时需结合该布尔值，才能区分“真没字幕”与“未登录被隐藏”。 |
| `data.subtitle.subtitles[]` | `array` | 该分 P 下挂载的字幕轨道数组。一个分 P 可能同时包含多条轨道（如人工中文字幕、AI 中文字幕、外语字幕）。 |
| `subtitles[].id` | `number` / `string` | 字幕轨道的唯一 ID。 |
| `subtitles[].lan` | `string` | 轨道语言代码。常见中文代码包括 `zh-CN`、`zh-Hans`、`zh-TW`、`zh-Hant`、`zh` 以及 AI 字幕常用的 `ai-zh`。 |
| `subtitles[].lan_doc` | `string` | 供界面展示的语言名称（如 `"中文（简体）"`、`"中文（自动生成）"`）。 |
| `subtitles[].subtitle_url` | `string` | 字幕正文 JSON 的 CDN 下载地址。注意：接口返回的地址常常是以 `//` 开头的协议相对路径（如 `//aisubtitle.hdslb.com/...`），请求前需补全为 `https://`。 |
| `subtitles[].author_mid`、`ai_type`、`ai_status` | `number` | 用于区分**人工字幕**与 **AI 字幕**的线索字段。B 站没有提供一个统一的枚举字段来标记字幕来源：通常 AI 字幕的 `lan` 会以 `ai-` 开头、`subtitle_url` 含有 `ai_subtitle`、或 `ai_type === 1` / `ai_status > 0`；而人工上传的字幕通常带有大于 `0` 的上传者 UID（`author_mid > 0`）。 |

---

### 第 3 步：字幕正文 CDN 接口（访问 `subtitle_url` 获取逐行台词）

将第 2 步拿到的 `subtitle_url` 补全 `https:` 协议头后，直接向 CDN（通常位于 `*.hdslb.com` 域名下）发起 `GET` 请求。

#### 请求格式

```http
GET https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/example.json
```

#### 响应示例

```json
{
  "body": [
    {
      "from": 0.25,
      "to": 2.8,
      "content": "哈喽大家好，今天我们聊一个问题。"
    },
    {
      "from": 3.0,
      "to": 5.5,
      "content": "就是为什么显卡算力没跑满？"
    }
  ]
}
```

#### 核心字段说明

| 字段路径 | 类型 | 含义说明 |
| --- | --- | --- |
| `body[]` | `array` | 按播放时间升序排列的逐行字幕条目数组。 |
| `body[].from` | `number` | 该句台词出现的起始时间（单位：秒，通常带有小数，如 `0.25`）。 |
| `body[].to` | `number` | 该句台词消失的结束时间（单位：秒，满足 `to >= from`）。 |
| `body[].content` | `string` | 该时间段内对应的单行字幕文本。 |

---

## 三、请求头、登录 Cookie 与常见状态码

### 1. 请求头与 Cookie 要求

- **常规请求头**：访问 `api.bilibili.com` 时，需携带常见的浏览器 `User-Agent`、`Referer: https://www.bilibili.com` 以及 `Origin: https://www.bilibili.com`。
- **登录态 Cookie**：访问需要登录才能查看的字幕（尤其是大部分 AI 自动生成字幕）时，请求 `api.bilibili.com` 需在 `Cookie` 请求头中携带登录凭证（核心字段为 `SESSDATA`，完整登录态通常还包含 `bili_jct` 与 `DedeUserID`）。
- **CDN 请求无需凭证**：第 3 步访问 `*.hdslb.com` 拉取字幕正文 JSON 时，URL 本身已包含访问签名或为公开静态资源，不需要携带用户的 `Cookie` 请求头。

### 2. 常见业务状态码与 HTTP 状态码

在请求第 1 步和第 2 步接口时，除了网络层面的 HTTP 状态码外，`api.bilibili.com` 还会在 JSON 顶层的 `code` 字段返回业务状态码：

| 状态码类型 | 状态码值 | 协议含义 |
| --- | --- | --- |
| **JSON 业务码 (`code`)** | `0` | 请求成功，有效载荷位于 `data` 字段。 |
| **JSON 业务码 (`code`)** | `-101` / `-403` | 账号未登录、Cookie 已过期，或当前账号无权访问该资源。 |
| **JSON 业务码 (`code`)** | `-400` / `-404` | 请求参数错误（如缺少 `bvid` / `cid`），或对应的视频稿件不存在、已下架。 |
| **JSON 业务码 (`code`)** | `-352` | 触发风控校验或服务端拒绝了未携带 WBI 签名的请求。 |
| **JSON 业务码 (`code`)** | `-412` / `-509` | 请求频率过高，触发业务层限流。 |
| **HTTP 状态码** | `412` / `429` | 触发网关层安全拦截（`412 Precondition Failed`）或请求频次限流（`429 Too Many Requests`）。 |
