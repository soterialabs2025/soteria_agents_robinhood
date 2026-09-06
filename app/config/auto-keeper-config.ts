/**
 * AutoKeeper shared settings (intervals, gas, harvest flags).
 * Per-DEX RH keepers (Uni V3 / Uni V4 / Sushi V3) live in {@link rh-keeper-pipelines}.
 * Operator wallets: up to 4 keys via {@link resolveRhOperatorWallets}.
 * Legacy getters below default to AutoKeeperRhV3 (docs/ADDRESSES.md).
 */

import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { envAddress, pickAddr } from "./env-address";
import {
  DEFAULT_OPERATOR_REGISTRY_ADDRESS,
  DEMETER_TWO_WALLET_ADDRESS,
  getOperatorRegistryAddress,
} from "./operator-registry-config";

/** RH AutoVault package Owner / Deployer (`docs/ADDRESSES.md`). Override: `AUTO_BAND_OWNER_ADDRESS`. */
export const RH_DEPLOYER_WALLET_ADDRESS =
  "0xf99faA74aF8cb06479bFCb62495F0404089EDc83" as const;

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

/** performHarvestBatch cadence when adaptive harvest is off / force-pinned. */
export const DEFAULT_AUTO_KEEPER_HARVEST_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

/** Max projected send gas per performUpkeepBatch chunk. Override: `AUTO_KEEPER_UPKEEP_BATCH_MAX_GAS`. */
export const DEFAULT_AUTO_KEEPER_UPKEEP_BATCH_MAX_GAS = 2_000_000n;

/** Max projected send gas per performHarvestBatch chunk. Override: `AUTO_KEEPER_HARVEST_BATCH_MAX_GAS`. */
export const DEFAULT_AUTO_KEEPER_HARVEST_BATCH_MAX_GAS = 25_000_000n;

/** refreshPriceRefBatch cadence (RhV4). Floor matches on-chain minRefUpdateInterval = 10 min. */
export const DEFAULT_AUTO_KEEPER_PRICE_REF_INTERVAL_MS = 10 * 60 * 1000;

/** Max projected send gas per refreshPriceRefBatch chunk. Override: `AUTO_KEEPER_PRICE_REF_BATCH_MAX_GAS`. */
export const DEFAULT_AUTO_KEEPER_PRICE_REF_BATCH_MAX_GAS = 2_000_000n;

/** How often the harvest loop wakes to re-check per-strategy due (adaptive mode). */
export const DEFAULT_AUTO_ADAPTIVE_HARVEST_POLL_MS = 60 * 60 * 1000; // 1 h

/** TVL → harvest interval tiers (WETH poolValue). */
export const DEFAULT_AUTO_HARVEST_TVL_DUST_ETH = 0.05;
export const DEFAULT_AUTO_HARVEST_TVL_SMALL_ETH = 0.25;
export const DEFAULT_AUTO_HARVEST_TVL_MED_ETH = 1.0;
export const DEFAULT_AUTO_HARVEST_INTERVAL_DUST_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_AUTO_HARVEST_INTERVAL_SMALL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AUTO_HARVEST_INTERVAL_MED_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_AUTO_HARVEST_INTERVAL_LARGE_MS = 6 * 60 * 60 * 1000;

/** Band controller loop wake. Override: `AUTO_BAND_LOOP_INTERVAL_MS`. */
export const DEFAULT_AUTO_BAND_LOOP_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_AUTO_BAND_WIDEN_REMINTS = 3;
export const DEFAULT_AUTO_BAND_WIDEN_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_AUTO_BAND_OUTER_TICKS = 800;
export const DEFAULT_AUTO_BAND_INNER_TICKS = 600;
export const DEFAULT_AUTO_BAND_TICK_SPACING = 200;

/** Adaptive targetAssetBps (Owner). Three stacks: 3000 / 5000 / 7000. */
export const DEFAULT_AUTO_TARGET_BASE_BPS = 5000;
export const DEFAULT_AUTO_TARGET_STEP_BPS = 2000;
export const DEFAULT_AUTO_TARGET_MIN_BPS = 3000;
export const DEFAULT_AUTO_TARGET_MAX_BPS = 7000;
export const DEFAULT_AUTO_TARGET_DEADBAND_BPS = 1200;
/** Ignore leftover smaller than ~0.001 ETH when measuring mix. */
export const DEFAULT_AUTO_TARGET_MIN_IDLE_WEI = 10n ** 15n;

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

