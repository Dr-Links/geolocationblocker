#!/bin/sh
# Container entrypoint. Usage: <image> [app|worker|migrate|<command…>]
# Every role `exec`s its process so it receives SIGTERM directly (tini is
# PID 1 and forwards signals): the worker then finishes in-flight jobs and
# Next.js drains requests before the platform kills the container.
set -e
role="${1:-app}"
case "$role" in
  app)
    # Migrations take a Postgres advisory lock, so several replicas starting at once is safe.
    # Set SKIP_MIGRATIONS=1 where the platform runs them as a release step (Fly, Render pre-deploy).
    if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then ./node_modules/.bin/prisma migrate deploy; fi
    exec ./node_modules/.bin/next start -p "${PORT:-3000}"
    ;;
  worker)
    export SERVICE_NAME=worker
    exec ./node_modules/.bin/tsx src/worker/index.ts
    ;;
  migrate)
    exec ./node_modules/.bin/prisma migrate deploy
    ;;
  *)
    exec "$@"
    ;;
esac
