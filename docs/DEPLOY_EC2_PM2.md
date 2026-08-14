# Deploy Soteria Agents on EC2 with PM2

Step-by-step guide to deploy the Soteria Agents app (Next.js + Demeter) on AWS EC2 using PM2 and Nginx.

**No website?** To run Demeter only (no Next.js, no Nginx), see [DEPLOY_EC2_HEADLESS.md](./DEPLOY_EC2_HEADLESS.md).

---

## Overview

- **Web app**: Next.js chat UI + API routes (`/api/agent`)
- **Demeter**: Long-running agent (upkeep, harvest, price check, change strategy)
- **Stack**: EC2 (Ubuntu) → Nginx (reverse proxy) → PM2 → Next.js (port 3000) + Demeter (background)

---

## Prerequisites

- AWS account
- Domain name with DNS access (for HTTPS)
- GitHub repo with your code (or another way to transfer files)
- SSH key pair for EC2
ssh -T -i ~/.ssh/github_deploy_soteria_rh_ed25519 -o IdentitiesOnly=yes git@github.com
---
ssh -T -i ~/.ssh/github_deploy_soteria_rh_ed25519 -o IdentitiesOnly=yes git@github.com

## Step 1: Launch EC2 Instance

1. **EC2 Dashboard** → Launch Instance
2. **Name**: `soteria-agents` (or similar)
3. **AMI**: Ubuntu Server 22.04 LTS
4. **Instance type**: `t3.small` or `t3.medium` (2 vCPU, 4 GB RAM recommended)
5. **Key pair**: Create or select an existing one
6. **Network**: Create/use a VPC with public subnet
7. **Storage**: 20–30 GB gp3
8. **Security group** (create new):
   - SSH (22) – your IP only
   - HTTP (80) – 0.0.0.0/0
   - HTTPS (443) – 0.0.0.0/0

9. Launch and note the **public IP**.
10. **Elastic IP** (recommended): Allocate and associate so the IP does not change on restart.

---

## Step 2: Connect and Update

```bash
# Replace with your key path and EC2 IP
ssh -i ~/.ssh/your-key.pem ubuntu@YOUR_EC2_PUBLIC_IP

# Update system
sudo apt update && sudo apt -y upgrade

# Install base tools
sudo apt -y install curl git ufw
```

Optional firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
```

---

## Step 3: Install Node.js and PM2

```bash
# Install NVM
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.nvm/nvm.sh

# Install Node LTS
nvm install --lts
node -v   # should be 20.x or 22.x
npm -v

# Install PM2
npm i -g pm2
pm2 -v

# Install tsx (for Demeter - runs TypeScript)
npm i -g tsx
```

---

## Step 4: Clone and Build the App

### Public repo (HTTPS)

```bash
# Create app directory
sudo mkdir -p /var/www/soteria-agents
sudo chown -R ubuntu:ubuntu /var/www
cd /var/www/soteria-agents

