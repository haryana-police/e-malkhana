# Google Drive Backup — one-time GCP setup

Ye 4 steps aapko apne browser me karne hain. Total time: 10-15 min.
Main in steps ko automate nahi kar sakta kyunki ye aapke Google account + browser session me hote hain (MFA, OAuth consent, etc.).

## 1. GCP project + Drive API enable
- Open https://console.cloud.google.com/
- Top-left project dropdown → **New Project** → name: `e-malkhana` → Create
- Wait for project to be created (notification bell)
- APIs & Services → Library → search "Google Drive API" → click it → **Enable**
- (Optional but recommended) OAuth consent screen → External → fill app name `e-malkhana` → save (you don't need to publish for service accounts)

## 2. Service account create
- IAM & Admin → Service Accounts → **Create Service Account**
- Name: `emalkhana-backup`
- Service account ID: `emalkhana-backup` (auto-filled)
- Description: `Daily db.json backup to Google Drive`
- Click **Create and Continue** → **Done** (skip role grant — Drive folder share handles perms)

## 3. JSON key download
- Click the service account you just created
- **Keys** tab → **Add Key** → **Create new key** → **JSON** → **Create**
- File downloads: `emalkhana-backup-<project-id>.json`
- **Move it to**: `C:\Users\gsash\e-malkhana\server\secrets\gcp-service-account.json`
- **DO NOT COMMIT THIS FILE** — already in `.gitignore` (we'll add it)

## 4. Drive folder create + share
- Open https://drive.google.com/
- **New** → **New folder** → name: `e-Malkhana Backups` → Create
- Open the folder
- Copy the folder ID from URL: `https://drive.google.com/drive/folders/<FOLDER_ID_HERE>`
- Click **Share** → paste the service account email (looks like `emalkhana-backup@<project-id>.iam.gserviceaccount.com`) → role: **Editor** → uncheck "Notify" → **Share**

## 5. Give me 2 values
- **Path to JSON key**: `C:\Users\gsash\e-malkhana\server\secrets\gcp-service-account.json`
- **Drive folder ID**: `<the ID you copied>`

## 6. (Optional) Verify
After step 1-5 done, run from `~/e-malkhana/server`:
```bash
node scripts/verify-drive-setup.js <folder-id>
```
This will list folder contents using the service account — confirms everything works.

## Security notes
- JSON key is the ONLY credential. Anyone with it can write to folders shared with the service account.
- Add to `.gitignore` BEFORE moving the file: `server/secrets/`
- If the key ever leaks → delete it in IAM & Admin → Service Accounts → click account → Keys → Delete
