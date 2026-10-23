# Build from the repository root: docker compose sets `context: .` and `dockerfile: apps/gateway/Dockerfile`.

# Stage 1: production dependencies. Manifests first so this layer is reused until a lockfile or manifest changes.
# The manifest list is the gateway's workspace closure: @artemis/mcp (device-server) pulls in tools and llm.
FROM node:24.19-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/llm/package.json packages/llm/
COPY packages/mcp/package.json packages/mcp/
COPY packages/tools/package.json packages/tools/
COPY packages/workspace/package.json packages/workspace/
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile --prod --filter @artemis/gateway...
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/llm packages/llm
COPY packages/mcp packages/mcp
COPY packages/tools packages/tools
COPY packages/workspace packages/workspace
COPY apps/gateway apps/gateway

# Stage 2: runtime. Only the gateway app, its workspace packages and production dependencies.
# The app sits at /app/apps/gateway so the working directory and its relative paths are unchanged.
# The packages export TypeScript source, so the gateway runs its source with Node's transform mode
# (no tsx and no build step in the image), as the agent-server does.
FROM node:24.19-alpine AS runtime
WORKDIR /app/apps/gateway
COPY --from=build /repo/node_modules /app/node_modules
COPY --from=build /repo/packages /app/packages
COPY --from=build /repo/apps/gateway /app/apps/gateway
# Gateway-only state and the shared workspace are mounted here; the runtime user owns both directories.
RUN mkdir -p /data/gateway /workspace && chown 1001:1001 /data/gateway /workspace
USER 1001:1001
EXPOSE 3000
CMD ["node", "--experimental-transform-types", "src/server.ts"]
