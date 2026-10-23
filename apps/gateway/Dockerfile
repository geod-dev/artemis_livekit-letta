FROM node:24.19-alpine

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

COPY . .
RUN pnpm install --frozen-lockfile --filter ./apps/gateway...

EXPOSE 3000
CMD ["pnpm", "--filter", "./apps/gateway", "start"]
