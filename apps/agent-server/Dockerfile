# Build from the repository root: docker compose sets `context: .` and `dockerfile: apps/agent-server/Dockerfile`.

# Stage 1: Node, pnpm, the Python data stack for the run_bash tool, and the two users that share the workspace.
# The Python tooling is a deliberate dependency of the run_bash tool, not of the server itself. It is the
# largest part of the image (pandas, matplotlib, pillow, openpyxl) and stays while run_bash exposes those tools.
# uid 1001 (`workspace`) runs the server and owns data/. uid 1002 (`agent`) runs agent shell commands
# (WORKSPACE_RUN_AS=1002:1001). Both are in group 1001, which can write the workspace root.
# The base is pinned by digest; the tag is kept in the reference.
FROM node:24.19-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git curl ripgrep python3-pip python3-venv python3-openpyxl python3-pandas python3-pil python3-matplotlib \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
RUN groupadd --gid 1001 workspace \
  && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin workspace \
  && useradd --uid 1002 --gid 1001 --no-create-home --shell /usr/sbin/nologin agent

# Stage 2: production dependencies. Manifests first so this layer is reused until a lockfile or manifest changes.
# The manifest list is this app's workspace closure, not every workspace member: apps/gateway and apps/web
# are not needed by the server, so their manifests are intentionally not copied. A new package that the
# server imports must be added here too; the frozen install fails if a listed manifest is missing.
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
  && rm -rf test \
  && chmod 0755 /app/apps/agent-server/docker-entrypoint.sh
# The image runs as production by default; NODE_ENV=production enables the server's production guards.
ENV NODE_ENV=production
# The workspace is a bind mount in Compose, which mounts data/ separately. These modes are the defaults for a
# run without one. The root is group-writable because agent commands write there. data/ is owned by the
# server (uid 1001) and mode 0755; the agent cannot write into it, but a rename of data/ inside the root
# is still possible through group write on the root, so the separate mount is what protects data/.
RUN mkdir -p /workspace/data \
  && chown 1001:1001 /workspace /workspace/data \
  && chmod 0775 /workspace \
  && chmod 0755 /workspace/data
EXPOSE 4000
# The container starts as root only so that docker-entrypoint.sh can start the server as uid 1001 and keep
# SETUID and SETGID for the server's agent shells (uid 1002). Compose must grant exactly those two
# capabilities and must not override `user:`.
ENTRYPOINT ["/app/apps/agent-server/docker-entrypoint.sh"]
# umask 0002: files the server creates (file tools, task logs) are group-writable, so agent commands
# running as uid 1002 in group 1001 can edit them. The umask is inherited by the agent's shell.
# The command is written here rather than taken from package.json's start script (`pnpm start`) because
# `exec node` keeps node as the process that receives signals; pnpm would add a parent process. Keep the
# two in step when the entry file changes.
CMD ["sh", "-c", "umask 0002 && exec node --experimental-transform-types src/main.ts"]