git clone https://github.com/YOUR_ORG/soteria_agents.git .
```

### Private repo (SSH — recommended for EC2)

GitHub remotes use either **HTTPS** or **SSH** ([About remote repositories](https://docs.github.com/en/get-started/git-basics/about-remote-repositories)). For a **private** repo, use **SSH** plus a **[deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#deploy-keys)** (SSH key attached only to that repository—ideal for a single server doing `git pull`).

1. **Check for existing keys** (optional): [Checking for existing SSH keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/checking-for-existing-ssh-keys)

2. **Generate a key on the EC2 instance** (no passphrase if `deploy.sh` must run unattended; store the private key only on that server):

   ```bash
   ssh-keygen -t ed25519 -C "ec2-soteria-deploy" -f ~/.ssh/github_deploy_soteria_ed25519 -N ""
   ```
ssh-keygen -t ed25519 -C "ec2-soteria-deploy" -f ~/.ssh/github_deploy_soteria_rh_ed25519 -N ""
   See [Generating a new SSH key and adding it to the ssh-agent](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent).

3. **Add the public key to GitHub**: on the EC2 instance, print the **contents** of the `.pub` file (not the path, not the private key):

   ```bash
   cat ~/.ssh/github_deploy_soteria_ed25519.pub
   ```

   Copy the **one line** that starts with `ssh-ed25519` (it looks like `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... ec2-soteria-deploy`). Then: repo → **Settings** → **Deploy keys** → **Add deploy key** — Title e.g. `EC2 prod`, paste that line into **Key**. Leave **Allow write access** unchecked if you only `git pull`.

   GitHub rejects the key if you paste the file path, the private key (no `.pub`, starts with `-----BEGIN`), extra quotes/newlines, or a key already used as a personal SSH key or a deploy key on another repo (“Key is already in use”). Generate a new key pair on this instance if needed. See [Managing deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#deploy-keys).

4. **Trust `github.com` host key** (verify fingerprint against [GitHub’s SSH key fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)):

   ```bash
   ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts
   ```

5. **Clone over SSH** (replace `YOUR_ORG`):

   ```bash
   sudo mkdir -p /var/www/soteria-agents
   sudo chown -R ubuntu:ubuntu /var/www
   cd /var/www/soteria-agents
   git clone git@github.com:YOUR_ORG/soteria_agents.git .
   ```

6. **Test**: `ssh -T git@github.com` — expect “successfully authenticated” ([Testing your SSH connection](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/testing-your-ssh-connection)). If Git for Windows on the instance conflicts with Windows OpenSSH, see the “Troubleshooting SSH agent” note in GitHub’s ssh-agent doc.

7. **Deploy script**: Copy `scripts/ec2-deploy-pull.example.sh` from this repo onto the server as `deploy.sh`, set `APP_DIR` / `BRANCH` / `DEPLOY_KEY`, `chmod +x deploy.sh`. It sets `GIT_SSH_COMMAND` so non-interactive `git pull` uses the deploy key.

### Already cloned with HTTPS → switch to SSH (no re-clone)

You keep the same folder and history; only **`origin`** changes from HTTPS to SSH ([Managing remote URLs](https://docs.github.com/en/get-started/git-basics/managing-remote-repositories)).

1. **Deploy key** is already on the repo; **`known_hosts`** for GitHub:

   ```bash
   ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts
   ```

2. **(Optional) One last update over HTTPS** — from your app root (where `.git` lives), e.g. `cd /var/www/soteria-agents` or `cd /var/www/soteria-agents/soteria_agents` depending on how you cloned:

   ```bash
   cd /path/to/your/clone
   git pull origin main
   ```

   For a **private** repo, HTTPS may ask for credentials; use a [PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token) or skip this and pull once over SSH after step 3.

3. **Point `origin` at SSH** (replace `soterialabs2025` / `soteria_agents` if different):

   ```bash
   git remote set-url origin git@github.com:soterialabs2025/soteria_agents.git
   git remote -v
   ```

   You should see `git@github.com:...` for `fetch` and `push`.
   git@github.com:soterialabs2025/soteria_agents_robinhood.git

4. **Tell Git which key to use** for `github.com` (deploy keys are not the default `id_ed25519`). **Permanent setup (recommended):** edit **`~/.ssh/config`** on the EC2 instance as `ubuntu` — then plain `git pull` in **`./deploy.sh`** uses this key automatically (no `GIT_SSH_COMMAND` needed).

   ```bash
   mkdir -p ~/.ssh
   chmod 700 ~/.ssh
   nano ~/.ssh/config
   ```

   Paste (or append) this block — **indent with spaces**; paths must match your deploy key filename:

   ```text
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_deploy_soteria_ed25519
  IdentitiesOnly yes
   ```

   Save, then lock down permissions:

   ```bash
   chmod 600 ~/.ssh/config
   ```

   **One-off alternative** (no config file):  
   `GIT_SSH_COMMAND='ssh -i ~/.ssh/github_deploy_soteria_ed25519 -o IdentitiesOnly=yes' git pull origin main`

5. **Verify** from your clone directory ([Testing your SSH connection](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/testing-your-ssh-connection)):

   ```bash
   ssh -T git@github.com
   cd /path/to/your/clone
   git fetch origin
   ```

   If `ssh -T` shows success and `git fetch` works, **`./deploy.sh`** can keep using normal `git` commands; `~/.ssh/config` applies to all SSH invocations for `github.com` for that user.

---

## Step 5: Environment Variables

```bash
# Create .env
nano .env
```

Add (use your real values, never commit these):

```env
# Required
OPENAI_API_KEY=sk-proj-...
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
RPC_URL=https://base-mainnet.infura.io/v3/YOUR_INFURA_KEY

