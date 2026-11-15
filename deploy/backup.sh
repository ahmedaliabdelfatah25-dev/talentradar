#!/bin/sh
# Logical backup of the Talent Radar database (custom format, compressed).
# Connection comes from the standard PG* environment variables or DATABASE_URL.
set -eu
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/talentradar-$STAMP.dump"
if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$FILE"
else
  pg_dump --format=custom --no-owner --no-privileges --file="$FILE"
fi
# A dump that cannot be listed is not a backup.
pg_restore --list "$FILE" > /dev/null
echo "backup written: $FILE ($(wc -c < "$FILE") bytes)"
find "$BACKUP_DIR" -name 'talentradar-*.dump' -mtime +"$RETENTION_DAYS" -delete
