# 平台技术架构（实现说明）

本文描述**当前代码实际如何运行**。产品目标、取舍和里程碑见 [design.md](design.md)；本地启动步骤见 [README](../README.md)；应用配置字段见 [manifest.md](manifest.md)；安全边界见 [security-boundary.md](security-boundary.md)。

## 1. 运行形态

平台是一个 Node.js（TypeScript）模块化单体，Fastify 提供 HTTP，后台任务在同一进程内运行。

```
浏览器 / App WebView
        │ HTTPS
        ▼
nginx（线上 ingress / 本地 scripts/dev-proxy.mjs）
        │ 按路径分流
        ▼
server（Fastify，单进程，可水平扩容）
 ├ admin-api        后台接口
 ├ gateway          /__platform/*，应用同源接口
 ├ app-host         dev / beta / prod 静态源码
 ├ agent            AI 轮次执行（同一应用串行）
 ├ build            发布前校验队列（进程内循环 + Redis 锁）
 └ telemetry        埋点与预览运行时错误
        │
        ├ MongoDB        平台库 + 每个应用每环境一个库 + 内容寻址 blob
        ├ Redis（可选）  锁、限流、计数、pub/sub；未配置时退回进程内存
        └ LLM 网关       OpenAI 兼容 Chat Completions
```

进程角色由 `ROLES` 控制，默认 `api,build`（[config.ts](../apps/server/src/config.ts)、[main.ts](../apps/server/src/main.ts)）：

| 角色 | 启动内容 |
|---|---|
| `api` | HTTP 服务；启动时 `recoverTurns()` 清理上次卡住的 AI 轮次并继续排队任务 |
| `build` | 发布前校验队列（启动时把 `running` 重置为 `queued`，之后每 5s 拉取） |

预览不需要独立角色：草稿文件由 `api` 直接返回。

单进程部署最简单；拆多副本时必须配置 `REDIS_URL`，否则锁、限流和 pub/sub 只在本进程内生效。

## 2. 仓库与模块边界

```
apps/server          Fastify 服务端
  src/config.ts      环境变量解析
  src/app.ts         路由装配、路径解析、admin 静态资源、预览代理
  src/core/          应用、草稿、快照、校验、业务接口文档
  src/modules/
    admin/           后台登录、应用/成员、文件、数据台、能力审批、发布、监控
    gateway/         身份、数据库、KV、文件、业务代理、埋点
    host/            dev / beta / prod 静态托管、平台运行时文件、CSP、占位页
    agent/           系统提示、工具、轮次执行、事件流、SSE 路由
    build/           构建、manifest 变更对比、发布、飞书通知
  src/lib/           mongo、blob、store(Redis/内存)、llm、http、token
apps/admin-web       Vue3 + Element Plus + Monaco 后台与对话式 IDE
packages/sdk         应用运行时 SDK，esbuild 打成单文件 dist/sdk.js
packages/app-template 应用模板、平台前端运行时（dom/ui）、Tailwind 运行时
packages/shared      manifest/DSL/事件协议/OpenAPI 解析
packages/app-guard   生成代码安全扫描
packages/agent-docs  给模型看的规则、SDK、manifest 文档
deploy/              Dockerfile、nginx 模板、本地证书
scripts/             dev 编排、HTTPS 代理、冒烟测试
```

运行时不执行应用代码：没有编译和打包，`index.html` 和 `src/**/*.js` 直接返回（仅对指向应用文件的根路径引用补 `/a/{appId}/` 前缀），浏览器直接执行。原子类由浏览器端的 `/__platform/tailwind.js` 扫描 DOM 生成；没有组件库，界面由原生标签 + Tailwind 组合，小工具从 `/__platform/dom.js` 导入（[packages/app-template/platform/index.mjs](../packages/app-template/platform/index.mjs)）。

## 3. 入口域名与请求分流

平台只有一个入口域名，站点由**路径**区分（解析见 [packages/shared/src/app-id.ts](../packages/shared/src/app-id.ts)）：

