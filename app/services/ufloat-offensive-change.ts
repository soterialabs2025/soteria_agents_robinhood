/**
 * UFloat offensive-metrics loop (separate from post-upkeep DEFENSIVE in ufloat-defensive-change):
 * - **Offensive-metrics loop** — allowlist ∩ V4 universe + momentum → changeAsset (NORMAL only)
 *
 * mode=OFFENSIVE: contract handles position — no offensive-metrics loop.
 * mode=DEFENSIVE: post-upkeep default-metrics pass in {@link handleUFloatDefensiveAfterUpkeep}.
 * mode=STABLE: upkeep only — owner exits STABLE (contract stop-loss or manual).
 */
import type { Address } from "viem";

import { UFLOAT_STRATEGY_MODE, formatUFloatStrategyMode } from "../abi/contract-enums";
import { getCachedTokenComparisonV4 } from "./token-comparison-cache";
import { COINGECKO_NETWORK } from "../config/chain-config";
import { isTritonWethAddress } from "../action-providers/liquid-strat-min-v4-action-provider";
import { getTopActionableOffensiveScore } from "../config/demeter-config";
import { checkDemeterStopSignal, sleepWithStopCheck } from "../config/demeter-stop";
import {
  getTritonRankingEligibilityThresholds,
  getTritonScheduledChangeMinWeightedScore,
  getUfloatApplyScheduledChangeMinWeightedScore,
  getUfloatChangeAssetCooldownMs,
  getUfloatOffensiveIntervalMs,
  TRITON_WETH_ADDRESS,
} from "../config/triton-config";
import {
  buildUfloatPoolByTokenMap,
  filterAllowedWithPoolMapping,
  readUFloatAllowedTokenAddresses,
  readUFloatStratMethod,
  readUFloatStrategyAsset,
  readUFloatStrategyMode,
  sendUFloatStrategyChangeAsset,
  formatUFloatChangeAssetSuccessLog,
  UFLOAT_STABLE_MODE,
  type UFloatDefensiveStrategyRow,
} from "./ufloat-defensive-change";
import {
  formatUFloatStratMethod,
  ufloatStratMethodAllowsOffensiveMetricsLoop,
} from "./ufloat-strat-method";
import { allowlistCacheKey } from "./token-comparison-cache";
import {
  enqueueUfloatWalletTx,
  getUfloatTxWallet,
  getUfloatTxWalletIds,
  type UfloatTxWalletId,
} from "./ufloat-wallet-pool";
import { pickShardWalletId } from "./operator-shard";

const NORMAL_MODE = UFLOAT_STRATEGY_MODE.Normal;
const OFFENSIVE_MODE = UFLOAT_STRATEGY_MODE.Offensive;
const CHANGE_ASSET_MAX_TRIES = 5;
const CHANGE_ASSET_RETRY_MS = 30_000;
const INTER_STRATEGY_TX_GAP_MS = 2_000;

const lastOffensiveMetricsAtMs = new Map<string, number>();

function normalizeAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

type TokenSummaryRow = {
  symbol: string;
  address: string;
  volume_h12?: number;
  liquidity_usd?: number | null;
  volatility_h24?: number;
};

type OffensiveComparisonShape = {
  tokens_summary?: TokenSummaryRow[];
  weighted_ranking?: {
    ranked: Array<{ symbol: string; score: number }>;
  };
};

export type MetricsPick = {
  symbol: string;
  address: Address;
  score: number;
};

type StrategyAgentContext = {
  row: UFloatDefensiveStrategyRow;
  stratMethod: number;
  mode: number;
  asset: Address;
  allowedLc: Set<string>;
  comparable: Address[];
  allowKey: string;
};

export type AgentChangeJob = {
  walletId: UfloatTxWalletId;
  context: StrategyAgentContext;
  pick: MetricsPick;
  passLabel: string;
};

export async function fetchUFloatV4OffensiveComparison(): Promise<OffensiveComparisonShape> {
  return (await getCachedTokenComparisonV4(COINGECKO_NETWORK)) as OffensiveComparisonShape;
}

