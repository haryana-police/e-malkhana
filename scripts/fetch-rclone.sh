#!/bin/bash
# Download rclone for Linux amd64 into server/bin/ so the backup script can
# reach Google Drive from Vercel serverless (no pg_dump / rclone preinstalled).
# Runs as part of `vercel-build`.  Skips if already present.
set -e
# mkdir BEFORE resolving with cd — on a fresh Vercel clone server/bin does not
# exist (git doesn't track empty dirs) and `cd` into it would fail the build.
BIN_DIR="$(dirname "$0")/../server/bin"
mkdir -p "$BIN_DIR"
BIN_DIR="$(cd "$BIN_DIR" && pwd)"
if [ -x "$BIN_DIR/rclone" ]; then
  echo "[fetch-rclone] already present: $BIN_DIR/rclone"
  exit 0
fi
echo "[fetch-rclone] downloading rclone linux-amd64..."
curl -sL -o /tmp/rclone-linux.zip https://downloads.rclone.org/rclone-current-linux-amd64.zip
unzip -q -o /tmp/rclone-linux.zip -d /tmp/rclone-extract
cp /tmp/rclone-extract/rclone-v*-linux-amd64/rclone "$BIN_DIR/rclone"
chmod +x "$BIN_DIR/rclone"
rm -rf /tmp/rclone-linux.zip /tmp/rclone-extract
echo "[fetch-rclone] installed: $BIN_DIR/rclone"
"$BIN_DIR/rclone" version | head -1 || true