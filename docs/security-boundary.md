# 安全边界（方案 2：单域名 + 路径前缀）

本文记录平台当前的安全模型、**明确接受的风险**，以及为什么后台认证不能用 cookie。改动这些前提之前先读这里。

## 1. 威胁模型

- 应用代码由 AI 生成、由内部员工发布，按**不可信代码**处理。
- 应用的访问者不可信：任何人可以在应用页打开控制台执行任意 JS。
- **产品决策（2026-10）**：应用自身的数据按“不敏感”对待；平台级业务能力（携带主站 cookie 的接口）即使被滥用，也不在本平台的防护范围内。因此**放弃应用之间的 origin 隔离**，换取单域名部署。

## 2. 已放弃的边界（已知代价）

所有应用共享 `https://apps.example.com`，浏览器把它们视为同一个主体。由此：

- 应用 A 的代码可以改 URL 前缀/请求头，以应用 B 的身份调用平台网关，借用 B 已审批的业务接口前缀。
- 应用 A 可以往应用 B 的 `public_read` 集合写入、刷榜、灌表单；限流按应用+用户计数，跨应用轮换可以放大。
- `localStorage` / `sessionStorage` / IndexedDB / Cache Storage 同源共享，命名前缀只能避免误撞，不能防越权。
- `frame-ancestors 'self'` 允许应用互相嵌套，存在应用间的点击劫持风险。
- 资源缓存路径已带 `/a/{appId}/` 前缀，不同应用不再撞键。

这些是方案 2 的代价，不是 bug。不要用“给 cookie/storage 加 appId 前缀”来假装解决——约定跑在被约束的不可信代码里，约束不了自己。

## 3. 保留的边界

### 3.1 后台认证：Bearer，禁用 cookie

后台与应用同源，**cookie 会话绝对不能用**：

- 应用页面 `fetch('/admin-api/...')` 会自动带上 `__Host-app_admin`；
- `Origin` 在同源下必然通过；
- `X-App-Admin` 只是普通请求头，应用可以随便加。

结果就是任何应用都能以管理员身份操作（发布、读所有应用数据、改授权）。

当前实现：

1. 飞书 OAuth 回调签发**一次性登录票据**（60 秒，存 `adm:tkt:<jti>`），同时签发一枚**恢复 cookie**（见下）。
2. 302 到 `/admin#t=<ticket>&next=...`。fragment 不发给服务端、不进 Referer。
3. SPA 立即 `history.replaceState` 清掉 URL，`POST /admin-api/auth/exchange` 换会话 token，并轮换恢复 cookie。
4. token **只存内存**，所有请求走 `Authorization: Bearer`。刷新后 token 丢失，靠恢复 cookie 免跳一次飞书；恢复失败才走飞书静默登录。
5. 服务端业务接口（`/admin-api/*` 除登录相关路由外）只认 Bearer，**没有 cookie 回退**。

**恢复 cookie 不是会话 cookie**，不能用来调任何业务接口，只解决「刷新丢内存 token」这一个问题：

- 名字 `__Secure-adm_resume`，`HttpOnly` + `Secure` + `SameSite=Strict`，`Path=/admin-api/auth/`——浏览器只在访问这个路径前缀时才带上它，`/admin-api/apps/...` 之类的业务请求根本不会带。
- 只认**浏览器顶层导航**：服务端校验 `Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document`，应用页面用 `fetch`/`XHR`/iframe 带 cookie 发起的请求会被判定为非顶层导航并拒绝（403）。这一步是必须的：`SameSite=Strict` 防跨站，但管理后台与应用同源，同源 `fetch` 一样会带上 cookie，必须靠这个头再挡一层。
- 值只做哈希（`sha256`）后存 Mongo（`admin_resumes`，TTL 索引自动过期），泄库拿不到可用原文；每次使用（命中 `/admin-api/auth/resume`）都轮换失效。
- 换到的仍是一次性登录票据，走的是已有的 `exchange` 流程——不是新开一条认证路径。

为什么不用 `sessionStorage` / `localStorage` / IndexedDB：

- `window.open` 打开的新标签页会**复制** opener 的 `sessionStorage`。后台打开预览时，新标签页里跑的就是应用代码，等于把管理员 token 直接交给应用。
- 同源 iframe 可以访问 `parent.localStorage`、`parent.history.state`，应用预览就是同源 iframe。
- 因此只有当前文档的内存变量是应用代码拿不到的；代价是刷新需要重新登录一次。

依赖的浏览器防护：