# CoinGecko (for token data)
COIN_GECKO_API_KEY=...

# Optional - for wallet
# CDP_WALLET_SECRET=...
# EOA_ADDRESS=...
# RouletteContractManager address is in app/config/demeter-config.ts, not env
```

Save and exit (Ctrl+X, Y, Enter).

---

## Step 6: Install Dependencies and Build

```bash
cd /var/www/soteria-agents

npm ci
npm run build
```

Quick manual test:

```bash
npm run start -- -p 3000
# Visit http://YOUR_EC2_IP:3000 - then Ctrl+C to stop
```

---

## Step 7: Create PM2 Ecosystem Config

Create or update `ecosystem.config.cjs` in the project root to run both Next.js and Demeter. Use `.cjs` so Node treats it as CommonJS (the project has `"type": "module"`).

```javascript
/**
 * PM2 config for EC2: Next.js web app + Demeter agent
 * Run: pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: "soteria-web",
      cwd: "/var/www/soteria-agents",
      script: "npm",
      args: "start -- -p 3000",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production", PORT: "3000" },
    },
    {
      name: "demeter",
      cwd: "/var/www/soteria-agents",
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
cd /var/www/soteria-agents

pm2 start ecosystem.config.cjs
pm2 status
pm2 save

# Make PM2 start on system boot
pm2 startup systemd -u ubuntu --hp /home/ubuntu
# Run the command it prints (usually: sudo env PATH=... pm2 startup ...)
```

Check logs:

```bash
pm2 logs soteria-web
pm2 logs demeter
```

---

## Step 9: Install and Configure Nginx

```bash
sudo apt -y install nginx
sudo systemctl enable --now nginx
```

Create site config:

```bash
sudo nano /etc/nginx/sites-available/soteria-agents
```

Copy the repo file (edit `server_name` if needed). For **Amplify + `agent.yourdomain.com` on EC2**, use only `agent.yourdomain.com` in `server_name`:

```bash
sudo cp /var/www/soteria-agents/deploy/nginx-soteria-agents.conf /etc/nginx/sites-available/soteria-agents
```

That config:

- Protects the **Agent console** with nginx Basic auth (`realm="Agent console"`, `/etc/nginx/.htpasswd`).
- Exempts **`/api/demeter/*`** from Basic auth so the Amplify dapp BFF can poll with `DEMETER_LOGS_API_KEY` only (app-layer auth).

Create Basic auth credentials once:

```bash
sudo apt -y install apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd agent_admin
```

Enable and test:

```bash
sudo ln -s /etc/nginx/sites-available/soteria-agents /etc/nginx/sites-enabled/
# Remove default if it conflicts:
# sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

---

## Step 10: Point DNS to EC2

**Amplify + EC2 subdomain (e.g. `soterialabs.io` on Amplify, agent console on EC2):**

| Host | Points to | Notes |
|------|-----------|--------|
| `soterialabs.io` / `www` | Amplify (CNAME/ALIAS per Amplify console) | Do **not** A-record apex to EC2 |
| `agent.soterialabs.io` | EC2 **Elastic IP** (A record) | Agent console only |

In Route 53 or your DNS provider: **`agent`** → **A** → Elastic IP (not the auto-assigned public IP unless you never stop/start the instance).

Verify from your laptop:

```bash
dig +short agent.soterialabs.io
# should print your Elastic IP
```

**EC2-only (no Amplify):** use A records for apex/www to the same Elastic IP instead.

---

## Step 11: Add HTTPS (Let's Encrypt)

**Subdomain on EC2** — request a cert **only** for the agent host (Amplify already has HTTPS for the main site):

```bash
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d agent.soterialabs.io --redirect -m your@email.com --agree-tos -n
```

**EC2-only** — include your apex/www domains:

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com --redirect -m your@email.com --agree-tos -n
```

Renewal is automatic. Check:

```bash
sudo systemctl status certbot.timer
```

After certbot adds HTTPS, the **`:443` server block** must duplicate the same two `location` blocks as port 80 (`/api/demeter/logs` exempt, everything else Basic auth). See `deploy/nginx-soteria-agents.conf` for the full two-block template.

---

## Demeter logs API (Amplify dapp BFF)

The Soteria dapp polls Demeter APIs server-to-server:

| Endpoint | Source |
|----------|--------|
| `GET /api/demeter/logs?stream=strategy\|pool` | JSONL audit files (strategy changes, pool value) |
| `GET /api/demeter/console-logs?channel=out\|err\|all` | PM2 `logs/demeter-out.log` + `demeter-error.log` |

nginx must **not** require Basic auth on `/api/demeter/*` (see `deploy/nginx-soteria-agents.conf`).

**EC2 `.env`** (same key as Amplify `DEMETER_LOGS_API_KEY`):

```bash
DEMETER_LOGS_API_KEY=<long-random-secret-min-16-chars>
DEMETER_LOGS_PUBLISH_DELAY_MS=5000
DEMETER_LOGS_CORS_ORIGINS=https://soterialabs.io,https://www.soterialabs.io
SOTERIA_REPO_ROOT=/var/www/soteria-agents
```

Reload after env changes:

```bash
pm2 reload soteria-web
```

**Verify on EC2** (replace `$DEMETER_LOGS_API_KEY`):

```bash
# nginx passes through — 401 JSON from app (missing key), not nginx HTML
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://agent.soterialabs.io/api/demeter/logs?stream=strategy&limit=5"

curl -sS \
  -H "Authorization: Bearer $DEMETER_LOGS_API_KEY" \
  -H "Accept: application/json" \
  "https://agent.soterialabs.io/api/demeter/logs?stream=strategy&limit=5"

# Agent console still behind Basic auth
curl -sS -o /dev/null -w "%{http_code}\n" "https://agent.soterialabs.io/"
```

Expected: first curl **401** (app JSON), second **200** + JSON, third **401** with `www-authenticate: Basic realm="Agent console"`.

If the first curl still returns nginx HTML `401 Authorization Required`, the **`:443` block** is missing the logs exemption — edit `/etc/nginx/sites-available/soteria-agents` and add `location = /api/demeter/logs { auth_basic off; ... }` above `location /` in the `listen 443 ssl` server.

**Optional rate limit** — in `/etc/nginx/nginx.conf` inside `http { }`:

```nginx
limit_req_zone $binary_remote_addr zone=demeter_logs:10m rate=30r/m;
```

Then uncomment `limit_req` in the `location = /api/demeter/logs` block.

---

## Step 12: Verify

1. Visit `https://agent.soterialabs.io` (or your host) – chat UI should load.
2. Send a message – agent should respond.
3. Check PM2: `pm2 status` – both `soteria-web` and `demeter` should be `online`.
4. Optional: in chat, say "start demeter" – loops will run in the background (they also run via the PM2 `demeter` process if started at boot).

---

## Deployment Script (Updates)

Create `/var/www/soteria-agents/deploy.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
APP_DIR="/var/www/soteria-agents"
cd "$APP_DIR"
git fetch --all
git reset --hard origin/main
npm ci
npm run build
pm2 reload soteria-web
pm2 reload demeter
echo "Deploy complete."
```

```bash
chmod +x /var/www/soteria-agents/deploy.sh
```

To deploy updates:

```bash
/var/www/soteria-agents/deploy.sh
```

---

## Useful Commands

| Task | Command |
|------|---------|
| View logs | `pm2 logs` or `pm2 logs demeter` |
| Restart web | `pm2 restart soteria-web` |
| Restart Demeter | `pm2 restart demeter` |
| Status | `pm2 status` |
| Monitor | `pm2 monit` |
| Stop all | `pm2 stop all` |

---

## Troubleshooting

| Issue | Check |
|-------|-------|
| 502 Bad Gateway | `pm2 status`, `pm2 logs soteria-web` – ensure app is running on 3000 |
| Chat fails / "Y is not a function" | Full Node runtime on EC2 avoids serverless bundling issues |
| Demeter not running | `pm2 logs demeter` – check RPC_URL, CDP keys, OPENAI_API_KEY |
| Out of memory | Use t3.medium or increase `max_memory_restart` in ecosystem config |
| Build fails | `sudo apt -y install build-essential` then `npm run build` |

---

## Security Notes

- Keep `.env` out of git; store secrets in AWS Secrets Manager or Parameter Store if preferred
- Restrict SSH (port 22) to your IP in the security group
- Use `sudo apt update && sudo apt upgrade` regularly
- Consider AWS WAF or CloudFlare for DDoS protection
