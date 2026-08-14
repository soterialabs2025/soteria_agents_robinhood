# Deploy Demeter Agent Only on EC2 (No Website)

Run the Demeter agent on AWS EC2 with PM2—no Next.js, no Nginx, no chat UI. Just the upkeep, harvest, price check, and change-strategy loops.



On EC2 you should use **PM2**, not `npm run demeter` by itself.

- **`npm run demeter`** – Runs Demeter in the **foreground**. When you close SSH or the process exits, it stops. Use it only for a quick test (e.g. to confirm it starts and logs look right).

- **PM2** (`pm2 start ecosystem.config.cjs`) – Runs Demeter in the **background**, restarts it if it crashes, and (after you ran the startup command) starts it again on reboot. That’s what you want for a long‑running deployment.

So on the server: use **PM2** for normal operation. Use `npm run demeter` only when you’re testing, then stop it (Ctrl+C) and start it properly with PM2.
---

## Overview

- **What runs**: Demeter only (`npm run demeter`) – upkeep, harvest, change strategy, and price check loops (intervals from app/config/demeter-config.ts).
- **No**: Next.js, chat UI, `/api/agent`, Nginx, domain, or HTTPS.
- **Stack**: EC2 (Ubuntu) → PM2 → Demeter.

---

## Prerequisites

- AWS account
- GitHub repo (or another way to get the code onto the instance)
- SSH key pair for EC2

---

## Step 1: Launch EC2 Instance

1. **EC2 Dashboard** → Launch Instance
2. **Name**: `soteria-demeter` (or similar)
3. **AMI**: Ubuntu Server 22.04 LTS
4. **Instance type**: `t3.small` or `t3.medium` (2 vCPU, 4 GB RAM recommended)
5. **Key pair**: Create or select one
6. **Network**: VPC with public subnet
7. **Storage**: 20–30 GB gp3
8. **Security group** (minimal):
   - SSH (22) – your IP only (no HTTP/HTTPS needed)

9. Launch and note the **public IP**.

---

## Step 2: Connect and   Update 

```bash
ssh -i ~/.ssh/rh-agent-pair.pem ubuntu@3.145.26.185

chmod 400 rh-agent-pair.pem

 ssh -i "rh-agent-pair.pem" ubuntu@ec2-3-145-26-185.us-east-2.compute.amazonaws.com





sudo apt update && sudo apt -y upgrade



```

Optional firewall (SSH only):

```bash
sudo ufw allow OpenSSH
sudo ufw --force enable
```

---

## Step 3: Install Node.js and PM2

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.nvm/nvm.sh

nvm install --lts
node -v
npm -v

npm i -g pm2
pm2 -v

npm i -g tsx
```
ssh-keygen -t ed25519 -C isaiahc@soterialabs.io

---

## Step 4: Clone and Set Up the App

The app root is `/var/www/soteria_agents_robinhood` (where `package.json` lives). Clone into that directory with `.` so you do not get a nested folder. The directory must be empty (move an existing `.env` aside first, then move it back after clone).

```bash
sudo mkdir -p /var/www/soteria_agents_robinhood
sudo chown -R ubuntu:ubuntu /var/www
cd /var/www/soteria_agents_robinhood
GIT_SSH_COMMAND='ssh -i ~/.ssh/github_deploy_soteria_rh_ed25519 -o IdentitiesOnly=yes' git clone git@github.com:soterialabs2025/soteria_agents_robinhood.git .
```

All following steps (env, build, PM2) run from `/var/www/soteria_agents_robinhood`.

---

## Step 5: Environment Variables

```bash
cd /var/www/soteria_agents_robinhood
nano .env
```

Add (use your real values):

```env
OPENAI_API_KEY=sk-proj-...
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
RPC_URL=https://base-mainnet.infura.io/v3/YOUR_INFURA_KEY
COIN_GECKO_API_KEY=...

