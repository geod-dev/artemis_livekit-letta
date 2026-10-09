FROM letta/letta:0.34.4

# Python for the agent's file work in its workspace (spreadsheets, images, data,
# charts), with pip and venv to install more.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3-pip python3-venv python3-openpyxl python3-pandas python3-pil python3-matplotlib \
  && rm -rf /var/lib/apt/lists/*

# Use Pi's existing instruction-role conversion only for Groq-hosted Qwen.
# Keep this tied to the inspected release; upgrades must revalidate the patch.
COPY patch-groq-qwen.mjs /opt/letta-patches/patch-groq-qwen.mjs
RUN node /opt/letta-patches/patch-groq-qwen.mjs /usr/local/lib/node_modules/@letta-ai/letta-code
