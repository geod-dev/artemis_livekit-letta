# Build from the repository root: docker compose sets `context: .` and `dockerfile: apps/agent-server/Dockerfile`.

# Stage 1: Node, pnpm, the Python data stack for the run_bash tool, and the unprivileged workspace user.
# The Python tooling is a deliberate dependency of the run_bash tool, not of the server itself.
FROM node:24.19-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git curl ripgrep python3-pip python3-venv python3-openpyxl python3-pandas python3-pil python3-matplotlib \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
RUN groupadd --gid 1001 workspace && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin workspace

# Stage 2: production dependencies. Manifests first so this layer is reused until a lockfile or manifest changes.
# The manifest list mirrors pnpm-workspace.yaml: a new workspace package must be added here too.
FROM base AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/agent-loop/package.json packages/agent-loop/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/http/package.json packages/http/
COPY packages/llm/package.json packages/llm/
COPY packages/mcp/package.json packages/mcp/
COPY packages/memory/package.json packages/memory/
COPY packages/storage/package.json packages/storage/
COPY packages/tools/package.json packages/tools/
COPY packages/workspace/package.json packages/workspace/
COPY apps/agent-server/package.json apps/agent-server/
RUN pnpm install --frozen-lockfile --prod --filter @artemis/agent-server...
COPY packages packages
COPY apps/agent-server apps/agent-server

# Stage 3: runtime. Only the agent-server app, its workspace packages and production dependencies.
# The app sits at /app/apps/agent-server so the working directory and its relative paths are unchanged.
# The packages export TypeScript source, so the server runs the source with Node's transform mode
# (no tsx and no build step in the image). Test files and test helpers are removed from the copy.
FROM base AS runtime
WORKDIR /app/apps/agent-server
COPY --from=build /repo/node_modules /app/node_modules
COPY --from=build /repo/packages /app/packages
COPY --from=build /repo/apps/agent-server /app/apps/agent-server
RUN find src \( -name '*.test.ts' -o -name 'test-support.ts' \) -delete && rm -rf test
# Agent-writable state lives in the mounted /workspace; the directory is owned by the runtime user.
RUN mkdir -p /workspace && chown 1001:1001 /workspace
USER 1001:1001
EXPOSE 4000
CMD ["node", "--experimental-transform-types", "src/main.ts"]
