# One image, three roles (see docker/entrypoint.sh):
#   app (default) · worker · migrate
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
# The worker runs TypeScript via tsx and migrations need the Prisma CLI, so
# node_modules is kept whole; .next, src, prisma and public come from the build.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/package.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/docker/entrypoint.sh ./docker/entrypoint.sh
RUN mkdir -p /app/.data/media && chown -R node:node /app/.data
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["app"]
