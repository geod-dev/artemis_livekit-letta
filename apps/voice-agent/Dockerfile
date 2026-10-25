# Pinned to the same uv patch release as CI (.github/workflows/ci.yml); bump both together.
FROM ghcr.io/astral-sh/uv:0.7.22-python3.13-bookworm-slim@sha256:aff1a91c16d89e5542e11472631488bc2269e3d8bbfb1144874c3c5716d53cd3

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
