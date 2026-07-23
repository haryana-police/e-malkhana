#!/bin/bash
# Daily e-Malkhana Neon DB backup to Google Drive
# Output: backup-YYYY-MM-DD-HHMM.sql.gz in Drive folder
# Retention: 10 days (configurable via BACKUP_RETENTION_DAYS)
#
# Schedule via Windows Task Scheduler (every day 02:00):
#   Action: Start a program
#   Program: C:\Program Files\Git\bin\bash.exe
#   Arguments: -lc "cd /c/Users/gsash/e-malkhana && bash server/scripts/backup-to-drive.sh"
#
# Requires:
#   - rclone configured with a remote named "gdrive" pointing to your Google account
#   - DATABASE_URL in .env.local (or set in this script)
#   - pg_dump on PATH (PostgreSQL client)

set -euo pipefail

# --- locate repo root (parent of server/) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# --- load DATABASE_URL from .env.local if present ---
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL not set — check .env.local or env vars}"
# Folder name has a SPACE — use ${IFS} or quotes carefully
: "${GDRIVE_REMOTE:=gdrive:e-Malkhana Backups}"
: "${BACKUP_RETENTION_DAYS:=10}"

# --- locate rclone + pg_dump ---
RCLONE_BIN=""
for d in "$HOME/bin"/rclone-*-windows-amd64 "/c/Program Files/rclone" "/c/ProgramData/chocolatey/bin"; do
  if [ -x "$d/rclone.exe" ]; then RCLONE_BIN="$d/rclone.exe"; break; fi
done
[ -n "$RCLONE_BIN" ] || { echo "✗ rclone.exe not found — install to ~/bin/"; exit 1; }

PG_DUMP_BIN=""
for d in "/c/Program Files/PostgreSQL/18/bin" "/c/Program Files/PostgreSQL/17/bin" "/c/Program Files/PostgreSQL/16/bin" "/c/Program Files/PostgreSQL/15/bin"; do
  if [ -x "$d/pg_dump.exe" ]; then PG_DUMP_BIN="$d/pg_dump.exe"; break; fi
done
[ -n "$PG_DUMP_BIN" ] || { echo "✗ pg_dump.exe not found"; exit 1; }

# --- timestamp + filename ---
TS=$(date +%Y-%m-%d-%H%M)
FILE="backup-${TS}.sql.gz"

echo "▶ e-Malkhana → Google Drive backup"
echo "  source:  Neon Postgres"
echo "  target:  ${GDRIVE_REMOTE}/${FILE}"
echo "  retain:  ${BACKUP_RETENTION_DAYS} days"

# --- pg_dump (Neon) | gzip | rclone rcat (stream, no temp file) ---
# --no-owner --no-acl: skip permissions (Neon role may differ on restore)
# --schema=public: only app schema
# --no-comments: skip COMMENT statements to keep file small (toggle as needed)
if "$PG_DUMP_BIN" \
    --no-owner --no-acl \
    --schema=public \
    --dbname="$DATABASE_URL" \
  | gzip -9 \
  | "$RCLONE_BIN" rcat "${GDRIVE_REMOTE}/${FILE}"; then
  echo "✓ uploaded: ${FILE}"
else
  echo "✗ backup failed"; exit 1
fi

# --- prune older backups ---
echo "▶ pruning files older than ${BACKUP_RETENTION_DAYS} days..."
DELETED=$("$RCLONE_BIN" delete "${GDRIVE_REMOTE}/" \
            --min-age "${BACKUP_RETENTION_DAYS}d" \
            --include "backup-*.sql.gz" \
            --drive-use-trash=false 2>&1 | tee /dev/stderr | wc -l || true)
echo "✓ done (prune log lines: ${DELETED})"
echo "✓ backup complete: ${FILE}"