| 路径 | 含义 | 数据环境 |
|---|---|---|
| `/admin`、`/admin/...` | 后台 SPA | — |
| `/admin-api/...` | 后台接口 | — |
| `/a/{appId}/...` | 线上版 | `prod` |
| `/a/{appId}--beta/...` | 测试版 | `dev` |
| `/a/{appId}--dev/...` | 实时预览 | `dev` |
| `/__platform/...` | 平台运行时、SDK、网关接口 | 由请求头决定 |
| `/healthz` | 健康检查 | — |

- `appId` 为 3–30 位小写字母/数字/连字符，不能含 `--`；`admin`、`api`、`www` 等是保留字。
- nginx 只做 HTTPS 终止和反向代理，**不注入**任何身份头；server 按路径解析站点（[apps/server/src/app.ts](../apps/server/src/app.ts)）。
- 应用代码里的根路径引用（`/src/app.js`、`/logo.png`）在返回时被重写为 `/a/{appId}[--channel]/...`；只有能对应到应用文件的路径才会重写，避免误伤 `platform.biz.request('/api/...')`。
- 后台如果走 nginx 静态托管，`/admin/` 需要透传 server 返回的 COOP / XFO / CSP 头。
- 本地由 `scripts/dev-proxy.mjs` 复刻同一套分流：`/admin/` 转发 admin-web（Vite :5173），其余转发 server（:3000）。只需要一个 `/etc/hosts` 记录，不再需要泛域名 DNS。

`/*` 最终处理顺序：

1. `admin` 路径 → 读 `apps/admin-web/dist`（`/admin` 前缀已剥离），SPA 路由回退 `index.html`。
2. `dev` 渠道 → 校验预览 cookie，通过后由 `serveAppDraft()` 直接返回草稿文件。
3. `prod` / `beta` → `serveAppBuild()` 返回对应构建记录里的文件清单（内容就是源码）。

## 4. 应用托管

### 线上版与测试版

应用源码以文件清单（path + blob hash）存在 `builds` 文档里，文件内容在 `blobs` 集合（内容寻址，SHA-256）。`serveAppBuild()`（[app-host.ts](../apps/server/src/modules/host/app-host.ts)）：

- 应用文件挂在 `/a/{appId}[--channel]/` 下；`serveFiles()` 用去掉前缀后的路径查文件清单。
- 文本文件（html/js/css/svg）里的根绝对引用会补上应用前缀，改写结果按构建 + 路径缓存；只改写能匹配到应用文件的路径。
- `index.html` 缺少的平台标签由服务端注入：`boot.js?app=...&channel=...`、`ui.css`、`tailwind.js`。应用删掉也一定生效。
- 三个渠道的 `index.html` 都返回 `no-store`；beta / prod 的其他文件 60s 缓存并带 ETag。
- 未知无扩展名路径回退 `index.html`，支持 history 路由；多页应用可以直接放 `about.html` 或 `about/index.html`。
- `.map` 一律 404；`admin.json` 也不通过应用路径返回。
- 平台运行时文件由 [platform-assets.ts](../apps/server/src/modules/host/platform-assets.ts) 提供：`dom.js`、`ui.js`、`ui.css`、`tailwind.js`，都带一天缓存，路径保持根路径、跨应用共享。
- 下线、未到活动时间、已结束、未发布时返回平台占位页。
- 响应统一带 CSP 与安全头（[csp.ts](../apps/server/src/modules/host/csp.ts)）：`default-src 'self'`、`script-src 'self'`、`style-src 'self' 'unsafe-inline'`、`frame-src 'none'`、`frame-ancestors 'self'`。业务接口走同源代理，因此不需要放行业务域名。

### 实时预览

1. 后台调用 `POST /admin-api/apps/:appId/preview-url` 签发短期票据（普通 10 分钟，二维码 30 分钟），票据里带 appId 和渠道。
2. 浏览器访问 `/__platform/preview-auth?t=...&next=...`，服务端校验票据后写入 `__Host-app_preview__{appId}` cookie（24h，HttpOnly、Secure、SameSite=Lax），再 302 到 `/a/{appId}--dev/{next}`。
3. `dev` / `beta` 渠道的页面请求和平台接口都要求该 cookie；没有则返回「需要预览权限」占位页。
4. 预览直接返回草稿文件（`serveAppDraft()`），没有 dev server、没有 HMR；刷新页面即可看到最新代码。
5. `public/` 下的文件按应用根路径访问（各渠道一致）。
6. 预览身份可锁定为 `self` / `guest` / `test`，由票据声明；`guest` 和 `test` 会覆盖主站 cookie 的解析结果。
7. cookie 名带 appId，可以同时预览多个应用；claims 里的 appId 也会校验，不能拿 A 的票据预览 B。

