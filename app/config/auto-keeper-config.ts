/**
 * AutoKeeper shared settings (intervals, gas, harvest flags).
 * Per-DEX RH keepers (Uni V3 / Uni V4 / Sushi V3) live in {@link rh-keeper-pipelines}.
 * Operator wallets: up to 4 keys via {@link resolveRhOperatorWallets}.
 * Legacy getters below default to AutoKeeperRhV3 (docs/ADDRESSES.md).
 */

import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { envAddress } from "./env-address";
import {
  DEFAULT_OPERATOR_REGISTRY_ADDRESS,
  DEMETER_TWO_WALLET_ADDRESS,
  getOperatorRegistryAddress,
} from "./operator-registry-config";

/** AutoOperatorRegistry on Robinhood Chain. Prefer {@link getOperatorRegistryAddress}. */
export const AUTO_OPERATOR_REGISTRY_ADDRESS = DEFAULT_OPERATOR_REGISTRY_ADDRESS;

/** AutoFactoryRhV3 on Robinhood Chain (legacy alias). */
export const AUTO_FACTORY_V3_RH_ADDRESS =
  "0xB3E65742e90af23f30527A9745B63F90DAA48B78" as const;

/** AutoSwapRouterRhV3 on Robinhood Chain (legacy alias). */
export const AUTO_SWAP_ROUTER_V3_RH_ADDRESS =
  "0x8A8c18445792e04e8512D5c6CD680331F9575a3F" as const;

/** AutoKeeperRhV3 on Robinhood Chain (legacy alias). */
export const AUTO_KEEPER_V3_RH_ADDRESS =
  "0xD35CE6610AcB37D545bb5ec4192fC50505Dd26Ad" as const;

/** AutoKeeperV3Rh: env `AUTO_KEEPER_ADDRESS` or {@link AUTO_KEEPER_V3_RH_ADDRESS}. */
export function getAutoKeeperAddress(): Address {
  return envAddress("AUTO_KEEPER_ADDRESS") ?? AUTO_KEEPER_V3_RH_ADDRESS;
}

/** AutoFactoryV3Rh: env `AUTO_FACTORY_ADDRESS` or {@link AUTO_FACTORY_V3_RH_ADDRESS}. */
export function getAutoFactoryAddress(): Address {
  return envAddress("AUTO_FACTORY_ADDRESS") ?? AUTO_FACTORY_V3_RH_ADDRESS;
}

/** AutoOperatorRegistry: `OPERATOR_REGISTRY_ADDRESS` / `AUTO_OPERATOR_REGISTRY_ADDRESS` or default. */
export function getAutoOperatorRegistryAddress(): Address {
  return getOperatorRegistryAddress();
}

/** AutoSwapRouterV3Rh: env `AUTO_SWAP_ROUTER_ADDRESS` or {@link AUTO_SWAP_ROUTER_V3_RH_ADDRESS}. */
export function getAutoSwapRouterAddress(): Address {
  return envAddress("AUTO_SWAP_ROUTER_ADDRESS") ?? AUTO_SWAP_ROUTER_V3_RH_ADDRESS;
}

export async function resolveAutoKeeperAddress(_rpcUrl?: string): Promise<Address> {
  return getAutoKeeperAddress();
}

export async function resolveAutoFactoryAddress(_rpcUrl?: string): Promise<Address> {
  return getAutoFactoryAddress();
}

/** performUpkeepBatch cadence. Override: `AUTO_KEEPER_UPKEEP_INTERVAL_MS`. */
export const DEFAULT_AUTO_KEEPER_UPKEEP_INTERVAL_MS = 60 * 1000; // 1 min

/** performHarvestBatch cadence. Override: `AUTO_KEEPER_HARVEST_INTERVAL_MS`. */
export const DEFAULT_AUTO_KEEPER_HARVEST_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Max projected send gas per performUpkeepBatch chunk. Override: `AUTO_KEEPER_UPKEEP_BATCH_MAX_GAS`. */
export const DEFAULT_AUTO_KEEPER_UPKEEP_BATCH_MAX_GAS = 2_000_000n;

/** Max projected send gas per performHarvestBatch chunk. Override: `AUTO_KEEPER_HARVEST_BATCH_MAX_GAS`. */
export const DEFAULT_AUTO_KEEPER_HARVEST_BATCH_MAX_GAS = 25_000_000n;

function envFlagTrue(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function envFlagFalse(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "false" || raw === "0" || raw === "no";
}

function parseGasEnv(name: string): bigint | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  try {
    const n = BigInt(raw);
    if (n > 0n) return n;
  } catch {
    /* ignore */
  }
  return undefined;
}

