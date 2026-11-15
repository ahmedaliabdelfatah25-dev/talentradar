#!/bin/sh
# Restores a backup produced by backup.sh into the database named by DATABASE_URL (or PG* variables).
# The target database is emptied first. Stop the application before restoring.
#   Usage: DATABASE_URL=postgres://… sh deploy/restore.sh backups/talentradar-20261115T020000Z.dump
set -eu
FILE="${1:?Usage: restore.sh <backup-file.dump>}"
[ -f "$FILE" ] || { echo "No such file: $FILE" >&2; exit 1; }
printf 'This REPLACES all data in the target database with %s. Type RESTORE to continue: ' "$FILE"
read -r ANSWER
[ "$ANSWER" = "RESTORE" ] || { echo "Cancelled."; exit 1; }
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
  pg_restore --no-owner --no-privileges --exit-on-error --dbname="$DATABASE_URL" "$FILE"
else
  psql -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
  pg_restore --no-owner --no-privileges --exit-on-error --dbname="${PGDATABASE:?set PGDATABASE}" "$FILE"
fi
echo "Restore complete. Start the application; it applies any newer migrations automatically."
