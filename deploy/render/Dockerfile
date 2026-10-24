# syntax=docker/dockerfile:1
# Single-service image for the Render demo (render.yaml): the server also serves the built web
# client (STATIC_DIR), because Render's free plan runs one web service and no nginx. The full
# production setup (nginx + two replicas) is docker-compose.prod.yml. Build from the repo root:
#   docker build -f deploy/render/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile --filter @whiteboard/server... --filter @whiteboard/client...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/client packages/client
# The production client build: no window.__board debug handle.
RUN pnpm -F @whiteboard/server build && pnpm -F @whiteboard/client build

FROM node:22-alpine AS runtime
# Render sets PORT itself (10000); 0.0.0.0 so its proxy can reach the server.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    MIGRATIONS_DIR=/app/drizzle \
    STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build --chown=node:node /repo/packages/server/dist ./dist
COPY --from=build --chown=node:node /repo/packages/server/drizzle ./drizzle
COPY --from=build --chown=node:node /repo/packages/client/dist ./public
USER node
EXPOSE 10000
# Render checks /healthz itself (healthCheckPath in render.yaml). Node handles SIGTERM:
# graceful shutdown flushes the op log and closes sockets with 1012 so clients reconnect.
CMD ["node", "dist/index.js"]
