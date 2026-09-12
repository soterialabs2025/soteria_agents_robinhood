/**
 * Operator failover when a shard wallet cannot pay gas (insufficient ETH).
 */
import type { Address, PublicClient } from "viem";

import { createTritonPublicClient } from "../action-providers/liquid-strat-min-v4-action-provider";
import { pickShardWalletId } from "./operator-shard";

export type OperatorSigner = {
  id: string;
  privateKey: string;
  address: Address;
};

/** Skip wallets below this native balance (~0.00005 ETH) before attempting a send. */
export const MIN_OPERATOR_NATIVE_WEI_FOR_TX = 50_000_000_000_000n;

export function isInsufficientEthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /insufficient funds|insufficient balance|exceeds.*balance|lack of funds|doesn't have enough funds|not enough funds|insufficient eth/i.test(
    msg
  );
}

/** Rotate wallet ids starting at `preferred` (inclusive), wrapping around. */
export function rotateWalletIdsFrom<T extends string>(
  preferred: T,
  walletIds: readonly T[]
): T[] {
  if (walletIds.length === 0) return [];
  const start = walletIds.indexOf(preferred);
  if (start < 0) return [...walletIds];
  return [...walletIds.slice(start), ...walletIds.slice(0, start)];
}

export async function hasEnoughNativeForTx(
  publicClient: PublicClient,
  address: Address,
  minWei: bigint = MIN_OPERATOR_NATIVE_WEI_FOR_TX
): Promise<boolean> {
  try {
    const bal = await publicClient.getBalance({ address });
    return bal >= minWei;
  } catch {
    return true;
  }
}

/**
 * Send a strategy tx from the shard operator, rotating on empty ETH.
 * Callers must use wallets already allowed on OperatorRegistry (or Owner).
 */
export async function sendWithOperatorFailover<T>(params: {
  wallets: readonly OperatorSigner[];
  strategyId: number;
  rpcUrl: string;
  logTag: string;
  action: string;
  fn: (wallet: OperatorSigner) => Promise<T>;
}): Promise<T> {
  if (params.wallets.length === 0) {
    throw new Error(`${params.action}: no operator wallets`);
  }
  const ids = params.wallets.map((w) => w.id);
  const preferred = pickShardWalletId(params.strategyId, ids);
  const order = rotateWalletIdsFrom(preferred, ids);
  const byId = new Map(params.wallets.map((w) => [w.id, w]));
  const publicClient = createTritonPublicClient(params.rpcUrl);

  let lastError: unknown;
  for (const id of order) {
    const wallet = byId.get(id);
    if (!wallet) continue;
    const funded = await hasEnoughNativeForTx(publicClient, wallet.address);
    if (!funded) {
      console.warn(
        `[${params.logTag}] [${id}] skip ${params.action} id=${params.strategyId} — native balance too low`
      );
      continue;
    }
    try {
      return await params.fn(wallet);
    } catch (e) {
      lastError = e;
      if (isInsufficientEthError(e)) {
        console.warn(
          `[${params.logTag}] [${id}] ${params.action} id=${params.strategyId} insufficient ETH — trying next operator:`,
          e instanceof Error ? e.message : e
        );
        continue;
      }
      throw e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${params.action} id=${params.strategyId}: all operators failed`);
}
