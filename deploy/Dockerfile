# 平台镜像：server（含 admin-web 静态资源、SDK、应用模板依赖）
FROM node:22-bookworm-slim AS base
RUN npm i -g pnpm@12.5.1 --registry=https://registry.npmmirror.com
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/admin-web/package.json apps/admin-web/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
COPY packages/app-template/package.json packages/app-template/
COPY packages/app-guard/package.json packages/app-guard/
COPY packages/agent-docs/package.json packages/agent-docs/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @app-platform/sdk build && pnpm --filter @app-platform/admin-web build

FROM base
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