## 5. 身份与登录

### 后台

- 只支持飞书 OAuth；本地 `DEV_ADMIN_BYPASS=1` 时可用 `/admin-api/auth/dev-login`。
- 后台与应用**同源**，因此**不使用 cookie 会话**。飞书回调签发 60 秒一次性票据，302 到 `/admin#t=...`；SPA 用 `POST /admin-api/auth/exchange` 换 Bearer token，只存内存（刷新后静默重登）。
- `/admin-api/*` 只认 `Authorization: Bearer`，没有 cookie 回退；非 GET 仍校验 `Origin`；OPTIONS 直接 403；不开放 CORS。
- `/admin` 文档返回 `Cross-Origin-Opener-Policy: same-origin`、`X-Frame-Options: DENY`、`frame-ancestors 'none'`，阻止应用页面通过 popup / iframe 拿到 token。细节见 [security-boundary.md](security-boundary.md)。
- 角色：平台管理员、应用 `owner` / `developer` / `viewer`。平台管理员对所有应用等价于 owner。

### 应用端

`resolveIdentity()`（[identity.ts](../apps/server/src/modules/gateway/identity.ts)）：

- `AUTH_PROVIDER=main-site`：把 `sess` 等主站 cookie 转发给 `AUTH_USERINFO_URL`，把结果按 `sha256(sess)` 缓存 `AUTH_CACHE_SECONDS`（默认 60s）；用户 uid 字段按 `AUTH_UID_FIELDS`（默认 `uid,user_id`）依次尝试取值。平台**不签发自己的会话**，主站登出后最多 60s 失效。
- `AUTH_PROVIDER=mock`：读取 `app_mock_user` cookie，配合 `/__platform/api/dev/mock-login` 做本地调试。
- 预览渠道优先使用票据里的锁定身份。

SDK 登录（[packages/sdk/src/auth.ts](../packages/sdk/src/auth.ts)）：

- 启动即请求 `/auth/me`；`requireLogin` 且未登录时进入登录门禁。
- App 内走原生桥拉起登录，用「原生回调 + 回到前台 + 每 2s 轮询」三路检测，最多 2 分钟。
- 浏览器内渲染 SDK 自己的登录弹窗（手机号 + 短信 + 极验），不依赖应用的技术栈。
- 任何 `401`/`LOGIN_REQUIRED` 由 `withLogin()` 全局 single-flight 拉起一次登录，成功后重放请求。没有 `requireLogin` 的应用同样适用：游客先浏览，点到需要身份的操作才登录。
- 页面可见时每 5 分钟、切回前台时检查身份；uid 变化强制 reload。

登录要求本身由 `manifest.requireLogin` 控制（默认 `false`）。后台设置页的开关调用 `PUT /admin-api/apps/:appId/require-login`（`developer` 及以上），直接改草稿里的 `manifest.json` 并写审计 `app.requireLogin`；`dev` 立即生效，`beta` / `prod` 随发布生效。取消强制登录会在发布时生成确认项。

## 6. 平台网关（`/__platform/api/*`）

入口中间件（[gateway/index.ts](../apps/server/src/modules/gateway/index.ts)）依次校验：

1. 请求必须带合法的 appId（SDK 请求头或查询参数）。
2. OPTIONS 一律 403。
3. 除 `boot.js`、`preview-auth`、`telemetry` 和文件 GET 外，必须带 `X-App-SDK: 1`。
4. 带 `Sec-Fetch-Site` 时必须是 `same-origin`。
5. 按 IP 限流（默认 1200 次/分钟）。
6. 应用必须存在。
7. `dev` / `beta` 还必须带有效预览 cookie。

响应统一为 `{ error_code, error_msg, data }`；未登录返回 HTTP 401，其余错误码见 [shared/errors.ts](../packages/shared/src/errors.ts)。

