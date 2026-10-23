# syntax=docker/dockerfile:1
# Production image for the web client: static files served by nginx, which also proxies
# /api and /ws to the server. Build from the repository root:
#   docker build -f packages/client/Dockerfile .

# ---- build: Vite production bundle ----
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile --filter @whiteboard/client...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/client packages/client
RUN pnpm -F @whiteboard/client build

# ---- runtime: unprivileged nginx (runs as uid 101, listens on 8080) ----
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY packages/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/packages/client/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ > /dev/null || exit 1
