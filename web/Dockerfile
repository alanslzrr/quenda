FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app/web
RUN npm install --global pnpm@10.30.3 --ignore-scripts
COPY web/package.json web/pnpm-lock.yaml web/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/public ./public
COPY web/src ./src
RUN pnpm exec vite build

FROM nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8 AS runtime
ARG SOURCE_REVISION=unknown
ENV QUENDA_API_UPSTREAM=api:3000 NGINX_ENVSUBST_FILTER=^QUENDA_
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
LABEL org.opencontainers.image.title="Quenda web" org.opencontainers.image.licenses="AGPL-3.0-only"
COPY web/nginx/templates /etc/nginx/templates
COPY web/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY LICENSE /usr/share/nginx/html/licenses/LICENSE
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