### 接口清单

| 路径 | 说明 |
|---|---|
| `GET /__platform/boot.js` | 注入 `window.__APP_CONFIG__` 配置并返回 SDK 单文件 |
| `GET /__platform/dom.js` `ui.js` `ui.css` | 平台前端工具与基础样式 |
| `GET /__platform/tailwind.js` | Tailwind v4 浏览器运行时（扫描 DOM 生成原子类） |
| `GET /__platform/preview-auth` | 预览票据换 cookie |
| `GET /__platform/api/auth/me` | 当前用户 |
| `POST /__platform/api/dev/mock-login` / `mock-logout` | 仅 mock 模式 |
| `POST /db/:col/query`、`/count`、`/group` | 查询、计数、分组 |
| `POST /db/:col`、`GET/PATCH/DELETE /db/:col/:id` | 增删改查 |
| `GET/PUT/DELETE /kv/user/:key`、`GET /kv/app/:key` | 用户 KV、应用 KV |
| `POST /files`、`GET /files/:id` | 文件上传与读取 |
| `POST /telemetry` | 埋点（sendBeacon 不带 SDK 头，单独放行） |
| `POST /dev/errors` | 预览运行时错误回传 |
| `ALL /biz/*` | 业务接口同源代理 |

### 数据读写

实现见 [gateway/data.ts](../apps/server/src/modules/gateway/data.ts)：

- 集合必须在当前渠道生效的 manifest 中声明：`dev` 用草稿，`beta` / `prod` 用对应 build 的 manifest。
- ACL 在服务端强制：`private` / `public_read` / `submit_only` / `public_submit` / `public_write` / `readonly` / `admin_only`。完整矩阵见 [manifest.md](manifest.md)。
- 数据归属（actor）：登录用户用 `uid`；游客用 `app_vid` cookie 拼成 `vid:<值>`，没有 cookie 时退回 `ip:<客户端 IP>`。`_owner`、`mine()`、`perUserDocs`、唯一索引、写入限流都按 actor 计算。
- `public_submit`：游客可新增，读自己的，不能改删；`public_write`：游客可新增，所有人可读，可改删自己设备提交的。其余 ACL 的新增/修改/删除仍要求登录。
- 读过滤自动注入 `_owner`（`own` 范围）；写操作只能改自己创建的文档。
- 写入前用 AJV 校验 `fields`（`additionalProperties: false`），拒绝 `_` 开头的系统字段和 `$` / `.` 开头的键；单条默认上限 16KB。
- 系统字段由服务端写入：`_id`、`_owner`、`_ownerProfile`、`_createdAt`、`_updatedAt`。
- 查询 DSL 只允许 `$eq $ne $gt $gte $lt $lte $in $nin $exists` 与 `$and/$or`，深度 ≤ 3、条件 ≤ 30、`limit` ≤ 100、`skip` ≤ 5000；`orderBy` 最多 3 个字段。
- 生产环境排序、计数、分组只能用已声明索引的字段；开发环境只上报 `data-warning` 给 AI。
- 写入限流：全局每用户每分钟 120 次，集合可再配 `writesPerMinute`；`perUserDocs` 做每人条数配额。
- `moderate` 字段写入前过内容安全审核。

### 文件与 KV

- 上传只接受图片、音频、视频，默认 5MB，每用户 30 次/分钟；内容存 `blobs`，元数据存 `_files`。
- 公开文件可被所有访问者读取；私有文件只有上传者可读。文件响应带 `sandbox` CSP 和 `nosniff`。
- `kv.user` 需要登录，每个应用每环境按 `{uid}:{key}` 存；`kv.app` 只读，由后台数据台维护。

### 业务接口代理

`resolveBizTarget()`（[core/biz-docs.ts](../apps/server/src/core/biz-docs.ts)）按「已授权前缀 → 目录条目 → OpenAPI operation」解析：

