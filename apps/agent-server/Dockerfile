# Build from the repository root: docker compose sets `context: .` and `dockerfile: apps/agent-server/Dockerfile`.

# Stage 1: Node, pnpm, the Python data stack for the run_bash tool, and the two users that share the workspace.
# The Python tooling is a deliberate dependency of the run_bash tool, not of the server itself.
# uid 1001 (`workspace`) runs the server and owns data/. uid 1002 (`agent`) runs agent shell commands
# (WORKSPACE_RUN_AS=1002:1001). Both are in group 1001, which can write the workspace root.
FROM node:24.19-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git curl ripgrep python3-pip python3-venv python3-openpyxl python3-pandas python3-pil python3-matplotlib \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
RUN groupadd --gid 1001 workspace \
  && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin workspace \
  && useradd --uid 1002 --gid 1001 --no-create-home --shell /usr/sbin/nologin agent

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
# (no tsx and no build step in the image). Test files are removed from the copy: the packages and the app.
FROM base AS runtime
WORKDIR /app/apps/agent-server
COPY --from=build /repo/node_modules /app/node_modules
COPY --from=build /repo/packages /app/packages
COPY --from=build /repo/apps/agent-server /app/apps/agent-server
RUN find /app/packages /app/apps/agent-server/src -type f -name '*.test.ts' -exec rm -f {} + \
  && rm -rf test
# The workspace is a bind mount in Compose; these modes are the defaults for a run without one.
# The root is group-writable (agent commands write there); data/ is owned by the server and read-only to the agent.
RUN mkdir -p /workspace/data \
  && chown 1001:1001 /workspace /workspace/data \
  && chmod 0775 /workspace \
  && chmod 0755 /workspace/data
USER 1001:1001
EXPOSE 4000
# umask 0002: files the server creates (file tools, task logs) are group-writable, so agent commands
# running as uid 1002 in group 1001 can edit them. The umask is inherited by the agent's shell.
CMD ["sh", "-c", "umask 0002 && exec node --experimental-transform-types src/main.ts"]
