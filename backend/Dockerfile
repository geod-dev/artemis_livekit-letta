FROM node:24.19-alpine

WORKDIR /app
ENV ARTEMIS_REPO_ROOT=/app
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

COPY . .
RUN pnpm install --frozen-lockfile --filter ./backend...

EXPOSE 3000
CMD ["pnpm", "--filter", "./backend", "start"]
