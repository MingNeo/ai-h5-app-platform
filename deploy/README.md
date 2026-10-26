# 线上部署

平台是单个 Node.js 服务进程（可水平扩容），同时托管后台静态资源、应用源码、平台网关和 AI 构建队列。不需要独立的应用服务器、对象存储或构建机。

相关文档：

- 反向代理 / Ingress 细节：[nginx/README.md](nginx/README.md)
- 环境变量完整示例：[../.env.example](../.env.example)
- 后台认证与安全前提：[../docs/security-boundary.md](../docs/security-boundary.md)
- 运行原理：[../docs/architecture.md](../docs/architecture.md)

## 0. 部署前准备

| 依赖 | 要求 | 说明 |
|---|---|---|
| 域名 | 一个完整域名，如 `apps.example.com` | 所有应用和后台共用；不需要泛解析 |
| 证书 | 该域名的普通证书 | Let's Encrypt HTTP-01 即可 |
| MongoDB | 4.4+ | 平台库 + 每个应用每个环境一个库，账号需要有建库/建索引权限 |
| Redis | 可选，多副本必填 | 锁、限流、计数、pub/sub；单副本可不配 |
| 飞书应用 | 企业自建应用 | 后台登录；需要用户信息读取权限 |
| LLM 网关 | OpenAI 兼容 Chat Completions | 不配置时使用脚本化 mock 模型，只能走流程演示 |
| 主站登录服务 | 用户信息接口 | 只有应用端需要真实登录时配置；本地 mock 可跳过 |

MongoDB 用空库即可：平台启动时自动建平台库索引，应用库在构建/发布时按 manifest 建索引，不需要手工建表。服务器最低建议：2 核 4GB，Node 22.12+（镜像内已包含）。磁盘主要被 Mongo 的 `blobs` 占用。

## 1. 准备生产环境变量

复制 `.env.example` 为服务器上的 `.env.production`（不要提交、不要打进镜像），按下面几组填写。

**必须修改**

```bash
APP_BASE_DOMAIN=apps.example.com
SECRET=<至少 32 字节的随机串>          # 后台票据和预览签名，变更会让已登录后台失效
MONGO_URL=mongodb://user:pass@mongo:27017/app_platform
REDIS_URL=redis://redis:6379/0          # 多副本必填；单副本可留空
```

**关闭本地调试**

```bash
DEV_ADMIN_BYPASS=0
```

**后台登录（飞书）**

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_TENANT_KEY=xxx                   # 只允许本企业登录；留空则不校验
PLATFORM_ADMINS=ops@example.com         # 邮箱或 open_id，逗号分隔；首位登录者也会自动成为平台管理员
FEISHU_BOT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx   # 可选，发布通知
```

飞书开放平台里把重定向 URL 配成：

```
https://apps.example.com/admin-api/auth/feishu/callback
```

**应用端登录（复用主站账号）**

```bash
AUTH_PROVIDER=main-site
AUTH_USERINFO_URL=https://login.example.com/user/info
AUTH_UID_FIELDS=uid,user_id             # 按顺序从响应里取用户 ID
AUTH_CACHE_SECONDS=60
LOGIN_ORIGIN=https://login.example.com
LOGIN_MOBILE_ORIGIN=https://m.login.example.com
LOGIN_FROM_ACTIVITY=<主站分配的值>
LOGIN_AGREEMENT_URL=
LOGIN_PRIVACY_URL=
```

`AUTH_PROVIDER=main-site` 时缺少 `AUTH_USERINFO_URL` 服务会启动失败。主站 cookie 必须能带到 `APP_BASE_DOMAIN`（同站或 Domain 覆盖）。

**AI 与业务接口（按需）**

```bash
LLM_BASE_URL=https://llm-gateway.example.com/v1
LLM_API_KEY=xxx
LLM_MODELS=glm-4.6,qwen3-coder-plus,deepseek-chat
LLM_DEFAULT_MODEL=glm-4.6
LLM_SMALL_MODEL=qwen-turbo
BIZ_API_ORIGIN=http://internal-api.example.com
BIZ_UNAUTH_CODES=401
MODERATION_URL=
MODERATION_BLOCKED_WORDS=
CDN_PURGE_URL=
CSP_IMG_EXTRA=
GUARD_ALLOWED_REDIRECT_HOSTS=
```

其余变量含义见 `.env.example`；配置在启动时读取，改完需要重启。

## 2. 构建镜像

在仓库根目录：

```bash
# 方式一：带版本 tag（推荐，方便回滚）
docker build -f deploy/Dockerfile -t app-platform-server:$(git rev-parse --short HEAD) .

# 方式二：固定 latest
make image
```

镜像构建阶段会执行 `pnpm install --frozen-lockfile`、构建 SDK 和 `admin-web/dist`，运行阶段只启动 server；`node_modules`、SDK 产物、后台静态文件都在镜像内。

`.dockerignore` 已排除 `node_modules`、`dist`、`.data`、`.env.local`、`deploy/certs`，不会把本地配置和证书带进镜像。

不用 Docker 时，在服务器上执行：

```bash
pnpm install --frozen-lockfile
pnpm build               # 构建 sdk + admin-web
pnpm start               # NODE_ENV=production 按需自己加在 EnvironmentFile / .env.local 里
```

环境变量通过进程环境注入（systemd `EnvironmentFile`、PM2、supervisord 均可）；也可以放在仓库根目录的 `.env.local`，启动时会读取，但不会覆盖已有环境变量。

systemd 示例：

```ini
[Unit]
Description=app-platform
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/app-platform
EnvironmentFile=/etc/app-platform/env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --import tsx apps/server/src/main.ts
Restart=always
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

