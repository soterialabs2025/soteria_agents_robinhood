/**
 * UFloatKeeper upkeep + harvest — Triton operator wallets (TRITON_PRIVATE_KEY + optional TRITON_TWO_PRIVATE_KEY).
 *
 * 1. FloatContractManagerV4.getAddress("UFloatKeeperV4")
 * 2. For each index 0..strategiesLength-1, watched(id) → collect ids with active && pool+idle≥1e14 wei
 * 3. performUpkeepBatch(ids) chunked by gas on upkeep interval (sharded by strategy id)
 * 4. After upkeep: mode=DEFENSIVE → default-metrics rank → changeAsset (best allowlist token; no park-to-STABLE)
 * 5. Offensive-metrics loop (NORMAL only) — skips OFFENSIVE/DEFENSIVE/STABLE and underfunded pool+idle
 * 6. performHarvestBatch(ids) chunked by gas on harvest interval — skips mode=STABLE and underfunded pool+idle
 */
import type { Abi, Address } from "viem";
import { zeroAddress } from "viem";
import { getRpcUrl, explorerTxUrl } from "../config/chain-config";

import floatContractManagerV4Json from "../abi/FloatContractManagerV4.json";
import ufloatKeeperJson from "../abi/UFloatKeeper.json";
import {
  createTritonPublicClient,
  createTritonWalletClient,
} from "../action-providers/liquid-strat-min-v4-action-provider";
import { getFloatContractManagerV4Address } from "../config/demeter-config";
import { checkDemeterStopSignal, sleepWithStopCheck } from "../config/demeter-stop";
import { getOperatorRegistryAddress } from "../config/operator-registry-config";
import {
  getTokenComparisonCacheTtlMs,
  getUfloatHarvestBatchMaxGas,
  getUfloatUpkeepBatchMaxGas,
} from "../config/token-comparison-cache-config";
import {
  getUfloatChangeAssetCooldownMs,
  getUfloatKeeperHarvestIntervalMs,
  getUfloatKeeperUpkeepIntervalMs,
  getUfloatOffensiveIntervalMs,
} from "../config/triton-config";
import { getDemeterTxGasHeadroomBps, getTxMinGasLimit, isTxOutOfGasError, resolveBatchTxGasLimit, resolveTxGasLimit } from "../config/demeter-tx-gas";
import { assertOperatorWalletsRegistered } from "./operator-registry";
import { groupStrategyIdsByShard } from "./operator-shard";
import {
  handleUFloatDefensiveAfterUpkeep,
  readUFloatStrategyMode,
  UFLOAT_STABLE_MODE,
} from "./ufloat-defensive-change";
import {
  chunkUfloatKeeperIdsByGas,
  type UfloatKeeperBatchFunction,
} from "./ufloat-keeper-batch";
import {
  runUFloatOffensiveMetricsPass,
} from "./ufloat-offensive-change";
import {
  enqueueUfloatWalletTx,
  getUfloatTxWalletIds,
  resolveUfloatTxWallets,
  type UfloatTxWalletId,
} from "./ufloat-wallet-pool";
import {
  filterActiveByMinPoolValue,
  MIN_STRATEGY_POOL_VALUE_WEI,
} from "./strategy-pool-value-eligibility";

const UFLOAT_KEEPER_REGISTRY_NAME = "UFloatKeeperV4";
const MANAGER_ABI = floatContractManagerV4Json.abi as Abi;
const UFLOAT_KEEPER_ABI = ufloatKeeperJson.abi as Abi;

export type UfloatWatchedRow = {
  id: number;
  stratAddr: Address;
  minInterval: number;
  lastAction: number;
  active: boolean;
};

export async function resolveUFloatKeeperAddress(rpcUrl: string): Promise<Address> {
  const client = createTritonPublicClient(rpcUrl);
  const addr = await client.readContract({
    address: getFloatContractManagerV4Address(),
    abi: MANAGER_ABI,
    functionName: "getAddress",
    args: [UFLOAT_KEEPER_REGISTRY_NAME],
  });
  if (!addr || addr === zeroAddress) {
    throw new Error(
      `FloatContractManagerV4.getAddress("${UFLOAT_KEEPER_REGISTRY_NAME}") returned zero — register keeper on manager first`
    );
  }
  return addr as Address;
}

