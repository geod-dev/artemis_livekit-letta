# Build from the repository root: docker compose sets `context: .` and `dockerfile: apps/web/Dockerfile`.

FROM node:24.19-alpine AS build

# The web app is a member of the root pnpm workspace, so it installs from the repo root.
# It depends on packages/contracts through `workspace:`, so that package is copied alongside it.
# The install includes devDependencies: the build needs them (TypeScript, Vite, the schema tooling).
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @artemis/web... --filter @artemis/contracts
COPY packages/contracts packages/contracts
COPY apps/web apps/web

# The assistant name is injected at build time; the default is set once, in vite.config.ts.
ARG ASSISTANT_NAME
ENV ASSISTANT_NAME=${ASSISTANT_NAME}
RUN pnpm --filter @artemis/web build

# The unprivileged image runs nginx as a non-root user and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.27.5-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
