.PHONY: install certs hosts dns-setup dns dev proxy seed test typecheck image

install:
	pnpm install
	pnpm --filter @app-platform/sdk build

certs:
	bash scripts/certs.sh

# 回退方案：无法使用 /etc/resolver 时手工写 hosts
hosts:
	bash scripts/hosts-add.sh demo

# 一次性写入 /etc/resolver，把 *.<APP_BASE_DOMAIN> 的解析交给本地 dev-dns（幂等）
dns-setup:
	bash scripts/dns-setup.sh

# 单独启动本地泛解析 DNS（127.0.0.1:5354）
dns:
	node scripts/dev-dns.mjs

# DNS + proxy + server + admin-web；Ctrl-C 一次全部退出
dev:
	bash scripts/dns-setup.sh
	node scripts/dev.mjs

# 本地 HTTPS 入口（443，规则与 deploy/nginx 一致）
proxy:
	node scripts/dev-proxy.mjs

seed:
	pnpm seed

test:
	pnpm test

typecheck:
	pnpm -r typecheck

# 部署镜像
image:
	docker build -f deploy/Dockerfile -t app-platform-server .
