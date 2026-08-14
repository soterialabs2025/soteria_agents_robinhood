import { customActionProvider, WalletProvider, EvmWalletProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { Address, encodeFunctionData } from "viem";

import { fetchTokenData } from "./coingecko-action-provider";
import {
  getKeeperStrategyHarvestTimestamps,
  getKeeperStrategyStats,
  getStrategyMode,
  resolveKeeperAbi,
} from "./keeper-strategy-action-provider";
import { getFloatAssetAddress, shouldStopFloatHarvestRetryAttempts } from "./float-action-provider";
import {
  defensiveStableChosenToken,
  isBlockedV4ChangeStrategyTokenAddress,
  shouldRunFloatV4MarketBreadthStableExit,
  tryFloatDefensiveStableParkWhenNoPick,
  tryFloatV4MarketBreadthStableExit,
} from "../services/float-market-breadth-stable";
import { FLOAT_STRATEGY_STABLE_MODE, STABLE_V4_WETH_ADDRESS } from "../config/demeter-config";
import { getRpcUrlOptional, WETH_ADDRESS } from "../config/chain-config";
import {
  buildFloatKeeperPipelines,
  formatFloatChangeStrategyLogTag,
  formatFloatPipelineLoopRunLog,
  formatFloatPipelineLoopSkipLog,
  shouldLogFloatPipelineLoopSkip,
  isAnyFloatPipelineStrategyOffensive,
  sleepFloatPipelineStagger,
  tickFloatPipelineLoopGate,
  type FloatKeeperPipeline,
} from "../config/float-keeper-pipeline";
import { sleepWithStopCheck } from "../config/demeter-stop";
import { getPipelineLoopThresholds } from "../config/ranking-eligibility";
import {
  getOffensiveTokenRankingMetrics,
  getTopActionableOffensiveScore,
  passesChangeStrategyVolatilityH24Band,
  isStableUsdcTokenAddress,
  buySellBuyPressureScore,
  pickStrongestBuyPressureCandidate,
  type TokenRankingMetricsMap,
} from "../config/demeter-config";
import {
  appendDemeterDefensiveOffensiveLog,
  buildOldTokenEntry,
  formatDemeterLogTimestamps,
  type DemeterChangeStrategyAuditContext,
  type DemeterChosenTokenMetrics,
  weightedCompositeScoreForSymbol,
  type WeightedRankingRowForLog,
} from "../services/demeter-defensive-offensive-log";
import {
  buildMetricCalibrationFields,
  buildTokenCalibrationMetrics,
} from "../services/metric-calibration/calibration-snapshots";
import { shouldRecordCalibrationEvent } from "../services/metric-calibration/calibration-candidates";
import { sendEvmTxWithGasHeadroom } from "../services/demeter-wallet-tx";

function buildChosenMetrics(
  chosen: {
    symbol: string;
    buy_sell_ratio_h6: number | null;
    buy_sell_ratio_h24: number | null;
  },
  options?: {
    omitBuyPressureScore?: boolean;
    weightedCompositeScore?: number;
    weighted_metric_scores?: Record<string, number>;
    offensive_ranking_raw?: Record<string, number | null>;
    chosen_token_tokens_summary?: Record<string, string | number | null>;
  }
): DemeterChosenTokenMetrics {
  const base: DemeterChosenTokenMetrics = {
    buy_sell_ratio_h6: chosen.buy_sell_ratio_h6 ?? null,
    buy_sell_ratio_h24: chosen.buy_sell_ratio_h24 ?? null,
  };
  const w =
    typeof options?.weightedCompositeScore === "number" && Number.isFinite(options.weightedCompositeScore)
      ? { weighted_composite_score: options.weightedCompositeScore }
      : {};
  const extras: Pick<
    DemeterChosenTokenMetrics,
    "weighted_metric_scores" | "offensive_ranking_raw" | "chosen_token_tokens_summary"
  > = {};
  if (options?.weighted_metric_scores && Object.keys(options.weighted_metric_scores).length > 0) {
    extras.weighted_metric_scores = options.weighted_metric_scores;
  }
  if (options?.offensive_ranking_raw && Object.keys(options.offensive_ranking_raw).length > 0) {
    extras.offensive_ranking_raw = options.offensive_ranking_raw;
  }
  if (options?.chosen_token_tokens_summary && Object.keys(options.chosen_token_tokens_summary).length > 0) {
    extras.chosen_token_tokens_summary = options.chosen_token_tokens_summary;
  }
  if (options?.omitBuyPressureScore) return { ...base, ...w, ...extras };
  return { ...base, ...w, ...extras, buyPressureScore: buySellBuyPressureScore(chosen.buy_sell_ratio_h6) };
}

function buildChangeSummary(
  oldToken: { address: string; symbol: string | null },
  chosen: { symbol: string; address: string }
): string {
  const from =
    oldToken.symbol?.trim() ||
    (oldToken.address
      ? `${oldToken.address.slice(0, 6)}…${oldToken.address.slice(-4)}`
      : "unknown");
  return `Strategy asset: ${from} → ${chosen.symbol} (${chosen.address})`;
}

const DEFENSIVE_MODE = 1;
const OFFENSIVE_MODE = 2;
const STABLE_MODE = FLOAT_STRATEGY_STABLE_MODE;
/** When OFFENSIVE and consecutiveOffensiveCount reaches this, run change strategy (same as demeter-agent). */
const OFFENSIVE_CHANGE_THRESHOLD = 20;

/** WETH on Robinhood Chain – never select; contract's WETH path fails gas estimation (same as demeter-agent). */
const WETH_BASE = WETH_ADDRESS;

/** Retry changeStrategy submissions after failures. */
const CHANGE_STRATEGY_TX_RETRY_MS = 30_000; // 30 seconds

/** Harvest submission retries (1 min); on-chain lastHarvest/PrevHarvestTime can stop retries early. */
const HARVEST_TX_RETRY_MS = 60_000;

const FLOAT_ABI = [
  {
    inputs: [{ internalType: "address", name: "_newAssetAddr", type: "address" }],
    name: "changeStrategyAsset",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/** Top N from weighted ranking to consider; then pick strongest 6h buy pressure. Matches demeter-agent. */
const TOP_N_FOR_PRICE_PICK = 4;
const CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN = 5;

/**
 * Run change strategy: comparison → top 4 by rank, then strongest buy pressure via 6h buy/sell ratio (not WETH, not current) → FloatContractManager.changeStrategyAsset.
 * Matches demeter-agent `executeChangeStrategy` (top N + buy-pressure tie-break only when `rankingMetrics` omitted).
 * Pass `rankingMetrics` for scheduled runs (offensive composite: min–max vs pre-momentum eligible cohort, `ranked` = momentum-qualified only); omit for DEFENSIVE / price-check paths (Float default).
 * Pass `minWeightedScore` > 0 with scheduled runs to require composite ≥ floor ({@link getScheduledChangeMinWeightedScore}).
 */
async function runChangeStrategy(
  walletProvider: EvmWalletProvider,
  pipeline: FloatKeeperPipeline,
  rpcUrl: string,
  audit: DemeterChangeStrategyAuditContext | null = null,
  forceChangeIfTopIsCurrent = false,
  rankingMetrics?: TokenRankingMetricsMap,
  minWeightedScore?: number
): Promise<{ changed: boolean; txHash?: string; reason?: string }> {
  const logTag = formatFloatChangeStrategyLogTag(pipeline);

  if (
    audit?.trigger !== "DEFENSIVE" &&
    audit?.trigger !== "STABLE" &&
    audit?.trigger !== "OFFENSIVE" &&
    (await isAnyFloatPipelineStrategyOffensive(pipeline, rpcUrl))
  ) {
    const msg = `${logTag} skip changeStrategyAsset: strategy OFFENSIVE`;
    console.log(`[demeter_runCycle] ${msg}`);
    return { changed: false, reason: msg };
  }

  const ts = audit ? formatDemeterLogTimestamps() : null;

  let comparisonForCalibration:
    | {
        tokens_summary?: Array<Record<string, unknown>>;
        weighted_ranking?: {
          ranked: WeightedRankingRowForLog[];
          metrics_used?: string[];
        };
      }
    | undefined;

  const logAudit = async (entry: {
    changeStrategyTransaction: string | null;
    topThreeTokens: Array<{ symbol: string; address: string }>;
    oldToken: { address: string; symbol: string | null };
    chosenToken: { symbol: string; address: string } | null;
    chosenTokenMetrics?: DemeterChosenTokenMetrics | null;
    changeSummary?: string | null;
    outcome: "success" | "skipped" | "failed";
    details?: string;
  }) => {
    if (!audit || !ts) return;
    try {
      const calibrationExtras =
        entry.outcome === "success" &&
        shouldRecordCalibrationEvent(entry.topThreeTokens) &&
        comparisonForCalibration
          ? buildMetricCalibrationFields(
              entry.topThreeTokens,
              comparisonForCalibration.weighted_ranking?.ranked,
              comparisonForCalibration.tokens_summary ?? [],
              comparisonForCalibration.weighted_ranking,
              new Date(ts.timestampUtc),
              { omitBuyPressureScore: rankingMetrics != null }
            )
          : {};
      await appendDemeterDefensiveOffensiveLog({
        trigger: audit.trigger,
        upkeepTransaction: audit.upkeepTransaction ?? null,
        strategyId: audit.strategyId,
        keeperPipeline: audit.keeperPipeline ?? "float",
        timestampUtc: ts.timestampUtc,
        timestampPacific: ts.timestampPacific,
        ...entry,
        ...calibrationExtras,
      });
    } catch (e) {
      console.error("[demeter_runCycle] DEFENSIVE/OFFENSIVE audit log failed:", e);
    }
  };

  let currentAsset = "";
  try {
    currentAsset = await getFloatAssetAddress(
      pipeline.contractManagerAddress,
      rpcUrl,
      pipeline.strategyRegistryKey
    );
  } catch {
    currentAsset = "";
  }

  const comparison = (await pipeline.fetchComparison(
    currentAsset || null,
    rankingMetrics,
    {
      forceMarketBreadthStable: audit?.trigger === "DEFENSIVE",
      disableMarketBreadth: audit?.trigger === "STABLE",
    }
  )) as {
    tokens_summary?: Array<{
      symbol: string;
      address: string;
      volume_h12?: number;
      liquidity_usd?: number | null;
      volatility_h24?: number;
      buy_sell_ratio_h6?: number | null;
      buy_sell_ratio_h24?: number | null;
    }>;
    weighted_ranking?: {
      ranked: WeightedRankingRowForLog[];
      metrics_used?: string[];
    };
  };
  comparisonForCalibration = comparison as {
    tokens_summary?: Array<Record<string, unknown>>;
    weighted_ranking?: {
      ranked: WeightedRankingRowForLog[];
      metrics_used?: string[];
    };
  };
  const ranked = comparison?.weighted_ranking?.ranked;
  const tokens = comparison?.tokens_summary;

  const oldToken = buildOldTokenEntry(currentAsset || null, tokens);

  const marketBreadthDefensiveActive =
    comparison != null &&
    typeof comparison === "object" &&
    (comparison as { market_breadth_defensive_active?: unknown }).market_breadth_defensive_active ===
      true;

  if (
    audit?.trigger !== "STABLE" &&
    (shouldRunFloatV4MarketBreadthStableExit(pipeline.strategyRegistryKey, {
      market_breadth_defensive_active: marketBreadthDefensiveActive,
    }) ||
      (marketBreadthDefensiveActive &&
        (comparison as { market_breadth_on_chain_action?: string }).market_breadth_on_chain_action ===
          "exitStrategyToStable"))
  ) {
    const stableChosen = { symbol: "WETH", address: STABLE_V4_WETH_ADDRESS };
    const stableResult = await tryFloatV4MarketBreadthStableExit(walletProvider, pipeline, rpcUrl);
    if (stableResult.kind === "skipped") {
      await logAudit({
        changeStrategyTransaction: null,
        topThreeTokens: [stableChosen],
        oldToken,
        chosenToken: stableChosen,
        chosenTokenMetrics: null,
        changeSummary: buildChangeSummary(oldToken, stableChosen),
        outcome: "skipped",
        details: stableResult.reason,
      });
      return { changed: false, reason: stableResult.reason };
    }
    if (stableResult.kind === "sent") {
      console.log(
        `[demeter_runCycle] ${logTag} exitStrategyToStable tx ${stableResult.txHash} https://robinhoodchain.blockscout.com/tx/${stableResult.txHash}`
      );
      await logAudit({
        changeStrategyTransaction: stableResult.txHash,
        topThreeTokens: [stableChosen],
        oldToken,
        chosenToken: stableChosen,
        chosenTokenMetrics: null,
        changeSummary: buildChangeSummary(oldToken, stableChosen),
        outcome: "success",
      });
      return { changed: true, txHash: stableResult.txHash };
    }
    if (stableResult.kind === "failed") {
      await logAudit({
        changeStrategyTransaction: null,
        topThreeTokens: [stableChosen],
        oldToken,
        chosenToken: stableChosen,
        chosenTokenMetrics: null,
        changeSummary: buildChangeSummary(oldToken, stableChosen),
        outcome: "failed",
        details: stableResult.error,
      });
      return { changed: false, reason: stableResult.error };
    }
  }

  if (!ranked?.length || !tokens?.length) {
    const skipDetails = "No ranked tokens from comparison";
    if (audit?.trigger === "DEFENSIVE") {
      const stableChosen = defensiveStableChosenToken(pipeline.strategyRegistryKey);
      const parkResult = await tryFloatDefensiveStableParkWhenNoPick(walletProvider, pipeline, rpcUrl);
      if (parkResult.kind === "sent") {
        console.log(
          `[demeter_runCycle] ${logTag} DEFENSIVE no pick — stable park tx ${parkResult.txHash} https://robinhoodchain.blockscout.com/tx/${parkResult.txHash}`
        );
        await logAudit({
          changeStrategyTransaction: parkResult.txHash,
          topThreeTokens: [stableChosen],
          oldToken,
          chosenToken: stableChosen,
          chosenTokenMetrics: null,
          changeSummary: buildChangeSummary(oldToken, stableChosen),
          outcome: "success",
          details: `${skipDetails}; parked to ${stableChosen.symbol}`,
        });
        return { changed: true, txHash: parkResult.txHash };
      }
      await logAudit({
        changeStrategyTransaction: null,
        topThreeTokens: [stableChosen],
        oldToken,
        chosenToken: stableChosen,
        chosenTokenMetrics: null,
        changeSummary: buildChangeSummary(oldToken, stableChosen),
        outcome: parkResult.kind === "failed" ? "failed" : "skipped",
        details:
          parkResult.kind === "failed" || parkResult.kind === "skipped"
            ? parkResult.kind === "failed"
              ? parkResult.error
              : parkResult.reason
            : skipDetails,
      });
      return {
        changed: false,
        reason:
          parkResult.kind === "failed"
            ? parkResult.error
            : parkResult.kind === "skipped"
              ? parkResult.reason
              : skipDetails,
      };
    }
    await logAudit({
      changeStrategyTransaction: null,
      topThreeTokens: [],
      oldToken,
      chosenToken: null,
      chosenTokenMetrics: null,
      changeSummary: null,
      outcome: "skipped",
      details: skipDetails,
    });
    return { changed: false, reason: skipDetails };
  }

  const loopCfg = getPipelineLoopThresholds(pipeline.id);
  const ranking = loopCfg.ranking;
  const minVol = ranking.minVolumeH12Usd;
  const minLiq = ranking.minPoolLiquidityUsd;
  const minVolatilityH24 = ranking.minVolatilityH24Usd;
  const maxVolatilityH24 = ranking.maxVolatilityH24Usd;
  const currentLower = currentAsset.toLowerCase();
  if (typeof minWeightedScore === "number" && minWeightedScore > 0) {
    const topActionable = getTopActionableOffensiveScore(ranked, tokens, {
      minVolumeH12Usd: minVol,
      minPoolLiquidityUsd: minLiq,
      minVolatilityH24Usd: minVolatilityH24,
      maxVolatilityH24Usd: maxVolatilityH24,
      wethLower: WETH_BASE.toLowerCase(),
    });
    if (topActionable && topActionable.score < minWeightedScore) {
      await logAudit({
        changeStrategyTransaction: null,
        topThreeTokens: [],
        oldToken,
        chosenToken: null,
        chosenTokenMetrics: null,
        changeSummary: null,
        outcome: "skipped",
        details: `Offensive composite ${topActionable.score.toFixed(3)} < min ${minWeightedScore} (${topActionable.symbol})`,
      });
      return {
        changed: false,
        reason: `Composite below scheduledChangeMinWeightedScore (${topActionable.score.toFixed(3)} < ${minWeightedScore})`,
      };
    }
  }
  const wethLower = WETH_BASE.toLowerCase();

  const candidates: {
    symbol: string;
    address: string;
    buy_sell_ratio_h6: number | null;
    buy_sell_ratio_h24: number | null;
  }[] = [];
  for (const { symbol } of ranked) {
    if (candidates.length >= TOP_N_FOR_PRICE_PICK) break;
    const token = tokens.find((t) => t.symbol === symbol);
    const addr = token?.address?.toLowerCase();
    if (!addr) continue;
    if (addr === wethLower) continue;
    if (audit?.trigger === "STABLE") {
      if (isStableUsdcTokenAddress(token?.address)) continue;
      if (
        pipeline.strategyRegistryKey === "FloatStrategyV4" &&
        addr === STABLE_V4_WETH_ADDRESS.toLowerCase()
      ) {
        continue;
      }
    }
    if (
      pipeline.strategyRegistryKey === "FloatStrategyV4" &&
      isBlockedV4ChangeStrategyTokenAddress(token?.address)
    ) {
      continue;
    }
    if (token && typeof token.volume_h12 === "number" && token.volume_h12 < minVol) continue;
    if (token && (typeof token.liquidity_usd !== "number" || token.liquidity_usd < minLiq)) continue;
    if (
      !passesChangeStrategyVolatilityH24Band(
        token?.volatility_h24,
        minVolatilityH24,
        maxVolatilityH24,
        token?.address
      )
    ) {
      continue;
    }
    if (forceChangeIfTopIsCurrent && currentLower && addr === currentLower) continue;
    candidates.push({
      symbol,
      address: token!.address,
      buy_sell_ratio_h6: token?.buy_sell_ratio_h6 ?? null,
      buy_sell_ratio_h24: token?.buy_sell_ratio_h24 ?? null,
    });
  }

  const topThreeTokens = candidates.map((c) => ({ symbol: c.symbol, address: c.address }));

  if (candidates.length === 0) {
    const skipDetails =
      "No eligible ranked token (excluding WETH, volume / liquidity / volatility filter, current)";
    if (audit?.trigger === "DEFENSIVE") {
      const stableChosen = defensiveStableChosenToken(pipeline.strategyRegistryKey);
      const parkResult = await tryFloatDefensiveStableParkWhenNoPick(walletProvider, pipeline, rpcUrl);
      if (parkResult.kind === "sent") {
        console.log(
          `[demeter_runCycle] ${logTag} DEFENSIVE no pick — stable park tx ${parkResult.txHash} https://robinhoodchain.blockscout.com/tx/${parkResult.txHash}`
        );
        await logAudit({
          changeStrategyTransaction: parkResult.txHash,
          topThreeTokens: [stableChosen],
          oldToken,
          chosenToken: stableChosen,
          chosenTokenMetrics: null,
          changeSummary: buildChangeSummary(oldToken, stableChosen),
          outcome: "success",
          details: `${skipDetails}; parked to ${stableChosen.symbol}`,
        });
        return { changed: true, txHash: parkResult.txHash };
      }
      await logAudit({
        changeStrategyTransaction: null,
        topThreeTokens: [stableChosen],
        oldToken,
        chosenToken: stableChosen,
        chosenTokenMetrics: null,
        changeSummary: buildChangeSummary(oldToken, stableChosen),
        outcome: parkResult.kind === "failed" ? "failed" : "skipped",
        details:
          parkResult.kind === "failed" || parkResult.kind === "skipped"
            ? parkResult.kind === "failed"
              ? parkResult.error
              : parkResult.reason
            : skipDetails,
      });
      return {
        changed: false,
        reason:
          parkResult.kind === "failed"
            ? parkResult.error
            : parkResult.kind === "skipped"
              ? parkResult.reason
              : skipDetails,
      };
    }
    await logAudit({
      changeStrategyTransaction: null,
      topThreeTokens,
      oldToken,
      chosenToken: null,
      chosenTokenMetrics: null,
      changeSummary: null,
      outcome: "skipped",
      details: skipDetails,
    });
    return { changed: false, reason: skipDetails };
  }

  const offensiveWeightedPick = rankingMetrics != null;
  for (const chosen of candidates) {
    let lastErr: string | null = null;
    const topAddress = chosen.address;
    const chosenMetricsOpts = { omitBuyPressureScore: offensiveWeightedPick };
    const chosenMetricsBase = () => ({
      ...chosenMetricsOpts,
      weightedCompositeScore: weightedCompositeScoreForSymbol(ranked, chosen.symbol),
    });

    if (!forceChangeIfTopIsCurrent && currentLower && topAddress.toLowerCase() === currentLower) {
      await logAudit({
        changeStrategyTransaction: null,
        topThreeTokens,
        oldToken,
        chosenToken: { symbol: chosen.symbol, address: topAddress },
        chosenTokenMetrics: buildChosenMetrics(chosen, chosenMetricsBase()),
        changeSummary: buildChangeSummary(oldToken, { symbol: chosen.symbol, address: topAddress }),
        outcome: "skipped",
        details: "Chosen token already current asset (scheduled path)",
      });
      return { changed: false, reason: "Chosen token already current asset" };
    }

    if (
      pipeline.strategyRegistryKey === "FloatStrategyV4" &&
      isBlockedV4ChangeStrategyTokenAddress(topAddress)
    ) {
      const stableResult = await tryFloatV4MarketBreadthStableExit(walletProvider, pipeline, rpcUrl);
      if (stableResult.kind === "sent") {
        await logAudit({
          changeStrategyTransaction: stableResult.txHash,
          topThreeTokens,
          oldToken,
          chosenToken: { symbol: "WETH", address: STABLE_V4_WETH_ADDRESS },
          chosenTokenMetrics: buildChosenMetrics(chosen, chosenMetricsBase()),
          changeSummary: buildChangeSummary(oldToken, { symbol: "WETH", address: STABLE_V4_WETH_ADDRESS }),
          outcome: "success",
        });
        return { changed: true, txHash: stableResult.txHash };
      }
      lastErr =
        stableResult.kind === "failed" ? stableResult.error : "exitStrategyToStable not sent";
      console.warn(
        `[demeter_runCycle] ${logTag} V4 USDC pick blocked; exitStrategyToStable failed: ${lastErr}`
      );
      continue;
    }

    const changeData = encodeFunctionData({
      abi: FLOAT_ABI,
      functionName: "changeStrategyAsset",
      args: [topAddress as Address],
    });

    for (let attempt = 1; attempt <= CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN; attempt++) {
      try {
        const txHash = await sendEvmTxWithGasHeadroom(walletProvider, {
          to: pipeline.contractManagerAddress,
          data: changeData,
        });
        console.log(
          `[demeter_runCycle] ${logTag} changeStrategyAsset tx ${txHash} https://robinhoodchain.blockscout.com/tx/${txHash}`
        );
        await logAudit({
          changeStrategyTransaction: txHash,
          topThreeTokens,
          oldToken,
          chosenToken: { symbol: chosen.symbol, address: topAddress },
          chosenTokenMetrics: buildChosenMetrics(chosen, {
            ...chosenMetricsBase(),
            ...buildTokenCalibrationMetrics(
              chosen.symbol,
              ranked,
              tokens as unknown as Array<Record<string, unknown>>,
              comparison?.weighted_ranking,
              tokens?.find((t) => t.symbol === chosen.symbol),
              { omitBuyPressureScore: offensiveWeightedPick }
            ),
          }),
          changeSummary: buildChangeSummary(oldToken, { symbol: chosen.symbol, address: topAddress }),
          outcome: "success",
        });
        return { changed: true, txHash };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        await logAudit({
          changeStrategyTransaction: null,
          topThreeTokens,
          oldToken,
          chosenToken: { symbol: chosen.symbol, address: topAddress },
          chosenTokenMetrics: buildChosenMetrics(chosen, chosenMetricsBase()),
          changeSummary: buildChangeSummary(oldToken, { symbol: chosen.symbol, address: topAddress }),
          outcome: "failed",
          details: lastErr,
        });
        if (attempt < CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN) {
          console.warn(
            `[demeter_runCycle] ${logTag} changeStrategyAsset failed (${lastErr}); retrying in ${CHANGE_STRATEGY_TX_RETRY_MS / 1000}s (attempt ${attempt}/${CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN})…`
          );
          await new Promise((r) => setTimeout(r, CHANGE_STRATEGY_TX_RETRY_MS));
        }
      }
    }

    console.warn(
      `[demeter_runCycle] ${logTag} giving up after ${CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN} attempts for ${chosen.symbol}; trying next token` +
        (lastErr ? ` (last error: ${lastErr})` : "")
    );
  }

  return {
    changed: false,
    reason: `All candidates failed changeStrategyAsset (max ${CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN} tries each)`,
  };
}

/**
 * Run one full Demeter cycle matching npm run demeter:
 * 1. Upkeep for configured Float keeper ids
 * 2. Float: DEFENSIVE or OFFENSIVE (consecutive threshold) → changeStrategyAsset on FloatContractManager
 * 3. Harvest for configured ids
 * 4. Price / volume check (Float): 12h pool volume floor or m30 drop → changeStrategyAsset
 * 5. Scheduled Float change strategy (offensive metrics + score gate)
 */
export function demeterRunCycleActionProvider() {
  return customActionProvider([
    {
      name: "demeter_runCycle",
      description: `Run one full Demeter cycle like npm run demeter for Float V3 and V4: (1) upkeep per keeper, (2) DEFENSIVE/OFFENSIVE changeStrategyAsset on each FloatContractManager, (3) harvest, (4) price/volume check, (5) scheduled offensive change.`,
      schema: z.object({
        skipChangeStrategy: z
          .boolean()
          .nullable()
          .default(false)
          .describe("If true, skip all change-strategy steps (upkeep and harvest only)"),
      }),
      invoke: async (
        walletProvider: WalletProvider,
        args: { skipChangeStrategy?: boolean | null }
      ) => {
        try {
          if (!(walletProvider instanceof EvmWalletProvider)) {
            return JSON.stringify({
              success: false,
              error: "Wallet provider must be an EVM wallet provider",
            });
          }

          const rpcUrl = getRpcUrlOptional();
          if (!rpcUrl) {
            return JSON.stringify({
              success: false,
              error: "RPC_URL required for full cycle (DEFENSIVE check, price check)",
            });
          }

          const pipelines = buildFloatKeeperPipelines();
          if (pipelines.length === 0) {
            return JSON.stringify({
              success: false,
              error: "No valid Float keeper pipelines (STRATEGY_IDS / FLOAT_V4_STRATEGY_IDS)",
            });
          }

          const results: { step: string; txHash?: string; reason?: string; error?: string }[] = [];
          const activePipelineIds = pipelines.map((p) => p.id);

          for (const pipeline of pipelines) {
            const pipelineTag = pipeline.id;
            const loopCfg = getPipelineLoopThresholds(pipeline.id);
            const priceDropThresholdPct = loopCfg.priceDropThresholdPct;

            const cycleGate = tickFloatPipelineLoopGate(pipeline, "runCycle");
            if (!cycleGate.shouldRun) {
              if (shouldLogFloatPipelineLoopSkip(cycleGate.loopNumber, cycleGate.runEvery)) {
                console.log(
                  formatFloatPipelineLoopSkipLog(
                    pipeline,
                    "runCycle",
                    cycleGate.loopNumber,
                    cycleGate.runEvery
                  )
                );
              }
              results.push({
                step: `skipped_${pipelineTag}`,
                reason: `runEveryNLoops=${cycleGate.runEvery} (wake ${cycleGate.loopNumber}; next gated wake pending)`,
              });
              continue;
            }
            console.log(
              formatFloatPipelineLoopRunLog(
                pipeline,
                "runCycle",
                cycleGate.loopNumber,
                cycleGate.runEvery
              )
            );

            await sleepFloatPipelineStagger(
              pipeline.id,
              activePipelineIds,
              sleepWithStopCheck
            );

            const keeperAbi = resolveKeeperAbi(pipeline.keeperAddress, pipeline.id);

            // 1. Upkeep
            let upkeepTxHash: string | undefined;
            if (pipeline.strategyIds.length === 0) {
              results.push({
                step: `upkeep_${pipelineTag}`,
                reason: "skipped_no_strategy_ids",
              });
            } else {
              try {
                const upkeepData =
                  pipeline.strategyIds.length > 1
                    ? encodeFunctionData({
                        abi: keeperAbi,
                        functionName: "performUpkeepBatch",
                        args: [pipeline.strategyIds.map(BigInt)],
                      })
                    : encodeFunctionData({
                        abi: keeperAbi,
                        functionName: "performUpkeep",
                        args: [BigInt(pipeline.strategyIds[0])],
                      });
                upkeepTxHash = await sendEvmTxWithGasHeadroom(walletProvider, {
                  to: pipeline.keeperAddress,
                  data: upkeepData,
                });
                console.log(
                  `[demeter_runCycle] [${pipeline.label}] upkeep tx ${upkeepTxHash} keeper ${pipeline.keeperAddress}`
                );
                results.push({ step: `upkeep_${pipelineTag}`, txHash: upkeepTxHash });
              } catch (e) {
                results.push({
                  step: `upkeep_${pipelineTag}`,
                  error: e instanceof Error ? e.message : String(e),
                });
                return JSON.stringify({
                  success: false,
                  error: `[${pipeline.label}] Upkeep failed`,
                  results,
                });
              }
            }

            await new Promise((r) => setTimeout(r, 8000));

            // 2. DEFENSIVE / OFFENSIVE threshold → changeStrategyAsset on this pipeline's manager
            if (!(args.skipChangeStrategy ?? false)) {
              for (const id of pipeline.strategyIds) {
                try {
                  const mode = await getStrategyMode(
                    pipeline.keeperAddress,
                    id,
                    rpcUrl,
                    pipeline.id
                  );
                  let floatConsecutive: number | undefined;
                  try {
                    const stats = await getKeeperStrategyStats(
                      pipeline.keeperAddress,
                      id,
                      rpcUrl,
                      pipeline.strategyRegistryKey,
                      pipeline.id
                    );
                    floatConsecutive =
                      stats.consecutiveOffensiveCount !== undefined
                        ? Number(stats.consecutiveOffensiveCount)
                        : undefined;
                  } catch {
                    /* ignore */
                  }
                  if (mode === DEFENSIVE_MODE) {
                    const r = await runChangeStrategy(
                      walletProvider,
                      pipeline,
                      rpcUrl,
                      {
                        trigger: "DEFENSIVE",
                        upkeepTransaction: upkeepTxHash ?? null,
                        strategyId: id,
                        keeperPipeline: pipeline.auditKeeperPipeline,
                      },
                      true
                    );
                    results.push({
                      step: `changeStrategy_${pipelineTag}_defensive`,
                      ...(r.txHash && { txHash: r.txHash }),
                      reason: r.reason ?? (r.changed ? "Changed (DEFENSIVE)" : "Skipped"),
                    });
                    break;
                  }
                  if (mode === STABLE_MODE) {
                    const r = await runChangeStrategy(
                      walletProvider,
                      pipeline,
                      rpcUrl,
                      {
                        trigger: "STABLE",
                        upkeepTransaction: upkeepTxHash ?? null,
                        strategyId: id,
                        keeperPipeline: pipeline.auditKeeperPipeline,
                      },
                      true
                    );
                    results.push({
                      step: `changeStrategy_${pipelineTag}_stable`,
                      ...(r.txHash && { txHash: r.txHash }),
                      reason: r.reason ?? (r.changed ? "Changed (STABLE re-entry)" : "Skipped"),
                    });
                    break;
                  }
                  if (mode === OFFENSIVE_MODE && floatConsecutive === OFFENSIVE_CHANGE_THRESHOLD) {
                    const r = await runChangeStrategy(
                      walletProvider,
                      pipeline,
                      rpcUrl,
                      {
                        trigger: "OFFENSIVE",
                        upkeepTransaction: upkeepTxHash ?? null,
                        strategyId: id,
                        keeperPipeline: pipeline.auditKeeperPipeline,
                      },
                      true
                    );
                    results.push({
                      step: `changeStrategy_${pipelineTag}_offensive`,
                      ...(r.txHash && { txHash: r.txHash }),
                      reason:
                        r.reason ??
                        (r.changed
                          ? `Changed (OFFENSIVE consecutive=${OFFENSIVE_CHANGE_THRESHOLD})`
                          : "Skipped"),
                    });
                    break;
                  }
                } catch {
                  /* ignore */
                }
              }
            }

            // 3. Harvest
            for (const id of pipeline.strategyIds) {
              let baselineLastHarvest = 0;
              try {
                baselineLastHarvest = (
                  await getKeeperStrategyHarvestTimestamps(
                    pipeline.keeperAddress,
                    id,
                    rpcUrl,
                    pipeline.strategyRegistryKey,
                    pipeline.id
                  )
                ).lastHarvest;
              } catch {
                /* baseline 0 if unreadable */
              }
              for (;;) {
                try {
                  const harvestData = encodeFunctionData({
                    abi: keeperAbi,
                    functionName: "performHarvest",
                    args: [BigInt(id), false],
                  });
                  const harvestHash = await sendEvmTxWithGasHeadroom(walletProvider, {
                    to: pipeline.keeperAddress,
                    data: harvestData,
                  });
                  console.log(
                    `[demeter_runCycle] [${pipeline.label}] harvest id=${id} tx ${harvestHash}`
                  );
                  results.push({ step: `harvest_${pipelineTag}_${id}`, txHash: harvestHash });
                  await new Promise((r) => setTimeout(r, 1000));
                  break;
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  try {
                    const ts = await getKeeperStrategyHarvestTimestamps(
                      pipeline.keeperAddress,
                      id,
                      rpcUrl,
                      pipeline.strategyRegistryKey,
                      pipeline.id
                    );
                    if (
                      shouldStopFloatHarvestRetryAttempts(
                        baselineLastHarvest,
                        ts.lastHarvest,
                        ts.prevHarvestTime
                      )
                    ) {
                      console.warn(
                        `[demeter_runCycle] [${pipeline.label}] harvest id=${id} settled on-chain (${msg})`
                      );
                      results.push({
                        step: `harvest_${pipelineTag}_${id}`,
                        reason: "stopped_retry_chain_harvest_settled",
                      });
                      break;
                    }
                  } catch {
                    /* fall through */
                  }
                  console.warn(
                    `[demeter_runCycle] [${pipeline.label}] harvest id=${id} failed (${msg}); retrying…`
                  );
                  await new Promise((r) => setTimeout(r, HARVEST_TX_RETRY_MS));
                }
              }
            }

            // 4. Price / volume check (skipped when mode=STABLE — re-entry runs on upkeep loop)
            if (!(args.skipChangeStrategy ?? false)) {
              try {
                let skipPriceVolumeCheck = false;
                for (const strategyId of pipeline.strategyIds) {
                  const mode = await getStrategyMode(
                    pipeline.keeperAddress,
                    strategyId,
                    rpcUrl,
                    pipeline.id
                  );
                  if (mode === STABLE_MODE) {
                    skipPriceVolumeCheck = true;
                    results.push({
                      step: `changeStrategy_${pipelineTag}_priceDrop`,
                      reason: `Skipped m30/volume — strategy ${strategyId} STABLE (re-entry on upkeep loop)`,
                    });
                    break;
                  }
                }
                if (!skipPriceVolumeCheck) {
                const currentAsset = await getFloatAssetAddress(
                  pipeline.contractManagerAddress,
                  rpcUrl,
                  pipeline.strategyRegistryKey
                );
              const minVolH12Usd = loopCfg.minVolumeH12Usd;
              const data = (await fetchTokenData([currentAsset], undefined, {
                strategyRegistryKey: pipeline.strategyRegistryKey,
              })) as {
                pools?: Array<{
                  price_change_percentage?: { m30?: string };
                  volume_usd?: Record<string, unknown>;
                }>;
              };
              const pool = data?.pools?.[0];
              const parseNum = (v: unknown): number =>
                typeof v === "string" ? parseFloat(v) : Number(v) || 0;
              const poolVol = pool?.volume_usd;
              const volumeH12Usd =
                poolVol != null
                  ? poolVol["h12"] != null
                    ? parseNum(poolVol["h12"])
                    : poolVol.h6 != null && poolVol.h24 != null
                      ? (parseNum(poolVol.h6) + parseNum(poolVol.h24)) / 2
                      : poolVol.h24 != null
                        ? parseNum(poolVol.h24)
                        : null
                  : null;

              if (volumeH12Usd != null && Number.isFinite(volumeH12Usd) && volumeH12Usd < minVolH12Usd) {
                const r = await runChangeStrategy(
                  walletProvider,
                  pipeline,
                  rpcUrl,
                  {
                    trigger: "PRICE_CHECK_LOW_VOLUME_12H",
                    keeperPipeline: pipeline.auditKeeperPipeline,
                  },
                  true
                );
                results.push({
                  step: `changeStrategy_${pipelineTag}_lowVolume12h`,
                  ...(r.txHash && { txHash: r.txHash }),
                  reason:
                    r.reason ??
                    (r.changed
                      ? `Changed (12h vol $${volumeH12Usd.toFixed(0)} < $${minVolH12Usd})`
                      : "Skipped"),
                });
              } else {
                const m30Str = pool?.price_change_percentage?.m30;
                const m30 =
                  m30Str != null ? parseFloat(String(m30Str)) : null;

                if (m30 !== null && m30 <= priceDropThresholdPct) {
                  const r = await runChangeStrategy(
                    walletProvider,
                    pipeline,
                    rpcUrl,
                    { trigger: "PRICE_CHECK_M30", keeperPipeline: pipeline.auditKeeperPipeline },
                    true
                  );
                  results.push({
                    step: `changeStrategy_${pipelineTag}_priceDrop`,
                    ...(r.txHash && { txHash: r.txHash }),
                    reason:
                      r.reason ??
                      (r.changed ? `Changed (m30 ${m30}% <= ${priceDropThresholdPct}%)` : "Skipped"),
                  });
                } else if (m30 === null) {
                  results.push({
                    step: `changeStrategy_${pipelineTag}_priceDrop`,
                    reason: "No m30 data for current asset",
                  });
                }
              }
                }
              } catch (e) {
                results.push({
                  step: `changeStrategy_${pipelineTag}_priceDrop`,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }

            // 5. Scheduled change strategy (offensive weighted ranking → top token)
            if (!(args.skipChangeStrategy ?? false)) {
              const r = await runChangeStrategy(
                walletProvider,
                pipeline,
                rpcUrl,
                { trigger: "SCHEDULED", keeperPipeline: pipeline.auditKeeperPipeline },
                false,
                getOffensiveTokenRankingMetrics(),
                loopCfg.scheduledChangeMinWeightedScore
              );
              results.push({
                step: `changeStrategy_${pipelineTag}_scheduled`,
                ...(r.txHash && { txHash: r.txHash }),
                reason: r.reason ?? (r.changed ? "Changed to top-ranked token" : "Skipped"),
              });
            }
          }

          return JSON.stringify({
            success: true,
            message: "Full cycle completed (same logic as npm run demeter)",
            results,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error running cycle",
          });
        }
      },
    },
  ]);
}
