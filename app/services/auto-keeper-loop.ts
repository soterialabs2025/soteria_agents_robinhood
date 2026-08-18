/**
 * AutoKeeper pipelines (Uni V3 / Uni V4 / Sushi V3) — performUpkeepBatch + performHarvestBatch.
 * ABIs: AutoKeeperRhV3 / AutoKeeperRhV4 / AutoKeeperSv3 (identical operator surface).
 *
 * Strategy ids shard across up to 4 operator wallets (id % N). Txs serialize per address.
 * Auto strategies have no mode(); harvest uses the same active-id list as upkeep.
 */
import type { Abi, Account, Address, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getRpcUrl, explorerTxUrl } from "../config/chain-config";
import {
  createTritonPublicClient,
  createTritonWalletClient,
} from "../action-providers/liquid-strat-min-v4-action-provider";
import {
  getAutoKeeperBatchMaxGas,
  getAutoKeeperHarvestIntervalMs,
  getAutoKeeperHarvestSkipIncreaseLiquidity,
  getAutoKeeperStrategyIdAllowlist,
  getAutoKeeperUpkeepIntervalMs,
} from "../config/auto-keeper-config";
import {
  getEnabledAutoKeeperPipelines,
  type AutoKeeperPipeline,
} from "../config/rh-keeper-pipelines";
import { checkDemeterStopSignal, sleepWithStopCheck } from "../config/demeter-stop";
import {
  getDemeterTxGasHeadroomBps,
  getTxMinGasLimit,
  isTxOutOfGasError,
  resolveBatchTxGasLimit,
  resolveTxGasLimit,
} from "../config/demeter-tx-gas";
import { filterRegisteredOperatorWallets } from "./operator-registry";
import { groupStrategyIdsByShard } from "./operator-shard";
import { enqueueSerializedAddressTx } from "./operator-tx-queue";
import {
  resolveRhOperatorWallets,
  type RhOperatorWallet,
} from "./rh-operator-pool";
import { filterActiveByMinPoolValue, MIN_STRATEGY_POOL_VALUE_WEI } from "./strategy-pool-value-eligibility";

const AUTO_KEEPER_TX_MAX_ATTEMPTS = 3;

function isNonceTooLowError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /nonce too low|nonce provided for the transaction is lower/i.test(msg);
}

export type AutoKeeperBatchFunction = "performUpkeepBatch" | "performHarvestBatch";

export type AutoWatchedRow = {
  id: number;
  stratAddr: Address;
  minInterval: number;
  lastUpkeep: number;
  lastHarvest: number;
  active: boolean;
};