export function pickOffensiveMetricsForAllowlist(
  comparison: OffensiveComparisonShape,
  allowedLc: Set<string>,
  currentAsset: Address,
  ignoreCurrentAsset: boolean
): MetricsPick | null {
  const ranked = comparison.weighted_ranking?.ranked;
  const tokens = comparison.tokens_summary;
  if (!ranked?.length || !tokens?.length) return null;

  const allowedRanked = ranked.filter((r) => {
    const token = tokens.find((t) => t.symbol === r.symbol);
    const addr = token?.address?.toLowerCase();
    return Boolean(addr && allowedLc.has(addr));
  });
  if (allowedRanked.length === 0) return null;

  const ranking = getTritonRankingEligibilityThresholds();
  const topActionable = getTopActionableOffensiveScore(allowedRanked, tokens, {
    minVolumeH12Usd: ranking.minVolumeH12Usd,
    minPoolLiquidityUsd: ranking.minPoolLiquidityUsd,
    minVolatilityH24Usd: ranking.minVolatilityH24Usd,
    maxVolatilityH24Usd: ranking.maxVolatilityH24Usd,
    wethLower: TRITON_WETH_ADDRESS.toLowerCase(),
  });
  if (!topActionable) return null;

  if (getUfloatApplyScheduledChangeMinWeightedScore()) {
    const scoreFloor = getTritonScheduledChangeMinWeightedScore();
    if (topActionable.score < scoreFloor) return null;
  }

  const pick = tokens.find((t) => t.symbol === topActionable.symbol);
  if (!pick?.address) return null;
  if (!ignoreCurrentAsset && normalizeAddr(pick.address) === normalizeAddr(currentAsset)) return null;

  return {
    symbol: topActionable.symbol,
    address: pick.address as Address,
    score: topActionable.score,
  };
}

function isIntervalReady(stratAddr: Address, lastChangeMap: Map<string, number>, intervalMs: number): boolean {
  if (intervalMs <= 0) return true;
  const key = normalizeAddr(stratAddr);
  const lastAt = lastChangeMap.get(key) ?? 0;
  return Date.now() - lastAt >= intervalMs;
}

/**
 * Offensive-metrics periodic loop: NORMAL in-range token only.
 * Never mode=OFFENSIVE, DEFENSIVE, or STABLE (STABLE is owner-only exit).
 */
function eligibleForOffensiveMetricsLoop(mode: number, stratMethod: number): boolean {
  if (!ufloatStratMethodAllowsOffensiveMetricsLoop(stratMethod)) return false;
  if (mode === OFFENSIVE_MODE || mode === UFLOAT_STRATEGY_MODE.Defensive) return false;
  if (mode === UFLOAT_STABLE_MODE) return false;
  return mode === NORMAL_MODE;
}

async function readStrategyAgentContext(
  row: UFloatDefensiveStrategyRow,
  rpcUrl: string,
  poolByToken: Map<string, string>
): Promise<StrategyAgentContext | null> {
  const [stratMethod, mode, asset, allowed] = await Promise.all([
    readUFloatStratMethod(row.stratAddr, rpcUrl),
    readUFloatStrategyMode(row.stratAddr, rpcUrl),
    readUFloatStrategyAsset(row.stratAddr, rpcUrl),
    readUFloatAllowedTokenAddresses(row.stratAddr, rpcUrl),
  ]);

  const comparable = filterAllowedWithPoolMapping(allowed, poolByToken);
  if (comparable.length === 0) return null;

  return {
    row,
    stratMethod,
    mode,
    asset,
    allowedLc: new Set(comparable.map((a) => normalizeAddr(a))),
    comparable,
    allowKey: allowlistCacheKey(comparable.map((a) => normalizeAddr(a))),
  };
}