# Optional
# EOA_ADDRESS=...
# FloatContractManager address is in app/config/demeter-config.ts, not env
```

Save and exit (Ctrl+X, Y, Enter).

---

## Step 6: Install Dependencies and Build

The app still needs a build (agent code and deps). Run from the app root.

```bash
cd /var/www/soteria_agents_robinhood
npm ci
npm run build
```

**If the build hangs** (common on t2.micro/t2.small): add [swap](#build-hangs-or-never-completes) first, or run with a memory limit: `NODE_OPTIONS="--max-old-space-size=1536" npm run build`

Quick test (then Ctrl+C to stop):

```bash
npm run demeter
```

You should see Demeter start and the upkeep/harvest/change-strategy/price-check loop messages.

---

## Step 7: PM2 Ecosystem (Demeter Only)

Create or update `ecosystem.config.cjs` in the app root (`/var/www/soteria_agents_robinhood`). Use `.cjs` so Node treats it as CommonJS (the project has `"type": "module"`). The `cwd` must be that folder so `npm run demeter` runs in the right place.

```javascript
/**
 * PM2 config for EC2 headless: Demeter agent only (no web app)
 * Run from app root: pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: "demeter",
      cwd: "/var/www/soteria_agents_robinhood",
      script: "npm",
      args: "run demeter",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      max_memory_restart: "1G",
      env: { NODE_ENV: "production" },
    },
  ],
};
```

---

## Step 8: Start with PM2 and Enable Startup

```bash
cd /var/www/soteria_agents_robinhood

pm2 start ecosystem.config.cjs
pm2 status
pm2 save

pm2 startup systemd -u ubuntu --hp /home/ubuntu
# PM2 will print a second command starting with "sudo env PATH=...". You must copy and run that command to install the startup script. Only then will Demeter start on reboot.
```

Logs:

```bash
pm2 logs demeter
```

---

## Deploy Script (Updates)

Create the script in the app root:

```bash
nano /var/www/soteria_agents_robinhood/deploy.sh
```

Paste:

```bash
#!/usr/bin/env bash
set -euo pipefail
APP_DIR="/var/www/soteria_agents_robinhood"
cd "$APP_DIR"
git fetch --all
git reset --hard origin/main
npm ci
npm run build
pm2 reload demeter
echo "Deploy complete."
```

```bash
chmod +x /var/www/soteria_agents_robinhood/deploy.sh
```

To deploy updates (from anywhere, or from the app folder use `./deploy.sh`):

```bash
/var/www/soteria_agents_robinhood/deploy.sh
```

---

## Useful Commands

| Task           | Command                |
|----------------|------------------------|
| View logs      | `pm2 logs demeter`     |
| Restart        | `pm2 restart demeter`   |
| Status         | `pm2 status`           |
| Stop           | `pm2 stop demeter`      |

---

## Troubleshooting

| Issue              | Check                                                                 |
|--------------------|-----------------------------------------------------------------------|
| Demeter exits      | `pm2 logs demeter` – check OPENAI_API_KEY, CDP keys, RPC_URL          |
| Out of memory      | Use t3.medium or raise `max_memory_restart` in ecosystem.config.cjs   |
| Build fails        | `sudo apt -y install build-essential` then `npm run build`            |
| Build hangs        | See below (memory/swap on small instances)                            |

### Build hangs or never completes

On t2.micro / t2.small, `npm run build` can hang with no error because the Next.js build uses a lot of RAM and the process gets starved or killed by the OOM killer.

**1. Add swap (recommended before first build)**

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Then run `npm run build` again. It may be slow but should finish.

**2. Limit Node memory during build**

Prevents runaway allocation; may allow build to complete on low-RAM instances:

```bash
cd /var/www/soteria_agents_robinhood
NODE_OPTIONS="--max-old-space-size=2048" npm run build
```

Use `1024` on a 1 GB instance, `1536` or `2048` on 2 GB.

**3. Build elsewhere, deploy artifacts**

Build on your local machine or a larger instance, then copy the built app to EC2 so the server never runs `npm run build`:

- Locally (or on a build server): `npm ci && npm run build`
- Copy the whole project (including `.next` and `node_modules`) to EC2, or use `rsync`/`scp` to sync `.next` and run `npm ci --production` on EC2. Then start with PM2 as usual.

---

## Summary

- **With website**: Use [DEPLOY_EC2_PM2.md](./DEPLOY_EC2_PM2.md) (Next.js + Nginx + HTTPS + Demeter).
- **No website**: This guide – EC2 + PM2 running Demeter only; no port 80/443, no Nginx, no domain.
