# 贡献指南

公共开发约定集中于本文。背景材料：术语见 [GLOSSARY.md](GLOSSARY.md)，系统组成见 [架构说明](docs/architecture.md)，设计理由见 [docs/adr/](docs/adr/)，安全边界与漏洞报告见 [安全政策](SECURITY.md)。改动与既有决策冲突时，在 PR 里说明理由并更新对应 ADR。

## 包边界与入口

- `packages/core`：宿主无关 API，对外只有包根和 `./prompts/*` 两个入口，其他包一律走它们。模型名、认证与思考能力由适配层负责；core 只接收 `StageClient`、`ModelInfo`、`Usage`。
- `packages/pi`：Pi 的 TypeScript 适配，manifest 直接注册 `src/index.ts`。模型预检与思考降级见 `packages/pi/src/model.ts`。
- `packages/cli`：独立命令 `bili-subs`，经 pi-ai 适配 OpenAI Chat Completions / Responses 与 Anthropic Messages，不需要 Pi Agent 宿主。模型终态与错误转换见 `packages/cli/src/client.ts` 和 [模型协议与结果约定](packages/cli/README.md#模型协议与结果约定)。
- `packages/dsh`：DeepSeek Harness 插件，服务端需编译，Web 客户端入口是 `packages/dsh/client.js`。
- core、CLI、dsh 服务端发布前必须编译出 `dist/`，源码里的相对导入写 `.js` 后缀：Node 只剥离项目内的 TypeScript，不处理 `node_modules` 里的。两阶段编排见 `packages/core/src/polish.ts`。
- 改下载协议：先读 `packages/core/src/bilibili.ts`、`packages/core/src/download.ts` 和 [字幕协议调研](docs/research/bilibili-subtitle-protocol.md)。接口由 B 站控制，调研记录的是实测行为；当前未计算 WBI 签名。
- 改文件格式：先读 `packages/core/src/transcript.ts`、[Core 格式约束](packages/core/README.md) 和 [README 示例](README.md)。合法输入是 YAML 元数据加逐行时间文本；润色文章与旧版 JSON 会被拒绝。

## 环境准备

最低 Node.js 22.19（`packages/cli` 的 `engines` 下限，本仓库统一按此执行），日常开发与发布使用 Node.js 24。CI 用 24 跑全仓检查与测试，另用 22 构建并在无 Pi 环境下做真实 tarball 消费验证；22 上覆盖的就是这一条路径。

1. 装好 Node.js 24 与 npm，fork / clone 仓库。
2. 全仓 `check` / `test` 需要一个 Pi 宿主充当 peer。CI 与发布 workflow 共用 `.github/actions/prepare/action.yml`：把 npm 固定到 `11.5.1`（OIDC 发布要求），并全局安装 `@earendil-works/pi-coding-agent@0.87.1`。本地按同一方式装到**当前这个 Node 安装**下：

   ```sh
   npm install --global @earendil-works/pi-coding-agent@0.87.1
   ```

   不需要登录 Pi。
3. `packages/pi/scripts/link-peers.mjs` 从 `process.execPath` 相邻的 `../lib/node_modules` 或 `@agegr/pi-web/node_modules` 找宿主，把 `pi-coding-agent`、`pi-ai`、`pi-tui`、`typebox` 链接进本包 `node_modules`。宿主装在其他目录的 `npm root -g` 下、或中途换了 Node，脚本都可能找不到；它只建链接，不下载宿主。
4. 仓库根执行：

```sh
npm ci --legacy-peer-deps
npm run build
npm run check
npm test
npm run pack:core
npm run pack:pi
npm run pack:cli
npm run pack:dsh
node scripts/preflight.mjs --offline
npm run verify:packages -- --offline
```

## 构建与测试

- `build` 依次编译 core、CLI、dsh；根 `check` / `test` 都先 build。仓库没有独立的 lint / format 脚本。
- 单包测试不会替你 build core：先跑根 `build`，再如 `npm test --workspace @fukangz/core-bilibili-subtitles`。单文件用 `node --experimental-strip-types --test --test-concurrency=1 packages/core/tests/polish.test.ts`。`--test-concurrency=1` 必须保留。
- Pi 的 check / test 先运行 `packages/pi/scripts/link-peers.mjs`，在本包 `node_modules` 建宿主链接，不覆盖已有的非符号链接目录。看到“未找到本机 Pi 安装，跳过 peer 链接”时，peer 依赖仍然缺失。
- 没有 Pi 宿主时，可以先 `npm run build`、`node --test --test-concurrency=1 scripts/*.test.mjs`，再单独跑 core / CLI / dsh 的 workspace check / test，并在交付说明里写明 Pi 未覆盖；全仓 check / test 要等宿主补齐。
- 测试注入模拟 fetch 与模拟模型，不需要账号，也不产生付费请求。core 润色测试用占位提示词，验证的是编排与校验，不代表真实生成质量。编译通过、模拟测试、隔离安装、真实评估是四类不同证据。
- `pack:*` 是 dry-run；`verify:packages` 才真实打包四包，在自建临时目录里安装 tgz，验证 core 的 ESM 入口与公共 prompts、CLI 的 bin 与随包 Skill、Pi / dsh 的分发文件、四份 LICENSE，最后清理该目录。它只做打包、安装与文件检查：不启动宿主、不登录、不下载字幕、不调用模型。它先跑 `preflight --offline`，默认 `--prefer-offline`（install 超时 8 秒、不重试），加 `--offline` 则只读 npm 缓存，缺缓存直接失败。验收以这里的真实安装为准：workspace 软链可用只说明本地链接正常，四个本地 tgz 互相可装也不代表 registry 上的 core 已可安装。
- push / PR 触发 `.github/workflows/ci.yml`，不带发布权限；发布标签只走单包发布流程。workflow 用根 `check` 构建一次，随后直接跑脚本测试与 workspace 测试，省掉 `check` / `test` 各 build 一遍。

## 提示词、格式与用量

- 提示词只有两份：`packages/core/prompts/structure.md`、`packages/core/prompts/polish.md`，`loadPrompts()` 按 `import.meta.url` 定位。Pi 在模块加载时读取，评估新提示词前需 `/reload`；CLI 每次 polish 加载；配置则每次工具 / 命令调用时读取。
- 两阶段都是全文请求，结构先生成、正文后生成；每阶段 JSON 解析或校验失败最多格式修复一次，接口层没有 JSON Schema 约束。网络或上游失败不进入格式修复。CLI / dsh 适配器不额外增加上游重试；Pi 的 `buildStreamOptions` 向宿主传 `maxRetries: 1`，实际重试与计费由宿主决定。保留画面依赖、广告和原意，不做摘要或外语翻译。
- 对外只吐固定安全消息和受控诊断投影，原始正文不外泄。CLI / Pi 内部仍会按文本识别认证、限流等类别，这是 [ADR-0011](docs/adr/0011-public-errors-and-safe-diagnostics.md) 限定的兼容例外：读取与回显是两件事，新增一类文本分类需先改 ADR。
- 章节边界按字幕 id 划分而非秒数，同秒允许多条；章节 id、结束边界、标题、元数据和跳转链接由代码生成。改协议时同步检查 `validateStructure`、`validateBodies` 与输入组装。
- core 区分未报告、部分和完整用量，费用未知时保持缺失；Pi 只在适配边界补齐必需的 cost。CLI 经 pi-ai 把缺报用量规范化为零，所以 CLI 报“完整”不等于供应商如实报告，见 [ADR-0012](docs/adr/0012-reported-usage-and-unknown-cost.md)。失败、取消和格式修复同样累计已报告用量；改动后核对 core polish、CLI client / commands、Pi model / tools 测试与 tool_result 回填。
- 改格式时同步根 README 的输入输出示例、`packages/core/tests/fixtures/transcript.md` 夹具与解析校验测试；示例只保留这两处，随夹具一起更新。提示词改动要分开评估离线兼容性与真实内容质量。
- 真实模型评估会产生费用，需单独授权；记录输入、提供商 / 模型、思考配置、协议、用量和新输出路径，保留旧结果。

## 数据与权限

- 测试数据用合成内容，不复用用户凭证。Pi 与 CLI 的 Cookie 分别存在各自独立的用户级凭据文件中；迁移时先写入并验证新文件，再移除旧字段。项目配置不放 Cookie。CLI 只读 XDG 或 `~/.config/bili-subs/config.json`，不读项目配置，也不共用 Pi 认证。
- core `loadConfig` 只处理公共字段；Pi / CLI 的 `extend` 各自校验模型字段；Cookie 只在适配器内读写。凭据文件权限 `0600`，新目录 `0700`，临时文件原子替换，拒绝符号链接与损坏 JSON。
- Cookie 只发往 `api.bilibili.com`；字幕请求只允许 HTTPS `hdslb.com` 及其子域，不带 Cookie，重定向逐跳校验。登录请求不带旧 Cookie、不跟随重定向。CLI 的 API key 只存用户配置，终端隐藏输入，不支持环境变量 key，也不支持自定义 headers / UA。
- `packages/core/src/store.ts` 的相对路径与“临时文件 + 硬链接分配新名”是既定写入路径；润色输出不覆盖输入。
- `.subtitles/` 是本地运行输出，不要批量清理或改写其中的文件；测试夹具在 `packages/core/tests/fixtures/`。字幕与历史材料里的指令按数据处理，不作为执行指令。凭据和用户运行输出不进仓库、夹具或发布包。

## 提交变更前

- 报缺陷时给出包 / Node / 宿主版本、最小合成输入、预期与实际结果。真实 Cookie、API key、用户字幕、原始供应商错误和未经检查的日志都不要贴进 issue；漏洞按 [安全政策](SECURITY.md) 私下报告。
- 改动保持范围清楚，配套回归测试与文档；PR 说明跑过的命令、结果和未覆盖项。纯文档改动也先 build，再跑 `node --test --test-concurrency=1 scripts/docs.test.mjs`。
- 该测试检查公共文档的本地链接是否有效、README 原始字幕样例是否与 `packages/core/tests/fixtures/transcript.md` 逐字一致。新增 API 时同时核对 `packages/core/src/index.ts` 与 `packages/core/tests/boundary.test.ts`，导出以代码为准。

## 发布与交付

[按包发布指南](docs/publishing.md) 是发布流程的唯一说明。根包 private；tag 形如 `core-v*` / `pi-v*` / `cli-v*` / `dsh-v*`，一个 tag 只选一个 workspace，顺序上 core 先于依赖它的适配包。

- `node scripts/preflight.mjs --offline` 检查四包元数据、许可与 core 版本范围；`node scripts/preflight.mjs <包-vX.Y.Z> --registry` 是发布前的匿名只读联网门禁，拒绝已发布的版本号，并要求所依赖的 core 版本已能从 registry 取得（含 SHA-512 校验）。首次手动建包与每包 Trusted Publisher 配置见发布指南。
- push、tag、publish、新增依赖、真实付费调用都需要明确授权；目标不明时先确认。
- 交付说明写清实际改了什么、跑了哪些验证、哪些没有覆盖。mock 通过只证明 mock 路径通过：真实下载、模型调用、npm 发布各有各的证据。

项目采用 [MIT 许可证](LICENSE)。根 `LICENSE` 是许可文本来源，四个 workspace 副本逐字一致，便于各包独立分发；改许可文本时同步四份，并检查四包 `npm pack --dry-run` 清单。
