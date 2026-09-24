#!/bin/sh
# Entrypoint of the postgres container. The backups volume mounts owned by
# root and archive_command runs as postgres, so wal/ is handed over first.
set -eu

: "${BACKUP_DIR:?}"

mkdir -p "${BACKUP_DIR}/wal"
chown postgres:postgres "${BACKUP_DIR}/wal"
chmod 0700 "${BACKUP_DIR}/wal"

exec docker-entrypoint.sh "$@"