- `/admin` 文档返回 `Cross-Origin-Opener-Policy: same-origin`：应用页面 `window.open('/admin')` 后 opener 被切断，读不到 popup 的 URL 和存储。
- `X-Frame-Options: DENY` + `frame-ancestors 'none'`：不能被应用页面 iframe。
- `Referrer-Policy: no-referrer`、`Cache-Control: no-store`。

**回归要求**：冒烟测试必须断言 `/admin` 带 COOP 头，以及“仅带 cookie 调 `/admin-api` 返回 401”；另外断言非顶层导航（不带 `Sec-Fetch-Mode: navigate`）调 `/admin-api/auth/resume` 返回 403。COOP 头一旦丢失，整套方案失效。

### 3.2 预览隔离

- 预览票据与 cookie 都带 `appId`，读取时校验。
- 预览 cookie 每个应用一个名字（`__Host-app_preview__{appId}`），避免同时预览多个应用互相覆盖。
- 预览仍要求登录后台时签发的票据，应用之间不能互相预览未发布草稿（claims 校验）。

### 3.3 平台接口

- appId 来自 SDK 请求头（`X-App-Id` / `X-App-Channel`）或查询参数。**这是可伪造的**，按已接受的风险处理；服务端仍用它做 ACL、授权、限流、审计。
- 写操作默认必须登录；例外是集合 ACL 显式设为 `public_submit` / `public_write` 时，游客可以新增（`public_write` 还可改删自己设备提交的记录）。游客身份来自 `app_vid` cookie，缺省时退回 `ip:<IP>`，可用于按设备配额和限流，但不是可信身份。
- `OPTIONS` 一律 403；带 `Sec-Fetch-Site` 时必须是 `same-origin`（防止外部站点调用）。
- 业务接口代理只转发管理员配置的上游，应用无法指定任意地址。
- 审计日志里的 appId 只作运营归属，**不能作为追责证据**。

### 3.4 其他

- 应用源码里的 `.map` 一律 404；`admin.json` 不对应用访问者暴露。
- 应用 CSP 仍是 `default-src 'self'`、`script-src 'self'`、`frame-src 'none'`，业务接口经同源代理，不需要放行外部域名。
- 后台 CSP 比应用更严：禁止内联脚本、禁止被嵌入。

## 4. 残余风险

- 后台 token 只在内存：XSS 或恶意浏览器扩展仍可读取（同一执行环境内无解）；但不会残留到磁盘、历史或其他标签页。
- 多标签页各自用恢复 cookie 免登（失败则各自走一次飞书 SSO）；登出会清掉恢复 cookie，但只影响当前标签页的内存 token，其他已打开标签页要等下次刷新才会发现登出。
- 应用页面可以用 `fetch` 调 `POST /admin-api/auth/logout`（同源请求，Origin 校验对同源请求天然通过）。这只是骚扰——把管理员登出、逼着重新走一次登录——拿不到任何权限或数据，不属于本节要防的越权风险。
- 应用之间的同源横向能力（第 2 节）无法在应用层修复。
- `public_submit` / `public_write` 是匿名写入口：设备身份靠 cookie/IP，可被清空、伪造或共享出口 IP；配额、唯一索引和限流只能提高成本，不能防刷。公开可写集合应配置 `limits`、`moderate`，必要时改用需要登录的 `submit_only`。
- 后台预览是同源 iframe：被预览的应用代码可以读后台页面的 DOM。预览的是本应用自己的草稿，且后台 cookie 已不存在，但不要把敏感信息渲染在预览面板外的同一页面里。
- 如果未来恢复隔离，只有两条路：回到 `{appId}.<domain>` 子域，或把应用放进 sandboxed iframe 并重写 SDK/网关。后者与“应用作为顶层页面运行在 WebView”冲突，成本更高。

## 5. 明确禁止的做法

- 任何把后台会话本身放回 cookie 的改动——3.1 节的恢复 cookie 是例外，但只能用于「顶层导航换一次性票据」，**不能**让它直接鉴权任何业务接口，也不能放宽它的 `Path` 或去掉顶层导航校验。
- 为了“刷新免登录”把后台 token 放进 `localStorage` / `sessionStorage` / `IndexedDB`（同源应用或它打开的新标签页可直接读）。
- 在 `/admin` 上移除 `COOP` / `X-Frame-Options` / `frame-ancestors 'none'`。
- 用 `X-App-Admin`、`Origin`、appId 前缀之类的约定当作安全边界。