- 路径必须以已批准前缀开头，否则 403。
- 上游地址优先级：接口级 `x-upstream` > 目录 `upstream` > `BIZ_API_ORIGIN`；都未配置时代理报「没有配置上游地址」。
- 请求头可配置目录级/接口级覆盖（`x-upstream-headers`），值支持 `env:NAME` 从环境变量读取。
- OpenAPI 里配置了路径改写时按文档转换（`x-upstream-path`）；未配置原样转发。
- 转发主站 cookie，但剔除平台 cookie（后台会话、预览票据、mock 身份）。
- 上游 3xx 直接报错（避免浏览器跟到内网地址）；超时默认 15s；响应不缓存。

## 7. AI Agent

### 轮次执行

[agent/runner.ts](../apps/server/src/modules/agent/runner.ts)：

- 消息先落 `agent_turns` 为 `queued`，然后 `kick(appId)`。
- 同一应用用 Redis/内存锁串行执行；不同应用可并行。
- 每轮开始创建 `pre` 快照；执行完按文件哈希对比生成 `ai` 或 `interrupted` 快照。
- 每轮最多 `AGENT_MAX_STEPS`（默认 40）次模型调用。
- 工具调用结果按顺序回填为 `tool` 消息；界面只展示摘要。
- 结束前若本轮改过文件或最后一次校验失败，强制跑 `check`；失败自动追加修复提示，最多 `AGENT_MAX_AUTOFIX`（默认 3）轮。
- 每用户每日 token 上限 `AGENT_DAILY_TOKENS_PER_USER`（默认 300 万），按应用另有统计。
- 服务重启时，卡在 `running` 的轮次标记为失败并推送 `turn.done`；`queued` 的继续执行。

上下文管理：

- 历史来自同一会话已结束的轮次；最近两轮保留 4000 字符的工具输出，更早的截到 600。
- 估算 token 超过上下文窗口一半时，用 `LLM_SMALL_MODEL` 把较早轮次压缩成摘要，存到 `agent_sessions.summary`。

### 工具

| 工具 | 作用 |
|---|---|
| `list_files` `read_file` `glob` `grep` | 读草稿 |
| `write_file` `edit_file` `delete_file` `move_file` | 改草稿；`manifest.json` 写入前先校验 |
| `todo_write` | 更新步骤清单 |
| `check` | manifest + app-guard + 业务接口核对 + `node --check` 语法检查 |
| `get_runtime_errors` | 读预览回传的 JS/console/接口/编译错误 |
| `db_query` / `db_seed` | 只操作 dev 数据 |
| `read_docs` | 读取 `agent-docs` 的规则、SDK、manifest 文档 |
| `read_biz_api` | 读取已登记业务接口的 OpenAPI 细节 |

方案模式（`planMode`）只暴露只读工具，任何写工具都会被拒绝。

### 事件与续传

[agent/events.ts](../apps/server/src/modules/agent/events.ts)：

- 事件类型见 [shared/events.ts](../packages/shared/src/events.ts)。
- `text.delta` / `thinking.delta` 按 80ms 合并，其他事件 300ms 批量落库。
- 实时推送走 Redis pub/sub（或内存 EventEmitter）；`agent_events` 持久化，`seq` 唯一。
- 每轮开始原子预留 100 万个 seq，避免排队事件与运行中事件冲突；SSE 客户端按已发送集合去重，而不是假设 seq 单调。
- `GET /admin-api/sessions/:id/stream?after=<seq>` 先订阅再补发历史，避免丢事件；每 15s 发 ping。

### 撤销与回滚

- `POST /admin-api/turns/:id/revert`：只恢复该轮改过的文件；若之后又被改过，默认拒绝，`force=true` 才覆盖。
- `POST /admin-api/turns/:id/rollback`：整库恢复到该轮开始前的快照。
- 两者都会再生成一条 `rollback` 快照，不会丢失操作痕迹。

## 8. 校验、构建与发布

### 校验（`check`）

[core/checks.ts](../apps/server/src/core/checks.ts) 顺序执行：

1. manifest 解析与 schema 校验；`index.html` 必须存在。
2. app-guard 安全扫描：内联脚本、外链、`eval`、原生桥、相对导入缺扩展名、`.vue` 文件等。
3. 业务接口调用核对：路径是否授权、是否在文档中、方法/参数名是否一致。
4. `node --input-type=module --check -` 逐文件做语法解析（只解析，不执行）。

错误阻断，警告不阻断。

### 构建

