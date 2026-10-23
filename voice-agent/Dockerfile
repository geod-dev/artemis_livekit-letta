FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /app
COPY voice-agent/pyproject.toml voice-agent/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY voice-agent/src ./src
# Install the project only after its package sources are present.
RUN uv sync --locked --no-dev --no-editable

CMD ["uv", "run", "--no-sync", "agent", "start"]
