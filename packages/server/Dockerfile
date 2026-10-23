# syntax=docker/dockerfile:1
# Production image for the API + WebSocket server. Build from the repository root:
#   docker build -f packages/server/Dockerfile .

# ---- build: install the workspace, bundle the server (shared is compiled in) ----
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @whiteboard/server...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm -F @whiteboard/server build

# ---- runtime: Node + the bundle + SQL migrations, nothing else; runs as a non-root user ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build --chown=node:node /repo/packages/server/dist ./dist
COPY --from=build --chown=node:node /repo/packages/server/drizzle ./drizzle
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/healthz > /dev/null || exit 1
# Node is PID 1 and handles SIGTERM itself (graceful shutdown in src/index.ts).
# Migrations run on start, serialized across replicas by an advisory lock.
CMD ["node", "--enable-source-maps", "dist/index.js"]