`admin-web/dist` 必须存在，否则 `/admin/` 返回「admin-web 未构建」。

## 3. 启动服务

```bash
docker run -d \
  --name app-platform \
  --restart unless-stopped \
  --env-file /etc/app-platform/.env.production \
  -p 3000:3000 \
  app-platform-server:<tag>
```

- 服务监听 `0.0.0.0:3000`，前面必须有 HTTPS 反向代理；不要把 3000 直接暴露到公网
- 健康检查：`GET /healthz` 返回 `{"ok":true}`
- 只需要一个容器；`ROLES` 默认 `api,build`，构建队列和 HTTP 在同一进程
- 退出时收到 `SIGTERM` 会关闭 HTTP、Redis 和 Mongo 连接，给滚动发布留 10 秒

多副本 / K8s：

- 副本数 > 1 时必须配 `REDIS_URL`，否则锁、限流、pub/sub 只在单进程内生效
- 所有副本都跑 `api,build` 即可，构建靠 Redis 锁互斥；也可以拆出只跑 `ROLES=build` 的副本
- 不需要 sticky session，后台和 SDK 都不依赖会话粘性
- 建议探针：readiness / liveness 都打 `/healthz`

K8s 最小工作负载：

```yaml
containers:
  - name: server
    image: app-platform-server:<tag>
    ports: [{ containerPort: 3000 }]
    envFrom:
      - secretRef: { name: app-platform-env }
    readinessProbe:
      httpGet: { path: /healthz, port: 3000 }
    livenessProbe:
      httpGet: { path: /healthz, port: 3000 }
```

## 4. 配置反向代理

一条 `server_name`，所有路径转给 `server:3000`。完整模板见 [nginx/README.md](nginx/README.md)，关键点：

- `/admin` 必须 301 到 `/admin/`
- 原样透传 `/admin` 的 `Cross-Origin-Opener-Policy`、`X-Frame-Options`、`Content-Security-Policy`，否则后台 token 防护失效
- SSE（AI 对话）需要 `proxy_buffering off`、`proxy_read_timeout` / `proxy_send_timeout` 调大（模板里是 3600s）
- `client_max_body_size` 至少 12m（上传默认 5MB，留余量）
- 不要注入 `X-App-Id` / `X-App-Channel`，server 自己按路径和 SDK 请求头解析

## 5. 首次上线验证

1. `curl -fsS https://apps.example.com/healthz`
2. 浏览器打开 `https://apps.example.com/admin/`，用飞书登录；首位登录者自动成为平台管理员
3. 新建一个应用，确认预览可打开、AI 对话有响应
4. 生成测试版 → 发布到线上 → 打开 `/a/{appId}/`
5. 检查登录：未配置 `requireLogin` 的应用游客可访问；需要身份的操作会拉起主站登录
6. 上传一个图片素材，确认文件接口和 CSP 正常
7. 如果需要开放接口，在后台「开放接口」页创建 token，用 `GET /open-api/v1/apps` 验证

## 6. 日常升级与回滚

升级：

```bash
git pull
make image                       # 重新打 tag
docker rm -f app-platform
docker run -d ... app-platform-server:<new-tag>
```

- 升级只替换进程，Mongo 数据、应用草稿、构建和发布记录都保留
- 平台库索引在启动时自动补建；应用库索引在构建/发布时补建
- 滚动发布建议一次只重启一个副本，等 `/healthz` 通过再继续

回滚：

- 应用内容回滚用后台的发布记录，不依赖镜像
- 平台自身回滚用上一个镜像 tag；如果新版本包含不兼容的数据迁移，需要同时回滚数据库（当前版本没有破坏性迁移）

备份：

- 至少备份 `MONGO_URL` 指向的整个实例（平台库和 `appdata_*` 应用库）
- 文件内容也在 Mongo 的 `blobs` 集合里，Mongo 备份即覆盖
- `.data/` 只在内置 mongod（`MONGO_URL=memory`）时使用，线上不要用

## 7. 常见问题

| 现象 | 排查 |
|---|---|
| 启动报「缺少环境变量 APP_BASE_DOMAIN」 | 环境变量没注入，或域名不是完整域名 |
| 启动报 `AUTH_PROVIDER=main-site 时必须配置 AUTH_USERINFO_URL` | 补 `AUTH_USERINFO_URL`，或本地用 `AUTH_PROVIDER=mock` |
| 访问根路径 404 / 「资源不存在」 | 请求 Host 不是 `APP_BASE_DOMAIN`；检查 DNS、代理的 `Host` 头 |
| `/admin/` 打开空白或 404 | 镜像里没有 `apps/admin-web/dist`；重新构建镜像 |
| 后台登录后刷新掉登录 | 正常：token 只存内存，刷新会走一次飞书静默登录；若失败检查飞书回调 URL 和 `SECRET` 是否稳定 |
| 后台接口 401 | 确认请求带 `Authorization: Bearer`，且代理没有改写 `Origin` / 丢掉头 |
| AI 对话卡住或断开 | 检查代理的 SSE 配置（关闭缓冲、超时）、`REDIS_URL` 与 LLM 网关连通性 |
| 发布后新版本没生效 | 确认发布记录指向新 build；配置了 `CDN_PURGE_URL` 时检查刷新回调 |
| 线上应用写入报索引错误 | 新集合的排序/分组字段没在 `manifest.json` 的 `indexes` 声明，补上后重新发布 |
| 多副本下限流失效 / 重复执行 | 没配 `REDIS_URL` |
