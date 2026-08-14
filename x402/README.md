# x402 Token Score (Bankr)

Paid Bankr x402 endpoint that ranks **2–10 Base token contract addresses** for LP positioning. Price: **$0.01 USDC** (exact).

Flow: caller → Bankr `token-score` handler → Demeter `POST /api/x402/token-score` → CoinGecko + `X402_TOKEN_RANKING_METRICS`.

## EC2 (Demeter backend)

1. Add to `.env`:

```bash
X402_TOKEN_SCORE_API_KEY=generate-a-long-random-secret-min-16-chars
```

2. Deploy nginx exemption for `/api/x402/` (see `deploy/nginx-soteria-agents.conf`):

```bash
sudo cp /var/www/soteria-agents/soteria_agents/deploy/nginx-soteria-agents.conf /etc/nginx/sites-available/soteria-agents
sudo nginx -t && sudo systemctl reload nginx
```

3. Reload web app so the new route is live:

```bash
cd /var/www/soteria-agents/soteria_agents
# pull + build as usual
pm2 reload soteria-web --update-env
```

4. Smoke test (no Bankr payment):

```bash
curl -sS -X POST "https://agent.soterialabs.io/api/x402/token-score" \
  -H "Authorization: Bearer $X402_TOKEN_SCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tokens":["0xTokenA...","0xTokenB..."]}'
```

## Bankr deploy

```bash
bankr login
bankr x402 deploy token-score

bankr x402 env set X402_TOKEN_SCORE_BACKEND_URL=https://agent.soterialabs.io/api/x402/token-score
bankr x402 env set X402_TOKEN_SCORE_API_KEY=same-secret-as-ec2
```

Test paid call (Bankr CLI):

```bash
bankr x402 call https://x402.bankr.bot/0xYourWallet/token-score -X POST \
  -d '{"tokens":["0x...","0x..."]}'
```

Or from this repo (pays with `DEMETER_TWO_PRIVATE_KEY` / USDC on Base):

```bash
# once: set paid URL from `bankr x402 list`
# in .env: X402_TOKEN_SCORE_URL=https://x402.bankr.bot/0xYourWallet/token-score

npm run x402:token-score
npm run x402:token-score -- 0xTokenA 0xTokenB
npm run x402:token-score -- --url https://x402.bankr.bot/0xYourWallet/token-score 0xA 0xB
```

## Request body

```json
{
  "tokens": ["0xabc...", "0xdef..."]
}
```

- Network: Base only  
- Min 2 / max 10 unique `0x` addresses  
- Response includes `best`, `ranked` (with `score` + `score_normalized`), `errors`, `metrics`