function normalizePk(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

export async function readAutoKeeperOperatorRegistry(
  keeperAddress: Address,
  rpcUrl: string,
  abi: Abi
): Promise<Address> {
  const client = createTritonPublicClient(rpcUrl);
  return (await client.readContract({
    address: keeperAddress,
    abi,
    functionName: "operatorRegistry",
  })) as Address;
}

/** AutoKeeper.operatorRegistry for isOperator checks (not AutoFactory). */
export async function getConfiguredAutoOperatorRegistry(rpcUrl: string): Promise<Address> {
  const pipeline = getEnabledAutoKeeperPipelines()[0] ?? null;
  if (!pipeline) {
    throw new Error("No AutoKeeper pipelines enabled");
  }
  return readAutoKeeperOperatorRegistry(pipeline.keeperAddress, rpcUrl, pipeline.abi);
}

/** Load watched[] rows; strategy id = 0-based index. */
export async function listAutoWatchedRows(
  keeperAddress: Address,
  rpcUrl: string,
  abi: Abi
): Promise<AutoWatchedRow[]> {
  const client = createTritonPublicClient(rpcUrl);
  const len = Number(
    await client.readContract({
      address: keeperAddress,
      abi,
      functionName: "strategiesLength",
    })
  );
  const rows: AutoWatchedRow[] = [];
  for (let id = 0; id < len; id++) {
    const row = await client.readContract({
      address: keeperAddress,
      abi,
      functionName: "watched",
      args: [BigInt(id)],
    });
    const [stratAddr, minInterval, lastUpkeep, lastHarvest, active] = row as readonly [
      Address,
      number,
      number,
      number,
      boolean,
    ];
    rows.push({
      id,
      stratAddr,
      minInterval: Number(minInterval),
      lastUpkeep: Number(lastUpkeep),
      lastHarvest: Number(lastHarvest),
      active: Boolean(active),
    });
  }
  return rows;
}

/** Active for keeper txs: watched.active && strat ≠ 0 && poolValue ≥ {@link MIN_STRATEGY_POOL_VALUE_WEI}. */
export async function activeAutoStrategyIds(
  rows: AutoWatchedRow[],
  rpcUrl: string
): Promise<number[]> {
  const allowlist = getAutoKeeperStrategyIdAllowlist();
  const allowSet = allowlist ? new Set(allowlist) : null;
  const eligible = await filterActiveByMinPoolValue(rows, rpcUrl, "AutoKeeper");
  return eligible
    .filter((r) => (allowSet ? allowSet.has(r.id) : true))
    .map((r) => r.id);
}

function batchArgs(
  functionName: AutoKeeperBatchFunction,
  ids: number[],
  skipIncreaseLiquidity: boolean
): readonly unknown[] {
  const idArgs = ids.map((id) => BigInt(id));
  if (functionName === "performHarvestBatch") {
    return [idArgs, skipIncreaseLiquidity];
  }
  return [idArgs];
}

async function estimateBatchSendGas(
  publicClient: PublicClient,
  account: Account,
  keeperAddress: Address,
  abi: Abi,
  functionName: AutoKeeperBatchFunction,
  ids: number[],
  skipIncreaseLiquidity: boolean
): Promise<bigint> {
  const raw = await publicClient.estimateContractGas({
    account,
    address: keeperAddress,
    abi,
    functionName,
    args: batchArgs(functionName, ids, skipIncreaseLiquidity) as never,
  });
  return ids.length > 1 ? resolveBatchTxGasLimit(raw) : resolveTxGasLimit(raw);
}

/**
 * Split strategy ids into chunks under {@link getAutoKeeperBatchMaxGas}
 * (same greedy pack as UFloatKeeper).
 */
export async function chunkAutoKeeperIdsByGas(params: {
  publicClient: PublicClient;
  account: Account;
  keeperAddress: Address;
  abi: Abi;
  functionName: AutoKeeperBatchFunction;
  ids: number[];
  skipIncreaseLiquidity: boolean;
  maxGas?: bigint;
}): Promise<number[][]> {
  const { publicClient, account, keeperAddress, abi, functionName, ids, skipIncreaseLiquidity } =
    params;
  const maxGas = params.maxGas ?? getAutoKeeperBatchMaxGas(functionName);
  if (ids.length === 0) return [];

  const fullGas = await estimateBatchSendGas(
    publicClient,
    account,
    keeperAddress,
    abi,
    functionName,
    ids,
    skipIncreaseLiquidity
  );
  if (fullGas <= maxGas) return [ids];

  const chunks: number[][] = [];
  let cursor = 0;
  while (cursor < ids.length) {
    let chunk: number[] = [];

    while (cursor < ids.length) {
      const nextId = ids[cursor]!;
      const trial = [...chunk, nextId];
      let trialGas: bigint;
      try {
        trialGas = await estimateBatchSendGas(
          publicClient,
          account,
          keeperAddress,
          abi,
          functionName,
          trial,
          skipIncreaseLiquidity
        );
      } catch {
        if (chunk.length === 0) {
          console.warn(
            `[AutoKeeper] ${functionName} gas estimate failed for id ${nextId} — sending singleton chunk`
          );
          chunks.push([nextId]);
          cursor += 1;
          chunk = [];
          break;
        }
        break;
      }

      if (trialGas <= maxGas || chunk.length === 0) {
        chunk = trial;
        cursor += 1;
        if (trialGas > maxGas && chunk.length === 1) {
          console.warn(
            `[AutoKeeper] ${functionName} id ${nextId} alone uses ${trialGas} gas (cap ${maxGas}) — sending anyway`
          );
          break;
        }
        continue;
      }
      break;
    }

    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }

  if (chunks.length > 1) {
    console.log(
      `[AutoKeeper] ${functionName} gas chunking: ${ids.length} ids → ${chunks.length} batch(es) (max gas ${maxGas})`
    );
  }
  return chunks;
}

async function submitAutoBatchTxOnce(
  privateKey: string,
  rpcUrl: string,
  keeperAddress: Address,
  abi: Abi,
  functionName: AutoKeeperBatchFunction,
  ids: number[],
  skipIncreaseLiquidity: boolean
): Promise<`0x${string}`> {
  const wallet = createTritonWalletClient(privateKey, rpcUrl);
  const publicClient = createTritonPublicClient(rpcUrl);
  const args = batchArgs(functionName, ids, skipIncreaseLiquidity);
  const account = wallet.account;
  if (!account) throw new Error("AutoKeeper wallet client missing account");

  let lastError: unknown;
  for (let attempt = 1; attempt <= AUTO_KEEPER_TX_MAX_ATTEMPTS; attempt++) {
    try {
      const rawEstimate = await publicClient.estimateContractGas({
        account,
        address: keeperAddress,
        abi,
        functionName,
        args,
      });
      const gas =
        ids.length > 1 ? resolveBatchTxGasLimit(rawEstimate) : resolveTxGasLimit(rawEstimate);
      const nonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });

      const hash = await wallet.writeContract({
        account,
        address: keeperAddress,
        abi,
        functionName,
        args,
        gas,
        nonce,
        chain: wallet.chain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        if (receipt.gasUsed >= gas - 50_000n) {
          throw new Error(
            `${functionName} reverted (likely OOG): ${hash} gasUsed=${receipt.gasUsed}/${gas}`
          );
        }
        throw new Error(`${functionName} reverted: ${hash}`);
      }
      console.log(
        `[AutoKeeper] ${functionName} ids [${ids.join(", ")}] gas ${gas} (estimate ${rawEstimate}, used ${receipt.gasUsed})`
      );
      return hash;
    } catch (e) {
      lastError = e;
      if (isNonceTooLowError(e) && attempt < AUTO_KEEPER_TX_MAX_ATTEMPTS) {
        console.warn(
          `[AutoKeeper] ${functionName} ids [${ids.join(", ")}] nonce too low — retry ${attempt + 1}/${AUTO_KEEPER_TX_MAX_ATTEMPTS}`
        );
        await sleepWithStopCheck(400 * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

async function submitAutoBatchTx(
  privateKey: string,
  rpcUrl: string,
  keeperAddress: Address,
  abi: Abi,
  functionName: AutoKeeperBatchFunction,
  ids: number[],
  skipIncreaseLiquidity: boolean
): Promise<`0x${string}`> {
  if (ids.length === 0) {
    throw new Error(`${functionName}: ids must not be empty`);
  }

  const account = privateKeyToAccount(normalizePk(privateKey));
  return enqueueSerializedAddressTx(account.address, async () => {
    try {
      return await submitAutoBatchTxOnce(
        privateKey,
        rpcUrl,
        keeperAddress,
        abi,
        functionName,
        ids,
        skipIncreaseLiquidity
      );
    } catch (e) {
      if (isTxOutOfGasError(e) && ids.length > 1) {
        const mid = Math.ceil(ids.length / 2);
        console.warn(
          `[AutoKeeper] ${functionName} OOG for ids [${ids.join(", ")}] — splitting into [${ids.slice(0, mid).join(", ")}] + [${ids.slice(mid).join(", ")}]`
        );
        await submitAutoBatchTxOnce(
          privateKey,
          rpcUrl,
          keeperAddress,
          abi,
          functionName,
          ids.slice(0, mid),
          skipIncreaseLiquidity
        );
        return submitAutoBatchTxOnce(
          privateKey,
          rpcUrl,
          keeperAddress,
          abi,
          functionName,
          ids.slice(mid),
          skipIncreaseLiquidity
        );
      }
      throw e;
    }
  });
}

async function runAutoKeeperBatches(
  wallet: RhOperatorWallet,
  rpcUrl: string,
  pipeline: AutoKeeperPipeline,
  functionName: AutoKeeperBatchFunction,
  ids: number[],
  label: string
): Promise<void> {
  const tag = pipeline.label;
  if (ids.length === 0) {
    console.log(`[${tag}] [${wallet.id}] ${label} skipped — no active watched strategies`);
    return;
  }

  const skipIncreaseLiquidity = getAutoKeeperHarvestSkipIncreaseLiquidity();
  const walletClient = createTritonWalletClient(wallet.privateKey, rpcUrl);
  const publicClient = createTritonPublicClient(rpcUrl);
  const chunks = await chunkAutoKeeperIdsByGas({
    publicClient,
    account: walletClient.account,
    keeperAddress: pipeline.keeperAddress,
    abi: pipeline.abi,
    functionName,
    ids,
    skipIncreaseLiquidity,
  });

  for (const chunk of chunks) {
    try {
      const hash = await submitAutoBatchTx(
        wallet.privateKey,
        rpcUrl,
        pipeline.keeperAddress,
        pipeline.abi,
        functionName,
        chunk,
        skipIncreaseLiquidity
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

async function runShardedAutoBatches(
  rpcUrl: string,
  pipeline: AutoKeeperPipeline,
  wallets: RhOperatorWallet[],
  functionName: AutoKeeperBatchFunction,
  ids: number[],
  label: string
): Promise<void> {
  const walletIds = wallets.map((w) => w.id);
  const groups = groupStrategyIdsByShard(ids, walletIds);
  await Promise.all(
    wallets.map(async (wallet) => {
      const shardIds = groups.get(wallet.id) ?? [];
      if (shardIds.length === 0) return;
      await runAutoKeeperBatches(wallet, rpcUrl, pipeline, functionName, shardIds, label);
    })
  );
}

async function autoKeeperUpkeepLoop(
  rpcUrl: string,
  pipeline: AutoKeeperPipeline,
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
      const rows = await listAutoWatchedRows(pipeline.keeperAddress, rpcUrl, pipeline.abi);
      const ids = await activeAutoStrategyIds(rows, rpcUrl);
      await runShardedAutoBatches(rpcUrl, pipeline, wallets, "performUpkeepBatch", ids, "Upkeep");
    } catch (e) {
      console.error(`[${tag}] Upkeep loop error:`, e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}

async function autoKeeperHarvestLoop(
  rpcUrl: string,
  pipeline: AutoKeeperPipeline,
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
      const rows = await listAutoWatchedRows(pipeline.keeperAddress, rpcUrl, pipeline.abi);
      const ids = await activeAutoStrategyIds(rows, rpcUrl);
      await runShardedAutoBatches(rpcUrl, pipeline, wallets, "performHarvestBatch", ids, "Harvest");
    } catch (e) {
      console.error(`[${tag}] Harvest loop error:`, e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}

async function startAutoKeeperPipeline(
  rpcUrl: string,
  pipeline: AutoKeeperPipeline,
  wallets: RhOperatorWallet[]
): Promise<void> {
  const tag = pipeline.label;
  const operatorRegistry = await readAutoKeeperOperatorRegistry(
    pipeline.keeperAddress,
    rpcUrl,
    pipeline.abi
  );
  if (operatorRegistry.toLowerCase() !== pipeline.operatorRegistryAddress.toLowerCase()) {
    console.warn(
      `[${tag}] operatorRegistry ${operatorRegistry} ≠ configured ${pipeline.operatorRegistryAddress} — isOperator uses on-chain registry`
    );
  }
  const shardWallets = await filterRegisteredOperatorWallets(
    wallets,
    rpcUrl,
    operatorRegistry,
    tag
  );

  const upkeepMs = getAutoKeeperUpkeepIntervalMs();
  const harvestMs = getAutoKeeperHarvestIntervalMs();
  const rows = await listAutoWatchedRows(pipeline.keeperAddress, rpcUrl, pipeline.abi);
  const activeIds = await activeAutoStrategyIds(rows, rpcUrl);
  const skipLiq = getAutoKeeperHarvestSkipIncreaseLiquidity();

  console.log(`[${tag}] Loop starting (sharded ×${shardWallets.length})`);
  console.log(`[${tag}] Keeper: ${pipeline.keeperAddress} (hardcoded, no manager lookup)`);
  console.log(`[${tag}] Factory: ${pipeline.factoryAddress}`);
  console.log(`[${tag}] SwapRouter: ${pipeline.swapRouterAddress}`);
  console.log(`[${tag}] OperatorRegistry: ${operatorRegistry}`);
  for (const w of shardWallets) {
    console.log(`[${tag}] Operator wallet ${w.id}: ${w.address}`);
  }
  console.log(
    `[${tag}] Active strategy ids (watched.active && pool+idle≥${MIN_STRATEGY_POOL_VALUE_WEI}): [${activeIds.join(", ") || "none"}]`
  );
  console.log(
    `[${tag}] performUpkeepBatch every ${upkeepMs / 1000}s (gas-chunked, shard id % ${shardWallets.length}, max send ${getAutoKeeperBatchMaxGas("performUpkeepBatch")})`
  );
  console.log(
    `[${tag}] performHarvestBatch every ${harvestMs / 3600000}h (skipIncreaseLiquidity=${skipLiq}; gas-chunked, max send ${getAutoKeeperBatchMaxGas("performHarvestBatch")})`
  );
  console.log(
    `[${tag}] Tx gas: ${getDemeterTxGasHeadroomBps() / 1000}× headroom (batch), min ${getTxMinGasLimit()}`
  );

  await Promise.race([
    autoKeeperUpkeepLoop(rpcUrl, pipeline, shardWallets, upkeepMs),
    autoKeeperHarvestLoop(rpcUrl, pipeline, shardWallets, harvestMs),
  ]);
}

/** AutoKeeper upkeep + harvest on all enabled RH pipelines. */
export async function autoKeeperLoop(): Promise<void> {
  const rpcUrl = getRpcUrl();
  const wallets = resolveRhOperatorWallets();
  const pipelines = getEnabledAutoKeeperPipelines();
  if (pipelines.length === 0) {
    throw new Error("AUTO_KEEPER_ENABLED but no AutoKeeper pipelines are enabled");
  }

  console.log(
    `[AutoKeeper] Starting ${pipelines.length} pipeline(s): ${pipelines.map((p) => p.label).join(", ")}`
  );

  await Promise.race(pipelines.map((pipeline) => startAutoKeeperPipeline(rpcUrl, pipeline, wallets)));
}
