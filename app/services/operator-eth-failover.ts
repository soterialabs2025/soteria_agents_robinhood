/**
 * Operator failover when a shard wallet cannot pay gas (insufficient ETH).
 */
import type { Address, PublicClient } from "viem";

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
