# Build from the repository root: docker compose sets `context: .` and `dockerfile: apps/gateway/Dockerfile`.

# Stage 1: production dependencies. Manifests first so this layer is reused until a lockfile or manifest changes.
# The manifest list is the gateway's workspace closure: @artemis/mcp (its device-server subpath) pulls in
# core, contracts, tools and workspace, and @artemis/voice-services is imported directly. The LLM package
# is not part of the gateway's closure and is not copied.
FROM node:24.19-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/tools/package.json packages/tools/
COPY packages/voice-services/package.json packages/voice-services/
COPY packages/workspace/package.json packages/workspace/
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile --prod --filter @artemis/gateway...
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/mcp packages/mcp
COPY packages/tools packages/tools
COPY packages/voice-services packages/voice-services
COPY packages/workspace packages/workspace
COPY apps/gateway apps/gateway

# Stage 2: runtime. Only the gateway app, its workspace packages and production dependencies.
# The app sits at /app/apps/gateway so the working directory and its relative paths are unchanged.
# The packages export TypeScript source, so the gateway runs its source with Node's transform mode
# (no tsx and no build step in the image), as the agent-server does.
FROM node:24.19-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
WORKDIR /app/apps/gateway
COPY --from=build /repo/node_modules /app/node_modules
COPY --from=build /repo/packages /app/packages
COPY --from=build /repo/apps/gateway/package.json /app/apps/gateway/package.json
COPY --from=build /repo/apps/gateway/node_modules /app/apps/gateway/node_modules
COPY --from=build /repo/apps/gateway/src /app/apps/gateway/src
# Test files and the packages' src/testing helpers are removed from the copy; the image carries no lint or
# format config.
RUN find /app/packages /app/apps/gateway/src -type f -name '*.test.ts' -exec rm -f {} + \
  && find /app/packages -path '*/src/testing' -type d -prune -exec rm -rf {} +
# Gateway-only state and the shared workspace are mounted here; the runtime user owns both directories.
RUN mkdir -p /data/gateway /workspace && chown 1001:1001 /data/gateway /workspace
USER 1001:1001
EXPOSE 3000
CMD ["node", "--experimental-transform-types", "src/server.ts"]
