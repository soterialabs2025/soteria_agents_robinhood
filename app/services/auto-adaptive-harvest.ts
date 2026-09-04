/**
 * Per-strategy AutoKeeper harvest due filter from poolValue (WETH TVL) tiers.
 */
import type { Address } from "viem";

import {
  getAutoHarvestIntervalMsForTvlWei,
  isAutoAdaptiveHarvestEnabled,
  getAutoKeeperHarvestIntervalMs,
} from "../config/auto-keeper-config";
import { readStrategyPoolValueWei } from "./strategy-pool-value-eligibility";

export type AutoHarvestDueRow = {
  id: number;
  stratAddr: Address;
  lastHarvest: number;
};

export type AutoHarvestDueResult = {
  dueIds: number[];
  intervalsMs: Map<number, number>;
  tvlWei: Map<number, bigint>;
};

/**
 * Strategies whose lastHarvest + TVL-tier interval is due.
 * When adaptive harvest is off, uses the fixed Auto harvest interval for all.
 */
export async function filterAutoHarvestDueIds(
  rows: readonly AutoHarvestDueRow[],
  rpcUrl: string,
  logTag: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<AutoHarvestDueResult> {
  const dueIds: number[] = [];
  const intervalsMs = new Map<number, number>();
  const tvlWei = new Map<number, bigint>();

  if (rows.length === 0) {
    return { dueIds, intervalsMs, tvlWei };
  }

  const adaptive = isAutoAdaptiveHarvestEnabled();
  const fixedMs = getAutoKeeperHarvestIntervalMs();

  for (const row of rows) {
    let tvl = 0n;
    if (adaptive) {
      const read = await readStrategyPoolValueWei(row.stratAddr, rpcUrl);
      tvl = read ?? 0n;
    }
    tvlWei.set(row.id, tvl);

    const intervalMs = adaptive ? getAutoHarvestIntervalMsForTvlWei(tvl) : fixedMs;
    intervalsMs.set(row.id, intervalMs);

    const intervalSec = Math.max(1, Math.floor(intervalMs / 1000));
    const last = row.lastHarvest > 0 ? row.lastHarvest : 0;
    if (nowSec >= last + intervalSec) {
      dueIds.push(row.id);
    }
  }

  if (adaptive) {
    const dueParts = dueIds.map((id) => {
      const tvl = tvlWei.get(id) ?? 0n;
      const eth = Number(tvl) / 1e18;
      const hrs = (intervalsMs.get(id) ?? 0) / 3_600_000;
      return `${id}@${eth.toFixed(4)}ETH/${hrs}h`;
    });
    console.log(
      `[${logTag}] Adaptive harvest: ${dueIds.length}/${rows.length} due [${dueParts.join(", ") || "none"}]`
    );
  }

  return { dueIds, intervalsMs, tvlWei };
}
