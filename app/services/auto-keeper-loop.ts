/**
 * AutoKeeper (AutoVault V3 RH) — performUpkeepBatch + performHarvestBatch only.
 * ABI: `app/abi/auto-vaults-rh/AutoKeeper.abi.json`.
 *
 * 1. AutoKeeperV3Rh + AutoFactoryV3Rh (Robinhood defaults; env override)
 * 2. Read watched[] via strategiesLength + watched(id)
 * 3. Collect active strategy ids (optional AUTO_KEEPER_STRATEGY_IDS allowlist)
 * 4. performUpkeepBatch(ids) gas-chunked on upkeep interval
 * 5. performHarvestBatch(ids, skipIncreaseLiquidity) gas-chunked on harvest interval
 *    — skips mode=STABLE (no NEUTRAL; AutoStrategyV3Rh is NORMAL/DEFENSIVE/OFFENSIVE/STABLE)
 *
 * Uses the same batch gas model as Float/UFloat keepers ({@link resolveBatchTxGasLimit}).
 */
import type { Abi, Account, Address, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { AUTO_STRATEGY_MODE } from "../abi/contract-enums";
import autoKeeperRhAbi from "../abi/auto-vaults-rh/AutoKeeper.abi.json";
import autoStrategyRhAbi from "../abi/auto-vaults-rh/AutoStrategyV3Rh.abi.json";
import { getRpcUrl, explorerTxUrl } from "../config/chain-config";
import {
  createTritonPublicClient,
  createTritonWalletClient,
} from "../action-providers/liquid-strat-min-v4-action-provider";
import {
  getAutoKeeperBatchMaxGas,
  getAutoKeeperHarvestIntervalMs,
  getAutoKeeperHarvestSkipIncreaseLiquidity,
  getAutoKeeperPrivateKey,
  getAutoKeeperStrategyIdAllowlist,
  getAutoKeeperUpkeepIntervalMs,
  getAutoOperatorRegistryAddress,
  getAutoSwapRouterAddress,
  resolveAutoFactoryAddress,
  resolveAutoKeeperAddress,
} from "../config/auto-keeper-config";
import { checkDemeterStopSignal, sleepWithStopCheck } from "../config/demeter-stop";
import {
  getDemeterTxGasHeadroomBps,
  getTxMinGasLimit,
  isTxOutOfGasError,
  resolveBatchTxGasLimit,
  resolveTxGasLimit,
} from "../config/demeter-tx-gas";
import { readOperatorRegistryIsOperator } from "./operator-registry";
import { enqueueSerializedAddressTx } from "./operator-tx-queue";
import { filterActiveByMinPoolValue, MIN_STRATEGY_POOL_VALUE_WEI } from "./strategy-pool-value-eligibility";

const AUTO_KEEPER_ABI = autoKeeperRhAbi as Abi;
const AUTO_STRATEGY_ABI = autoStrategyRhAbi as Abi;
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
  rpcUrl: string
): Promise<Address> {
  const client = createTritonPublicClient(rpcUrl);
  return (await client.readContract({
    address: keeperAddress,
    abi: AUTO_KEEPER_ABI,
    functionName: "operatorRegistry",
  })) as Address;
}

/** AutoKeeper.operatorRegistry for isOperator checks (not AutoFactory). */
export async function getConfiguredAutoOperatorRegistry(rpcUrl: string): Promise<Address> {
  const keeper = await resolveAutoKeeperAddress(rpcUrl);
  return readAutoKeeperOperatorRegistry(keeper, rpcUrl);
}