function parseEthToWei(name: string, fallbackEth: number): bigint {
  const raw = process.env[name]?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      return BigInt(Math.floor(n * 1e18));
    }
  }
  return BigInt(Math.floor(fallbackEth * 1e18));
}

function normalizePrivateKey(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function isPrivateKeyHex(raw: string): boolean {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return /^[a-fA-F0-9]{64}$/.test(hex);
}

function autoBandOwnerKeyRaw(): string | null {
  const fromAddressVar = process.env.AUTO_BAND_OWNER_ADDRESS?.trim();
  if (fromAddressVar && isPrivateKeyHex(fromAddressVar)) return fromAddressVar;
  return (
    process.env.RH_DEPLOYER_KEY?.trim() ||
    process.env.AUTO_BAND_OWNER_KEY?.trim() ||
    process.env.BASE_DEPLOYER_KEY?.trim() ||
    process.env.BASE_DEPOLYER_KEY?.trim() ||
    null
  );
}

/**
 * Package Owner key for `setBandParams`.
 * Prefer `AUTO_BAND_OWNER_ADDRESS` as a 32-byte key (`0x` OK). Also accepts
 * `RH_DEPLOYER_KEY` / `AUTO_BAND_OWNER_KEY` / `BASE_DEPLOYER_KEY`.
 */
export function getAutoBandOwnerPrivateKey(): string | null {
  const pk = autoBandOwnerKeyRaw();
  if (!pk) return null;
  const account = privateKeyToAccount(normalizePrivateKey(pk));
  const expectedAddr = envAddress("AUTO_BAND_OWNER_ADDRESS");
  if (expectedAddr && account.address.toLowerCase() !== expectedAddr.toLowerCase()) {
    throw new Error(
      `Owner key derives ${account.address} but AUTO_BAND_OWNER_ADDRESS is ${expectedAddr} (Auto band)`
    );
  }
  return pk;
}

/**
 * Owner EOA used for `owner()` gates.
 * Prefer the address derived from the configured Owner key so the gate and the
 * signer cannot diverge (hardcoded deployer + operator key would revert onlyOwner).
 */
export function getAutoBandOwnerAddress(): Address {
  const pk = autoBandOwnerKeyRaw();
  if (pk) {
    return privateKeyToAccount(normalizePrivateKey(pk)).address;
  }
  return pickAddr("AUTO_BAND_OWNER_ADDRESS", RH_DEPLOYER_WALLET_ADDRESS);
}

/**
 * Owner signer for `setBandParams` / `setTargetAssetBps`.
 * Refuses to return a key that is not `strategy.owner()`.
 */
export function requireAutoBandOwnerSigner(onChainOwner: Address): {
  privateKey: string;
  address: Address;
} {
  const pk = getAutoBandOwnerPrivateKey();
  if (!pk) {
    throw new Error(
      "Owner key missing for Owner-only tx (AUTO_BAND_OWNER_ADDRESS as 32-byte key, or RH_DEPLOYER_KEY / AUTO_BAND_OWNER_KEY)"
    );
  }
  const address = privateKeyToAccount(normalizePrivateKey(pk)).address;
  if (address.toLowerCase() !== onChainOwner.toLowerCase()) {
    throw new Error(
      `Owner signer ${address} ≠ strategy.owner() ${onChainOwner} — not sending onlyOwner tx`
    );
  }
  return { privateKey: pk, address };
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

/** True when ops pinned a single harvest interval via env. */
export function isAutoKeeperHarvestIntervalForced(): boolean {
  const raw = process.env.AUTO_KEEPER_HARVEST_INTERVAL_MS?.trim();
  if (!raw) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 60_000;
}

/**
 * Per-strategy TVL harvest tiers. Default on.
 * Off: `AUTO_ADAPTIVE_HARVEST=false`. Forced off when harvest interval env is set.
 */
export function isAutoAdaptiveHarvestEnabled(): boolean {
  if (isAutoKeeperHarvestIntervalForced()) return false;
  if (envFlagFalse("AUTO_ADAPTIVE_HARVEST")) return false;
  if (envFlagTrue("AUTO_ADAPTIVE_HARVEST")) return true;
  return true;
}

/**
 * Owner-only ±1 tickSpacing band loop. Default on when an Owner key is set.
 * Off: `AUTO_ADAPTIVE_BAND=false`.
 */
export function isAutoAdaptiveBandEnabled(): boolean {
  if (envFlagFalse("AUTO_ADAPTIVE_BAND")) return false;
  if (!autoBandOwnerKeyRaw()) return false;
  if (envFlagTrue("AUTO_ADAPTIVE_BAND")) return true;
  return true;
}

/**
 * Owner-only targetAssetBps stepper (3000 / 5000 / 7000). Default on when an Owner key is set.
 * Off: `AUTO_ADAPTIVE_TARGET=false`. Same key as bands.
 */
export function isAutoAdaptiveTargetEnabled(): boolean {
  if (envFlagFalse("AUTO_ADAPTIVE_TARGET")) return false;
  if (!autoBandOwnerKeyRaw()) return false;
  if (envFlagTrue("AUTO_ADAPTIVE_TARGET")) return true;
  return true;
}

function parseBpsEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min && n <= max) return Math.floor(n);
  }
  return fallback;
}

function parseWeiEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    const n = BigInt(raw);
    if (n >= 0n) return n;
  } catch {
    /* ignore */
  }
  return fallback;
}

export type AutoTargetBpsConfig = {
  baseBps: number;
  stepBps: number;
  minBps: number;
  maxBps: number;
  deadbandBps: number;
  minIdleWei: bigint;
};

export function getAutoTargetBpsConfig(): AutoTargetBpsConfig {
  const baseBps = parseBpsEnv("AUTO_TARGET_BASE_BPS", DEFAULT_AUTO_TARGET_BASE_BPS, 1, 10_000);
  const stepBps = parseBpsEnv("AUTO_TARGET_STEP_BPS", DEFAULT_AUTO_TARGET_STEP_BPS, 1, 10_000);
  const minBps = parseBpsEnv("AUTO_TARGET_MIN_BPS", DEFAULT_AUTO_TARGET_MIN_BPS, 0, 10_000);
  const maxBps = parseBpsEnv("AUTO_TARGET_MAX_BPS", DEFAULT_AUTO_TARGET_MAX_BPS, 0, 20_000);
  return {
    baseBps,
    stepBps,
    minBps: Math.min(minBps, baseBps),
    maxBps: Math.max(maxBps, baseBps),
    deadbandBps: parseBpsEnv(
      "AUTO_TARGET_DEADBAND_BPS",
      DEFAULT_AUTO_TARGET_DEADBAND_BPS,
      0,
      10_000
    ),
    minIdleWei: parseWeiEnv("AUTO_TARGET_MIN_IDLE_WEI", DEFAULT_AUTO_TARGET_MIN_IDLE_WEI),
  };
}

/** Harvest dust TVL (WETH wei). Target writes skip at or below this. */
export function getAutoHarvestDustTvlWei(): bigint {
  return parseEthToWei("AUTO_HARVEST_TVL_DUST_ETH", DEFAULT_AUTO_HARVEST_TVL_DUST_ETH);
}

/**
 * Truncated price-ref refresh cadence (RhV4 `refreshPriceRefBatch`).
 * Independent of remint upkeep. Floor 10 min (`minRefUpdateInterval`).
 */
export function getAutoKeeperPriceRefIntervalMs(): number {
  return parseIntervalMs(
    "AUTO_KEEPER_PRICE_REF_INTERVAL_MS",
    DEFAULT_AUTO_KEEPER_PRICE_REF_INTERVAL_MS,
    DEFAULT_AUTO_KEEPER_PRICE_REF_INTERVAL_MS
  );
}

/**
 * Price-ref loop. Default on for keepers that expose `refreshPriceRefBatch`.
 * Off: `AUTO_KEEPER_PRICE_REF_ENABLED=false`.
 */
export function isAutoKeeperPriceRefEnabled(): boolean {
  if (envFlagFalse("AUTO_KEEPER_PRICE_REF_ENABLED")) return false;
  if (envFlagTrue("AUTO_KEEPER_PRICE_REF_ENABLED")) return true;
  return true;
}

