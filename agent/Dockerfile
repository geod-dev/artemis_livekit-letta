FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /app
COPY agent/pyproject.toml agent/uv.lock ./
RUN uv sync --locked --no-dev
COPY agent/src ./src

CMD ["uv", "run", "--no-sync", "agent", "start"]