export function buildOffensiveMetricsJobs(
  comparison: OffensiveComparisonShape,
  contexts: StrategyAgentContext[],
  intervalMs: number
): AgentChangeJob[] {
  const walletIds = getUfloatTxWalletIds();
  const jobs: AgentChangeJob[] = [];

  for (const context of contexts) {
    if (!isIntervalReady(context.row.stratAddr, lastOffensiveMetricsAtMs, intervalMs)) {
      console.log(
        `[UFloatKeeper] strategy ${context.row.id} offensive-metrics skipped — within ${intervalMs / 1000}s interval`
      );
      continue;
    }

    const pick = pickOffensiveMetricsForAllowlist(
      comparison,
      context.allowedLc,
      context.asset,
      false
    );
    if (!pick) {
      console.log(
        `[UFloatKeeper] strategy ${context.row.id} offensive-metrics — no pick (momentum gates / allowlist)`
      );
      continue;
    }

    jobs.push({
      walletId: pickShardWalletId(context.row.id, walletIds),
      context,
      pick,
      passLabel: "offensive-metrics NORMAL",
    });
  }

  jobs.sort((a, b) => b.pick.score - a.pick.score);
  return jobs;
}

async function executeChangeJob(
  rpcUrl: string,
  job: AgentChangeJob,
  lastChangeMap: Map<string, number>
): Promise<boolean> {
  const { row } = job.context;
  const { passLabel } = job;

  console.log(
    `[UFloatKeeper] strategy ${row.id} ${passLabel} — queue ${job.pick.symbol} (score ${job.pick.score.toFixed(3)})`
  );

  let lastErr: string | null = null;
  for (let attempt = 1; attempt <= CHANGE_ASSET_MAX_TRIES; attempt++) {
    if (checkDemeterStopSignal()) {
      console.log("[UFloatKeeper] Stop signal during changeAsset retry");
      return false;
    }

    const result = await enqueueUfloatWalletTx(job.walletId, () =>
      sendUFloatStrategyChangeAsset(
        getUfloatTxWallet(job.walletId).privateKey,
        rpcUrl,
        row.stratAddr,
        job.pick.address
      )
    );

    if (result.success) {
      lastChangeMap.set(normalizeAddr(row.stratAddr), Date.now());
      console.log(formatUFloatChangeAssetSuccessLog(row.id, passLabel, result));
      return true;
    }

    lastErr = result.error;
    console.warn(
      `[UFloatKeeper] strategy ${row.id} ${passLabel} attempt ${attempt}/${CHANGE_ASSET_MAX_TRIES} failed: ${lastErr}`
    );
    if (attempt < CHANGE_ASSET_MAX_TRIES) {
      await sleepWithStopCheck(CHANGE_ASSET_RETRY_MS);
    }
  }

  console.warn(`[UFloatKeeper] strategy ${row.id} ${passLabel} failed: ${lastErr}`);
  return false;
}

async function executeJobsSequential(
  rpcUrl: string,
  jobs: AgentChangeJob[],
  lastChangeMap: Map<string, number>
): Promise<void> {
  for (let i = 0; i < jobs.length; i++) {
    await executeChangeJob(rpcUrl, jobs[i]!, lastChangeMap);
    if (i < jobs.length - 1) {
      await sleepWithStopCheck(INTER_STRATEGY_TX_GAP_MS);
    }
  }
}

