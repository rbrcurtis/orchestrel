#!/bin/bash
set -ex

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB="${ORC_DB_PATH:-$SCRIPT_DIR/../data/orchestrel.db}"
BACKUP_DIR="${ORC_BACKUP_DIR:-/mnt/D/Sync/orchestra-backups}"
MAX_AGE_DAYS=3

# SQLite-safe backup using .backup command
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
sqlite3 "$DB" ".backup '${BACKUP_DIR}/orchestrel-${TIMESTAMP}.db'"

# Prune backups older than 3 days
find "$BACKUP_DIR" -name "orchestrel-*.db" -mtime +${MAX_AGE_DAYS} -delete
