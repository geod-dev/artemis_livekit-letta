#!/bin/sh
# Runs once, on an empty data volume, via /docker-entrypoint-initdb.d.
# Creates the artemis and hindsight roles/databases and enables pgvector for Hindsight.
# Role passwords are set again on every start by entrypoint.sh (ALTER ROLE), so rotation takes effect.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v artemis_pw="$ARTEMIS_DB_PASSWORD" -v hindsight_pw="$HINDSIGHT_DB_PASSWORD" <<'EOSQL'
CREATE ROLE artemis LOGIN PASSWORD :'artemis_pw';
CREATE ROLE hindsight LOGIN PASSWORD :'hindsight_pw';
CREATE DATABASE artemis OWNER artemis;
CREATE DATABASE hindsight OWNER hindsight;
EOSQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname hindsight -c 'CREATE EXTENSION IF NOT EXISTS vector;'
