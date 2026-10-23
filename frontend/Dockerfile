FROM node:24.19-alpine AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
# The frontend links @artemis/contracts from ../packages/contracts, which resolves to
# /packages/contracts from /app. It must exist before pnpm install creates the link.
COPY packages/contracts /packages/contracts
# packages/contracts/tsconfig.json extends ../../tsconfig.base.json, which is /tsconfig.base.json here.
COPY tsconfig.base.json /tsconfig.base.json
COPY frontend/.npmrc ./.npmrc
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./

ARG IP_ADDRESS=127.0.0.1
ARG ASSISTANT_NAME=Artemis
ENV IP_ADDRESS=${IP_ADDRESS} ASSISTANT_NAME=${ASSISTANT_NAME} BACKEND_URL=http://backend:3000
RUN pnpm build

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
