# Stage 1: Node, pnpm, the agent's Python tooling, and the unprivileged workspace user.
FROM node:24.19-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git curl ripgrep python3-pip python3-venv python3-openpyxl python3-pandas python3-pil python3-matplotlib \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
RUN groupadd --gid 1001 workspace && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin workspace

# Stage 2: workspace dependencies and sources. Runs as root (it must switch to uid 1001 for commands).
FROM base AS runtime
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@artemis/agent-server..."
EXPOSE 4000
CMD ["pnpm", "--filter", "./services/agent-server", "start"]
