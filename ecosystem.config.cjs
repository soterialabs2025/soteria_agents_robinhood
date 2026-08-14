/**
 * PM2 Ecosystem Configuration for Demeter Agent
 *
 * Run: pm2 start ecosystem.config.cjs
 * Monitor: pm2 logs soteria-web | pm2 logs demeter
 * Stop: pm2 stop soteria-web | pm2 stop demeter
 *
 * EC2: open SG port 3000 (or nginx → 3000). Build first: npm run build
 *
 * Uses tsx via Node (not `npm run`) for a stable script path on Windows and Linux.
 */
const path = require("path");

const repoRoot = __dirname;
const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");

module.exports = {
  apps: [
    {
      name: "soteria-web",
      cwd: repoRoot,
      /** Direct `next start` — PM2 + `script: npm` often stays "online" without binding port 3000. */
      script: nextBin,
      args: "start -p 3000 -H 0.0.0.0",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "512M",
      env_file: path.join(repoRoot, ".env"),
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        HOSTNAME: "0.0.0.0",
        SOTERIA_REPO_ROOT: repoRoot,
        DEMETER_ENV_FILE: path.join(repoRoot, ".env"),
        /** Local viem signing — do not use CDP for keeper/upkeep txs on EC2. */
        EVM_WALLET_SIGNER: "viem",
      },
      error_file: path.join(repoRoot, "logs", "soteria-web-error.log"),
      out_file: path.join(repoRoot, "logs", "soteria-web-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 4000,
    },
    {
      name: "demeter",
      cwd: repoRoot,
      script: path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      args: "app/services/demeter-agent.ts",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "1G",
      env_file: path.join(repoRoot, ".env"),
      env: {
        NODE_ENV: "production",
        FORCE_COLOR: "0",
        SOTERIA_REPO_ROOT: repoRoot,
        DEMETER_ENV_FILE: path.join(repoRoot, ".env"),
        /** Demeter loops sign with DEMETER_PRIVATE_KEY via viem, not CDP. */
        EVM_WALLET_SIGNER: "viem",
      },
      error_file: path.join(repoRoot, "logs", "demeter-error.log"),
      out_file: path.join(repoRoot, "logs", "demeter-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 4000,
    },
  ],
};
