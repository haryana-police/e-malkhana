# e-Malkhana — Daily Google Drive backup

Daily `server/data/db.json` → Google Drive, keep last 10 days, auto-prune older.

## One-time browser setup (10–15 min)

See **`docs/GDRIVE_BACKUP_SETUP.md`** for the full walk-through. TL;DR:

1. GCP project `e-malkhana` → enable **Google Drive API**
2. Service account `emalkhana-backup` → download JSON key → save to
   `server/secrets/gcp-service-account.json`
3. Drive folder `e-Malkhana Backups` → share with the service account email (Editor)

Then put the folder ID in **either**:

- `.gdrive-folder-id` (project root, gitignored) — preferred
- or `GDRIVE_FOLDER_ID` env var

## Run a backup

```bash
# from e-malkhana/ root
node server/scripts/backup-to-drive.js
# or
bash backup-daily.sh
```

Output looks like:

```
▶ e-Malkhana → Google Drive backup
  source:  server/data/db.json
  target:  drive folder 1A2b3C4d…
  file:    malkhana-backup-2026-07-06-1430.json
  retain:  10 days

✓ uploaded: malkhana-backup-2026-07-06-1430.json
✓ pruned 3 old backup(s)
```

## Schedule it

### Local (laptop dev)

**Windows Task Scheduler** (easiest, no admin needed):

1. `Win+R` → `taskschd.msc` → **Create Basic Task**
2. Name: `e-Malkhana Daily Backup`
3. Trigger: **Daily**, 02:00
4. Action: **Start a program**
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `server\scripts\backup-to-drive.js`
   - Start in: `C:\Users\gsash\e-malkhana`
5. ✅ "Open properties after finish" → Conditions → uncheck "Start only if on AC power"
6. OK

### Vercel (production)

**⚠ Vercel caveat:** on Vercel, `server/data/db.json` lives in `/tmp` (per-instance,
lost on cold start). For a meaningful production backup you need **persistent storage
first** — Vercel KV, Postgres, or Upstash Redis. Once that's in place, add a
Vercel Cron Job in `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/backup-drive", "schedule": "0 2 * * *" }
  ]
}
```

…and a thin `/api/backup-drive` API route that imports the script's logic.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GCP_SERVICE_ACCOUNT_JSON` | `server/secrets/gcp-service-account.json` | path to service-account JSON key |
| `GDRIVE_FOLDER_ID` | `.gdrive-folder-id` (project root) | Drive folder ID to write to |
| `BACKUP_RETENTION_DAYS` | `10` | older files auto-pruned |
| `DB_PATH` | `server/data/db.json` (or `/tmp/data/db.json` on Vercel) | source data file |

## Security

- `server/secrets/` is already in `.gitignore` — keep it that way
- Service account JSON has **Editor** rights to the **single folder** only — no
  access to your whole Drive
- If the key ever leaks: GCP console → IAM & Admin → Service Accounts →
  `emalkhana-backup` → Keys → **Delete**
