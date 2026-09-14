# syntax=docker/dockerfile:1

# All-in-one image: React build + Hono API + Postgres, one container, one port.
#
# Built for a single-service Coolify deployment. The only thing that has to
# survive a redeploy is the database, so mount a volume at
# /var/lib/postgresql/data and nothing else needs configuring.
#
# Point DATABASE_URL (or PGHOST) at a managed Postgres and the embedded server
# stays off - the same image then runs as a stateless web container.

# ---------- 1. build the frontend ----------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- 2. install the server's production deps ----------
FROM node:22-alpine AS deps
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---------- 3. runtime ----------
# The postgres base gives us a correctly initialised postgres user, PGDATA and
# su-exec; node comes from apk. Every dependency here is pure JS, so the
# node_modules tree built above copies in cleanly.
FROM postgres:16-alpine

RUN apk add --no-cache nodejs tini curl \
 && mkdir -p /run/postgresql \
 && chown -R postgres:postgres /run/postgresql \
 && adduser -D -H -u 1001 node

# No POSTGRES_PASSWORD default here on purpose - a password baked into an image
# layer is a password in every copy of the image. The entrypoint falls back to
# "dudeai" when nothing supplies one, which is what .env is for in production.
ENV NODE_ENV=production \
    PORT=8787 \
    PGDATA=/var/lib/postgresql/data \
    POSTGRES_USER=dudeai \
    POSTGRES_DB=dudeai \
    WEB_DIST=/app/web/dist

WORKDIR /app/server

COPY --from=deps /server/node_modules ./node_modules
COPY server/package.json server/knexfile.js ./
COPY server/migrations ./migrations
COPY server/seeds ./seeds
COPY server/scripts ./scripts
COPY server/src ./src
COPY --from=web /web/dist /app/web/dist

COPY docker-entrypoint.sh /usr/local/bin/app-entrypoint.sh
RUN chmod +x /usr/local/bin/app-entrypoint.sh

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/meta/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/app-entrypoint.sh"]
CMD ["node", "src/index.js"]