[build/service.ts](../apps/server/src/modules/build/service.ts)：

- 同一应用同一时间只允许一个 `queued` / `running` 构建。
- 构建前为草稿生成 `build` 快照，对快照源码执行 `checkSources`。
- 没有编译产物：成功时把快照的文件清单直接记为构建文件，记录 `manifest`、体积、变更摘要、需确认项，并切换 `apps.betaBuildId`。
- 源码超过 2MB 给警告；缺少 `index.html` 视为失败。
- 队列是进程内循环 + Redis `setNX` 锁，**不是**独立的 BullMQ worker；多副本可共存，靠锁互斥。
- 构建完成发飞书通知。

### 发布与回滚

- 只有应用 `owner` 能发布。
- `compareManifest()` 对比线上 build 的 manifest：删除集合、删除字段、放宽 ACL、取消强制登录等会生成确认项；未审批的能力/业务接口给警告。
- 存在确认项时必须显式 `confirmed=true`。
- 发布：按新 manifest 在 prod 库补索引 → 写 `releases` → 切换 `apps.prodBuildId` / `prodReleaseId` → 清应用缓存 →（配置了 `CDN_PURGE_URL` 时）刷新 CDN。
- 回滚：选中历史 release，重新指向其 build，并写一条 `kind=rollback` 记录。

## 9. 数据模型

平台库（MongoDB，`MONGO_URL` 指向的库）：

| 集合 | 内容 |
|---|---|
| `admin_users` | 后台用户、飞书 openId、是否平台管理员 |
| `apps` | 应用元数据、状态、排期、beta/prod 指针 |
| `app_members` | 应用成员与角色 |
| `draft_files` | 草稿文件元数据（hash、size、rev） |
| `blobs` | 内容寻址的二进制（草稿、快照、构建产物、上传文件共用） |
| `snapshots` | 版本快照（文件清单） |
| `builds` | 构建记录、产物清单、manifest、校验结果 |
| `releases` | 发布与回滚记录 |
| `grants` | 能力/业务接口申请与审批 |
| `biz_api_catalog` | 业务接口目录与 OpenAPI 文档 |
| `agent_sessions` | 会话、上下文摘要、token 用量 |
| `agent_turns` | 轮次、消息、改动、快照指针 |
| `agent_events` | SSE 事件（`sessionId + seq` 唯一） |
| `audit_logs` | 审计 |
| `api_clients` | 开放接口调用方（token 哈希、应用范围、权限、IP 白名单） |
| `telemetry_events` | 埋点，TTL 30 天 |

应用数据：

- 每个「应用 × 环境」一个库：`appdata_{appId}_{dev|prod}`。
- 预览和测试版读写 `dev`，线上读写 `prod`。
- 系统集合：`_kv_user`、`_kv_app`、`_files`。
- 发布只做增量建索引，不删除线上数据。

## 10. 配置

