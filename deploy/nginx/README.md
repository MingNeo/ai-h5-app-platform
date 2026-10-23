# 部署与运维配置

平台只需要**一个域名、一张普通证书、一条 Ingress 规则**。不需要泛域名 DNS，不需要通配证书，新增应用不需要运维介入。

## 需要运维做的一次性配置

1. **DNS**：`apps.example.com` 的 A/AAAA 记录指向入口 LB。
2. **证书**：`apps.example.com` 的单域名证书。Let's Encrypt 用 HTTP-01 即可。
3. **Ingress / nginx**：一个 `server_name`，所有路径转给平台 server；`/admin/` 可指向 admin-web 的静态托管（整套镜像模式下也指向 server）。

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name apps.example.com;

  ssl_certificate     /etc/nginx/certs/apps.pem;
  ssl_certificate_key /etc/nginx/certs/apps.key;
  client_max_body_size 12m;

  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto https;

  location = /admin { return 301 /admin/; }

  location /admin/ {
    proxy_pass http://server:3000;   # 或 admin-web 静态服务
  }

  location / {
    proxy_pass http://server:3000;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

Kubernetes Ingress：

```yaml
spec:
  tls:
    - hosts: ["apps.example.com"]
      secretName: apps-tls
  rules:
    - host: apps.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: server, port: { number: 3000 } } }
  # nginx.ingress.kubernetes.io/proxy-buffering: "off"
  # nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  # nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  # nginx.ingress.kubernetes.io/proxy-body-size: "12m"
```

## 注意事项

- **不要注入 `X-App-Id` / `X-App-Channel`**：server 自己按路径和 SDK 请求头解析。
- **不要给 `/admin` 配独立域名或独立端口**：后台与应用同源，认证依赖这一点（Bearer + sessionStorage，见 [docs/security-boundary.md](../../docs/security-boundary.md)）。
- **`/admin` 的响应头必须原样透传**：`Cross-Origin-Opener-Policy: same-origin`、`X-Frame-Options: DENY`、`Content-Security-Policy`。如果反向代理改写了这些头，后台 token 的防护会失效。
- WebSocket 升级和 SSE（AI 对话）需要 `Upgrade` / `Connection` 头和关闭缓冲。
- 证书到期前正常续期即可，与应用数量无关。
