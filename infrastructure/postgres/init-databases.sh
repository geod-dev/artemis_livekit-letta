#!/bin/sh
# Runs once, on an empty postgres-data volume, via /docker-entrypoint-initdb.d.
# Creates the artemis and hindsight roles/databases and enables pgvector for Hindsight.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v artemis_pw="$ARTEMIS_DB_PASSWORD" -v hindsight_pw="$HINDSIGHT_DB_PASSWORD" <<'EOSQL'
CREATE ROLE artemis LOGIN PASSWORD :'artemis_pw';
CREATE ROLE hindsight LOGIN PASSWORD :'hindsight_pw';
CREATE DATABASE artemis OWNER artemis;
CREATE DATABASE hindsight OWNER hindsight;
EOSQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname hindsight -c 'CREATE EXTENSION IF NOT EXISTS vector;'
