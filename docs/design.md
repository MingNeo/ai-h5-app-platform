# H5 应用平台（代号 4399）设计方案 v2

> 当前代码的实现说明见 [architecture.md](architecture.md)；本文保留产品目标、取舍与里程碑。

## 0. Context
内部员工在后台用在线 vibe coding（对话式界面，类似 Codex / Claude）生成 H5 应用，发布到 `apps.example.com/a/{appId}/`，运行在 App WebView 和手机浏览器里。平台要保证：
- 应用只能访问自身文件和平台提供的接口；
- 每个应用自动登录（复用主站账号），401 自动拦截到全局登录，登录后重放请求；
- 每个应用有独立的数据存储。

当前仓库是全新项目，尚无历史代码。本地开发不依赖 Docker；部署用 `deploy/Dockerfile` 出镜像。

v2 相对 v1 方案的变化：
- 域名统一放在 `.example.com` 下，**删掉 SSO 换票和主站反代**，直接用主站 cookie；
- 登录照搬「主站前端仓库」（feature-v1 分支）调用主站登录模块的做法；
- 不发 npm 包，SDK 以脚本形式由平台提供；
- AI 交互改成类 Codex / Claude 的对话式界面（纯点击操作）。

## 1. 决策汇总
| 维度 | 结论 |
|---|---|
| 创建者 / 规模 | 内部员工；百级应用，小流量；AI 代码按不可信处理 |
| 形态 | 活动页（首期无奖）、工具/表单、H5 小游戏 |
| 域名 | 单域名：线上 `apps.example.com`，本地 `local.example.test`；应用在 `/a/{appId}/`，后台在 `/admin/`；靠 hosts 切换，代码里不区分环境 |
| 运行 | 应用作为顶层页面运行；nginx 统一代理 |
| 登录 | 复用主站登录：`.example.com` cookie 天然共享，App 内调原生登录，浏览器弹 SDK 登录框（短信+极验，调用主站登录服务接口） |
| 用户身份 | 共享全局用户信息；默认游客可读，按需登录；manifest 可配 `requireLogin` |
| 应用栈 | 纯 HTML + 原生 ES 模块；Tailwind v4 浏览器运行时 + 原生 HTML 交互；零编译、零打包 |
| SDK | 平台托管的 `/__platform/boot.js`，由 host 自动注入，提供全局对象 `platform`；**不发 npm** |
| Vibe | 自研 Agent（结构化工具，不给 shell），模型走公司 LLM 网关；对话式界面，类似 Codex / Claude |
| 版本 | 平台快照，支持回滚；可在线编辑，不加锁 |
| 数据 | MongoDB；文档集合 + KV + 文件；集合级 ACL 预设 + schema 校验；首期不做云函数 |
| 能力 | 基础能力 + 业务接口（浏览器直连，带 cookie，后端开 CORS） |
| 发布 | 预览 → 测试版 → 自动检查 → 负责人确认上线；秒级回滚 |
| 平台技术 | Node.js（TS）模块化单体 + nginx；K8s；后台用飞书登录 |

## 2. 架构与域名
```
            nginx（线上 ingress / 本地 dev-proxy）
 apps.example.com（唯一入口，无通配）
 ├ /admin、/admin/...      → admin-web 静态资源；/admin-api → server
 ├ /a/{appId}/             线上版   ┐
 ├ /a/{appId}--beta/       测试版   ├ /__platform/* → server（gateway，同源）
 └ /a/{appId}--dev/        实时预览 ┘ 其余          → server（app-host：源码 / 草稿）

 server（Node.js 单体）：admin-api │ agent │ build-worker │ gateway │ app-host
 MongoDB · Redis · 对象存储（线上 COS / 本地磁盘）· LLM 网关
 外部：login.example.com（登录、用户信息）、业务后端（CORS 直连）
```
- 站点由路径区分：`/a/{appId}[--beta|--dev]/`。server 自己解析路径；SDK 请求头的 `X-App-Id` / `X-App-Channel` 只用于平台接口定位应用（可伪造，按已接受风险处理）。单域名意味着应用之间没有 origin 隔离，见 [security-boundary.md](security-boundary.md)。
- `admin`、`www`、`api`、`static` 等是保留 appId。appId 规则：`[a-z0-9-]{3,30}`，不能包含 `--`。
- 所有环境都用 https。主站 cookie 很可能带 Secure 属性，本地也必须用 https：用 mkcert 给 `local.example.test` 签单域名证书。

