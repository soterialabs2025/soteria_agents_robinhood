/**
 * UFloatKeeper RH V3 + V4 — upkeep + harvest sharded across up to 4 operator wallets.
 * changeAsset (DEFENSIVE / offensive metrics) stays on Triton wallets.
 * Upkeep txs only after off-chain keeperCheck() (from=keeper) says remint is needed.
 *
 * Keeper addresses from docs/ADDRESSES.md ({@link rh-keeper-pipelines}).
 */
import type { Abi, Address } from "viem";
import { getRpcUrl, explorerTxUrl } from "../config/chain-config";

import {
  createTritonPublicClient,
  createTritonWalletClient,
} from "../action-providers/liquid-strat-min-v4-action-provider";
import {
  getEnabledUfloatKeeperPipelines,
  getUfloatRhV4Pipeline,
  type UfloatKeeperPipeline,
} from "../config/rh-keeper-pipelines";
import { checkDemeterStopSignal, sleepWithStopCheck } from "../config/demeter-stop";
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
import { filterIdsNeedingRemint } from "./keeper-check-simulate";
import { filterRegisteredOperatorWallets } from "./operator-registry";
import { groupStrategyIdsByShard } from "./operator-shard";
import { enqueueSerializedAddressTx } from "./operator-tx-queue";
import {
  resolveRhOperatorWallets,
  type RhOperatorWallet,
} from "./rh-operator-pool";
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
  filterActiveByMinPoolValue,
  MIN_STRATEGY_POOL_VALUE_WEI,
} from "./strategy-pool-value-eligibility";

export type UfloatWatchedRow = {
  id: number;
  stratAddr: Address;
  minInterval: number;
  lastAction: number;
  active: boolean;
};

/** Hardcoded RH UFloat V4 keeper — never resolves via FloatContractManager.getAddress. */
export function resolveUFloatKeeperAddress(_rpcUrl?: string): Address {
  return getUfloatRhV4Pipeline().keeperAddress;
}

