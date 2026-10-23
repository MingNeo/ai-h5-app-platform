#!/usr/bin/env bash
# 生成本地 https 证书（单个入口域名，不需要泛域名）
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${APP_BASE_DOMAIN:-}" && -f .env.local ]]; then
  APP_BASE_DOMAIN="$(grep -E '^[[:space:]]*APP_BASE_DOMAIN=' .env.local | tail -1 | cut -d= -f2- | tr -d "'\"")"
fi
: "${APP_BASE_DOMAIN:?请配置 APP_BASE_DOMAIN（.env.local 或环境变量），例如 local.example.test}"
DOMAIN="$APP_BASE_DOMAIN"
command -v mkcert >/dev/null || { echo "请先安装 mkcert：brew install mkcert"; exit 1; }
mkdir -p deploy/certs
TRUST_STORES=${TRUST_STORES:-system} mkcert -cert-file deploy/certs/cert.pem -key-file deploy/certs/key.pem "${DOMAIN}"
echo
echo "证书已生成到 deploy/certs/。如果浏览器提示不受信任，请执行一次：mkcert -install"
