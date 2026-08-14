/**
 * Gate continuous Demeter / keeper / Triton loops so local dev does not compete with production EC2.
 *
 * Priority:
 * 1. `DEMETER_LOOPS_ENABLED=true|false` (explicit)
 * 2. `DEMETER_LOOPS_DISABLED=true` → off
 * 3. Default: off when `NODE_ENV=development`, on otherwise
 *
 * One-shot tools (`demeter_runCycle`, CoinGecko scripts) are not gated here.
 */

import dotenv from "dotenv";
import path from "path";

import { getSoteriaRepoRoot } from "./soteria-runtime-paths";

let envLoaded = false;

/** Load `.env` from repo root (or `DEMETER_ENV_FILE`), then `.env.local`. Safe to call multiple times. */
export function loadDemeterEnv(): void {
  if (envLoaded) return;
  const root = getSoteriaRepoRoot();
  const explicit = process.env.DEMETER_ENV_FILE?.trim();
  if (explicit) {
    // `.env` is source of truth on EC2 (PM2 may retain a stale COIN_GECKO_API_KEY until override).
    dotenv.config({ path: path.resolve(explicit), override: true });
  } else {
    dotenv.config({ path: path.join(root, ".env") });
  }
  dotenv.config({ path: path.join(root, ".env.local"), override: true });
  envLoaded = true;
}

function parseEnvBool(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

export function areDemeterLoopsEnabled(): boolean {
  loadDemeterEnv();
  const explicit = parseEnvBool(process.env.DEMETER_LOOPS_ENABLED);
  if (explicit !== undefined) return explicit;
  if (parseEnvBool(process.env.DEMETER_LOOPS_DISABLED) === true) return false;
  return process.env.NODE_ENV !== "development";
}

export function demeterLoopsDisabledMessage(): string {
  const nodeEnv = process.env.NODE_ENV ?? "(unset)";
  const explicit = process.env.DEMETER_LOOPS_ENABLED?.trim();
  return (
    "Continuous Demeter loops are disabled on this machine. " +
    "Production EC2 should run `npm run demeter` (PM2). " +
    `NODE_ENV=${nodeEnv}` +
    (explicit ? `, DEMETER_LOOPS_ENABLED=${explicit}` : " (default off in development)") +
    ". Set DEMETER_LOOPS_ENABLED=true in .env only if you intentionally want local loops."
  );
  
}
