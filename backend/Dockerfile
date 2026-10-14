FROM node:24.19-alpine

WORKDIR /app
ENV ARTEMIS_REPO_ROOT=/app
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

COPY backend/package.json backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY backend/ ./
COPY shared/generated/present-tool.json /shared/generated/present-tool.json
COPY shared/generated/present-components.json /shared/generated/present-components.json
COPY shared/contracts/chat-types.ts /shared/contracts/chat-types.ts
COPY shared/present-validation.ts /shared/present-validation.ts

EXPOSE 3000
CMD ["pnpm", "start"]