配置来源是环境变量和仓库根目录 `.env.local`（不覆盖已有环境变量）。完整列表见 `.env.example`，常用项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_BASE_DOMAIN` | 无（必填） | 平台唯一入口域名（如 `apps.example.com`）；未配置时服务启动报错 |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | server 监听 |
| `MONGO_URL` | `mongodb://127.0.0.1:27017/app_platform` | `memory` 启动内置 mongod |
| `REDIS_URL` | 空 | 空则用进程内存 |
| `DATA_DIR` | `.data` | 临时目录、内置 mongod 数据 |
| `SECRET` | 随机 | 后台会话和预览票据签名；不配置则重启失效 |
| `ROLES` | `api,build` | 进程角色 |
| `AUTH_PROVIDER` | `mock` | `mock` / `main-site` |
| `AUTH_USERINFO_URL` | 空 | 主站登录服务用户信息接口地址（`AUTH_PROVIDER=main-site` 时必填） |
| `AUTH_UID_FIELDS` | `uid,user_id` | 从用户信息响应里按顺序尝试取用户标识的字段名 |
| `AUTH_CACHE_SECONDS` | `60` | 身份缓存 |
| `LOGIN_ORIGIN` | 空 | 主站登录服务的 Web 端 origin，用于 CSP `connect-src` 及登录态校验 |
| `LOGIN_MOBILE_ORIGIN` | 空 | 主站登录服务的移动端 origin，登录弹窗加载失败时的兜底跳转 |
| `LOGIN_FROM_ACTIVITY` | 空 | 极验登录的 `from_activity` 取值 |
| `BIZ_API_ORIGIN` | 空 | 业务接口默认上游；未配置时业务代理报「没有配置上游地址」 |
| `BIZ_TIMEOUT_MS` | `15000` | 业务代理超时 |
| `CSP_IMG_EXTRA` | 空 | CSP `img-src` 追加的图片域名白名单 |
| `APP_CONTAINERS` | 空 | 原生容器识别配置，多条用逗号分隔，单条格式 `id:UA正则:协议[:全局变量名]`，协议为 `android-bridge` 或 `call-native` |
| `GUARD_FORBIDDEN_PACKAGES` | 空 | app-guard 禁止使用的依赖包名列表 |
| `GUARD_ALLOWED_REDIRECT_HOSTS` | 空 | app-guard 允许的登录兜底跳转域名白名单 |
| `DEV_ADMIN_BYPASS` | 关闭 | 本地后台免登 |
| `PLATFORM_ADMINS` | 空 | 平台管理员邮箱/openId 列表 |
| `FEISHU_*` | 空 | 飞书登录与应用通知 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODELS` | 空 | 未配置时用 mock 模型 |
| `LLM_DEFAULT_MODEL` / `LLM_SMALL_MODEL` | 首个模型 | 主模型、摘要/变更说明模型 |
| `AGENT_MAX_STEPS` | `40` | 每轮模型调用上限 |
| `AGENT_MAX_AUTOFIX` | `3` | 自动修复轮数 |
| `AGENT_DAILY_TOKENS_PER_USER` | `3000000` | 每人每日 token 上限 |
| `UPLOAD_MAX_BYTES` | `5MB` | 上传大小 |
| `CDN_PURGE_URL` | 空 | 发布后刷新 CDN |

容器识别（`APP_CONTAINERS`）：UA 命中某条规则时，`platform.env.container` 取该条的 `id`（例如 `app-a`、`app-b`），协议决定 SDK 走哪种原生调用方式；未命中任何规则的普通浏览器固定为 `browser`。

## 11. 安全不变量

1. 应用代码按不可信处理：不执行、不带 shell、构建配置和依赖由平台锁定。
2. 应用只能访问自身文件和同源 `/__platform/*`；CSP 禁止外部脚本、样式、字体、图片、音视频和外部请求。应用之间共享 origin，隔离已按产品决策放弃（见 [security-boundary.md](security-boundary.md)）。
3. 应用不能读写 `document.cookie`、不能直接调原生桥、不能注册 Service Worker、不能 `eval` / `new Function` / 内联脚本；由 app-guard 在 `check` 和构建时阻断。
4. 平台网关拒绝跨站调用：自定义头 + 拒绝 OPTIONS + `Sec-Fetch-Site` 校验；appId 来自请求头/参数，可被应用伪造（已接受的风险）。
5. 后台只认 `Authorization: Bearer`，不使用 cookie；`/admin` 必须带 COOP、`X-Frame-Options: DENY`、`frame-ancestors 'none'`。
6. 数据访问由服务端强制 ACL 和 owner 条件，DSL 只允许白名单操作符，文档键禁止 `$` 和 `.`。
7. 业务接口只允许已审批前缀，上游地址只由平台管理员配置，客户端无法指定。
8. 发布切换只由 owner 操作；放宽权限、删除集合/字段必须显式确认。

## 12. 与设计文档的已知差异

| 设计稿 | 当前实现 |
|---|---|
| 独立 `build-worker`、BullMQ | 同进程校验循环 + Redis 锁；`ROLES` 可拆分部署，但代码未拆包 |
| 对象存储（COS） | 默认全部存 Mongo `blobs`，接口已抽象为 `BlobStore`，后续可替换 |
| 独立 `preview` StatefulSet | 不需要：草稿文件由 `api` 直接返回，没有 dev server 和 HMR |
| 每个应用一个子域 | 单域名 + `/a/{appId}/` 路径；运维只需一条 DNS、一张普通证书（应用间 origin 隔离随之放弃，见 security-boundary） |
| 手写 demo 应用 | 模板初始化 + `make seed` 生成 demo |
| Vue3 + Vant + 构建 | 纯 HTML + 原生 ESM；Tailwind v4 浏览器运行时，零编译零打包 |

## 13. 运营后台与开放接口

### 应用后台视图（`admin.json`）

- 应用根目录的 `admin.json` 是一份**视图配置**，不是代码：只描述要展示什么（计数、分组、表格、说明文字），由后台渲染（[Console.vue](../apps/admin-web/src/pages/app/Console.vue)）。
- 区块类型：`stat`（计数 / 求和 / 平均）、`chart`（柱状 / 饼图 / 折线）、`table`（筛选、关键字搜索、分页、详情、编辑、删除、新增、CSV 导出）、`text`（说明）。
- 结构校验在 [shared/admin-view.ts](../packages/shared/src/admin-view.ts)：集合、字段必须在 manifest 中声明，否则拒绝写入。
- 写入口有三个：应用对话里 AI 通过 `write_file` 写（[tools.ts](../apps/server/src/modules/agent/tools.ts) 写入前校验）；后台「后台视图」页直接编辑（`PUT /admin-api/apps/:appId/admin-view`）；后台「AI 生成」用一句话生成（`POST /admin-api/apps/:appId/admin-view/ai`，只返回配置不落盘，按人 10 次/分钟限流）。
- 配置规范在 [agent-docs/admin-view.md](../packages/agent-docs/docs/admin-view.md)，模型通过 `read_docs('admin-view')` 读取，后台「配置说明」按钮读同一份（`GET /admin-api/apps/:appId/admin-view/doc`）。
- 归属草稿文件，随快照和发布流转：`env=dev` 读草稿，`env=prod` 读线上构建快照里的同一文件。
- `admin.json` **不会**通过应用路径返回（[app-host.ts](../apps/server/src/modules/host/app-host.ts) 直接 404），避免暴露运营配置。

### 数据聚合

- `POST /admin-api/apps/:appId/data/:env/:col/group`：按已声明字段分组计数，返回 `{ field, total, groups }`
- `POST /admin-api/apps/:appId/data/:env/:col/stats`：`{ op: count|sum|avg, field?, where?, timeField?, interval? }`。带 `timeField` 时按天 / 小时返回 `series`，供折线图
- 管理端查询额外支持 `search: { value, fields }`：对声明过的字符串字段做不区分大小写的包含匹配；应用 DSL 不开放这个操作

后台「数据」页用它做分组统计；「后台视图」的 stat / chart 区块也用这两个接口。

### 开放接口（`/open-api/v1/*`）

给内网其他系统（例如张大妈活动后台）服务端调用，实现见 [openapi/index.ts](../apps/server/src/modules/openapi/index.ts)。

- 鉴权：`Authorization: Bearer <token>`。`api_clients` 只存 `sha256(token)`，明文在创建时返回一次；支持吊销、应用范围、IP 白名单。
- 权限：`read` / `write` / `export` / `dev` 四种 scope。默认访问 prod；`env=dev` 必须额外有 `dev`。
- 接口：应用列表、应用详情（含 manifest）、集合列表与条数、查询、分组统计、单条读写、CSV 导出、应用级 KV 读取。
- 数据面：管理视角，不过滤 `_owner`；写入仍按 manifest schema 校验；每次调用写 `audit_logs`，actor 为 `client:{id}`；按 token 限流 600 次/分钟。
- 管理：后台「开放接口」页（仅平台管理员）创建和吊销 token；机器可读文档在 `/open-api/v1/openapi.json`。

## 14. 测试与验证

- `pnpm test`：Vitest，覆盖共享 DSL/manifest、app-guard、identity 等纯逻辑。
- `make typecheck`：全仓 TypeScript 检查（含 admin-web）。
- `node scripts/smoke.mjs`：对已启动的 server 做端到端冒烟。
- 本地全链路：`make dev` + `make seed`，验证后台、demo 应用、预览、发布。
- 真机重点：主站 cookie 共享、App 原生登录回调、登录弹窗与键盘、CSP 外部请求拦截。
