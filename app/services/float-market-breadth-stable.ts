import type { EvmWalletProvider } from "@coinbase/agentkit";
import type { Address } from "viem";

import {
  getFloatAssetAddress,
  sendChangeStrategyAsset,
  sendExitStrategyToStable,
  type FloatManagerStrategyKey,
} from "../action-providers/float-action-provider";
import { getStrategyMode } from "../action-providers/keeper-strategy-action-provider";
import type { FloatKeeperPipeline } from "../config/float-keeper-pipeline";
import {
  FLOAT_STRATEGY_STABLE_MODE,
  isStableUsdcTokenAddress,
  STABLE_USDC_WETH_PAIR,
  STABLE_V4_WETH_ADDRESS,
} from "../config/demeter-config";

export type FloatDefensiveStableParkResult =
  | { kind: "not_applicable" }
  | { kind: "sent"; txHash: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string };

/** @deprecated Use {@link FloatDefensiveStableParkResult}. */
export type FloatV4MarketBreadthStableResult = FloatDefensiveStableParkResult;

export function defensiveStableChosenToken(
  strategyRegistryKey: FloatManagerStrategyKey
): { symbol: string; address: string } {
  return strategyRegistryKey === "FloatStrategyV4"
    ? { symbol: "WETH", address: STABLE_V4_WETH_ADDRESS }
    : { symbol: "USDC", address: STABLE_USDC_WETH_PAIR.tokenAddress };
}

/**
 * Float V4 cohort risk-off: call FloatContractManagerV4.exitStrategyToStable() (100% WETH, mode STABLE).
 * V3 uses USDC via changeStrategyAsset — not handled here.
 */
export async function tryFloatV4MarketBreadthStableExit(
  walletProvider: EvmWalletProvider,
  pipeline: Pick<
    FloatKeeperPipeline,
    | "strategyRegistryKey"
    | "contractManagerAddress"
    | "keeperAddress"
    | "strategyIds"
    | "label"
    | "id"
  >,
  rpcUrl: string
): Promise<FloatDefensiveStableParkResult> {
  if (pipeline.strategyRegistryKey !== "FloatStrategyV4") {
    return { kind: "not_applicable" };
  }

  const strategyId = pipeline.strategyIds[0];
  if (strategyId === undefined) {
    return { kind: "skipped", reason: "no FLOAT_V4 strategy id configured" };
  }

  const wethLower = STABLE_V4_WETH_ADDRESS.toLowerCase();
  try {
    const asset = (await getFloatAssetAddress(
      pipeline.contractManagerAddress as Address,
      rpcUrl,
      "FloatStrategyV4"
    )).toLowerCase();
    const mode = await getStrategyMode(
      pipeline.keeperAddress as Address,
      strategyId,
      rpcUrl,
      pipeline.id
    );
    if (mode === FLOAT_STRATEGY_STABLE_MODE && asset === wethLower) {
      return {
        kind: "skipped",
        reason: "already STABLE mode (4) with ASSET=WETH",
      };
    }
  } catch (e) {
    console.warn(
      `[Demeter] [${pipeline.label}] pre-check before exitStrategyToStable failed (continuing):`,
      e
    );
  }

  const result = await sendExitStrategyToStable(
    walletProvider,
    pipeline.contractManagerAddress as Address
  );
  if (result.success) {
    return { kind: "sent", txHash: result.transactionHash };
  }
  return { kind: "failed", error: result.error };
}

/**
 * Float V3 DEFENSIVE no-pick: park via `changeStrategyAsset(USDC)` (WETH/USDC pool).
 */
export async function tryFloatV3DefensiveStablePark(
  walletProvider: EvmWalletProvider,
  pipeline: Pick<
    FloatKeeperPipeline,
    "strategyRegistryKey" | "contractManagerAddress" | "label"
  >,
  rpcUrl: string
): Promise<FloatDefensiveStableParkResult> {
  if (pipeline.strategyRegistryKey !== "FloatStrategy") {
    return { kind: "not_applicable" };
  }

  const usdcLower = STABLE_USDC_WETH_PAIR.tokenAddress.toLowerCase();
  try {
    const asset = (
      await getFloatAssetAddress(
        pipeline.contractManagerAddress as Address,
        rpcUrl,
        "FloatStrategy"
      )
    ).toLowerCase();
    if (asset === usdcLower) {
      return { kind: "skipped", reason: "already STABLE (USDC)" };
    }
  } catch (e) {
    console.warn(
      `[Demeter] [${pipeline.label}] pre-check before changeStrategyAsset(USDC) failed (continuing):`,
      e
    );
  }

  const result = await sendChangeStrategyAsset(
    walletProvider,
    pipeline.contractManagerAddress as Address,
    STABLE_USDC_WETH_PAIR.tokenAddress
  );
  if (result.success) {
    return { kind: "sent", txHash: result.transactionHash };
  }
  return { kind: "failed", error: result.error };
}

