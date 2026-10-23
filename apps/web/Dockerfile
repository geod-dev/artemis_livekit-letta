FROM node:24.19-alpine AS build

# The web app is a member of the root pnpm workspace, so it installs from the repo root.
# Build context: the repository root (see docker-compose.yml).
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile --filter @artemis/frontend...

ARG IP_ADDRESS=127.0.0.1
ARG ASSISTANT_NAME=Artemis
ENV IP_ADDRESS=${IP_ADDRESS} ASSISTANT_NAME=${ASSISTANT_NAME} BACKEND_URL=http://backend:3000
RUN pnpm --filter @artemis/frontend build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
