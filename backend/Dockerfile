FROM node:22-alpine

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

COPY backend/package.json backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY backend/ ./

EXPOSE 3000
CMD ["pnpm", "start"]
