#!/bin/bash
# Daily e-Malkhana backup to Google Drive
# Schedule via Windows Task Scheduler (every day 02:00):
#   Action: Start a program
#   Program: C:\Program Files\nodejs\node.exe
#   Arguments: server\scripts\backup-to-drive.js
#   Start in: C:\Users\gsash\e-malkhana
set -e
cd "$(dirname "$0")/.."
node server/scripts/backup-to-drive.js
