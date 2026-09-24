#!/bin/sh
# Entrypoint of the postgres container. The backups volume mounts owned by
# root and archive_command runs as postgres, so wal/ is handed over first.
set -eu

: "${BACKUP_DIR:?}"

# A backup fault must not stop the database; failed pushes are what the watch reports (KEHOACH 4.8).
if ! { mkdir -p "${BACKUP_DIR}/wal" \
        && chown postgres:postgres "${BACKUP_DIR}/wal" \
        && chmod 0700 "${BACKUP_DIR}/wal"; }; then
    echo "pg-start: could not hand ${BACKUP_DIR}/wal to postgres; WAL pushes will fail" >&2
fi

exec docker-entrypoint.sh "$@"
