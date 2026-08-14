#!/usr/bin/env bash
# Run ON EC2: bash scripts/ec2-network-diagnose.sh
set -e
cd "$(dirname "$0")/.."

echo "=== This instance (use this IP in browser) ==="
PUBLIC=$(curl -s --max-time 3 https://checkip.amazonaws.com 2>/dev/null || curl -s --max-time 3 ifconfig.me 2>/dev/null || true)
PRIVATE=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Public IP (browser):  ${PUBLIC:-unknown}"
echo "Private IP (VPC):    ${PRIVATE:-unknown}"
echo ""

echo "=== UFW (host firewall) ==="
if command -v ufw >/dev/null 2>&1; then
  sudo ufw status verbose 2>/dev/null || ufw status
else
  echo "ufw not installed"
fi
echo ""

echo "=== App on 3000 ==="
curl -s -o /dev/null -w "127.0.0.1:3000 → %{http_code}\n" http://127.0.0.1:3000/ || echo "FAIL"
ss -tlnp | grep ':3000' || echo "Nothing on 3000"
echo ""

echo "=== AWS security group (YOU must fix in console if browser cannot connect) ==="
echo "EC2 → Instances → this instance → Security → Security group → Edit inbound rules"
echo "Add ONE of:"
echo "  - Custom TCP 3000  →  http://${PUBLIC:-YOUR_PUBLIC_IP}:3000"
echo "  - HTTP 80          →  http://${PUBLIC:-YOUR_PUBLIC_IP}/  (with nginx proxy to 3000)"
echo "SSH (22) alone does NOT allow web traffic."
echo ""

TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" --max-time 2 2>/dev/null || true)
if [ -n "$TOKEN" ]; then
  SG=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/security-groups 2>/dev/null || true)
  echo "Metadata security group name(s): ${SG:-n/a}"
fi
