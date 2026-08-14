#!/usr/bin/env bash
# Example EC2 deploy: git pull over SSH for a private GitHub repo.
#
# 1) On the server, generate a deploy key (no passphrase recommended for unattended pulls):
#      ssh-keygen -t ed25519 -C "ec2-deploy-soteria" -f ~/.ssh/github_deploy_soteria_ed25519 -N ""
# 2) Add the **public** key in GitHub → repo → Settings → Deploy keys → Add deploy key
#      (read-only is enough for pull-only deploys). See:
#      https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#deploy-keys
# 3) Trust github.com host key once (verify fingerprint per GitHub docs):
#      ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts
# 4) Copy this file to the server as e.g. ~/deploy.sh, chmod +x, edit APP_DIR / BRANCH / KEY.
#
# Optional: ~/.ssh/config instead of GIT_SSH_COMMAND:
#   Host github.com
#     IdentityFile ~/.ssh/github_deploy_soteria_ed25519
#     IdentitiesOnly yes
#
# GitHub remotes: https://docs.github.com/en/get-started/git-basics/about-remote-repositories

set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/soteria-agents}"
BRANCH="${BRANCH:-main}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/github_deploy_soteria_ed25519}"

if [[ ! -f "$DEPLOY_KEY" ]]; then
  echo "Missing deploy private key: $DEPLOY_KEY" >&2
  exit 1
fi

export GIT_SSH_COMMAND="ssh -i ${DEPLOY_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"

cd "$APP_DIR"

# Ensure origin uses SSH (not HTTPS) — run once if you cloned with HTTPS:
#   git remote set-url origin git@github.com:OWNER/soteria_agents.git
git fetch origin
git checkout "$BRANCH"
git pull --ff-only "origin" "$BRANCH"

npm ci
npm run build

# PM2: adjust if your ecosystem file lives elsewhere
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart ecosystem.config.cjs --update-env || pm2 start ecosystem.config.cjs
fi

echo "Deploy finished."
