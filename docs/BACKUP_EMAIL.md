# e-Malkhana — Daily email backup

The production app runs on **Vercel (serverless)** with a **PostgreSQL (Neon)**
database.  Daily backups dump the entire "case register" (all tables) to a
timestamped JSON file and email it as an attachment.

## Why email (not Google Drive)

The earlier Drive design relied on a **service-account JSON key**.  This GCP
project has the org policy `iam.managed.disableServiceAccountKeyCreation`
enforced at the organization level, which **permanently blocks creating SA
keys** — it cannot be overridden.  Email needs no key file and no GCP consent
screen, so it sidesteps the block entirely.

## How it works

`server/scripts/backup-email.js`:

1. Connects to `DATABASE_URL` (Neon Postgres, HTTP transport — serverless-safe).
2. Dumps every table (`kv`, `users`, `sections`, `item_types`, `cases`,
   `bns_sections`, `movements`, `audit_log`, `fir_master`, `case_property`,
   `item_type_fields`, `case_property_fields`, `inspections`) into one JSON.
3. Writes a local copy to `server/data/backups/malkhana-backup-<ts>.json` and
   prunes copies older than `BACKUP_RETENTION_DAYS` (default 30).
4. If `BACKUP_TO` + SMTP creds are set, emails the JSON as an attachment.

The Vercel cron (`0 23 * * *` by default) and the **Run backup now** button in
Settings → Backup & Restore both call this script.  Each run is logged to
`db.backupLog` and shown in the Recent runs table.

## One-time setup (~5 min)

### 1. A sending Gmail account
Use a **dedicated** Gmail address (e.g. `emalkhana.backup@gmail.com`).  Normal
Gmail password will NOT work — you need an **App Password**:

1. Google Account → Security → enable **2-Step Verification**.
2. Security → **App passwords** → create one named "e-Malkhana backup".
3. Copy the 16-char password (spaces ok, e.g. `abcd efgh ijkl mnop`).

### 2. Set the env vars
Local (`.env`):
```dotenv
BACKUP_FROM=emalkhana.backup@gmail.com
BACKUP_TO=receiver1@gmail.com,receiver2@police.gov.in
BACKUP_SMTP_HOST=smtp.gmail.com
BACKUP_SMTP_PORT=465
BACKUP_SMTP_USER=emalkhana.backup@gmail.com
BACKUP_SMTP_PASS=abcd efgh ijkl mnop
BACKUP_RETENTION_DAYS=30
```

Vercel production (so they deploy with the bundle):
```bash
vercel env add BACKUP_FROM production
vercel env add BACKUP_TO production
vercel env add BACKUP_SMTP_HOST production
vercel env add BACKUP_SMTP_PORT production
vercel env add BACKUP_SMTP_USER production
vercel env add BACKUP_SMTP_PASS production
vercel env add BACKUP_RETENTION_DAYS production
```

> `DATABASE_URL` is already set on Vercel — the script reuses it.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | (required) | Neon Postgres connection string |
| `BACKUP_FROM` | `BACKUP_SMTP_USER` | From: address |
| `BACKUP_TO` | — | Comma-separated recipients (**enables email**) |
| `BACKUP_SMTP_HOST` | `smtp.gmail.com` | SMTP server |
| `BACKUP_SMTP_PORT` | `465` | SMTP port (SSL) |
| `BACKUP_SMTP_USER` | `BACKUP_FROM` | SMTP login |
| `BACKUP_SMTP_PASS` | — | SMTP / app password |
| `BACKUP_RETENTION_DAYS` | `30` | local-dump retention |
| `BACKUP_CRON` | `0 23 * * *` | cron schedule (server-side, long-lived only) |

## Safety net

If `BACKUP_TO` (or SMTP creds) are **not** set, the script still writes the
dump locally under `server/data/backups/` and exits 0 — so the cron records a
success and you always keep a local copy.  Set the SMTP vars to actually
deliver the email.

## Test a backup

```bash
# from e-malkhana/ root
node server/scripts/backup-email.js
# → writes local dump; emails it if BACKUP_TO is set
```
Check `server/data/backups/` for the file, and your inbox for the message.
