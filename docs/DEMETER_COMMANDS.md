
On EC2 you should **start Demeter with PM2**, not with `npm run demeter` in the foreground.

**Use this to start:**

```bash
cd /var/www/soteria-agents/soteria_agents
pm2 start ecosystem.config.cjs
```

That reads the config and starts the app named `demeter`, which runs `npm run demeter` for you in the background.

**After that:**

- **Restart:** `pm2 restart demeter`
- **Start again after a stop:** `pm2 start demeter` (PM2 already knows the “demeter” process from the first start)
- **See status:** `pm2 status`

**Avoid for long‑running use:**

- **`npm run demeter`** – Runs in the **foreground**. When you close SSH it stops, and it won’t restart on crash or reboot. Use it only for a quick local test, then stop with Ctrl+C and use PM2 for the real run.

**Summary**

| Goal                         | Command                          |
|-----------------------------|-----------------------------------|
| First start on EC2          | `pm2 start ecosystem.config.cjs` |
| Restart Demeter             | `pm2 restart demeter`            |
| Start Demeter after stop    | `pm2 start demeter`              |
| Quick test (foreground)     | `npm run demeter` (then Ctrl+C)   |

So: **start with `pm2 start ecosystem.config.cjs`**, then use **`pm2 start demeter`** or **`pm2 restart demeter`** as needed; don’t rely on **`npm run demeter`** for the instance.
less logs/demeter-defensive-offensive-strategy.jsonl