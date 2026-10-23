# Build from the repository root: docker compose sets `context: .` and `dockerfile: apps/web/Dockerfile`.

FROM node:24.19-alpine AS build

# The web app is a member of the root pnpm workspace, so it installs from the repo root.
# It depends on packages/contracts through `link:`, so that package is copied alongside it. Its
# devDependencies are selected explicitly: the generative UI library it exports is compiled into the app.
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @artemis/frontend... --filter @artemis/contracts
COPY packages/contracts packages/contracts
COPY apps/web apps/web

ARG IP_ADDRESS=127.0.0.1
ARG ASSISTANT_NAME=Artemis
ENV IP_ADDRESS=${IP_ADDRESS} ASSISTANT_NAME=${ASSISTANT_NAME} GATEWAY_URL=http://gateway:3000
RUN pnpm --filter @artemis/frontend build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
