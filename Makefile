.PHONY: install certs hosts dev proxy seed test typecheck image

install:
	pnpm install
	pnpm --filter @app-platform/sdk build

certs:
	bash scripts/certs.sh

# 单个入口域名写入 /etc/hosts（应用和后台同域，靠路径区分）
hosts:
	bash scripts/hosts-add.sh

# proxy + server + admin-web；Ctrl-C 一次全部退出
dev:
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
