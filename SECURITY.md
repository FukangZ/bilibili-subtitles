# 安全政策

## 报告问题

仓库是 [FukangZ/bilibili-subtitles](https://github.com/FukangZ/bilibili-subtitles)。普通缺陷按 [贡献指南](CONTRIBUTING.md) 提 Issue；涉及可利用细节、Cookie、模型 API key、用户字幕或原始供应商错误的，走私密渠道：仓库 Security 页的 “Report a vulnerability”。该入口不可用时，先公开发一条 Issue 只说明需要私密联系方式，等维护者回复后再发细节，Issue 里不附漏洞内容或附件。

报告写清包与版本、Node / 宿主版本和最小合成复现。响应时间没有承诺。维护者需在仓库 Settings → Code security 启用 Private vulnerability reporting，并核对入口确实可用。

## 凭据与网络边界

| 数据 | 位置 |
| --- | --- |
| Pi 的 B 站 Cookie | `agentDir/bilibili-subtitles.credentials.json`，默认 `~/.pi/agent/` 下，与普通插件配置分开 |
| CLI 的 B 站 Cookie | `$XDG_CONFIG_HOME/bili-subs/credentials.json`，未设 XDG 时为 `~/.config/bili-subs/` |
| CLI 的模型 API key | 同一目录下的 `config.json`，交互隐藏输入，不支持环境变量 key、自定义 headers / UA |
| dsh 的 B 站 Cookie | 宿主凭据存储的 `bilibili-subtitles/cookie`，生命周期由宿主管理 |
| Pi / dsh 的模型认证 | 由宿主处理，安全性取决于宿主配置 |

Pi 与 CLI 的凭据文件只存 `{ cookie: ... }`，与普通设置分开，以 `0600` 权限写入，新建父目录用 `0700`；写入走独占临时文件加原子重命名，读写都拒绝符号链接与损坏的 JSON。文件是明文，权限不等于加密。迁移旧配置时先建立并验证独立凭据、再删旧字段，已有的有效凭据优先。项目配置不放 Cookie，查看或更新普通配置也不会带出 Cookie。进程内写队列不是跨进程锁。理由见 [ADR-0010](docs/adr/0010-user-scoped-cookie-storage.md)。

扫码登录只走 core 的 B 站 passport 协议，不带旧 Cookie、不跟随重定向。下载时 Cookie 只发往 `api.bilibili.com`；字幕正文只从 HTTPS `hdslb.com` 及其子域读取，重定向逐跳校验且不带 Cookie。接口由 B 站控制，实测行为见 [协议调研](docs/research/bilibili-subtitle-protocol.md)。

## 内容、模型与文件

- 润色把字幕全文与相关元数据发给所选模型提供方，先确认这些内容可以发给它；B 站 Cookie 不进入模型请求。第三方的数据保留、地域和计费政策由提供方决定。
- 字幕、文章、供应商响应和历史材料里的指令都是数据，不构成工具执行授权。
- 对外只给固定安全消息与白名单诊断：message、响应体、headers、URL、堆栈、提示词、正文和凭证都不透传，见 [ADR-0011](docs/adr/0011-public-errors-and-safe-diagnostics.md)。提交日志前仍需人工检查。
- 输入输出接受当前工作目录内、规范化后无字面越界的相对路径。默认实现不解析真实路径，恶意工作目录中的符号链接逃逸需要外层沙箱。产物用临时文件加硬链接发布、重名编号、不覆盖输入；dsh 走宿主文件策略。保存前复核输入不构成跨文件事务，见 [ADR-0013](docs/adr/0013-atomic-non-overwriting-artifacts.md)。
- `.subtitles/`、真实字幕、凭据、未经检查的日志和本地配置都不进仓库、夹具或发布包；测试用合成样例。
