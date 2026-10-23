#!/usr/bin/env bash
# 遗留回退方案：默认用 make dns-setup + make dns 做泛域名解析，不再需要手工维护 hosts。
# 把后台和应用域名加到 /etc/hosts（hosts 不支持通配，每个应用都要加）
# 用法：scripts/hosts-add.sh demo my-app
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${APP_BASE_DOMAIN:-}" && -f .env.local ]]; then
  APP_BASE_DOMAIN="$(grep -E '^[[:space:]]*APP_BASE_DOMAIN=' .env.local | tail -1 | cut -d= -f2- | tr -d "'\"")"
fi
: "${APP_BASE_DOMAIN:?请配置 APP_BASE_DOMAIN（.env.local 或环境变量），例如 local.example.test}"
DOMAIN="$APP_BASE_DOMAIN"
IP="${HOSTS_IP:-127.0.0.1}"
names=("admin.${DOMAIN}")
for app in "$@"; do
  names+=("${app}.${DOMAIN}" "${app}--dev.${DOMAIN}" "${app}--beta.${DOMAIN}")
done
missing=()
for n in "${names[@]}"; do
  grep -qE "[[:space:]]${n//./\\.}([[:space:]]|$)" /etc/hosts || missing+=("$n")
done
if [ ${#missing[@]} -eq 0 ]; then
  echo "hosts 已包含全部域名"
  exit 0
fi
line="${IP} ${missing[*]}"
echo "将追加到 /etc/hosts：${line}"
echo "${line}" | sudo tee -a /etc/hosts >/dev/null
echo "完成"
