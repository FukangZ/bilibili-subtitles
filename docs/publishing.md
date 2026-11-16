# 按包发布

本仓库是 npm workspaces，根包为 private。发布单元是四个子包，不能在根目录直接 `npm publish`。本文描述流程，不代表已经推送源码、创建远端标签、发布 npm 包或配置好 Trusted Publisher。

## 发布目标

| Tag | Workspace | 入口 |
| --- | --- | --- |
| `core-v0.1.1` | `@fukangz/core-bilibili-subtitles` | `dist/index.js`、声明和 `prompts/` |
| `pi-v0.1.0` | `@fukangz/pi-bilibili-subtitles` | `src/index.ts`，由 Pi 加载 TS |
| `cli-v0.1.0` | `@fukangz/cli-bilibili-subtitles` | `bili-subs` -> `dist/main.js`，附 Skill |
| `dsh-v0.1.0` | `@fukangz/dsh-bilibili-subtitles` | `dist/index.js`、`client.js`、`cordis.patch.yml`、locale |

示例版本应换成对应包 `package.json` 中的真实版本。`scripts/release.mjs` 仍负责单包选择：只接受稳定版 `core-vX.Y.Z` / `pi-vX.Y.Z` / `cli-vX.Y.Z` / `dsh-vX.Y.Z`，核对包名、非 private 和该包版本，不使用根包版本。旧 `v*` 标签不触发发布；预发布标签也不通过选择校验。

## 三种不同操作

- **源码 push / PR**：`.github/workflows/ci.yml` 在分支 push 与 PR 上执行普通 CI；只有只读仓库权限，不发布 npm、不创建 GitHub Release。
- **包版本 tag push**：`.github/workflows/publish.yml` 仅由四类包标签触发；验证全部包后，仅对选定 workspace 执行 `npm publish`。它不是四包联发。
- **GitHub Release**：网页发布说明与附件，独立于源码 push 和 npm 发布。当前没有自动创建 Release；需要时由维护者手动整理说明。轻量记录目标包、版本、用户可见变动、兼容性与执行过的验证即可，不引入版本管理框架。

这些都是不同的远端写操作，必须分别有明确授权；不能为了验证 CI 随意创建或推送标签。

## 首次发布前

