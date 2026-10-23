# H5 应用平台

内部员工在后台用对话式 vibe coding 生成 H5 应用，发布到同一个域名下的 `/a/{appId}/`。设计与实现说明见 [docs/design.md](docs/design.md)、[docs/architecture.md](docs/architecture.md)，安全边界见 [docs/security-boundary.md](docs/security-boundary.md)。

要求：Node >= 22.12、pnpm 12.5。

## 部署形态

平台只有一个入口域名，不需要泛域名 DNS，也不需要通配证书：

| 路径 | 内容 |
|---|---|
| `https://apps.example.com/admin/` | 后台 SPA |
| `https://apps.example.com/admin-api/` | 后台接口 |
| `https://apps.example.com/a/{appId}/` | 应用线上版 |
| `https://apps.example.com/a/{appId}--beta/` | 测试版 |
| `https://apps.example.com/a/{appId}--dev/` | 实时预览 |
| `https://apps.example.com/__platform/` | 平台运行时与 SDK |

一个 server 进程、一个 nginx / Ingress 规则、一张普通证书。新增应用不需要任何运维动作。操作说明见 [deploy/nginx/README.md](deploy/nginx/README.md)。

## 本地启动

首次：

```bash
pnpm install          # 或 make install（同时构建 SDK）
cp .env.example .env.local
make certs            # 需要 mkcert：brew install mkcert && mkcert -install
make hosts            # 把入口域名写入 /etc/hosts（需要 sudo）
```

`.env.example` 默认 `MONGO_URL=memory`（内置 mongod，数据在 `.data/mongo`）、不配 `REDIS_URL`（进程内存），本地不需要装任何数据库。`DEV_ADMIN_BYPASS=1` 时后台免登录。

日常只需一个终端：

```bash
make dev      # HTTPS proxy（:443）+ server（:3000）+ admin-web（:5173）
```

就绪后自动在浏览器打开后台；`DEV_NO_OPEN=1 make dev` 可关闭自动打开。Ctrl-C 一次停止全部进程。

然后打开：

- 后台：`https://local.example.test/admin/`
- demo 应用：`https://local.example.test/a/demo/`（先 `make seed` 生成）

新建应用无需改 hosts：应用都在同一个域名下，只靠路径区分。

从子域版本升级：重新执行 `make certs`（改成单域名证书）、`make hosts`，并把 `.env.local` 里的 `APP_BASE_DOMAIN` 改成入口域名（例如 `local.example.test`）。旧应用 URL 会从 `https://{appId}.<domain>/` 变成 `https://<domain>/a/{appId}/`。

排障：

- 页面提示「资源不存在」：请求的 Host 不是入口域名。应用和后台都必须通过 `APP_BASE_DOMAIN` 访问；旧的 `admin.<domain>`、`{appId}.<domain>` 地址已经废弃。
- 本机没配 hosts 时可先用 `http://localhost:5173/admin/`（Vite，`DEV_ADMIN_BYPASS=1` 时）或 `http://localhost:3000/admin/`（server 直连）调试；两者都会把后台接口的 Host 修正为入口域名。
- 端口占用：`lsof -nP -iTCP:443 -sTCP:LISTEN`
- 需要单独调试某个组件时，仍可分别运行 `make proxy`。

## 其他命令

| 命令 | 作用 |
|---|---|
| `make seed` | 生成 demo 投票应用 |
| `make test` | 单测 |
| `make typecheck` | 类型检查 |
| `node scripts/smoke.mjs` | 端到端冒烟（需 server 已启动） |
| `make image` | 构建部署镜像（`deploy/Dockerfile`） |

## 应用技术栈

生成的应用是**纯 HTML + 原生 ES 模块**：没有编译、没有打包、没有 npm 依赖。

- 多页优先：每个页面可以是独立的完整 HTML，页面之间的跳转由应用自己决定
- 预览和线上都直接返回源码，刷新页面即可看到改动
- 原子类由浏览器端的 Tailwind v4 运行时生成；没有组件库，界面用原生标签 + Tailwind 组合
- 平台提供 `/__platform/dom.js`、`/__platform/ui.js`、`/__platform/ui.css`，由 server 注入 `index.html`
- 「构建」只做校验（manifest、安全扫描、业务接口核对、JS 语法），不产出构建物
- 应用源码里的根路径引用（如 `/src/app.js`、`/logo.png`）在返回时自动补上 `/a/{appId}[--channel]/` 前缀；新代码建议直接写相对路径