export async function readUFloatKeeperOperatorRegistry(
  keeperAddress: Address,
  rpcUrl: string,
  abi: Abi = getUfloatRhV4Pipeline().abi
): Promise<Address> {
  const client = createTritonPublicClient(rpcUrl);
  return (await client.readContract({
    address: keeperAddress,
    abi,
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
  rpcUrl: string,
  abi: Abi = getUfloatRhV4Pipeline().abi
): Promise<UfloatWatchedRow[]> {
  const client = createTritonPublicClient(rpcUrl);
  const len = Number(
    await client.readContract({
      address: keeperAddress,
      abi,
      functionName: "strategiesLength",
    })
  );
  const rows: UfloatWatchedRow[] = [];
  for (let id = 0; id < len; id++) {
    const row = await client.readContract({
      address: keeperAddress,
      abi,
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
  abi: Abi,
  functionName: UfloatKeeperBatchFunction,
  ids: number[]
): Promise<`0x${string}`> {
  const wallet = createTritonWalletClient(privateKey, rpcUrl);
  const publicClient = createTritonPublicClient(rpcUrl);
  const args = batchArgs(functionName, ids);
  const rawEstimate = await publicClient.estimateContractGas({
    account: wallet.account,
    address: keeperAddress,
    abi,
    functionName,
    args,
  });
  const gas =
    ids.length > 1 ? resolveBatchTxGasLimit(rawEstimate) : resolveTxGasLimit(rawEstimate);

  const hash = await wallet.writeContract({
    account: wallet.account,
    address: keeperAddress,
    abi,
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
  abi: Abi,
  functionName: UfloatKeeperBatchFunction,
  ids: number[]
): Promise<`0x${string}`> {
  if (ids.length === 0) {
    throw new Error(`${functionName}: ids must not be empty`);
  }
  try {
    return await submitUfloatBatchTxOnce(privateKey, rpcUrl, keeperAddress, abi, functionName, ids);
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
        abi,
        functionName,
        ids.slice(0, mid)
      );
      return submitUfloatBatchTxUnqueued(
        privateKey,
        rpcUrl,
        keeperAddress,
        abi,
        functionName,
        ids.slice(mid)
      );
    }
    throw e;
  }
}

function submitUfloatBatchTx(
  wallet: RhOperatorWallet,
  rpcUrl: string,
  keeperAddress: Address,
  abi: Abi,
  functionName: UfloatKeeperBatchFunction,
  ids: number[]
): Promise<`0x${string}`> {
  return enqueueSerializedAddressTx(wallet.address, () =>
    submitUfloatBatchTxUnqueued(wallet.privateKey, rpcUrl, keeperAddress, abi, functionName, ids)
  );
}

async function runUfloatKeeperBatches(
  wallet: RhOperatorWallet,
  rpcUrl: string,
  pipeline: UfloatKeeperPipeline,
  functionName: UfloatKeeperBatchFunction,
  ids: number[],
  label: string
): Promise<void> {
  const tag = pipeline.label;
  if (ids.length === 0) {
    console.log(`[${tag}] [${wallet.id}] ${label} skipped — no active watched strategies`);
    return;
  }

  const walletClient = createTritonWalletClient(wallet.privateKey, rpcUrl);
  const publicClient = createTritonPublicClient(rpcUrl);
  const chunks = await chunkUfloatKeeperIdsByGas({
    publicClient,
    account: walletClient.account,
    keeperAddress: pipeline.keeperAddress,
    abi: pipeline.abi,
    functionName,
    ids,
  });

  for (const chunk of chunks) {
    try {
      const hash = await submitUfloatBatchTx(
        wallet,
        rpcUrl,
        pipeline.keeperAddress,
        pipeline.abi,
        functionName,
        chunk
      );
      console.log(
        `[${tag}] [${wallet.id}] ${functionName} ids [${chunk.join(", ")}] tx ${hash} ${explorerTxUrl(hash)}`
      );
    } catch (e) {
      console.warn(
        `[${tag}] [${wallet.id}] ${functionName} ids [${chunk.join(", ")}] failed:`,
        e instanceof Error ? e.message : e
      );
    }
    if (chunks.length > 1) {
      await sleepWithStopCheck(500);
    }
  }
}

async function runShardedUfloatBatches(
  rpcUrl: string,
  pipeline: UfloatKeeperPipeline,
  wallets: RhOperatorWallet[],
  functionName: UfloatKeeperBatchFunction,
  ids: number[],
  label: string
): Promise<void> {
  const walletIds = wallets.map((w) => w.id);
  const groups = groupStrategyIdsByShard(ids, walletIds);
  await Promise.all(
    wallets.map(async (wallet) => {
      const shardIds = groups.get(wallet.id) ?? [];
      if (shardIds.length === 0) return;
      await runUfloatKeeperBatches(wallet, rpcUrl, pipeline, functionName, shardIds, label);
    })
  );
}

async function ufloatKeeperUpkeepLoop(
  rpcUrl: string,
  pipeline: UfloatKeeperPipeline,
  wallets: RhOperatorWallet[],
  intervalMs: number
): Promise<never> {
  const tag = pipeline.label;
  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log(`[${tag}] Stop signal — exiting upkeep loop`);
      return undefined as never;
    }
    try {
      const rows = await listUFloatWatchedRows(pipeline.keeperAddress, rpcUrl, pipeline.abi);
      const eligibleRows = await filterActiveByMinPoolValue(rows, rpcUrl, tag);
      const ids = await filterIdsNeedingRemint({
        rpcUrl,
        keeperAddress: pipeline.keeperAddress,
        rows: eligibleRows.map((r) => ({
          id: r.id,
          stratAddr: r.stratAddr,
          minIntervalSec: r.minInterval,
          lastUpkeepSec: r.lastAction,
        })),
        logTag: tag,
      });
      if (ids.length === 0) {
        console.log(`[${tag}] Upkeep skipped — no remint needed`);
      } else {
        await runShardedUfloatBatches(rpcUrl, pipeline, wallets, "performUpkeepBatch", ids, "Upkeep");
      }
      if (eligibleRows.length > 0) {
        await handleUFloatDefensiveAfterUpkeep(rpcUrl, eligibleRows);
      }
    } catch (e) {
      console.error(`[${tag}] Upkeep loop error:`, e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}

async function ufloatKeeperHarvestLoop(
  rpcUrl: string,
  pipeline: UfloatKeeperPipeline,
  wallets: RhOperatorWallet[],
  intervalMs: number
): Promise<never> {
  const tag = pipeline.label;
  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log(`[${tag}] Stop signal — exiting harvest loop`);
      return undefined as never;
    }
    try {
      const rows = await listUFloatWatchedRows(pipeline.keeperAddress, rpcUrl, pipeline.abi);
      const allActiveIds = await activeUFloatStrategyIds(rows, rpcUrl);
      const ids = await activeUFloatHarvestStrategyIds(rows, rpcUrl);
      if (ids.length < allActiveIds.length) {
        console.log(
          `[${tag}] Harvest skipping ${allActiveIds.length - ids.length} mode=STABLE strateg${allActiveIds.length - ids.length === 1 ? "y" : "ies"}`
        );
      }
      await runShardedUfloatBatches(rpcUrl, pipeline, wallets, "performHarvestBatch", ids, "Harvest");
    } catch (e) {
      console.error(`[${tag}] Harvest loop error:`, e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}

async function ufloatKeeperOffensiveMetricsLoop(
  rpcUrl: string,
  pipeline: UfloatKeeperPipeline,
  intervalMs: number
): Promise<never> {
  const tag = pipeline.label;
  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log(`[${tag}] Stop signal — exiting offensive-metrics loop`);
      return undefined as never;
    }
    try {
      const rows = await listUFloatWatchedRows(pipeline.keeperAddress, rpcUrl, pipeline.abi);
      const eligibleRows = await filterActiveByMinPoolValue(rows, rpcUrl, tag);
      await runUFloatOffensiveMetricsPass(rpcUrl, eligibleRows);
    } catch (e) {
      console.error(`[${tag}] offensive-metrics loop error:`, e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}

async function startUfloatKeeperPipeline(
  rpcUrl: string,
  pipeline: UfloatKeeperPipeline,
  wallets: RhOperatorWallet[]
): Promise<void> {
  const tag = pipeline.label;
  const onChainRegistry = await readUFloatKeeperOperatorRegistry(
    pipeline.keeperAddress,
    rpcUrl,
    pipeline.abi
  );
  if (onChainRegistry.toLowerCase() !== pipeline.operatorRegistryAddress.toLowerCase()) {
    throw new Error(
      `${tag}.operatorRegistry ${onChainRegistry} does not match configured ${pipeline.operatorRegistryAddress}`
    );
  }

  const shardWallets = await filterRegisteredOperatorWallets(
    wallets,
    rpcUrl,
    onChainRegistry,
    tag
  );

  const upkeepMs = getUfloatKeeperUpkeepIntervalMs();
  const harvestMs = getUfloatKeeperHarvestIntervalMs();
  const offensiveMetricsMs = getUfloatOffensiveIntervalMs();
  const changeAssetCooldownMs = getUfloatChangeAssetCooldownMs();
  const rows = await listUFloatWatchedRows(pipeline.keeperAddress, rpcUrl, pipeline.abi);
  const activeIds = await activeUFloatStrategyIds(rows, rpcUrl);

  console.log(`[${tag}] Loop starting (keeper checks sharded ×${shardWallets.length})`);
  console.log(`[${tag}] Keeper: ${pipeline.keeperAddress} (hardcoded, no manager lookup)`);
  console.log(`[${tag}] Factory: ${pipeline.factoryAddress}`);
  console.log(`[${tag}] SwapRouter: ${pipeline.swapRouterAddress}`);
  console.log(`[${tag}] OperatorRegistry: ${onChainRegistry}`);
  for (const w of shardWallets) {
    console.log(`[${tag}] Operator wallet ${w.id}: ${w.address}`);
  }
  console.log(
    `[${tag}] Active strategy ids (watched.active && pool+idle≥${MIN_STRATEGY_POOL_VALUE_WEI}): [${activeIds.join(", ") || "none"}]`
  );
  console.log(
    `[${tag}] performUpkeepBatch every ${upkeepMs / 1000}s after keeperCheck simulate (from=keeper; gas-chunked, shard id % ${shardWallets.length}, max send ${getUfloatUpkeepBatchMaxGas()})`
  );
  console.log(
    `[${tag}] post-upkeep DEFENSIVE default-metrics on each performUpkeepBatch (~${upkeepMs / 1000}s); mode=STABLE is upkeep-only (owner exit); changeAsset uses Triton wallets`
  );
  console.log(
    `[${tag}] offensive-metrics loop every ${offensiveMetricsMs / 1000}s (NORMAL only; skips OFFENSIVE/DEFENSIVE/STABLE) — comparison TTL ${getTokenComparisonCacheTtlMs() / 1000}s` +
      (changeAssetCooldownMs > 0 ? `; changeAsset cooldown ${changeAssetCooldownMs / 1000}s` : "; changeAsset cooldown disabled")
  );
  console.log(
    `[${tag}] performHarvestBatch every ${harvestMs / 3600000}h (skips mode=STABLE; gas-chunked, max send ${getUfloatHarvestBatchMaxGas()})`
  );
  console.log(
    `[${tag}] Tx gas: ${getDemeterTxGasHeadroomBps() / 1000}× headroom, min ${getTxMinGasLimit()}`
  );

  await Promise.race([
    ufloatKeeperUpkeepLoop(rpcUrl, pipeline, shardWallets, upkeepMs),
    ufloatKeeperHarvestLoop(rpcUrl, pipeline, shardWallets, harvestMs),
    ufloatKeeperOffensiveMetricsLoop(rpcUrl, pipeline, offensiveMetricsMs),
  ]);
}

/** UFloatKeeper RH V3 + V4 loops. */
export async function ufloatKeeperLoop(): Promise<void> {
  const rpcUrl = getRpcUrl();
  const wallets = resolveRhOperatorWallets();
  const pipelines = getEnabledUfloatKeeperPipelines();
  if (pipelines.length === 0) {
    throw new Error("UFloat keeper enabled but no UFloat RH pipelines are enabled");
  }

  console.log(
    `[UFloatKeeper] Starting ${pipelines.length} hardcoded RH pipeline(s) (no FloatContractManager.getAddress): ${pipelines.map((p) => `${p.label}=${p.keeperAddress}`).join(", ")}`
  );

  await Promise.race(pipelines.map((pipeline) => startUfloatKeeperPipeline(rpcUrl, pipeline, wallets)));
}