1. 项目采用 [MIT 许可证](../LICENSE)，已确认目标 GitHub 仓库为 [`FukangZ/bilibili-subtitles`](https://github.com/FukangZ/bilibili-subtitles)。四包元数据已设置该身份，但维护者仍须确认远端已创建、实际发布来源、仓库访问权限与代码审查完成。脚本不创建远端，也不能从本地元数据证明线上权限就绪；身份缺失或与预检中的明确目标不一致会阻止发布预检。
2. 由 npm 账号所有者确认 `@fukangz` scope 的发布权限及命名可用性。匿名查询 404 不等于获得发布权限，联网预检不能验证账号、2FA 或 OIDC 配置。
3. **每个 npm 包首次都要手动建包 / 发布**，不能假定新包已可配置 Trusted Publisher。先验证并手动发布 core；core 发布后，按下节单独从 registry 安装验收，再发布依赖它的 Pi、CLI、dsh。包首次发布仍只发布该 workspace，不在根目录发布所有包。
4. 对已经创建的四个 npm 包，**分别**配置 Trusted Publisher：GitHub owner/repo `FukangZ/bilibili-subtitles`，workflow 文件名 `publish.yml`。不能只给 core 配置后认为其他包自动继承。如启用 Environment，须同时在 workflow job 配置完全匹配的 environment；当前 workflow 未配置 environment。
5. 首次手动发布需要账号所有者在自己的终端完成 npm 登录、可能的 2FA，并获得发布授权。不要把 token 写进仓库或聊天；Trusted Publisher 就绪后的 CI 不依赖长效 npm token。实际发布或远端写入不属于离线验证。

## 本地离线验收

建议 Node.js 24，锁文件安装；Pi 宿主准备见 [贡献指南](../CONTRIBUTING.md)。没有宿主时只能执行明确不依赖 Pi 的局部验证，不能声称全仓通过。

```sh
npm ci --legacy-peer-deps
npm run check
node --test --test-concurrency=1 scripts/*.test.mjs
npm test --workspaces --if-present
node scripts/preflight.mjs --offline
npm run verify:packages -- --offline
```

root `check` 会先 build；随后直接运行脚本与 workspace 测试避免重复 build。`npm test` 仍是方便的一体化入口（也会 build）。没有独立 lint / format 脚本；TypeScript check 不是格式检查。单包测试不会自动 build core。

`preflight.mjs --offline` 检查四包当前版本；也可传单个 tag。它复用 `release.mjs` 检查 tag / 名称 / private / 版本，再核对 MIT、根包 private、仓库及发布元数据、许可证副本、适配包的 core 依赖范围。当前只接受已使用的普通稳定 `^X.Y.Z` 范围，并要求包含本地构建所用 core 版本；不接受 workspace、file、任意星号。以后变更范围写法需同步扩展预检与测试，而不是绕过门禁。

`npm run pack:core` / `pack:pi` / `pack:cli` / `pack:dsh` **仍是 dry-run**。`verify:packages` 才会真正生成四个 tgz，将四包装入无 workspace 链接、无 Pi peers 的临时消费项目（本地 core tgz 由临时清单关联，不回链仓库），检查：

- core ESM 公共入口、两份公开 `prompts/*` 与 `loadPrompts()` 内容一致，内部路径不能绕过 exports。
- CLI 的实际安装 bin `bili-subs --help` 与随包 `skills/bilibili-subtitles/SKILL.md`；不调用配置、登录、下载或模型。
- Pi 的 TS 入口、源码与示例；dsh 的编译入口、声明、Web 客户端、补丁、图标及中英文 locale 存在。**这是文件验收，不是 Pi / dsh 宿主加载成功。**
- 四份归档 / 安装包 LICENSE 与根文件逐字相同；没有测试、用户输出、个人规则、凭据或不在分发白名单内的文件。

脚本要求先 build。`--offline` 只用现有 npm 缓存，缺缓存直接失败；默认 `--prefer-offline`，缓存缺失时只安装包中已声明的依赖，请求 8 秒超时、无重试，不执行安装 lifecycle scripts。成功或失败都会清理自己创建的临时目录，不清理已有 `.subtitles/`、`.scratch/` 或其他历史目录。结果输出包含 Node 版本、包版本、文件数量、tgz integrity 与各项检查。它不等同于从 registry 安装验收。

## 实际发布前的联网门禁

显式执行以下只读命令才会查询 registry，不读取 npm 认证配置、不登录、不发布：

```sh
node scripts/preflight.mjs core-v0.1.1 --registry
# core 发布并完成 registry 安装验收后，才轮到适配包：
node scripts/preflight.mjs cli-v0.1.0 --registry
```

- 核对离线门禁，并匿名检查目标精确版本尚未发布；已发布或非 404 网络 / JSON 错误均阻止，不覆盖同版本。首次 core 发布不要求 core 自身已存在。
- 对适配包，检查**本地构建所用精确 core 版本**的 registry 元数据已存在；即使更旧版本满足声明范围，也不能用它代替新构建所需的版本。随后验证该 core 的官方 `dist.tarball` 可获取且 SHA-512 与元数据一致。
- 仅允许 `https://registry.npmjs.org/`，拒绝重定向、URL 认证信息 / query / fragment；每次 HTTP 请求最多 8 秒、无重试。core 归档上限 5 MiB，超限、缺 integrity、内容不符或不可取都失败，不静默降级为离线成功。
- GitHub Actions 中 `GITHUB_REPOSITORY` 必须匹配目标身份（若提供）；本地检查使用已确认的固定元数据。该检查不证明远端仓库存在、scope 权限或 Trusted Publisher 生效。

**门禁通过只代表注册表元数据与归档可获取 / 完整性通过，不代表真实从 registry 安装或运行。** 首个 core 发布后，由维护者在全新临时消费目录直接 `npm install @fukangz/core-bilibili-subtitles@<精确版本>`，不加 overrides / 本地 tgz、不使用 workspace；确认 core ESM 与两份公共提示词可用。保留结果后再给依赖适配包发布授权。CLI 发布后同理核验 registry 安装的 `bili-subs --help` 与 Skill；Pi / dsh 另需真实宿主兼容验收。这些首次发布后人工步骤尚未由本地测试完成。

## CI 与常规发布

普通 CI 的 Node 24 job 用共享 `.github/actions/prepare/action.yml` 准备 npm `11.5.1`、Pi 宿主 `@earendil-works/pi-coding-agent@0.87.1`，锁文件安装后运行全仓 check / 测试和离线预检。Node 22 job 不安装 Pi 宿主，只 build 与真实 tgz 消费，覆盖声明最低 Node 主版本的宿主无关分发路径，不声称所有宿主组合都兼容。脚本测试使用模拟 registry，无真实账号或模型。

Pi 的 peer 名称为 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`。`link-peers.mjs` 查找当前 Node 的全局宿主或 pi-web 内嵌宿主；跳过不等于满足 peer。`npm ci --legacy-peer-deps` 避免补装宿主 peers，不能代替 API 兼容性测试。

版本更新时同步检查 core API 与适配包范围，先发 core、验收其 registry 安装，再发适配包。不同包标签可能并行，但适配包的 registry 门禁**立即失败而不是等待或重试**；不要一起推四个首发标签。确认 core 已可用并有安装记录后，再单独触发适配包发布。CI 的只读检查与真正 publish 之间仍有时序窗口，发布权限与人工顺序不能被脚本取代。

获得授权后，才从已审查的发布提交创建并推送目标包标签，例如：

```sh
git tag core-v0.1.1
git push origin core-v0.1.1
```

发布 workflow 使用 Node 24 / npm 11.5.1 / 上述固定 Pi 宿主，在 GitHub 托管 runner 运行 check（含 build）、脚本和 workspace 测试、真实 tgz 验收、单包联网门禁，再只 publish 选定 workspace。只有该 job 有 `id-token: write`，仓库内容仍为只读；不会随标签发布根包、其他包或 GitHub Release。Trusted Publisher 的仓库 / workflow / environment 任一不匹配都可能认证失败；提交 workflow 不代表已经配置完成。