export async function readUFloatKeeperOperatorRegistry(
  keeperAddress: Address,
  rpcUrl: string
): Promise<Address> {
  const client = createTritonPublicClient(rpcUrl);
  return (await client.readContract({
    address: keeperAddress,
    abi: UFLOAT_KEEPER_ABI,
    functionName: "operatorRegistry",
  })) as Address;
}

/** @deprecated UFloatKeeper now uses operatorRegistry — kept for diagnostics. */
export async function readUFloatKeeperTritonAddr(
  keeperAddress: Address,
  rpcUrl: string
): Promise<Address> {
  return readUFloatKeeperOperatorRegistry(keeperAddress, rpcUrl);
}

/** Load watched[] rows; strategy id = 0-based index passed to watched(id). */
export async function listUFloatWatchedRows(
  keeperAddress: Address,
  rpcUrl: string
): Promise<UfloatWatchedRow[]> {
  const client = createTritonPublicClient(rpcUrl);
  const len = Number(
    await client.readContract({
      address: keeperAddress,
      abi: UFLOAT_KEEPER_ABI,
      functionName: "strategiesLength",
    })
  );
  const rows: UfloatWatchedRow[] = [];
  for (let id = 0; id < len; id++) {
    const row = await client.readContract({
      address: keeperAddress,
      abi: UFLOAT_KEEPER_ABI,
      functionName: "watched",
      args: [BigInt(id)],
    });
    const [stratAddr, minInterval, lastAction, active] = row as readonly [
      Address,
      number,
      number,
      boolean,
    ];
    rows.push({
      id,
      stratAddr,
      minInterval: Number(minInterval),
      lastAction: Number(lastAction),
      active: Boolean(active),
    });
  }
  return rows;
}

/** Active for keeper txs / ranking: watched.active && strat ≠ 0 && pool+idle ≥ floor. */
export async function activeUFloatStrategyIds(
  rows: UfloatWatchedRow[],
  rpcUrl: string
): Promise<number[]> {
  const eligible = await filterActiveByMinPoolValue(rows, rpcUrl, "UFloatKeeper");
  return eligible.map((r) => r.id);
}

