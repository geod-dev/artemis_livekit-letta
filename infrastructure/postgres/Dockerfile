# Postgres with the artemis/hindsight bootstrap script baked in. It runs once, on an
# empty data volume, through the image's docker-entrypoint-initdb.d hook.
FROM pgvector/pgvector:pg18
COPY init-databases.sh /docker-entrypoint-initdb.d/10-init-databases.sh
