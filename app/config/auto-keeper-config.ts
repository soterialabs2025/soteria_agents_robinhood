/**
 * AutoKeeper V3 RH (AutoVault liquidity manager) — upkeep + harvest only.
 * Canonical Robinhood deployments below; env overrides: AUTO_KEEPER_ADDRESS,
 * AUTO_FACTORY_ADDRESS, AUTO_OPERATOR_REGISTRY_ADDRESS, AUTO_SWAP_ROUTER_ADDRESS.
 * Operator allowlist: AutoKeeper.operatorRegistry via `DEMETER_TWO_PRIVATE_KEY`.
 */

import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { DEMETER_TWO_WALLET_ADDRESS } from "./operator-registry-config";

/** AutoOperatorRegistry on Robinhood Chain. */
export const AUTO_OPERATOR_REGISTRY_ADDRESS =
  "0x7df1120a04D82eA92EA2d5AA005e3316B37b936E" as const;

/** AutoFactoryV3Rh on Robinhood Chain. */
export const AUTO_FACTORY_V3_RH_ADDRESS =
  "0xeCad673d6B338D9b530401105332FFD55D35696F" as const;

/** AutoSwapRouterV3Rh on Robinhood Chain. */
export const AUTO_SWAP_ROUTER_V3_RH_ADDRESS =
  "0xB76cdfF814220334Bb46C247F5D7f5d6bE7c8d3B" as const;

/** AutoKeeperV3Rh on Robinhood Chain. */
export const AUTO_KEEPER_V3_RH_ADDRESS =
  "0x6ef6afF9Dc71202252B9A0c95E1193aD7D1e5795" as const;

function envAddress(name: string): Address | null {
  const raw = process.env[name]?.trim();
  if (raw && /^0x[a-fA-F0-9]{40}$/.test(raw)) return raw as Address;
  return null;
}

/** AutoKeeperV3Rh: env `AUTO_KEEPER_ADDRESS` or {@link AUTO_KEEPER_V3_RH_ADDRESS}. */
export function getAutoKeeperAddress(): Address {
  return envAddress("AUTO_KEEPER_ADDRESS") ?? AUTO_KEEPER_V3_RH_ADDRESS;
}

/** AutoFactoryV3Rh: env `AUTO_FACTORY_ADDRESS` or {@link AUTO_FACTORY_V3_RH_ADDRESS}. */
export function getAutoFactoryAddress(): Address {
  return envAddress("AUTO_FACTORY_ADDRESS") ?? AUTO_FACTORY_V3_RH_ADDRESS;
}

/** AutoOperatorRegistry: env `AUTO_OPERATOR_REGISTRY_ADDRESS` or {@link AUTO_OPERATOR_REGISTRY_ADDRESS}. */
export function getAutoOperatorRegistryAddress(): Address {
  return envAddress("AUTO_OPERATOR_REGISTRY_ADDRESS") ?? AUTO_OPERATOR_REGISTRY_ADDRESS;
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
export const DEFAULT_AUTO_KEEPER_UPKEEP_INTERVAL_MS = 90 * 1000; // 1 min 30 s

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
 * When true, Demeter runs AutoKeeper upkeep + harvest loops.
 * Default off. Set `AUTO_KEEPER_ENABLED=true` and `DEMETER_TWO_PRIVATE_KEY`.
 */
export function isAutoKeeperEnabled(): boolean {
  if (envFlagFalse("AUTO_KEEPER_ENABLED")) return false;
  if (!envFlagTrue("AUTO_KEEPER_ENABLED")) return false;
  return Boolean(process.env.DEMETER_TWO_PRIVATE_KEY?.trim());
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
