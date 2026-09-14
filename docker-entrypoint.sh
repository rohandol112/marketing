#!/bin/sh
# Bring up Postgres, bring the schema up to date, then hand over to the API.
#
# Runs as root so it can chown a freshly mounted volume; Postgres runs as
# postgres and the API as node, neither of them privileged.
set -eu

log() { echo "[boot] $*"; }

PORT="${PORT:-8787}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
POSTGRES_USER="${POSTGRES_USER:-dudeai}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-dudeai}"
POSTGRES_DB="${POSTGRES_DB:-dudeai}"
PGSOCK=/run/postgresql

# An external database wins over the built-in one. Detected rather than
# configured, so pasting a DATABASE_URL into Coolify is all it takes.
case "${EMBEDDED_POSTGRES:-auto}" in
  1|true|yes|on)  EMBEDDED=1 ;;
  0|false|no|off) EMBEDDED=0 ;;
  *)
    if [ -n "${DATABASE_URL:-}" ] || [ -n "${PGHOST:-}" ]; then EMBEDDED=0; else EMBEDDED=1; fi
    ;;
esac

start_postgres() {
  mkdir -p "$PGDATA" "$PGSOCK"
  chown postgres:postgres "$PGDATA" "$PGSOCK"
  chmod 0700 "$PGDATA"

  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    log "initialising a new cluster in $PGDATA"
    pwfile=$(mktemp)
    printf '%s' "$POSTGRES_PASSWORD" > "$pwfile"
    chown postgres "$pwfile"
    su-exec postgres initdb -D "$PGDATA" -U "$POSTGRES_USER" \
      --auth-local=trust --auth-host=scram-sha-256 --pwfile="$pwfile" \
      --encoding=UTF8 --no-locale >/dev/null
    rm -f "$pwfile"
  fi

  log "starting postgres"
  su-exec postgres pg_ctl -D "$PGDATA" -w -t 60 -l "$PGDATA/postgres.log" \
    -o "-c listen_addresses=127.0.0.1 -c port=5432 -c unix_socket_directories=$PGSOCK -c max_connections=${PG_MAX_CONNECTIONS:-50} -c shared_buffers=${PG_SHARED_BUFFERS:-128MB}" \
    start || { tail -n 40 "$PGDATA/postgres.log" 2>/dev/null; exit 1; }

  # Flags beat any PG* vars in the environment, so a stray PGPORT from the
  # app's config cannot send these at the wrong socket.
  psql_local() { su-exec postgres psql -h "$PGSOCK" -p 5432 -U "$POSTGRES_USER" "$@"; }

  if ! psql_local -d postgres -tAc \
      "select 1 from pg_database where datname = '$POSTGRES_DB'" | grep -q 1; then
    log "creating database $POSTGRES_DB"
    su-exec postgres createdb -h "$PGSOCK" -p 5432 -U "$POSTGRES_USER" \
      -O "$POSTGRES_USER" "$POSTGRES_DB"
  fi

  # knexfile.js falls back to these when DATABASE_URL is unset, which keeps the
  # password out of a URL that would otherwise need escaping.
  export PGHOST=127.0.0.1 PGPORT=5432 \
         PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" PGDATABASE="$POSTGRES_DB"
}

stop_postgres() {
  [ "$EMBEDDED" = "1" ] || return 0
  log "stopping postgres"
  su-exec postgres pg_ctl -D "$PGDATA" -w -t 30 -m fast stop >/dev/null 2>&1 || true
}

if [ "$EMBEDDED" = "1" ]; then
  start_postgres
else
  log "using the database from ${DATABASE_URL:+DATABASE_URL}${DATABASE_URL:-PGHOST=$PGHOST}"
fi

# Migrations every boot, seed only into an empty database.
su-exec node node scripts/bootstrap-db.js

log "starting the API on :$PORT"
su-exec node "$@" &
APP_PID=$!

shutdown() {
  kill -TERM "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  stop_postgres
  exit 0
}
trap shutdown TERM INT

set +e
wait "$APP_PID"
STATUS=$?
set -e
stop_postgres
exit "$STATUS"
