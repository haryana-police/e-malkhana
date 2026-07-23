#!/bin/bash
# Download rclone for Linux amd64 into server/bin/ so the backup script can
# reach Google Drive from Vercel serverless (no pg_dump / rclone preinstalled).
# Runs as part of `vercel-build`.  Skips if already present.
set -e
BIN_DIR="$(cd "$(dirname "$0")/../server/bin" && pwd)"
mkdir -p "$BIN_DIR"
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