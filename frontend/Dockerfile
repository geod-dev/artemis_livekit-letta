FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./

ARG IP_ADDRESS=127.0.0.1
ARG ASSISTANT_NAME=Ada
ENV IP_ADDRESS=${IP_ADDRESS} ASSISTANT_NAME=${ASSISTANT_NAME} BACKEND_URL=http://backend:3000
RUN pnpm build

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
