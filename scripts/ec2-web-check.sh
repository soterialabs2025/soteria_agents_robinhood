#!/usr/bin/env bash
# Run on EC2 from repo root: bash scripts/ec2-web-check.sh
set -e
cd "$(dirname "$0")/.."
echo "=== PM2 ==="
pm2 status 2>/dev/null || echo "pm2 not running"
echo ""
echo "=== Port 3000 ==="
ss -tlnp | grep ':3000' || echo "Nothing listening on 3000"
echo ""
echo "=== HTTP localhost ==="
curl -s -o /dev/null -w "127.0.0.1:3000 → HTTP %{http_code}\n" http://127.0.0.1:3000/ || echo "curl failed"
echo ""
echo "=== .next build ==="
if [ -d .next ]; then echo ".next exists"; else echo "MISSING .next — run: npm run build"; fi
echo ""
echo "=== Last soteria-web logs ==="
pm2 logs soteria-web --lines 15 --nostream 2>/dev/null || tail -15 logs/soteria-web-out.log 2>/dev/null || true
