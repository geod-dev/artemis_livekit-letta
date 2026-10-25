#!/bin/sh
# Entrypoint of the artemis Postgres image. It runs the stock entrypoint, then re-applies the
# application role passwords from the environment on every start. The stock image runs
# docker-entrypoint-initdb.d only on an empty volume, so without this a changed ARTEMIS_DB_PASSWORD
# or HINDSIGHT_DB_PASSWORD would never reach the running database.
set -eu

docker-entrypoint.sh "$@" &
server=$!
# docker stop sends SIGTERM to this shell (PID 1); pass it on to the server and let it shut down.
trap 'kill -TERM "$server" 2>/dev/null || true; wait "$server" || true' TERM INT

# The stock entrypoint listens on TCP only for the final server. During first-time initialization
# it runs a temporary server on the Unix socket alone, so TCP readiness means initialization is done.
until pg_isready -q -h 127.0.0.1 -p 5432 -U postgres; do
  if ! kill -0 "$server" 2>/dev/null; then
    wait "$server" || exit $?
    exit 1
  fi
  sleep 1
done

# Connect over the Unix socket. The image's local connections are trusted (initdb's default), so no
# superuser password is needed here. POSTGRES_PASSWORD is read only by the stock entrypoint at initdb,
# so a changed value never reaches a running database; see deploy/postgres/README.md.
psql -v ON_ERROR_STOP=1 -h /var/run/postgresql -p 5432 -U postgres -d postgres \
  -v artemis_pw="$ARTEMIS_DB_PASSWORD" -v hindsight_pw="$HINDSIGHT_DB_PASSWORD" <<'EOSQL'
ALTER ROLE artemis PASSWORD :'artemis_pw';
ALTER ROLE hindsight PASSWORD :'hindsight_pw';
EOSQL

wait "$server"
