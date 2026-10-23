# Postgres with the artemis/hindsight bootstrap script baked in. It runs once, on an
# empty data volume, through the image's docker-entrypoint-initdb.d hook.
# pgvector 0.8.7 on PostgreSQL 18 (Debian bookworm). The image is pinned to the extension
# release; the PostgreSQL minor version follows the image's pg18 line.
FROM pgvector/pgvector:0.8.7-pg18-bookworm
COPY init-databases.sh /docker-entrypoint-initdb.d/10-init-databases.sh