export function getAutoAdaptiveHarvestPollMs(): number {
  return parseIntervalMs(
    "AUTO_ADAPTIVE_HARVEST_POLL_MS",
    DEFAULT_AUTO_ADAPTIVE_HARVEST_POLL_MS,
    60_000
  );
}

export function getAutoBandLoopIntervalMs(): number {
  return parseIntervalMs(
    "AUTO_BAND_LOOP_INTERVAL_MS",
    DEFAULT_AUTO_BAND_LOOP_INTERVAL_MS,
    60_000
  );
}

export function getAutoBandWidenRemints(): number {
  const raw = process.env.AUTO_BAND_WIDEN_REMINTS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return DEFAULT_AUTO_BAND_WIDEN_REMINTS;
}

export function getAutoBandWidenWindowMs(): number {
  return parseIntervalMs(
    "AUTO_BAND_WIDEN_WINDOW_MS",
    DEFAULT_AUTO_BAND_WIDEN_WINDOW_MS,
    60_000
  );
}

/**
 * Map strategy `poolValue` (WETH wei) → harvest interval ms.
 * Dust <0.05 ETH → 48h; small <0.25 → 24h; med <1 → 12h; else 6h.
 */
export function getAutoHarvestIntervalMsForTvlWei(tvlWei: bigint): number {
  if (isAutoKeeperHarvestIntervalForced() || !isAutoAdaptiveHarvestEnabled()) {
    return getAutoKeeperHarvestIntervalMs();
  }

  const dust = parseEthToWei("AUTO_HARVEST_TVL_DUST_ETH", DEFAULT_AUTO_HARVEST_TVL_DUST_ETH);
  const small = parseEthToWei("AUTO_HARVEST_TVL_SMALL_ETH", DEFAULT_AUTO_HARVEST_TVL_SMALL_ETH);
  const med = parseEthToWei("AUTO_HARVEST_TVL_MED_ETH", DEFAULT_AUTO_HARVEST_TVL_MED_ETH);

  if (tvlWei < dust) {
    return parseIntervalMs(
      "AUTO_HARVEST_INTERVAL_DUST_MS",
      DEFAULT_AUTO_HARVEST_INTERVAL_DUST_MS,
      60_000
    );
  }
  if (tvlWei < small) {
    return parseIntervalMs(
      "AUTO_HARVEST_INTERVAL_SMALL_MS",
      DEFAULT_AUTO_HARVEST_INTERVAL_SMALL_MS,
      60_000
    );
  }
  if (tvlWei < med) {
    return parseIntervalMs(
      "AUTO_HARVEST_INTERVAL_MED_MS",
      DEFAULT_AUTO_HARVEST_INTERVAL_MED_MS,
      60_000
    );
  }
  return parseIntervalMs(
    "AUTO_HARVEST_INTERVAL_LARGE_MS",
    DEFAULT_AUTO_HARVEST_INTERVAL_LARGE_MS,
    60_000
  );
}

/** Harvest loop sleep: adaptive poll when tiers on; else full fixed interval. */
export function getAutoKeeperHarvestLoopSleepMs(): number {
  if (isAutoAdaptiveHarvestEnabled()) return getAutoAdaptiveHarvestPollMs();
  return getAutoKeeperHarvestIntervalMs();
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

export function getAutoKeeperPriceRefBatchMaxGas(): bigint {
  return (
    parseGasEnv("AUTO_KEEPER_PRICE_REF_BATCH_MAX_GAS") ??
    parseGasEnv("AUTO_KEEPER_BATCH_MAX_GAS") ??
    DEFAULT_AUTO_KEEPER_PRICE_REF_BATCH_MAX_GAS
  );
}

export type AutoKeeperBatchFnName =
  | "performUpkeepBatch"
  | "performHarvestBatch"
  | "refreshPriceRefBatch";

export function getAutoKeeperBatchMaxGas(functionName: AutoKeeperBatchFnName): bigint {
  if (functionName === "performUpkeepBatch") return getAutoKeeperUpkeepBatchMaxGas();
  if (functionName === "refreshPriceRefBatch") return getAutoKeeperPriceRefBatchMaxGas();
  return getAutoKeeperHarvestBatchMaxGas();
}
