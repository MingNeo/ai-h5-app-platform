# H5 应用平台

内部员工在后台用对话式 vibe coding 生成 H5 应用，发布到 `{appId}.apps.example.com`。设计与实现说明见 [docs/design.md](docs/design.md)、[docs/architecture.md](docs/architecture.md)。

要求：Node >= 22.12、pnpm 12.5。

## 本地启动

首次：

```bash
pnpm install          # 或 make install（同时构建 SDK）
cp .env.example .env.local
make certs            # 需要 mkcert：brew install mkcert && mkcert -install
make dns-setup        # 泛域名解析 *.local.apps.example.com → 127.0.0.1（首次需要 sudo）
```

`.env.example` 默认 `MONGO_URL=memory`（内置 mongod，数据在 `.data/mongo`）、不配 `REDIS_URL`（进程内存），本地不需要装任何数据库。`DEV_ADMIN_BYPASS=1` 时后台免登录。

日常只需一个终端：

```bash
make dev      # DNS（:5354）+ HTTPS proxy（:443）+ server（:3000）+ admin-web（:5173）
```

`make dev` 启动前会自动执行 `make dns-setup`（已配置时是 no-op），就绪后自动在浏览器打开后台；`DEV_NO_OPEN=1 make dev` 可关闭自动打开。Ctrl-C 一次停止全部进程。

然后打开：

- 后台：https://admin.local.apps.example.com
- demo 应用：https://demo.local.apps.example.com（先 `make seed` 生成）

新建应用无需改 hosts：`{appId}.<base>`、`{appId}--dev.<base>`、`{appId}--beta.<base>` 都由泛解析自动指向 `127.0.0.1`。

排障：

- 浏览器开启 Secure DNS / DoH 会绕过 `/etc/resolver`，需关闭或加例外；可用 `curl` / `dscacheutil` 验证。
- 改过 DNS 配置后：`sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder`。
- 端口占用：`lsof -nP -iTCP:443 -sTCP:LISTEN`、`lsof -nP -iUDP:5354`。
- 需要单独调试某个组件时，仍可分别运行 `make dns`、`make proxy`。

## 其他命令

| 命令 | 作用 |
|---|---|
| `make seed` | 生成 demo 投票应用 |
| `make test` | 单测 |
| `make typecheck` | 类型检查 |
| `node scripts/smoke.mjs` | 端到端冒烟（需 server 已启动） |
| `make image` | 构建部署镜像（`deploy/Dockerfile`） |


TODO: 1、现在打包和服务器是同一个服务，可能影响性能
 2、后面可以考虑两种方式：应用的独立部署，后台生成调试完上线传到独立服务器；或者生成纯 html 的