async function loadOffensiveMetricsContexts(
  rpcUrl: string,
  rows: UFloatDefensiveStrategyRow[]
): Promise<StrategyAgentContext[]> {
  const poolByToken = buildUfloatPoolByTokenMap();
  const contexts: StrategyAgentContext[] = [];

  for (const row of rows) {
    try {
      const ctx = await readStrategyAgentContext(row, rpcUrl, poolByToken);
      if (!ctx) continue;

      if (ctx.mode === OFFENSIVE_MODE) {
        console.log(
          `[UFloatKeeper] strategy ${row.id} offensive-metrics skipped — mode=OFFENSIVE (contract handles position)`
        );
        continue;
      }

      if (!eligibleForOffensiveMetricsLoop(ctx.mode, ctx.stratMethod)) {
        console.log(
          `[UFloatKeeper] strategy ${row.id} offensive-metrics skipped — mode=${formatUFloatStrategyMode(ctx.mode)} stratMethod=${formatUFloatStratMethod(ctx.stratMethod)}`
        );
        continue;
      }

      if (ctx.mode === NORMAL_MODE && isTritonWethAddress(ctx.asset)) {
        console.log(
          `[UFloatKeeper] strategy ${row.id} offensive-metrics NORMAL skipped — ASSET=WETH`
        );
        continue;
      }

      contexts.push(ctx);
    } catch (e) {
      console.warn(
        `[UFloatKeeper] strategy ${row.id} offensive-metrics context read failed:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  return contexts;
}

/** @deprecated STABLE re-entry is owner-only — agent no longer runs default-metrics STABLE passes. */
export async function runUFloatDefaultMetricsStablePass(
  _rpcUrl: string,
  _rows: UFloatDefensiveStrategyRow[]
): Promise<void> {
  console.warn(
    "[UFloatKeeper] runUFloatDefaultMetricsStablePass is deprecated — mode=STABLE is upkeep-only (owner exits STABLE)"
  );
}

/** Offensive-metrics loop — NORMAL in-range token only. Not mode=OFFENSIVE, DEFENSIVE, or STABLE. */
export async function runUFloatOffensiveMetricsPass(
  rpcUrl: string,
  rows: UFloatDefensiveStrategyRow[]
): Promise<void> {
  if (rows.length === 0) return;
  if (!process.env.COIN_GECKO_API_KEY?.trim()) {
    console.warn("[UFloatKeeper] offensive-metrics loop skipped — COIN_GECKO_API_KEY not set");
    return;
  }

  const swapCooldownMs = getUfloatChangeAssetCooldownMs();
  const contexts = await loadOffensiveMetricsContexts(rpcUrl, rows);
  if (contexts.length === 0) {
    console.log("[UFloatKeeper] offensive-metrics loop — no eligible strategies");
    return;
  }

  let jobs: AgentChangeJob[] = [];
  try {
    console.log("[UFloatKeeper] offensive-metrics loop — fetching Triton V4 universe (momentum gates)");
    const comparison = await fetchUFloatV4OffensiveComparison();
    jobs = buildOffensiveMetricsJobs(comparison, contexts, swapCooldownMs);
  } catch (e) {
    console.warn(
      "[UFloatKeeper] offensive-metrics comparison failed:",
      e instanceof Error ? e.message : e
    );
    return;
  }

  if (jobs.length > 0) {
    console.log(`[UFloatKeeper] offensive-metrics loop — ${jobs.length} changeAsset job(s) queued`);
  } else {
    console.log("[UFloatKeeper] offensive-metrics loop — no picks this wake");
  }

  await executeJobsSequential(rpcUrl, jobs, lastOffensiveMetricsAtMs);
}

/** @deprecated Use {@link runUFloatDefaultMetricsStablePass}. */
export const runUFloatStableEntryPass = runUFloatDefaultMetricsStablePass;

/** @deprecated Use {@link runUFloatOffensiveMetricsPass}. */
export const runUFloatOffensiveRotatePass = runUFloatOffensiveMetricsPass;

/** @deprecated Use {@link buildOffensiveMetricsJobs}. */
export const buildOffensiveRotateJobs = buildOffensiveMetricsJobs;

/** @deprecated Use {@link pickOffensiveMetricsForAllowlist}. */
export const pickOffensiveForAllowedSet = (
  comparison: OffensiveComparisonShape,
  allowedLc: Set<string>,
  currentAsset: Address
) => pickOffensiveMetricsForAllowlist(comparison, allowedLc, currentAsset, false);

/** @deprecated */
export type OffensivePick = MetricsPick;

/** @deprecated */
export type OffensiveChangeJob = AgentChangeJob;

/** @deprecated */
export async function runUFloatOffensivePass(
  rpcUrl: string,
  rows: UFloatDefensiveStrategyRow[]
): Promise<void> {
  await runUFloatOffensiveMetricsPass(rpcUrl, rows);
}

/** @deprecated */
export function buildOffensiveChangeJobs(
  comparison: OffensiveComparisonShape,
  contexts: StrategyAgentContext[],
  intervalMs: number = getUfloatOffensiveIntervalMs()
): AgentChangeJob[] {
  return buildOffensiveMetricsJobs(comparison, contexts, intervalMs);
}
