/**
 * Shared eligibility: keeper `watched.active` alone is not enough —
 * strategy/vault deployable value must be ≥ {@link MIN_STRATEGY_POOL_VALUE_WEI}.
 *
 * Prefers `totalValueWeth()` (= idle + pool). Falls back to `poolValue() + balanceOfIdle()`
 * for AutoVault (no `totalValueWeth`). DEFENSIVE often has poolValue=0 with capital in idle.
 *
 * Gates AutoKeeper + UFloatKeeper upkeep/harvest and UFloat CoinGecko changeAsset paths.
 */
import type { Abi, Address } from "viem";
import { zeroAddress } from "viem";

import { createTritonPublicClient } from "../action-providers/liquid-strat-min-v4-action-provider";

/** 1e14 wei (0.0001 ETH). Below this → treat as inactive for keeper + ranking actions. */
export const MIN_STRATEGY_POOL_VALUE_WEI = 100_000_000_000_000n;

const TOTAL_VALUE_WETH_ABI = [
  {
    type: "function",
    name: "totalValueWeth",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
] as const satisfies Abi;

/** Fallback for AutoVault (no totalValueWeth). */
const POOL_PLUS_IDLE_ABI = [
  {
    type: "function",
    name: "poolValue",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOfIdle",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
] as const satisfies Abi;

export type WatchedRowWithAddr = {
  id: number;
  stratAddr: Address;
  active: boolean;
};

/**
 * Read deployable strategy value in WETH wei.
 * UFloat: `totalValueWeth()`. AutoVault: `poolValue() + balanceOfIdle()`.
 */
export async function readStrategyPoolValueWei(
  stratAddr: Address,
  rpcUrl: string
): Promise<bigint | null> {
  const client = createTritonPublicClient(rpcUrl);
  try {
    const raw = await client.readContract({
      address: stratAddr,
      abi: TOTAL_VALUE_WETH_ABI,
      functionName: "totalValueWeth",
    });
    return raw as bigint;
  } catch {
    // AutoVault / older strats without totalValueWeth
  }
  try {
    const [poolValue, balanceOfIdle] = await Promise.all([
      client.readContract({
        address: stratAddr,
        abi: POOL_PLUS_IDLE_ABI,
        functionName: "poolValue",
      }) as Promise<bigint>,
      client.readContract({
        address: stratAddr,
        abi: POOL_PLUS_IDLE_ABI,
        functionName: "balanceOfIdle",
      }) as Promise<bigint>,
    ]);
    return poolValue + balanceOfIdle;
  } catch {
    return null;
  }
}

/** True when total value is readable and ≥ {@link MIN_STRATEGY_POOL_VALUE_WEI}. */
export async function strategyMeetsPoolValueFloor(
  stratAddr: Address,
  rpcUrl: string
): Promise<boolean> {
  if (!stratAddr || stratAddr === zeroAddress) return false;
  const value = await readStrategyPoolValueWei(stratAddr, rpcUrl);
  return value != null && value >= MIN_STRATEGY_POOL_VALUE_WEI;
}

/**
 * Keep rows that are watched-active, non-zero strat, and totalValueWeth (or pool+idle) ≥ floor.
 * Logs skips when watched-active but underfunded / unreadable.
 */
export async function filterActiveByMinPoolValue<T extends WatchedRowWithAddr>(
  rows: readonly T[],
  rpcUrl: string,
  logPrefix: string
): Promise<T[]> {
  const out: T[] = [];
  for (const row of rows) {
    if (!row.active || row.stratAddr === zeroAddress) continue;
    const value = await readStrategyPoolValueWei(row.stratAddr, rpcUrl);
    if (value == null) {
      console.warn(
        `[${logPrefix}] strategy ${row.id} (${row.stratAddr}) watched.active but totalValueWeth() failed — treating as inactive`
      );
      continue;
    }
    if (value < MIN_STRATEGY_POOL_VALUE_WEI) {
      console.log(
        `[${logPrefix}] strategy ${row.id} (${row.stratAddr}) watched.active but totalValueWeth=${value} < ${MIN_STRATEGY_POOL_VALUE_WEI} — treating as inactive`
      );
      continue;
    }
    out.push(row);
  }
  return out;
}
