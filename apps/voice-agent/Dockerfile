FROM ghcr.io/astral-sh/uv:0.12.5-python3.13-bookworm-slim

WORKDIR /app
COPY apps/voice-agent/pyproject.toml apps/voice-agent/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY apps/voice-agent/src ./src
# Install the project only after its package sources are present.
RUN uv sync --locked --no-dev --no-editable

# The worker runs unprivileged; the virtualenv is read-only to it, and uv's cache goes to /tmp.
ENV UV_CACHE_DIR=/tmp/uv-cache
USER 1001:1001

CMD ["uv", "run", "--no-sync", "voice-agent", "start"]
