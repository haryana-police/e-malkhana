# Daily Backup — e-Malkhana → Google Drive

Automated daily backup of the e-Malkhana Neon Postgres database to your Google Drive, as `backup-YYYY-MM-DD-HHMM.sql.gz` files. Retention: 10 days.

## What runs

| | |
|---|---|
| **Source** | Neon Postgres (`DATABASE_URL` from `.env.local`) |
| **Target** | Google Drive folder `e-Malkhana Backups` (ID `1gcQEnhcF9cXCYnURwYDnJt6mTzt2Ur2b`) |
| **Method** | `pg_dump` → `gzip -9` → `rclone rcat` (streamed, no temp file) |
| **Schedule** | Daily at 02:00 via Windows Task Scheduler |
| **Retention** | 10 days (configurable via `BACKUP_RETENTION_DAYS` env var) |
| **Account** | `asppanipat01@gmail.com` |

## Files

```
server/scripts/backup-to-drive.sh    # main script (bash)
server/scripts/backup-to-drive.cmd   # Task Scheduler launcher (.cmd wrapper)
~/bin/rclone-v1.74.4-windows-amd64/  # rclone binary
~/.config/rclone/rclone.conf         # OAuth token (DO NOT COMMIT)
```

## Verify a backup

Open the [e-Malkhana Backups](https://drive.google.com/drive/folders/1gcQEnhcF9cXCYnURwYDnJt6mTzt2Ur2b) folder — you should see new files each morning by ~02:05.

Or from the laptop:

```bash
~/bin/rclone-v1.74.4-windows-amd64/rclone.exe lsjson gdrive:e-Malkhana\ Backups
```

## Run a backup manually

```bash
cd /c/Users/gsash/e-malkhana
bash server/scripts/backup-to-drive.sh
```

or

```cmd
C:\Users\gsash\e-malkhana\server\scripts\backup-to-drive.cmd
```

## Restore a backup

```bash
# 1. Download from Drive
~/bin/rclone-v1.74.4-windows-amd64/rclone.exe copy \
  "gdrive:e-Malkhana Backups/backup-YYYY-MM-DD-HHMM.sql.gz" .

# 2. Decompress
gunzip backup-YYYY-MM-DD-HHMM.sql.gz

# 3. Restore to Neon (use unpooled URL for safety)
psql "postgresql://neondb_owner:...@ep-...c-9.us-east-1.aws.neon.tech/neondb?sslmode=require" \
  -f backup-YYYY-MM-DD-HHMM.sql
```

## Change retention

Set `BACKUP_RETENTION_DAYS` env var (default 10) before running the script, or edit the line in `backup-to-drive.sh`.

## Security

- **OAuth token** stored at `~/.config/rclone/rclone.conf` (local user only). Do NOT copy to other machines or commit.
- **Scope**: `drive.file` (per-file access), not full Drive.
- If the token leaks: go to https://myaccount.google.com/permissions → revoke "rclone" → re-run `rclone config reconnect gdrive:` to re-authorize.
- `.env.local` contains the DB connection string — never commit (already in `.gitignore` via `vercel env pull`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `rclone.exe not found` | Re-install to `~/bin/rclone-v1.74.4-windows-amd64/` |
| `pg_dump.exe not found` | Install PostgreSQL client or update path in script |
| `DATABASE_URL not set` | Run `vercel env pull .env.local --environment=production` |
| `ERROR : directory not found` (e-Malkhana Backups) | Make sure folder name has a SPACE, not hyphen — bash needs quoting |
| Task didn't run | Check `schtasks /query /tn "e-Malkhana Daily Backup"` |
| Want email on failure | Add a Send-Mail step in Task Scheduler → Actions → Send an email (deprecated in Win11 — use a small PowerShell trigger instead) |