/** Strategy ids eligible for harvest — excludes mode=STABLE and underfunded pool+idle. */
export async function activeUFloatHarvestStrategyIds(
  rows: UfloatWatchedRow[],
  rpcUrl: string
): Promise<number[]> {
  const active = await filterActiveByMinPoolValue(rows, rpcUrl, "UFloatKeeper");
  const ids: number[] = [];
  for (const row of active) {
    try {
      const mode = await readUFloatStrategyMode(row.stratAddr, rpcUrl);
      if (mode === UFLOAT_STABLE_MODE) continue;
      ids.push(row.id);
    } catch (e) {
      console.warn(
        `[UFloatKeeper] harvest eligibility read failed for strategy ${row.id}:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  return ids;
}

function batchArgs(functionName: UfloatKeeperBatchFunction, ids: number[]): readonly unknown[] {
  const idArgs = ids.map((id) => BigInt(id));
  if (functionName === "performHarvestBatch") {
    return [idArgs, false];
  }
  return [idArgs];
}

function isOutOfGasError(e: unknown): boolean {
  return isTxOutOfGasError(e);
}

async function submitUfloatBatchTxOnce(
  privateKey: string,
  rpcUrl: string,
  keeperAddress: Address,
  functionName: UfloatKeeperBatchFunction,
  ids: number[]
): Promise<`0x${string}`> {
  const wallet = createTritonWalletClient(privateKey, rpcUrl);
  const publicClient = createTritonPublicClient(rpcUrl);
  const args = batchArgs(functionName, ids);
  const rawEstimate = await publicClient.estimateContractGas({
    account: wallet.account,
    address: keeperAddress,
    abi: UFLOAT_KEEPER_ABI,
    functionName,
    args,
  });
  const gas =
    ids.length > 1 ? resolveBatchTxGasLimit(rawEstimate) : resolveTxGasLimit(rawEstimate);

  const hash = await wallet.writeContract({
    account: wallet.account,
    address: keeperAddress,
    abi: UFLOAT_KEEPER_ABI,
    functionName,
    args,
    gas,
    chain: wallet.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    if (receipt.gasUsed >= gas - 50_000n) {
      throw new Error(`${functionName} reverted (likely OOG): ${hash} gasUsed=${receipt.gasUsed}/${gas}`);
    }
    throw new Error(`${functionName} reverted: ${hash}`);
  }
  console.log(
    `[UFloatKeeper] ${functionName} ids [${ids.join(", ")}] gas ${gas} (estimate ${rawEstimate}, used ${receipt.gasUsed})`
  );
  return hash;
}

async function submitUfloatBatchTxUnqueued(
  privateKey: string,
  rpcUrl: string,
  keeperAddress: Address,
  functionName: UfloatKeeperBatchFunction,
  ids: number[]
): Promise<`0x${string}`> {
  if (ids.length === 0) {
    throw new Error(`${functionName}: ids must not be empty`);
  }
  try {
    return await submitUfloatBatchTxOnce(privateKey, rpcUrl, keeperAddress, functionName, ids);
  } catch (e) {
    if (isOutOfGasError(e) && ids.length > 1) {
      const mid = Math.ceil(ids.length / 2);
      console.warn(
        `[UFloatKeeper] ${functionName} OOG for ids [${ids.join(", ")}] — splitting into [${ids.slice(0, mid).join(", ")}] + [${ids.slice(mid).join(", ")}]`
      );
      await submitUfloatBatchTxUnqueued(
        privateKey,
        rpcUrl,
        keeperAddress,
        functionName,
        ids.slice(0, mid)
      );
      return submitUfloatBatchTxUnqueued(
        privateKey,
        rpcUrl,
        keeperAddress,
        functionName,
        ids.slice(mid)
      );
    }
    throw e;
  }
}

/** Keeper txs share the per-wallet queue with changeAsset to avoid nonce conflicts. */
function submitUfloatBatchTx(
  walletId: UfloatTxWalletId,
  privateKey: string,
  rpcUrl: string,
  keeperAddress: Address,
  functionName: UfloatKeeperBatchFunction,
  ids: number[]
): Promise<`0x${string}`> {
  return enqueueUfloatWalletTx(walletId, () =>
    submitUfloatBatchTxUnqueued(privateKey, rpcUrl, keeperAddress, functionName, ids)
  );
}

async function runUfloatKeeperBatches(
  walletId: UfloatTxWalletId,
  privateKey: string,
  rpcUrl: string,
  keeperAddress: Address,
  functionName: UfloatKeeperBatchFunction,
  ids: number[],
  label: string
): Promise<void> {
  if (ids.length === 0) {
    console.log(`[UFloatKeeper] ${label} skipped — no active watched strategies`);
    return;
  }

  const wallet = createTritonWalletClient(privateKey, rpcUrl);
  const publicClient = createTritonPublicClient(rpcUrl);
  const chunks = await chunkUfloatKeeperIdsByGas({
    publicClient,
    account: wallet.account,
    keeperAddress,
    abi: UFLOAT_KEEPER_ABI,
    functionName,
    ids,
  });

  for (const chunk of chunks) {
    try {
      const hash = await submitUfloatBatchTx(
        walletId,
        privateKey,
        rpcUrl,
        keeperAddress,
        functionName,
        chunk
      );
      console.log(
        `[UFloatKeeper] [${walletId}] ${functionName} ids [${chunk.join(", ")}] tx ${hash} ${explorerTxUrl(hash)}`
      );
    } catch (e) {
      console.warn(
        `[UFloatKeeper] ${functionName} ids [${chunk.join(", ")}] failed:`,
        e instanceof Error ? e.message : e
      );
    }
    if (chunks.length > 1) {
      await sleepWithStopCheck(500);
    }
  }
}

async function runShardedUfloatUpkeepBatch(
  rpcUrl: string,
  keeperAddress: Address,
  ids: number[]
): Promise<void> {
  const wallets = resolveUfloatTxWallets();
  const walletIds = getUfloatTxWalletIds();
  const groups = groupStrategyIdsByShard(ids, walletIds);

  await Promise.all(
    wallets.map(async (wallet) => {
      const shardIds = groups.get(wallet.id) ?? [];
      if (shardIds.length === 0) return;
      await runUfloatKeeperBatches(
        wallet.id,
        wallet.privateKey,
        rpcUrl,
        keeperAddress,
        "performUpkeepBatch",
        shardIds,
        "Upkeep"
      );
    })
  );
}

async function runShardedUfloatHarvestAll(
  rpcUrl: string,
  keeperAddress: Address,
  ids: number[]
): Promise<void> {
  const wallets = resolveUfloatTxWallets();
  const walletIds = getUfloatTxWalletIds();
  const groups = groupStrategyIdsByShard(ids, walletIds);

  await Promise.all(
    wallets.map(async (wallet) => {
      const shardIds = groups.get(wallet.id) ?? [];
      if (shardIds.length === 0) return;
      await runUfloatKeeperBatches(
        wallet.id,
        wallet.privateKey,
        rpcUrl,
        keeperAddress,
        "performHarvestBatch",
        shardIds,
        "Harvest"
      );
    })
  );
}

async function ufloatKeeperUpkeepLoop(
  rpcUrl: string,
  keeperAddress: Address,
  intervalMs: number
): Promise<never> {
  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[UFloatKeeper] Stop signal — exiting upkeep loop");
      return undefined as never;
    }
    try {
      const rows = await listUFloatWatchedRows(keeperAddress, rpcUrl);
      const eligibleRows = await filterActiveByMinPoolValue(rows, rpcUrl, "UFloatKeeper");
      const ids = eligibleRows.map((r) => r.id);
      await runShardedUfloatUpkeepBatch(rpcUrl, keeperAddress, ids);
      if (ids.length > 0) {
        await handleUFloatDefensiveAfterUpkeep(rpcUrl, eligibleRows);
      }
    } catch (e) {
      console.error("[UFloatKeeper] Upkeep loop error:", e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}

async function ufloatKeeperHarvestLoop(
  rpcUrl: string,
  keeperAddress: Address,
  intervalMs: number
): Promise<never> {
  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[UFloatKeeper] Stop signal — exiting harvest loop");
      return undefined as never;
    }
    try {
      const rows = await listUFloatWatchedRows(keeperAddress, rpcUrl);
      const allActiveIds = await activeUFloatStrategyIds(rows, rpcUrl);
      const ids = await activeUFloatHarvestStrategyIds(rows, rpcUrl);
      if (ids.length < allActiveIds.length) {
        console.log(
          `[UFloatKeeper] Harvest skipping ${allActiveIds.length - ids.length} mode=STABLE strateg${allActiveIds.length - ids.length === 1 ? "y" : "ies"}`
        );
      }
      await runShardedUfloatHarvestAll(rpcUrl, keeperAddress, ids);
    } catch (e) {
      console.error("[UFloatKeeper] Harvest loop error:", e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}

async function ufloatKeeperOffensiveMetricsLoop(
  rpcUrl: string,
  keeperAddress: Address,
  intervalMs: number
): Promise<never> {
  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[UFloatKeeper] Stop signal — exiting offensive-metrics loop");
      return undefined as never;
    }
    try {
      const rows = await listUFloatWatchedRows(keeperAddress, rpcUrl);
      const eligibleRows = await filterActiveByMinPoolValue(rows, rpcUrl, "UFloatKeeper");
      await runUFloatOffensiveMetricsPass(rpcUrl, eligibleRows);
    } catch (e) {
      console.error("[UFloatKeeper] offensive-metrics loop error:", e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}
/** UFloatKeeper loops — requires operator wallet keys registered on OperatorRegistry. */
export async function ufloatKeeperLoop(): Promise<void> {
  const rpcUrl = getRpcUrl();

  const operatorWallets = resolveUfloatTxWallets();
  const keeperAddress = await resolveUFloatKeeperAddress(rpcUrl);
  const onChainRegistry = await readUFloatKeeperOperatorRegistry(keeperAddress, rpcUrl);
  const expectedRegistry = getOperatorRegistryAddress();
  if (onChainRegistry.toLowerCase() !== expectedRegistry.toLowerCase()) {
    throw new Error(
      `UFloatKeeper.operatorRegistry ${onChainRegistry} does not match configured ${expectedRegistry}`
    );
  }

  const registryChecks = await assertOperatorWalletsRegistered(operatorWallets, rpcUrl, expectedRegistry);

  const upkeepMs = getUfloatKeeperUpkeepIntervalMs();
  const harvestMs = getUfloatKeeperHarvestIntervalMs();
  const offensiveMetricsMs = getUfloatOffensiveIntervalMs();
  const changeAssetCooldownMs = getUfloatChangeAssetCooldownMs();
  const rows = await listUFloatWatchedRows(keeperAddress, rpcUrl);
  const activeIds = await activeUFloatStrategyIds(rows, rpcUrl);

  console.log("[UFloatKeeper] Loop starting (operator wallet sharding)");
  console.log(`[UFloatKeeper] Manager: ${getFloatContractManagerV4Address()}`);
  console.log(`[UFloatKeeper] Keeper: ${keeperAddress} (registry "${UFLOAT_KEEPER_REGISTRY_NAME}")`);
  console.log(`[UFloatKeeper] OperatorRegistry: ${expectedRegistry}`);
  for (const check of registryChecks) {
    console.log(`[UFloatKeeper] Operator wallet ${check.id}: ${check.address} (registered)`);
  }
  console.log(
    `[UFloatKeeper] Active strategy ids (watched.active && pool+idle≥${MIN_STRATEGY_POOL_VALUE_WEI}): [${activeIds.join(", ") || "none"}]`
  );
  console.log(
    `[UFloatKeeper] performUpkeepBatch every ${upkeepMs / 1000}s (gas-chunked, sharded ×${operatorWallets.length}, max send ${getUfloatUpkeepBatchMaxGas()})`
  );
  console.log(
    `[UFloatKeeper] post-upkeep DEFENSIVE default-metrics on each performUpkeepBatch (~${upkeepMs / 1000}s); mode=STABLE is upkeep-only (owner exit)`
  );
  console.log(
    `[UFloatKeeper] offensive-metrics loop every ${offensiveMetricsMs / 1000}s (NORMAL only; skips OFFENSIVE/DEFENSIVE/STABLE) — comparison TTL ${getTokenComparisonCacheTtlMs() / 1000}s` +
      (changeAssetCooldownMs > 0 ? `; changeAsset cooldown ${changeAssetCooldownMs / 1000}s` : "; changeAsset cooldown disabled")
  );
  console.log(
    `[UFloatKeeper] performHarvestBatch every ${harvestMs / 3600000}h (skips mode=STABLE — no LP position; gas-chunked, sharded ×${operatorWallets.length}, max send ${getUfloatHarvestBatchMaxGas()})`
  );
  console.log(
    `[UFloatKeeper] Tx gas: ${getDemeterTxGasHeadroomBps() / 1000}× headroom, min ${getTxMinGasLimit()}`
  );

  await Promise.race([
    ufloatKeeperUpkeepLoop(rpcUrl, keeperAddress, upkeepMs),
    ufloatKeeperHarvestLoop(rpcUrl, keeperAddress, harvestMs),
    ufloatKeeperOffensiveMetricsLoop(rpcUrl, keeperAddress, offensiveMetricsMs),
  ]);
}
