FROM letta/letta:0.34.4

# Python for the agent's file work in its workspace (spreadsheets, images, data,
# charts), with pip and venv to install more.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3-pip python3-venv python3-openpyxl python3-pandas python3-pil python3-matplotlib \
  && rm -rf /var/lib/apt/lists/*

# Use Pi's existing instruction-role conversion only for Groq-hosted Qwen.
# Keep this tied to the inspected release; upgrades must revalidate the patch.
COPY patching/groq-qwen.mjs /opt/letta-patches/patch-groq-qwen.mjs
RUN node /opt/letta-patches/patch-groq-qwen.mjs /usr/local/lib/node_modules/@letta-ai/letta-code
COPY patching/task-control.mjs /opt/letta-patches/task-control.mjs
RUN node /opt/letta-patches/task-control.mjs /usr/local/lib/node_modules/@letta-ai/letta-code
COPY patching/worker-execution.mjs /opt/letta-patches/worker-execution.mjs
RUN node /opt/letta-patches/worker-execution.mjs /usr/local/lib/node_modules/@letta-ai/letta-code
COPY entrypoint.sh /opt/assistant/entrypoint.sh
RUN chmod 755 /opt/assistant/entrypoint.sh
