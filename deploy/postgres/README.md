# Postgres image

`Dockerfile` builds the database image used by the Compose stack: the pinned `pgvector/pgvector`
image (PostgreSQL 18 with pgvector 0.8.7) plus two files.

- `init-databases.sh` runs once, on an empty data volume, through the image's
  `docker-entrypoint-initdb.d` hook. It creates the `artemis` and `hindsight` roles and databases
  and enables pgvector for Hindsight.
- `entrypoint.sh` wraps the stock entrypoint. It starts the stock entrypoint in the background,
  waits for TCP readiness, re-applies the `artemis` and `hindsight` role passwords from
  `ARTEMIS_DB_PASSWORD` and `HINDSIGHT_DB_PASSWORD` with `ALTER ROLE`, then waits for the server.
  Stopping the container passes SIGTERM to the server.

## Connections

The re-apply step connects as the `postgres` superuser over the Unix socket
(`/var/run/postgresql`). The image trusts local socket connections, so the step needs no
password. The stock entrypoint uses `POSTGRES_PASSWORD` only at initialization, and this wrapper
does not read it.

## Rotation limits

- `ARTEMIS_DB_PASSWORD` and `HINDSIGHT_DB_PASSWORD` can be changed in the environment and take effect
  on the next container start.
- `POSTGRES_PASSWORD` is set only when the data volume is first initialized. Changing it later does
  not change the database, and nothing on restart reads it. To change the superuser password,
  run `ALTER USER postgres PASSWORD ...` inside the running database and then update the stored value.
- Role passwords must use letters and digits only, because the application builds connection URLs
  from them without encoding.
