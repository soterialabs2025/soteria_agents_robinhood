/**
 * Smoke: minInterval helper + live keeperCheck from=keeper vs from=operator.
 * Run: npx tsx scripts/keeper-check-simulate-smoke.ts
 */
import "dotenv/config";
import { zeroAddress } from "viem";

import { getRpcUrl } from "../app/config/chain-config";
import { getEnabledAutoKeeperPipelines } from "../app/config/rh-keeper-pipelines";
import {
  filterIdsNeedingRemint,
  isKeeperMinIntervalOpen,
  STRATEGY_KEEPER_CHECK_ABI,
} from "../app/services/keeper-check-simulate";
import { listAutoWatchedRows } from "../app/services/auto-keeper-loop";
import { createTritonPublicClient } from "../app/action-providers/liquid-strat-min-v4-action-provider";
import { resolveRhOperatorWallets } from "../app/services/rh-operator-pool";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log("ok:", msg);
}

async function main() {
  const now = 1_700_000_000;
  assert(isKeeperMinIntervalOpen(undefined, 60, now) === true, "missing lastUpkeep → open");
  assert(isKeeperMinIntervalOpen(0, 60, now) === true, "lastUpkeep=0 → open");
  assert(isKeeperMinIntervalOpen(now, 0, now) === true, "minInterval=0 → open");
  assert(isKeeperMinIntervalOpen(now - 10, 60, now) === false, "inside window → closed");
  assert(isKeeperMinIntervalOpen(now - 60, 60, now) === true, "exactly at window → open");
  assert(isKeeperMinIntervalOpen(now - 61, 60, now) === true, "past window → open");

  const rpcUrl = getRpcUrl();
  const pipelines = getEnabledAutoKeeperPipelines();
  if (pipelines.length === 0) {
    console.log("skip live: no AutoKeeper pipelines enabled");
    return;
  }

  const operator = (() => {
    try {
      return resolveRhOperatorWallets()[0]?.address;
    } catch {
      return undefined;
    }
  })();

  const client = createTritonPublicClient(rpcUrl);

  for (const pipeline of pipelines) {
    const rows = await listAutoWatchedRows(pipeline.keeperAddress, rpcUrl, pipeline.abi);
    const sample = rows.find((r) => r.active && r.stratAddr !== zeroAddress);
    if (!sample) {
      console.log(`[${pipeline.label}] skip live: no active strategy`);
      continue;
    }

    console.log(
      `[${pipeline.label}] sample watched[${sample.id}] ${sample.stratAddr} keeper=${pipeline.keeperAddress}`
    );

    const fromKeeper = await client.simulateContract({
      address: sample.stratAddr,
      abi: STRATEGY_KEEPER_CHECK_ABI,
      functionName: "keeperCheck",
      account: pipeline.keeperAddress,
    });
    console.log(`[${pipeline.label}] keeperCheck from=keeper →`, Boolean(fromKeeper.result));

    if (operator) {
      try {
        const fromOperator = await client.simulateContract({
          address: sample.stratAddr,
          abi: STRATEGY_KEEPER_CHECK_ABI,
          functionName: "keeperCheck",
          account: operator,
        });
        console.log(
          `[${pipeline.label}] keeperCheck from=operator →`,
          Boolean(fromOperator.result),
          "(expected: _onlyKeeper allows OperatorRegistry operators)"
        );
      } catch (e) {
        console.log(
          `[${pipeline.label}] keeperCheck from=operator reverted (_onlyKeeper):`,
          e instanceof Error ? e.message : e
        );
      }
    } else {
      console.log(`[${pipeline.label}] skip from=operator check (no operator wallet)`);
    }

    const remintIds = await filterIdsNeedingRemint({
      rpcUrl,
      keeperAddress: pipeline.keeperAddress,
      rows: rows
        .filter((r) => r.active && r.stratAddr !== zeroAddress)
        .map((r) => ({
          id: r.id,
          stratAddr: r.stratAddr,
          minIntervalSec: r.minInterval,
          lastUpkeepSec: r.lastUpkeep,
        })),
      logTag: pipeline.label,
    });
    assert(Array.isArray(remintIds), `${pipeline.label} filterIdsNeedingRemint returns an array`);
    console.log(`[${pipeline.label}] remint ids:`, remintIds);
  }

  console.log("\nkeeper-check-simulate-smoke: all assertions passed");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
