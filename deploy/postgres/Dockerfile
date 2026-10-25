# Postgres with the artemis/hindsight bootstrap baked in. init-databases.sh creates the roles and
# databases once, on an empty data volume, through the image's docker-entrypoint-initdb.d hook.
# entrypoint.sh wraps the stock entrypoint and re-applies the role passwords on every start.
# pgvector 0.8.7 on PostgreSQL 18 (Debian bookworm). The image is pinned to the extension
# release; the PostgreSQL minor version follows the image's pg18 line.
FROM pgvector/pgvector:0.8.7-pg18-bookworm@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11
COPY init-databases.sh /docker-entrypoint-initdb.d/10-init-databases.sh
COPY entrypoint.sh /usr/local/bin/artemis-entrypoint.sh
# The script runs through /bin/sh, so the copied file needs no executable bit.
ENTRYPOINT ["/bin/sh", "/usr/local/bin/artemis-entrypoint.sh"]
CMD ["postgres"]
