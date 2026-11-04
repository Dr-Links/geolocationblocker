# syntax=docker/dockerfile:1.7
# AllWebMails server image: user API + web app (PWA), admin site, background worker, CLI.
# Build from the repository root:  docker build -f deploy/server/Dockerfile -t allwebmails .

FROM node:22-bookworm-slim AS build
WORKDIR /src
# Optional: a CA bundle for builds behind a TLS-inspecting proxy (docker build --secret id=ca,src=ca.pem).
ENV NODE_EXTRA_CA_CERTS=/run/secrets/ca
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/admin-web/package.json apps/admin-web/
RUN --mount=type=secret,id=ca,required=false npm ci --no-audit --no-fund
COPY apps/mobile/package.json apps/mobile/package-lock.json apps/mobile/
RUN --mount=type=secret,id=ca,required=false cd apps/mobile && npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && cd apps/mobile && EXPO_OFFLINE=1 npx expo export --platform web --output-dir /src/web-dist
# Runtime dependencies only.
RUN node -e "const p=require('./apps/backend/package.json');require('fs').mkdirSync('/runtime',{recursive:true});require('fs').writeFileSync('/runtime/package.json',JSON.stringify({name:'allwebmails-server',version:p.version,private:true,type:'module',dependencies:p.dependencies},null,2))"
RUN --mount=type=secret,id=ca,required=false cd /runtime && npm install --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
# pg_dump/pg_restore 17 for backups (works with PostgreSQL 13-17 servers, incl. Supabase and Neon).
ARG INSTALL_PG_CLIENT=1
RUN set -eux; if [ "$INSTALL_PG_CLIENT" = "1" ]; then \
    apt-get update; apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; apt-get install -y --no-install-recommends postgresql-client-17; \
    apt-get purge -y curl gnupg; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; fi
WORKDIR /app
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /runtime/package.json ./package.json
COPY --from=build /src/apps/backend/dist ./dist
COPY --from=build /src/apps/backend/migrations ./migrations
COPY --from=build /src/apps/admin-web/dist ./admin-web
COPY --from=build /src/web-dist ./web
RUN mkdir -p /data/blobs /data/backups && chown -R node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 ADMIN_PORT=3001 \
    WEB_APP_DIR=/app/web ADMIN_STATIC_DIR=/app/admin-web BLOB_DIR=/data/blobs BACKUP_DIR=/data/backups \
    PG_DUMP_PATH=/usr/lib/postgresql/17/bin/pg_dump PG_RESTORE_PATH=/usr/lib/postgresql/17/bin/pg_restore
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" || exit 1
CMD ["node", "dist/entry-api.js"]
