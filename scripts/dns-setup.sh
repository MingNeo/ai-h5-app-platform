#!/usr/bin/env bash
# 一次性配置 macOS 域名级 DNS：把 *.<APP_BASE_DOMAIN> 的查询交给本地 dev-dns。
# 幂等；配置未变化时不会调用 sudo。用法：make dns-setup
set -euo pipefail
cd "$(dirname "$0")/.."

env_local_value() {
  local key="$1"
  [ -f .env.local ] || return 0
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" .env.local \
    | tail -n 1 \
    | tr -d '\r' \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

DOMAIN="${APP_BASE_DOMAIN:-$(env_local_value APP_BASE_DOMAIN)}"
if [ -z "$DOMAIN" ]; then
  echo "缺少 APP_BASE_DOMAIN：请在 .env.local 中配置应用基础域名，例如 local.example.test" >&2
  exit 1
fi
PORT="${DNS_PORT:-$(env_local_value DNS_PORT)}"
PORT="${PORT:-5354}"

RESOLVER="/etc/resolver/${DOMAIN}"
WANT="nameserver 127.0.0.1
port ${PORT}"

if [ -f "$RESOLVER" ] && [ "$(cat "$RESOLVER" 2>/dev/null || true)" = "$WANT" ]; then
  echo "resolver 已是最新：${RESOLVER}"
else
  echo "写入 ${RESOLVER}（需要 sudo）"
  sudo mkdir -p /etc/resolver
  printf '%s\n' "$WANT" | sudo tee "$RESOLVER" >/dev/null
  sudo chmod 644 "$RESOLVER"
  sudo dscacheutil -flushcache
  sudo killall -HUP mDNSResponder 2>/dev/null || true
  echo "已刷新 DNS 缓存"
fi

# /etc/hosts 优先级高于 DNS：非 loopback 条目会覆盖泛解析（只告警，不修改）
DOMAIN_ESC="${DOMAIN//./\\.}"
conflicts="$(grep -E "(^|[[:space:]])([A-Za-z0-9._-]+\.)?${DOMAIN_ESC}([[:space:]]|$)" /etc/hosts 2>/dev/null \
  | grep -vE '^[[:space:]]*#' \
  | grep -vE '^[[:space:]]*(127\.0\.0\.1|::1)[[:space:]]' || true)"
if [ -n "$conflicts" ]; then
  echo "警告：/etc/hosts 中有非 127.0.0.1 的条目，会覆盖泛解析："
  echo "$conflicts"
fi