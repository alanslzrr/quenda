# One-shot seeder for a demonstration installation. It is NOT part of the
# released artifact: it carries the demo dataset and its photos, and runs the
# TypeScript sources directly with the production dependencies.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
RUN npm install --global pnpm@10.30.3 --ignore-scripts
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY src ./src
COPY scripts/lib ./scripts/lib
COPY test/helpers/auth-client.ts ./test/helpers/auth-client.ts
COPY test/demo ./test/demo
COPY deploy/demo/seed.ts ./deploy/demo/seed.ts
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=$SOURCE_REVISION org.opencontainers.image.title="Quenda demo seeder"
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "deploy/demo/seed.ts"]