function parseIntervalMs(name: string, fallback: number, minMs: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < minMs) return fallback;
  return Math.floor(n);
}

function normalizePrivateKey(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

/**
 * Operator key for AutoKeeper `onlyOperator` txs — `DEMETER_TWO_PRIVATE_KEY` only.
 * Must derive {@link DEMETER_TWO_WALLET_ADDRESS}.
 */
export function getAutoKeeperPrivateKey(): string | null {
  const pk = process.env.DEMETER_TWO_PRIVATE_KEY?.trim();
  if (!pk) return null;
  const account = privateKeyToAccount(normalizePrivateKey(pk));
  const expected = DEMETER_TWO_WALLET_ADDRESS.toLowerCase();
  if (account.address.toLowerCase() !== expected) {
    throw new Error(
      `DEMETER_TWO_PRIVATE_KEY derives ${account.address} but expected ${DEMETER_TWO_WALLET_ADDRESS} (AutoKeeper)`
    );
  }
  return pk;
}

/**
 * When true, Demeter runs AutoKeeper upkeep + harvest on all enabled RH pipelines
 * (Uni V3, Uni V4, Sushi V3). Default off.
 * Set `AUTO_KEEPER_ENABLED=true` and at least one of DEMETER_PRIVATE_KEY,
 * DEMETER_TWO_PRIVATE_KEY, TRITON_PRIVATE_KEY, TRITON_TWO_PRIVATE_KEY.
 */
export function isAutoKeeperEnabled(): boolean {
  if (envFlagFalse("AUTO_KEEPER_ENABLED")) return false;
  if (!envFlagTrue("AUTO_KEEPER_ENABLED")) return false;
  return Boolean(
    process.env.DEMETER_PRIVATE_KEY?.trim() ||
      process.env.DEMETER_TWO_PRIVATE_KEY?.trim() ||
      process.env.TRITON_PRIVATE_KEY?.trim() ||
      process.env.TRITON_TWO_PRIVATE_KEY?.trim()
  );
}

export function getAutoKeeperUpkeepIntervalMs(): number {
  return parseIntervalMs(
    "AUTO_KEEPER_UPKEEP_INTERVAL_MS",
    DEFAULT_AUTO_KEEPER_UPKEEP_INTERVAL_MS,
    30_000
  );
}

export function getAutoKeeperHarvestIntervalMs(): number {
  return parseIntervalMs(
    "AUTO_KEEPER_HARVEST_INTERVAL_MS",
    DEFAULT_AUTO_KEEPER_HARVEST_INTERVAL_MS,
    60_000
  );
}

/**
 * `performHarvestBatch(..., skipIncreaseLiquidity)`.
 * Default false (compound). Override: `AUTO_KEEPER_HARVEST_SKIP_INCREASE_LIQUIDITY=true`.
 */
export function getAutoKeeperHarvestSkipIncreaseLiquidity(): boolean {
  if (envFlagTrue("AUTO_KEEPER_HARVEST_SKIP_INCREASE_LIQUIDITY")) return true;
  if (envFlagFalse("AUTO_KEEPER_HARVEST_SKIP_INCREASE_LIQUIDITY")) return false;
  return false;
}

/**
 * Optional allowlist of watched[] ids (comma-separated). Empty = all active.
 * Env: `AUTO_KEEPER_STRATEGY_IDS=0,1,2`
 */
export function getAutoKeeperStrategyIdAllowlist(): number[] | null {
  const raw = process.env.AUTO_KEEPER_STRATEGY_IDS?.trim();
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0);
  return ids.length > 0 ? [...new Set(ids)] : null;
}

export function getAutoKeeperUpkeepBatchMaxGas(): bigint {
  return (
    parseGasEnv("AUTO_KEEPER_UPKEEP_BATCH_MAX_GAS") ??
    parseGasEnv("AUTO_KEEPER_BATCH_MAX_GAS") ??
    DEFAULT_AUTO_KEEPER_UPKEEP_BATCH_MAX_GAS
  );
}

export function getAutoKeeperHarvestBatchMaxGas(): bigint {
  return (
    parseGasEnv("AUTO_KEEPER_HARVEST_BATCH_MAX_GAS") ??
    parseGasEnv("AUTO_KEEPER_BATCH_MAX_GAS") ??
    DEFAULT_AUTO_KEEPER_HARVEST_BATCH_MAX_GAS
  );
}

export function getAutoKeeperBatchMaxGas(
  functionName: "performUpkeepBatch" | "performHarvestBatch"
): bigint {
  return functionName === "performUpkeepBatch"
    ? getAutoKeeperUpkeepBatchMaxGas()
    : getAutoKeeperHarvestBatchMaxGas();
}
