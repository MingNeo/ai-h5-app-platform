#!/usr/bin/env bash
# 本地只需要一个入口域名（应用和后台同域，靠路径区分）
# 用法：scripts/hosts-add.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${APP_BASE_DOMAIN:-}" && -f .env.local ]]; then
  APP_BASE_DOMAIN="$(grep -E '^[[:space:]]*APP_BASE_DOMAIN=' .env.local | tail -1 | cut -d= -f2- | tr -d "'\"")"
fi
: "${APP_BASE_DOMAIN:?请配置 APP_BASE_DOMAIN（.env.local 或环境变量），例如 local.example.test}"
DOMAIN="$APP_BASE_DOMAIN"
IP="${HOSTS_IP:-127.0.0.1}"
if grep -qE "[[:space:]]${DOMAIN//./\\.}([[:space:]]|$)" /etc/hosts; then
  echo "hosts 已包含 ${DOMAIN}"
  exit 0
fi
line="${IP} ${DOMAIN}"
echo "将追加到 /etc/hosts：${line}"
echo "${line}" | sudo tee -a /etc/hosts >/dev/null
echo "完成"
