FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tooling
WORKDIR /app
RUN npm install --global pnpm@10.30.3 --ignore-scripts
COPY package.json pnpm-lock.yaml .npmrc ./

FROM tooling AS build
COPY .source/source.tar.gz /tmp/quenda-source.tar.gz
ARG SOURCE_REVISION
ARG SOURCE_ARCHIVE_SHA256
RUN test -n "$SOURCE_REVISION" && test -n "$SOURCE_ARCHIVE_SHA256" && echo "$SOURCE_ARCHIVE_SHA256  /tmp/quenda-source.tar.gz" | sha256sum --check
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM tooling AS dependencies
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
WORKDIR /app
ARG SOURCE_REVISION
ARG SOURCE_ARCHIVE_SHA256
ENV NODE_ENV=production HOST=0.0.0.0 SOURCE_ARCHIVE_PATH=/app/source/source.tar.gz SOURCE_REVISION=$SOURCE_REVISION SOURCE_ARCHIVE_SHA256=$SOURCE_ARCHIVE_SHA256
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
LABEL org.opencontainers.image.title="Quenda backend" org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
COPY .source/source.tar.gz ./source/source.tar.gz
COPY scripts ./scripts
COPY db ./db
USER node
EXPOSE 3000
ENTRYPOINT ["node"]
CMD ["dist/server.js"]
