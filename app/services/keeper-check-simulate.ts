/**
 * Off-chain remint gate: eth_call strategy.keeperCheck() with `from` = keeper contract.
 * _onlyKeeper() allows keeper, the strategy itself, OperatorRegistry operators, or owner.
 * JSON-RPC `from` is not signed. Simulate as the keeper so msg.sender matches performUpkeep.
 * Do not use Multicall3 — that would set msg.sender to the multicall (not in the allowlist).
 */
import type { Abi, Address } from "viem";
import { createPublicClient, http } from "viem";

import { getViemChain } from "../config/chain-config";

export const STRATEGY_KEEPER_CHECK_ABI = [
  {
    type: "function",
    name: "keeperCheck",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const satisfies Abi;

export type KeeperCheckRow = {
  id: number;
  stratAddr: Address;
  minIntervalSec?: number;
  lastUpkeepSec?: number;
};

export function isKeeperMinIntervalOpen(
  lastUpkeepSec: number | undefined,
  minIntervalSec: number | undefined,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!lastUpkeepSec || !minIntervalSec) return true;
  return nowSec >= lastUpkeepSec + minIntervalSec;
}

function createBatchedPublicClient(rpcUrl: string) {
  return createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl, { batch: true }),
  });
}

/**
 * Strategies whose simulated keeperCheck() returned true (remint needed).
 * Skips watched minInterval throttle first so those calls would no-op on-chain anyway.
 */
export async function filterIdsNeedingRemint(params: {
  rpcUrl: string;
  keeperAddress: Address;
  rows: readonly KeeperCheckRow[];
  logTag: string;
}): Promise<number[]> {
  const { rpcUrl, keeperAddress, rows, logTag } = params;
  if (rows.length === 0) return [];

  const intervalOpen = rows.filter((row) =>
    isKeeperMinIntervalOpen(row.lastUpkeepSec, row.minIntervalSec)
  );
  const intervalSkipped = rows.length - intervalOpen.length;
  if (intervalSkipped > 0) {
    console.log(
      `[${logTag}] Upkeep skip ${intervalSkipped} strateg${intervalSkipped === 1 ? "y" : "ies"} still in minInterval`
    );
  }
  if (intervalOpen.length === 0) return [];

  const client = createBatchedPublicClient(rpcUrl);
  const settled = await Promise.allSettled(
    intervalOpen.map((row) =>
      client.simulateContract({
        address: row.stratAddr,
        abi: STRATEGY_KEEPER_CHECK_ABI,
        functionName: "keeperCheck",
        account: keeperAddress,
      })
    )
  );

  const ids: number[] = [];
  settled.forEach((result, i) => {
    const row = intervalOpen[i]!;
    if (result.status === "fulfilled") {
      if (Boolean(result.value.result)) ids.push(row.id);
      return;
    }
    const reason = result.reason;
    console.warn(
      `[${logTag}] keeperCheck simulate failed for strategy ${row.id} (${row.stratAddr}):`,
      reason instanceof Error ? reason.message : reason
    );
  });

  console.log(
    `[${logTag}] Upkeep simulate: ${rows.length} eligible, ${intervalOpen.length} interval-open, ${ids.length} remint [${ids.join(", ") || "none"}]`
  );
  return ids;
}