/**
 * DEFENSIVE upkeep pass found no qualifying alt token — park V3 to USDC or V4 to WETH (exitStrategyToStable).
 */
export async function tryFloatDefensiveStableParkWhenNoPick(
  walletProvider: EvmWalletProvider,
  pipeline: Pick<
    FloatKeeperPipeline,
    | "strategyRegistryKey"
    | "contractManagerAddress"
    | "keeperAddress"
    | "strategyIds"
    | "label"
    | "id"
  >,
  rpcUrl: string
): Promise<FloatDefensiveStableParkResult> {
  if (pipeline.strategyRegistryKey === "FloatStrategyV4") {
    return tryFloatV4MarketBreadthStableExit(walletProvider, pipeline, rpcUrl);
  }
  if (pipeline.strategyRegistryKey === "FloatStrategy") {
    return tryFloatV3DefensiveStablePark(walletProvider, pipeline, rpcUrl);
  }
  return { kind: "not_applicable" };
}

export function marketBreadthOnChainActionForRegistry(
  key: FloatManagerStrategyKey
): "changeStrategyAsset" | "exitStrategyToStable" {
  return key === "FloatStrategyV4" ? "exitStrategyToStable" : "changeStrategyAsset";
}

/** V4 cohort risk-off always uses `exitStrategyToStable` (WETH/STABLE), never USDC `changeStrategyAsset`. */
export function shouldRunFloatV4MarketBreadthStableExit(
  strategyRegistryKey: FloatManagerStrategyKey,
  comparison: { market_breadth_defensive_active?: boolean }
): boolean {
  return (
    strategyRegistryKey === "FloatStrategyV4" && comparison.market_breadth_defensive_active === true
  );
}

/** V4 has no USDC pool mapping — never call `changeStrategyAsset` with Base USDC. */
export function isBlockedV4ChangeStrategyTokenAddress(tokenAddress: string | undefined | null): boolean {
  return isStableUsdcTokenAddress(tokenAddress);
}

function normalizeAssetAddressLc(tokenAddress: string | undefined | null): string | null {
  const raw = tokenAddress?.trim();
  if (!raw) return null;
  return raw.toLowerCase();
}

/**
 * Defensive periodic loop fetches CoinGecko pool stats for the current ASSET only.
 * Skip when that asset has no pool row in the pipeline's registry map (V3 USDC stable, V4 WETH stable, V4 USDC mis-hold).
 */
export function shouldSkipPeriodicDefensivePoolFetch(
  strategyRegistryKey: FloatManagerStrategyKey,
  assetAddress: string
): { skip: true; reason: string } | { skip: false } {
  const assetLc = normalizeAssetAddressLc(assetAddress);
  if (!assetLc) {
    return { skip: true, reason: "current ASSET address missing" };
  }

  if (strategyRegistryKey === "FloatStrategyV4") {
    if (isStableUsdcTokenAddress(assetAddress)) {
      return {
        skip: true,
        reason:
          "V4 stable is WETH via exitStrategyToStable — USDC has no V4 pool mapping (V3-only stable token)",
      };
    }
    if (assetLc === STABLE_V4_WETH_ADDRESS.toLowerCase()) {
      return {
        skip: true,
        reason:
          "V4 STABLE (WETH) — defensive volume/m30 checks apply to alt tokens only, not WETH pool mapping",
      };
    }
  }

  if (strategyRegistryKey === "FloatStrategy" && isStableUsdcTokenAddress(assetAddress)) {
    return {
      skip: true,
      reason:
        "V3 STABLE (USDC) — USDC is not in the offensive token pool map; skip alt-token defensive checks while stable",
    };
  }

  return { skip: false };
}