/** Load watched[] rows; strategy id = 0-based index. */
export async function listAutoWatchedRows(
  keeperAddress: Address,
  rpcUrl: string
): Promise<AutoWatchedRow[]> {
  const client = createTritonPublicClient(rpcUrl);
  const len = Number(
    await client.readContract({
      address: keeperAddress,
      abi: AUTO_KEEPER_ABI,
      functionName: "strategiesLength",
    })
  );
  const rows: AutoWatchedRow[] = [];
  for (let id = 0; id < len; id++) {
    const row = await client.readContract({
      address: keeperAddress,
      abi: AUTO_KEEPER_ABI,
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

export async function readAutoStrategyMode(
  strategyAddress: Address,
  rpcUrl: string
): Promise<number> {
  const client = createTritonPublicClient(rpcUrl);
  const mode = await client.readContract({
    address: strategyAddress,
    abi: AUTO_STRATEGY_ABI,
    functionName: "mode",
  });
  return Number(mode);
}

/** Harvest ids — same as {@link activeAutoStrategyIds} minus mode=STABLE (no LP). */
export async function activeAutoHarvestStrategyIds(
  rows: AutoWatchedRow[],
  rpcUrl: string
): Promise<number[]> {
  const active = await activeAutoStrategyIds(rows, rpcUrl);
  const activeSet = new Set(active);
  const ids: number[] = [];
  for (const row of rows) {
    if (!activeSet.has(row.id)) continue;
    try {
      const mode = await readAutoStrategyMode(row.stratAddr, rpcUrl);
      if (mode === AUTO_STRATEGY_MODE.Stable) continue;
      ids.push(row.id);
    } catch (e) {
      console.warn(
        `[AutoKeeper] harvest eligibility read failed for strategy ${row.id}:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  return ids;
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
  functionName: AutoKeeperBatchFunction,
  ids: number[],
  skipIncreaseLiquidity: boolean
): Promise<bigint> {
  const raw = await publicClient.estimateContractGas({
    account,
    address: keeperAddress,
    abi: AUTO_KEEPER_ABI,
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
  functionName: AutoKeeperBatchFunction;
  ids: number[];
  skipIncreaseLiquidity: boolean;
  maxGas?: bigint;
}): Promise<number[][]> {
  const { publicClient, account, keeperAddress, functionName, ids, skipIncreaseLiquidity } =
    params;
  const maxGas = params.maxGas ?? getAutoKeeperBatchMaxGas(functionName);
  if (ids.length === 0) return [];

  const fullGas = await estimateBatchSendGas(
    publicClient,
    account,
    keeperAddress,
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
        abi: AUTO_KEEPER_ABI,
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
        abi: AUTO_KEEPER_ABI,
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
          functionName,
          ids.slice(0, mid),
          skipIncreaseLiquidity
        );
        return submitAutoBatchTxOnce(
          privateKey,
          rpcUrl,
          keeperAddress,
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
  privateKey: string,
  rpcUrl: string,
  keeperAddress: Address,
  functionName: AutoKeeperBatchFunction,
  ids: number[],
  label: string
): Promise<void> {
  if (ids.length === 0) {
    console.log(`[AutoKeeper] ${label} skipped — no active watched strategies`);
    return;
  }

  const skipIncreaseLiquidity = getAutoKeeperHarvestSkipIncreaseLiquidity();
  const wallet = createTritonWalletClient(privateKey, rpcUrl);
  const publicClient = createTritonPublicClient(rpcUrl);
  const chunks = await chunkAutoKeeperIdsByGas({
    publicClient,
    account: wallet.account,
    keeperAddress,
    functionName,
    ids,
    skipIncreaseLiquidity,
  });

  for (const chunk of chunks) {
    try {
      const hash = await submitAutoBatchTx(
        privateKey,
        rpcUrl,
        keeperAddress,
        functionName,
        chunk,
        skipIncreaseLiquidity
      );
      console.log(
        `[AutoKeeper] ${functionName} ids [${chunk.join(", ")}] tx ${hash} ${explorerTxUrl(hash)}`
      );
    } catch (e) {
      console.warn(
        `[AutoKeeper] ${functionName} ids [${chunk.join(", ")}] failed:`,
        e instanceof Error ? e.message : e
      );
    }
    if (chunks.length > 1) {
      await sleepWithStopCheck(500);
    }
  }
}

async function autoKeeperUpkeepLoop(
  privateKey: string,
  rpcUrl: string,
  keeperAddress: Address,
  intervalMs: number
): Promise<never> {
  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[AutoKeeper] Stop signal — exiting upkeep loop");
      return undefined as never;
    }
    try {
      const rows = await listAutoWatchedRows(keeperAddress, rpcUrl);
      const ids = await activeAutoStrategyIds(rows, rpcUrl);
      await runAutoKeeperBatches(
        privateKey,
        rpcUrl,
        keeperAddress,
        "performUpkeepBatch",
        ids,
        "Upkeep"
      );
    } catch (e) {
      console.error("[AutoKeeper] Upkeep loop error:", e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}

async function autoKeeperHarvestLoop(
  privateKey: string,
  rpcUrl: string,
  keeperAddress: Address,
  intervalMs: number
): Promise<never> {
  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[AutoKeeper] Stop signal — exiting harvest loop");
      return undefined as never;
    }
    try {
      const rows = await listAutoWatchedRows(keeperAddress, rpcUrl);
      const allActiveIds = await activeAutoStrategyIds(rows, rpcUrl);
      const ids = await activeAutoHarvestStrategyIds(rows, rpcUrl);
      if (allActiveIds.length > ids.length) {
        console.log(
          `[AutoKeeper] Harvest skipping ${allActiveIds.length - ids.length} mode=STABLE strateg${allActiveIds.length - ids.length === 1 ? "y" : "ies"}`
        );
      }
      await runAutoKeeperBatches(
        privateKey,
        rpcUrl,
        keeperAddress,
        "performHarvestBatch",
        ids,
        "Harvest"
      );
    } catch (e) {
      console.error("[AutoKeeper] Harvest loop error:", e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}

/** AutoKeeper upkeep + harvest loops. Requires `AUTO_KEEPER_ENABLED=true` + `DEMETER_TWO_PRIVATE_KEY`. */
export async function autoKeeperLoop(): Promise<void> {
  const rpcUrl = getRpcUrl();

  const privateKey = getAutoKeeperPrivateKey();
  if (!privateKey) {
    throw new Error("DEMETER_TWO_PRIVATE_KEY is required for AutoKeeper loop");
  }

  const keeperAddress = await resolveAutoKeeperAddress(rpcUrl);
  const autoFactory = await resolveAutoFactoryAddress(rpcUrl);
  const expectedRegistry = getAutoOperatorRegistryAddress();
  const swapRouter = getAutoSwapRouterAddress();
  const operatorAddress = privateKeyToAccount(normalizePk(privateKey)).address;

  const operatorRegistry = await readAutoKeeperOperatorRegistry(keeperAddress, rpcUrl);
  if (operatorRegistry.toLowerCase() !== expectedRegistry.toLowerCase()) {
    console.warn(
      `[AutoKeeper] AutoKeeper.operatorRegistry ${operatorRegistry} ≠ configured AutoOperatorRegistry ${expectedRegistry} — isOperator uses on-chain operatorRegistry`
    );
  }

  const ok = await readOperatorRegistryIsOperator(operatorRegistry, operatorAddress, rpcUrl);
  if (!ok) {
    throw new Error(
      `DEMETER_TWO wallet ${operatorAddress} is not registered on AutoKeeper.operatorRegistry ${operatorRegistry}`
    );
  }

  const upkeepMs = getAutoKeeperUpkeepIntervalMs();
  const harvestMs = getAutoKeeperHarvestIntervalMs();
  const rows = await listAutoWatchedRows(keeperAddress, rpcUrl);
  const activeIds = await activeAutoStrategyIds(rows, rpcUrl);
  const skipLiq = getAutoKeeperHarvestSkipIncreaseLiquidity();

  console.log("[AutoKeeper] Loop starting");
  console.log(`[AutoKeeper] Keeper (AutoKeeperV3Rh): ${keeperAddress}`);
  console.log(`[AutoKeeper] AutoFactoryV3Rh: ${autoFactory}`);
  console.log(`[AutoKeeper] AutoSwapRouterV3Rh: ${swapRouter}`);
  console.log(`[AutoKeeper] OperatorRegistry: ${operatorRegistry} (AutoKeeper.operatorRegistry)`);
  console.log(`[AutoKeeper] Operator wallet (DEMETER_TWO): ${operatorAddress}`);
  console.log(
    `[AutoKeeper] Active strategy ids (watched.active && pool+idle≥${MIN_STRATEGY_POOL_VALUE_WEI}): [${activeIds.join(", ") || "none"}]`
  );
  console.log(
    `[AutoKeeper] performUpkeepBatch every ${upkeepMs / 1000}s (gas-chunked, max send ${getAutoKeeperBatchMaxGas("performUpkeepBatch")})`
  );
  console.log(
    `[AutoKeeper] performHarvestBatch every ${harvestMs / 3600000}h (skips mode=STABLE; skipIncreaseLiquidity=${skipLiq}; gas-chunked, max send ${getAutoKeeperBatchMaxGas("performHarvestBatch")})`
  );
  console.log(
    `[AutoKeeper] Tx gas: ${getDemeterTxGasHeadroomBps() / 1000}× headroom (batch), min ${getTxMinGasLimit()}`
  );

  await Promise.race([
    autoKeeperUpkeepLoop(privateKey, rpcUrl, keeperAddress, upkeepMs),
    autoKeeperHarvestLoop(privateKey, rpcUrl, keeperAddress, harvestMs),
  ]);
}
