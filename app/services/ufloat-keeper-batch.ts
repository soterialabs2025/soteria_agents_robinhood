/**
 * Gas-aware chunking for UFloatKeeper batch calls (performUpkeepBatch / performHarvestBatch).
 */
import type { Abi, Account, Address, PublicClient } from "viem";

import { getUfloatKeeperBatchMaxGas } from "../config/token-comparison-cache-config";
import { resolveBatchTxGasLimit, resolveTxGasLimit } from "../config/demeter-tx-gas";

export type UfloatKeeperBatchFunction = "performUpkeepBatch" | "performHarvestBatch";

function batchArgsForFunction(
  fn: UfloatKeeperBatchFunction,
  ids: number[]
): readonly unknown[] {
  const idArgs = ids.map((id) => BigInt(id));
  if (fn === "performHarvestBatch") {
    return [idArgs, false] as const;
  }
  return [idArgs] as const;
}

/** Raw on-chain estimate (no min floor — for chunking only). */
async function estimateBatchGasRaw(
  publicClient: PublicClient,
  account: Account,
  keeperAddress: Address,
  abi: Abi,
  functionName: UfloatKeeperBatchFunction,
  ids: number[]
): Promise<bigint> {
  if (ids.length === 0) return 0n;
  return publicClient.estimateContractGas({
    account,
    address: keeperAddress,
    abi,
    functionName,
    args: batchArgsForFunction(functionName, ids) as never,
  });
}

/** Projected gas limit we would send for this batch (used for chunk sizing). */
async function estimateBatchSendGas(
  publicClient: PublicClient,
  account: Account,
  keeperAddress: Address,
  abi: Abi,
  functionName: UfloatKeeperBatchFunction,
  ids: number[]
): Promise<bigint> {
  const raw = await estimateBatchGasRaw(
    publicClient,
    account,
    keeperAddress,
    abi,
    functionName,
    ids
  );
  return ids.length > 1 ? resolveBatchTxGasLimit(raw) : resolveTxGasLimit(raw);
}

/**
 * Split strategy ids into chunks where each batch fits under {@link getUfloatKeeperBatchMaxGas}.
 * Greedy pack; falls back to singleton chunks when one id exceeds the cap.
 */
export async function chunkUfloatKeeperIdsByGas(params: {
  publicClient: PublicClient;
  account: Account;
  keeperAddress: Address;
  abi: Abi;
  functionName: UfloatKeeperBatchFunction;
  ids: number[];
  maxGas?: bigint;
}): Promise<number[][]> {
  const { publicClient, account, keeperAddress, abi, functionName, ids } = params;
  const maxGas = params.maxGas ?? getUfloatKeeperBatchMaxGas(functionName);
  if (ids.length === 0) return [];

  const fullGas = await estimateBatchSendGas(
    publicClient,
    account,
    keeperAddress,
    abi,
    functionName,
    ids
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
          trial
        );
      } catch {
        if (chunk.length === 0) {
          console.warn(
            `[UFloatKeeper] ${functionName} gas estimate failed for id ${nextId} — sending singleton chunk`
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
            `[UFloatKeeper] ${functionName} id ${nextId} alone uses ${trialGas} gas (cap ${maxGas}) — sending anyway`
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
      `[UFloatKeeper] ${functionName} gas chunking: ${ids.length} ids → ${chunks.length} batch(es) (max gas ${maxGas})`
    );
  }
  return chunks;
}
