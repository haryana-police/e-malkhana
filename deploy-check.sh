#!/bin/bash
cd ~/e-malkhana
TOK=$(cat .vercel-token)
export VERCEL_TOKEN=*** "=== env vars on e-malkhana project (production) ==="
vercel env ls e-malkhana production 2>&1 | head -20
echo ""
echo "=== Current production alias ==="
vercel alias ls 2>&1 | head -20
