/**
 * Strategy-id → operator wallet shard routing (stable modulo hash).
 */

/** Pick wallet id for a strategy id using stable modulo sharding. */
export function pickShardWalletId<T extends string>(strategyId: number, walletIds: readonly T[]): T {
  if (walletIds.length === 0) {
    throw new Error("pickShardWalletId: walletIds must not be empty");
  }
  const index = ((strategyId % walletIds.length) + walletIds.length) % walletIds.length;
  return walletIds[index]!;
}

/** Group strategy ids by shard wallet id. */
export function groupStrategyIdsByShard<T extends string>(
  strategyIds: readonly number[],
  walletIds: readonly T[]
): Map<T, number[]> {
  const groups = new Map<T, number[]>();
  for (const walletId of walletIds) {
    groups.set(walletId, []);
  }
  for (const id of strategyIds) {
    const walletId = pickShardWalletId(id, walletIds);
    groups.get(walletId)!.push(id);
  }
  return groups;
}