## 3. 运行时托管与隔离
**app-host**
- 用 `release:{appId}:{channel}` 查到 buildId（Redis，Mongo 兜底），返回该构建的 `index.html`，并在 `<head>` 最前面注入：
  ```html
  <script src="/__platform/boot.js?app=<appId>&channel=<channel>"></script>
  <link rel="stylesheet" href="/__platform/ui.css">
  <script src="/__platform/tailwind.js"></script>
  ```
  即使 AI 删掉了平台引用，每个应用也一定带着自动登录和 401 拦截。
- 应用挂在 `/a/{appId}[--channel]/` 下；源码里的根绝对引用在返回时补前缀（只改写能对应到应用文件的路径）。
- `/assets/*` 返回 immutable 长缓存，`index.html` 返回 no-cache；未知路径回退 index.html。下线或不在排期内时，返回平台占位页。
- 静态文件：线上从对象存储读（可加 CDN），本地读磁盘 volume。

**CSP（实现「只能调用自身文件 + 平台接口」）**
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: 图片域名白名单（CSP_IMG_EXTRA）; font-src 'self' data:; media-src 'self' blob:;
connect-src 'self' https://login.example.com https://*.geetest.com;
frame-src 'none'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self' https://login.example.com;
frame-ancestors 'self'（后台与应用同源，天然允许后台预览嵌入）
```
- 业务接口按「以 / 结尾的路径前缀」授权；应用通过同源 `/__platform/api/biz/*` 调用，由平台网关校验前缀后转发到上游，CSP 不需要放行业务域名。
- 极验需要的域名（`static.geetest.com`、`gcaptcha4.geetest.com` 等）只在 SDK 登录框用到，统一加进白名单。

**构建期扫描 app-guard（发布阻断项）**：`eval` / `new Function`；直接访问 `AndroidBridge`、`webkit.messageHandlers`、`callNative`、平台禁用的第三方登录包（`GUARD_FORBIDDEN_PACKAGES` 配置）；读写 `document.cookie`（应用和主站同在 `.example.com`，这条很重要）；注册 serviceWorker；外链脚本；`postMessage(*, '*')`；疑似密钥。依赖只能从白名单里选；`package.json`、`vite.config` 由平台锁定。

## 4. 登录与 401（参考 feature-v1 分支）
### 4.1 身份来源
应用和 gateway 都在 `.example.com` 下，主站登录 cookie（`sess` 等）会**自动带到** `/__platform/*`。
- gateway 鉴权中间件：拿请求里的主站 cookie 调主站用户信息接口（`login.example.com/user/info/jsonp_get_current` 或业务后端的 `/api/v1/get_current_user`，二选一，待确认），结果按 `sha256(sess)` 在 Redis 缓存 60s，得到 `{uid, nickname, avatar}`。
- 平台**不签发自己的会话**，不需要换票，不需要 SSO。主站一登出，平台立刻跟着失效（最多 60s 延迟）。
- 业务接口：应用调用同源代理 `/__platform/api/biz/*`，平台网关按已授权前缀转发到登记的上游（内网地址即可），并转发主站 cookie / 目录与接口配置的服务令牌。上游不需要对应用域名开 CORS。

### 4.2 拉起登录（按环境分支，逻辑照搬 v1 的 `unLoginHandler`，「主站前端仓库」`src/utils/request.ts`）
| 环境（UA） | 方式 |
|---|---|
| App A（UA `app-a`，由 `APP_CONTAINERS` 配置） | `callNative({module:'module_user', action:'user_login'})`（主站前端仓库 `src/utils/jsbridge.ts`） |
| App B（UA `app-b`，由 `APP_CONTAINERS` 配置） | `module_detail_common/call_client_login`（即平台禁用的第三方登录包的 `loginApp`） |
| 手机浏览器 | SDK 在应用页内渲染登录弹窗（移植「主站前端仓库」`src/components/business/Login/*`：手机号 + 短信 + 极验，调 `login.example.com/user/login/ajax_get_mobile_code`、`ajax_quick_check`，`withCredentials`）。成功后主站登录服务写入 `.example.com` cookie；弹窗加载失败时整页跳 `https://m.login.example.com/user/login/quick/?redirect_to=<当前 URL>` 兜底 |

### 4.3 SDK 状态机
```
加载 → GET /__platform/api/auth/me → READY(user | guest)
       requireLogin && guest → 立即拉起登录，此时不渲染业务内容
任一请求 401（平台接口 HTTP 401 / 业务接口未登录 error_code）：
  请求入队，全局 single-flight 拉起登录（4.2）
  等待登录完成：
    浏览器弹窗：ajax_quick_check 成功回调
    App：回调 + visibilitychange/pageshow + 每 2s 轮询 auth/me（最多 2 分钟），
         防止原生登录是浮层、不触发生命周期事件
  完成 → auth/me 拿到新用户 → 按序重放队列（被 401 的请求服务端没执行，重放安全）
  取消 / 超时 → 队列全部 reject(LOGIN_CANCELLED)
页面可见时每 5 分钟、切回前台时各 auth/me 一次：uid 变了就强制 reload
```

### 4.4 需要确认 / 配合（项目里只剩这些外部依赖）
1. 主站登录服务的登录接口和用户信息接口对 `https://apps.example.com` 开放 CORS（v1 是从 `api.example.com` 调的，新 origin 要加白名单）；极验 `from_activity` 要申请一个新的取值。
2. 业务后端对新 origin 开放 CORS（精确回显 Origin + credentials），并在公共中间件里**集中校验 Origin**。因为应用之间、应用和主站都是同站，SameSite 不起作用。
3. App A 内：cookie 注入的 Domain 要覆盖 `.example.com`（或 App 打开时按 v1 `get_cookies` 同步）。这一项要真机验证。
4. 主站 `sess` 是否 HttpOnly。如果不是，应用 JS 理论上可以读到，只能靠 app-guard 扫描和审计约束（内部创建者，残余风险可接受）。

## 5. 平台 SDK（`/__platform/boot.js`，注入配置 + 单文件 SDK，挂 `window.platform`）
```ts
await platform.ready()
platform.auth.user / isLogin / login() / logout() / onChange(cb)
platform.db.collection('votes').add(doc) | .doc(id).get/update/remove()
  | .where({ score: { $gte: 60 } }).orderBy('score','desc').limit(20).get() | .count() | .mine()
platform.kv.user.get/set/remove(key);  platform.kv.app.get(key)
platform.files.upload(file, { public })        // → { fileId, url }
platform.biz.request('/api/xxx', { method, data })   // 经平台同源代理转发到上游
platform.app / platform.env                    // appId、channel、inApp、os
```
- 统一错误类型 `PlatformError{code}`。
- `platform` 是 boot.js 注入的全局对象，应用不需要 import，也没有类型文件。
- SDK 版本由平台统一升级，应用不用做任何改动；有破坏性变更时用 `sdk.v2.js` 区分。
- 登录弹窗用原生 DOM + 内联样式实现，不依赖应用的技术栈。

## 6. Gateway（`/__platform/api/*`，同源）
- 路由：`auth/me`、`db/:col/query|count`、`db/:col`、`db/:col/:id`、`kv/user/:key`、`kv/app/:key`、`files/upload`、`files/:id`、`telemetry`、`dev/errors`（仅预览）。
- 防跨应用请求：必须带 `X-App-SDK: 1`，OPTIONS 一律拒绝；带 `Sec-Fetch-Site` 时必须是 same-origin。
- 写操作必须登录，保证 `_owner` 一定存在。
- 限流（Redis，按应用 / 用户 / IP）；配额（存储、每用户文档数、上传大小）；写操作审计。
- 响应信封与主站一致：`{error_code, error_msg, data}`；未登录统一返回 HTTP 401。

## 7. 数据存储（MongoDB）
- 平台库 `platform`：`apps`、`app_members`、`drafts`、`snapshots`、`builds`、`releases`、`grants`、`biz_api_catalog`、`agent_sessions`、`agent_events`、`audit_logs`、`telemetry_*`（TTL）。
- 应用库：每个「应用 × 环境」一个库 `appdata_{appId}_{dev|prod}`，含系统集合 `_kv_user`、`_kv_app`、`_files`。系统字段由服务端写入。
- ACL 预设：`private` / `public_read` / `submit_only` / `readonly` / `admin_only`；ajv 校验 schema（`additionalProperties:false`）；支持 `unique`、`limits`、`moderate`（公开文本过内容安全）。
- 查询 DSL 白名单：`$eq $ne $gt $gte $lt $lte $in $nin $exists $and $or`，深度 ≤ 3；`limit` ≤ 100；`maxTimeMS` 2000。prod 环境的排序和 count 只能用声明了索引的字段。
- 环境：预览和测试版用 dev 库，线上用 prod 库。发布时只做增量（新增集合、新增索引）；放宽 ACL 要在审批时确认。
- 后台数据台：浏览、编辑、导出，`readonly` 种子数据可从 dev 同步到 prod。

## 8. 平台能力
- 授权：manifest 声明 `capabilities` / `bizApis` → 平台管理员审批 → gateway 和 CSP 按授权放行。
- 业务接口：`biz_api_catalog` 每条记录保存接口前缀、默认上游（可选 `upstream` + 请求头 `headers`，接口级可用 `x-upstream` / `x-upstream-path` / `x-upstream-headers` 覆盖）和一份 OpenAPI 3 文档（YAML 或 JSON，解析后存对象、原文一并保存；只用 `paths`、`parameters`、`requestBody`、`responses`、`components.schemas`、`$ref`），外加一段补充说明。文档用途：① Agent 的系统提示里只放签名索引（已授权的和 manifest 已声明但未开通的都放，未开通的标明审批前调用会 403），细节由 `read_biz_api` 按需读取；② 按已授权与 manifest 已声明的前缀生成应用的 `src/biz-api.d.ts`，让类型检查能发现路径和返回类型写错；③ `check` 阶段静态核对 `platform.biz.request` 的路径是否授权、是否在文档里、方法对不对、参数名是否一致（未开通前缀的调用也会核对文档，manifest 声明了目录里不存在的错误前缀直接报错）。`platform.biz.request` 返回上游完整响应体（主站信封 `{error_code, error_msg, data}`），文档、类型声明与运行时保持一致。运行时由网关代理强制校验：路径必须以已授权前缀开头，否则 403；上游地址只由平台管理员配置。
- 当前能力注册表为空，不提供 AI 对话 / 生图；新能力以 key 注册到 `CAPABILITIES`，加 gateway 路由和配额即可。
- 二期：营销原子能力（抽奖、签到、发奖）、原生能力、云函数、埋点。

## 9. Vibe Coding：对话式（类 Codex / Claude 网页端对话）
### 9.1 IDE 布局（admin-web）
普通网页聊天界面，所有操作都通过可点击的按钮和菜单完成，**不需要快捷键或斜杠命令**。
```
┌ 会话 ───┬──────────── 对话（主区）─────────────┬─ 预览 | 代码 ──────┐
│ + 新会话 │ 🧑 做一个投票页，3 个选项，一人一票     │ [草稿▾][机型▾][↻]  │
│ 会话1 ●  │ 🤖 好的，我先建数据集合再写页面。       │ ┌──────────┐       │
│ 会话2    │  ▸ 已思考 6 秒（点击展开）              │ │ 手机外壳 │       │
│          │  ┌ 执行计划 ─────────────────┐          │ │  iframe  │       │
│          │  │ ✓ 创建 votes 集合          │          │ └──────────┘       │
│          │  │ ◐ 编写投票页面             │          │ [扫码真机] [新窗口]│
│          │  │ ○ 校验并修复               │          │ 控制台 2 条错误    │
│          │  └────────────────────────────┘          │  [让 AI 修复]      │
│          │  ▸ 已查看 3 个文件、修改 2 个文件（展开）│                    │
│          │  ┌ 改动 ─────────────────────┐          │                    │
│          │  │ src/pages/vote.js   +32 -4 [查看差异]│                    │
│          │  │ manifest.json       +8     [查看差异]│                    │
│          │  └ [撤销本轮改动]─────────────┘          │                    │
│          │  ✓ 校验通过 · 预览已更新                 │                    │
│          ├──────────────────────────────────────────┤                    │
│          │ [📎 引用文件/集合] 输入需求…    [发送]   │                    │
│          │ 模型[▾] 先出方案再改[开关]   [■ 停止]    │                    │
└──────────┴──────────────────────────────────────────┴────────────────────┘
```
- 对话：
  - AI 回复流式输出；思考过程默认折叠为「已思考 N 秒」，点击展开；
  - 工具调用不逐条刷屏：合并成「已查看 N 个文件、修改 M 个文件」这样一行摘要，点击展开明细（读了哪些文件、执行了哪些检查、查询了哪些数据）；
  - 执行计划以清单卡片展示，随进度实时打勾；
  - 每轮结束显示**改动卡片**：列出文件和增删行数，「查看差异」打开 diff 弹窗，可以「撤销本轮改动」；
  - 校验结果用状态条展示（通过 / 自动修复中 / 失败并给出原因）。
- 输入区：
  - 「引用」按钮，可以选择文件、数据集合或预览里的报错；支持上传截图或设计稿图片（模型支持图片时可用）；
  - 「发送」按钮；运行中变成「停止」按钮，期间仍可继续输入，消息排队发送；
  - 模型下拉框；「先出方案再改」开关：打开后 AI 先只读分析、给出方案卡片，用户点「按此执行」后才动代码。
- 消息操作：悬停后显示「复制」「重新生成」「从这里回滚」。
- 会话栏：新建会话、重命名、删除；顶部显示本应用的 token 用量。
- 右栏：「预览」「代码」两个 Tab。代码 Tab 是文件树 + Monaco，可以直接手改并保存。
- 推荐指令：新会话的空白页展示模板化的快捷需求按钮，例如「做一个报名表单」「加一个排行榜」。
- 渲染：SSE 客户端复用「主站前端仓库」的 `src/utils/fetch-event-source.ts`；工具明细渲染参考 `src/components/openClaw/AssistantMessage/*`，改成折叠的摘要样式。
- 同一应用可以有多个会话，但 Agent 任务按应用串行执行。手工编辑和 AI 改动共用草稿，按文件做乐观并发（`baseRev`）。

### 9.2 Agent 服务
- 用 Vercel AI SDK 实现多步工具调用，接 OpenAI 兼容的 LLM 网关；模型可在后台切换。
- 事件协议（SSE，同时落库 `agent_events`，断线后可续传）：
  `turn.start` `text.delta` `thinking.delta` `tool.start{id,name,input}` `tool.result{id,ok,output,diff?}` `todo.update` `files.changed` `turn.done{usage,snapshotId}` `error`
- 工具（不提供 shell）：`list_files` `read_file` `write_file` `edit_file`（精确查找替换）`delete_file` `move_file` `glob` `grep` `todo_write` `check`（manifest + app-guard + 业务接口调用核对 + JS 语法检查）`get_runtime_errors` `db_query` / `db_seed`（只作用于 dev）`read_docs`（规范、SDK、manifest）`read_biz_api`（按需读取已授权业务接口的文档）。
- 系统提示：纯 HTML + 原生 JS 规范、Tailwind 用法、移动端 H5 规范（vw 适配、安全区）、SDK 文档、禁用项、当前 manifest 和文件树。较早的对话做摘要压缩。
- 约束：每轮工具调用 ≤ 40 次，并有 token 上限；结束前强制跑 `check`，失败自动修复 ≤ 3 轮；中断时保存「已中断」快照。按人 / 应用统计用量，设日预算。
- 快照：每轮结束和手动保存时生成快照（文件按内容哈希存储）；回滚 = 恢复到所选快照并新记一条快照。

### 9.3 预览

**后台在线看效果**：IDE 右栏和应用详情页都有预览面板。面板里是一个 iframe，套在手机外壳里。
- **版本切换**：
  - 草稿实时：`--dev`，直接返回草稿源码，AI 改完刷新即可；
  - 测试版：`--beta`；
  - 线上：prod；
  - 任意历史快照：`--dev?snapshot=<id>`，按需构建后只读预览，用于回滚前对比。
- **机型和主题**：可切换机型尺寸（375/390/414、平板）和横竖屏；可切换浅色和深色；支持刷新、新窗口打开。
- **身份**：可选「我的主站账号」或「游客」。dev 环境还能用测试身份，方便调试 ACL。
- **调试**：控制台面板展示 SDK 回传的 console 输出、接口请求和报错，报错可以一键交给 AI 修复；数据台和预览联动，直接查看 dev 库里写入的数据。
- **真机预览**：二维码带短期票据。需要原生能力（JSBridge、原生登录）的场景，必须在 App 里扫码真机验证；iframe 只能模拟浏览器环境。
- **iframe 可行性**：后台与应用同源，iframe 里主站 cookie 和预览票据 cookie 都能正常带上，Safari 也不会拦截。CSP 的 `frame-ancestors 'self'` 即可允许后台嵌入预览。
- **票据写入**：iframe 先访问 `https://{appId}--dev.<base>/__platform/preview-auth?t=<签名票据>`，在这里写入 `__Host-app_preview` cookie，然后 302 到应用首页。
- `{appId}--dev` 的请求由 server 直接返回草稿文件，没有 dev server、没有 HMR，也没有需要回收的进程。
- 预览访问：后台签发预览票据，写入 `__Host-` cookie，24h 有效。`--beta` 共用这套票据，二维码里带短期票据。
- 预览环境的 SDK 会回传 console 错误、未处理的 rejection、接口失败，供 IDE 展示和 `get_runtime_errors` 使用。
- 服务端不执行生成的代码：没有 SSR，也没有构建和打包，源码原样返回。

## 10. 构建与发布
1. **测试版**：build-worker 对快照执行校验（app-guard、业务接口核对、JS 语法、体积、manifest 变更检查），最后由小模型写变更摘要。**没有编译产物**：校验通过后直接把快照的文件清单记为构建文件，切换 `--beta` 指针。
2. **上线**：负责人在审批页查看报告并扫码测试，确认后依次：应用 schema 增量到 prod 库 → 切换 prod 指针 →（有 CDN 时）刷新 index.html。
3. 回滚：切换到历史 release。下线和定时上下线在后台配置。飞书机器人推送通知。

## 11. 后台
- 飞书 OAuth 登录（限本企业）。角色：平台管理员；应用级 owner / developer / viewer。
- **数据台**：dev / prod 切换、集合与字段、分页查询、增删改、CSV 导出、readonly 同步、应用级 KV、按字段分组统计。
- **后台视图**：应用里的 `admin.json` 描述运营要看什么（数字卡片、柱状/饼图/折线、可筛选可搜索可编辑的表格、说明），后台按配置渲染；AI 对话、后台「AI 生成」、手写 JSON 三种方式都能产出，规范见 `agent-docs/admin-view.md`。
- **开放接口**：内网系统用 Bearer token 调 `/open-api/v1/*`，读数据、统计、导出；token 在后台「开放接口」页管理，按应用和 scope 授权，调用留审计。
- 页面：应用列表与创建、Vibe IDE（§9）、能力申请与审批、数据台、发布、监控、成员、审计、平台设置（模型、模板、业务接口目录）。
- 技术：Vue3 + Element Plus + Monaco + monaco diff。后台接口不开放 CORS，cookie 用 `__Host-` 前缀 + `SameSite=Strict`，请求必须带自定义头。

## 12. 本地开发环境
本地不依赖 Docker，全部在宿主机跑：
| 组件 | 说明 |
|---|---|
| `make proxy` | `scripts/dev-proxy.mjs`，443 端口，用 mkcert 生成的单域名证书，路由规则与线上 nginx 模板（`deploy/nginx/`）一致 |
| `make dev` | 一条命令启动 DNS + HTTPS proxy + server（`tsx watch`，agent、preview、build-worker 在同一进程）+ admin-web（Vite dev），就绪后自动打开后台，Ctrl-C 一次全部退出 |
| Mongo | `MONGO_URL=memory` 启动内置 mongod，数据在 `DATA_DIR/mongo`；也可以指向已有实例 |
| Redis | 不配 `REDIS_URL` 时用进程内存（只适合单进程） |
| 对象存储 | 本地磁盘（`DATA_DIR`） |

- 本地只需要一个入口域名：`make hosts` 把 `APP_BASE_DOMAIN` 写入 `/etc/hosts`。`make dev` 启动 proxy、server、admin-web；新建应用无需任何配置，因为应用都在同一个域名下按路径访问。本地域名由 `APP_BASE_DOMAIN`（`.env.local` 或环境变量）配置，示例值 `local.example.test`。
- `scripts/hosts-add.sh` 仅作为无法使用 `/etc/resolver` 时的回退方案。
- `.env.local`：LLM 网关地址和 key、飞书应用配置（本地可开 `DEV_ADMIN_BYPASS=1` 跳过飞书登录）。
- `make seed`：生成一个 demo 应用（投票页），用来验证全链路。
- 部署镜像：`make image`（`deploy/Dockerfile`）。
- 线上入口域名在 `.example.com` 下，并且走 https，浏览器会带上真实的主站 cookie（前提是 §4.4 的 CORS 已放开；未放开前用 `DEV_FAKE_USER` 注入模拟用户）。本地用 `AUTH_PROVIDER=mock`。

## 13. 安全汇总
| 威胁 | 措施 |
|---|---|
| 应用访问外部域名 / 未授权接口 | CSP `connect-src` 按授权前缀放行；扫描外部 URL |
| 应用读写主站 cookie | app-guard 禁止 `document.cookie`；推动敏感 cookie 设为 HttpOnly（残余风险） |
| 应用直接调桥 | app-guard 禁止；只有 SDK 能调桥 |
| 应用之间互相请求 / CSRF | 自定义头 + 拒绝预检 + Sec-Fetch-Site；业务后端集中校验 Origin（SameSite 无效） |
| 伪造登录框钓鱼 | 内部创建者 + 审批 + 扫描（禁止出现手机号 / 验证码类输入框的可疑模式）；残余风险可接受 |
| 数据越权 / NoSQL 注入 | 服务端注入 owner 条件、ACL 预设、ajv 校验、操作符白名单 |
| 生成代码危害服务端 | 不执行生成代码；没有构建配置和依赖，源码原样返回 |
| 成本 / 滥用 | 多级限流和配额；AI 必须登录；上传限类型和大小 |
| 开放重定向（兜底登录 redirect_to） | 只传当前页 URL；跳转目标由主站登录服务校验，并限制在 `GUARD_ALLOWED_REDIRECT_HOSTS` 配置的白名单内 |

## 14. 可观测与部署
- SDK 遥测：JS 错误、接口错误和耗时、Web Vitals、PV，用 sendBeacon 上报；后台按应用展示，用 sourcemap 还原错误栈。
- 服务端：pino 日志 + Prometheus 指标；飞书告警。
- K8s：`server-api`（配 HPA）、`build-worker`；预览没有独立进程，不需要 StatefulSet。nginx ingress 配置与本地同一份模板。

## 15. 仓库结构（pnpm monorepo）
```
apps/admin-web        后台 + 对话式 IDE
apps/server           Node.js（Fastify）
  src/modules/{admin,agent,build,gateway,host}
packages/sdk          运行时 SDK → 构建产物 sdk.js（server 托管）+ platform.d.ts
packages/app-template 纯 HTML 模板、平台前端运行时、Tailwind 运行时
packages/shared       manifest schema、查询 DSL、事件协议类型
packages/app-guard    扫描规则
packages/agent-docs   给模型看的文档
deploy/nginx          nginx 模板（线上 / 本地共用）
deploy/Dockerfile     部署镜像（server 含 admin-web 静态资源、SDK）
Makefile  scripts/
```
从「主站前端仓库」（feature-v1 分支）复用：
- `src/utils/platform.ts`：环境识别；
- `src/utils/jsbridge.ts`：原生登录；
- `src/utils/request.ts`：`unLoginHandler` 的分支逻辑；
- `src/components/business/Login/*` + `src/api/user.ts`：主站登录服务的短信 / 极验登录；
- `src/utils/fetch-event-source.ts`、`src/components/openClaw/AssistantMessage/*`：IDE 对话渲染。

## 16. 里程碑
| 阶段 | 内容 |
|---|---|
| M0（1 周） | monorepo、部署 Dockerfile、nginx 模板、mkcert、server 骨架、飞书登录（含本地跳过）、应用 CRUD、app-host 托管手工产物 + CSP |
| M1（2 周） | SDK（auth/me、401 队列、三种登录方式、弹窗）、gateway（db/kv/files）；手写 demo 应用在浏览器和 App 跑通全链路 |
| M2（2–3 周） | Agent 服务 + 事件协议、对话式 IDE、预览、运行时错误回传、快照回滚 |
| M3（1–2 周） | 校验、测试版、审批上线、回滚、数据台 |
| M4（1–2 周） | 业务接口目录 + CSP + `biz.request` |
| M5（1 周） | 遥测、告警、配额、审计、安全自测 |

## 17. 验证
- **本地全链路**：`make dev`、`make seed`，然后打开 `https://local.example.test/a/demo/`：
  1. 游客能浏览；
  2. 点投票 → 弹出登录框 → 短信登录 → 投票请求自动重放成功；
  3. 在主站登录服务退出登录后，5 分钟内或切回前台时应用感知到登出；
  4. 在控制台 fetch 外部域名，被 CSP 拦截；
  5. 从 demo 页请求 `other.local-…/__platform/api/db`，被拒。
- **IDE**：在 `https://local.example.test/admin/` 创建应用，对话生成投票页，确认改动卡片、diff、执行计划、停止、撤销、预览 HMR、报错一键修复都正常。
- **单元测试**：DSL 和 ACL（表驱动 + 注入用例）、app-guard 违规样例、SDK 状态机（并发 5 个 401 只登录一次、全部重放；取消后全部 reject）。
- **集成测试**（testcontainers）：五种 ACL × 本人 / 他人 / 游客；限流和配额。
- **E2E**：Playwright 移动端模拟跑上述流程（主站登录用 `DEV_FAKE_USER` 打桩）。
- **真机**：App A、App B、iOS Safari、Android Chrome；重点验证 cookie 共享、原生登录完成后的感知、弹窗与键盘的交互。
- **Vibe 评测集**：15 个基准需求，统计首轮构建成功率和完成所需轮数；换模型或改模板时跑回归。
