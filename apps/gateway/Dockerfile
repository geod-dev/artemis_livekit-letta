# Build from the repository root: docker compose sets `context: .` and `dockerfile: apps/gateway/Dockerfile`.

# Stage 1: production dependencies. Manifests first so this layer is reused until a lockfile or manifest changes.
FROM node:24.19-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/workspace/package.json packages/workspace/
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile --prod --filter @artemis/gateway...
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/workspace packages/workspace
COPY apps/gateway apps/gateway

# Stage 2: runtime. Only the gateway app, its workspace packages and production dependencies.
# The app sits at /app/apps/gateway so the working directory and its relative paths are unchanged.
FROM node:24.19-alpine AS runtime
WORKDIR /app/apps/gateway
COPY --from=build /repo/node_modules /app/node_modules
COPY --from=build /repo/packages/contracts /app/packages/contracts
COPY --from=build /repo/packages/core /app/packages/core
COPY --from=build /repo/packages/workspace /app/packages/workspace
COPY --from=build /repo/apps/gateway /app/apps/gateway
EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
