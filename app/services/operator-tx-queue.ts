/**
 * Per-wallet FIFO queue — one in-flight tx per key (avoids nonce races across parallel loops).
 */
export function enqueueSerializedWalletWork<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const prior = queues.get(key);
  const run: Promise<T> = (prior ?? Promise.resolve()).then(
    () => fn(),
    () => fn()
  );
  queues.set(key, run);
  return run;
}

/** Process-wide queues keyed by lowercase EVM address (shared across AutoKeeper + Demeter shards). */
const addressTxQueues = new Map<string, Promise<unknown>>();

/**
 * Serialize all txs for one on-chain address across modules (e.g. DEMETER_TWO used by
 * Float operator shard + AutoKeeper upkeep/harvest).
 */
export function enqueueSerializedAddressTx<T>(
  address: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = address.trim().toLowerCase();
  if (!key) throw new Error("enqueueSerializedAddressTx: address required");
  return enqueueSerializedWalletWork(addressTxQueues, key, fn);
}
