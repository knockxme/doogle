#!/bin/bash
# Nightly MySQL dump. Runs forever: dumps at start, then every 24 hours.
# Keeps 14 days. Never prints the password (it travels in MYSQL_PWD, not argv).
set -u -o pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
DB_HOST="${DB_HOST:-mysql}"
DB_NAME="${MYSQL_DATABASE:-9drive}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-}"

run_once() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  tmp="$BACKUP_DIR/.backup-$stamp.sql.gz.tmp"
  final="$BACKUP_DIR/backup-$stamp.sql.gz"
  if mysqldump -h "$DB_HOST" -u root --single-transaction --routines "$DB_NAME" 2>/dev/null | gzip > "$tmp" \
     && [ "${PIPESTATUS[0]}" -eq 0 ] && [ -s "$tmp" ]; then
    mv "$tmp" "$final"
    echo "backup ok: $(basename "$final") ($(wc -c < "$final") bytes)"
    find "$BACKUP_DIR" -maxdepth 1 -name 'backup-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
  else
    rm -f "$tmp"
    echo "backup FAILED at $stamp" >&2
  fi
}

mkdir -p "$BACKUP_DIR"
while true; do
  run_once
  [ "${BACKUP_ONCE:-}" = "1" ] && break
  sleep "$INTERVAL_SECONDS"
done
