/**
 * Shared ranking / eligibility thresholds.
 * Float V3 + Float V4 (Demeter): {@link demeter-config}.
 * UFloat / Triton / LiquidStratMinV4 token universe: {@link triton-config} via {@link triton_v4}.
 */

import {
  getMarketBreadthNegativeH24FractionGte,
  getMaxNegativePriceChangeH24Pct,
  getMaxNegativePriceChangeM5M15M30Pct,
  getMaxVolatilityH24Usd,
  getMergedConfig,
  getMinPoolLiquidityUsd,
  getMinVolatilityH24Usd,
  getMinVolumeH12Usd,
  getOffensiveMomentumExcludePriceChangeH12PctGte,
  getOffensiveMomentumExcludePriceChangeH24PctGte,
  getOffensiveMomentumMaxM15Pct,
  getOffensiveMomentumMaxM30Pct,
  getOffensiveMomentumMaxM5Pct,
  getOffensiveMomentumMinM15Pct,
  getOffensiveMomentumMinM30Pct,
  getOffensiveMomentumMinM5Pct,
  getOffensiveMomentumVolumeOverSpreadRatio,
  getScheduledChangeMinWeightedScore,
} from "./demeter-config";
import {
  getTritonChangeStrategyIntervalMs,
  getTritonFloatPriceCheckIntervalMs,
  getTritonHarvestIntervalMs,
  getTritonPriceDropThresholdPct,
  getTritonRankingEligibilityThresholds,
  getTritonScheduledChangeMinWeightedScore,
} from "./triton-config";

/** Float V3/V4 use demeter-config; UFloat/Triton CoinGecko paths use triton-config. */
export type FloatRankingProfile = "float_v3" | "float_v4" | "triton_v4";

/** CoinGecko comparison + offensive momentum gates for one pipeline profile. */
export type RankingEligibilityThresholds = {
  minVolumeH12Usd: number;
  minPoolLiquidityUsd: number;
  minVolatilityH24Usd: number;
  maxVolatilityH24Usd: number;
  maxNegativePriceChangeH24Pct: number;
  maxNegativePriceChangeM5M15M30Pct: number;
  scheduledChangeMinWeightedScore: number;
  offensiveMomentumMinM5Pct: number;
  offensiveMomentumMaxM5Pct: number;
  offensiveMomentumMinM15Pct: number;
  offensiveMomentumMaxM15Pct: number;
  offensiveMomentumMinM30Pct: number;
  offensiveMomentumMaxM30Pct: number;
  offensiveMomentumVolumeOverSpreadRatio: number;
  offensiveMomentumExcludePriceChangeH24PctGte: number;
  offensiveMomentumExcludePriceChangeH12PctGte: number;
  marketBreadthNegativeH24FractionGte: number;
  marketBreadthRequireCurrentAssetNegativeH24: boolean;
};

/** Demeter-config threshold bundle (Float V3 + Float V4). */
export function getDemeterRankingEligibilityThresholds(): RankingEligibilityThresholds {
  const breadth = getMarketBreadthNegativeH24FractionGte();
  return {
    minVolumeH12Usd: getMinVolumeH12Usd(),
    minPoolLiquidityUsd: getMinPoolLiquidityUsd(),
    minVolatilityH24Usd: getMinVolatilityH24Usd(),
    maxVolatilityH24Usd: getMaxVolatilityH24Usd(),
    maxNegativePriceChangeH24Pct: getMaxNegativePriceChangeH24Pct(),
    maxNegativePriceChangeM5M15M30Pct: getMaxNegativePriceChangeM5M15M30Pct(),
    scheduledChangeMinWeightedScore: getScheduledChangeMinWeightedScore(),
    offensiveMomentumMinM5Pct: getOffensiveMomentumMinM5Pct(),
    offensiveMomentumMaxM5Pct: getOffensiveMomentumMaxM5Pct(),
    offensiveMomentumMinM15Pct: getOffensiveMomentumMinM15Pct(),
    offensiveMomentumMaxM15Pct: getOffensiveMomentumMaxM15Pct(),
    offensiveMomentumMinM30Pct: getOffensiveMomentumMinM30Pct(),
    offensiveMomentumMaxM30Pct: getOffensiveMomentumMaxM30Pct(),
    offensiveMomentumVolumeOverSpreadRatio: getOffensiveMomentumVolumeOverSpreadRatio(),
    offensiveMomentumExcludePriceChangeH24PctGte: getOffensiveMomentumExcludePriceChangeH24PctGte(),
    offensiveMomentumExcludePriceChangeH12PctGte: getOffensiveMomentumExcludePriceChangeH12PctGte(),
    marketBreadthNegativeH24FractionGte: breadth.fractionGte,
    marketBreadthRequireCurrentAssetNegativeH24: breadth.requireCurrentAssetNegativeH24,
  };
}

export function getRankingEligibilityThresholds(profile: FloatRankingProfile): RankingEligibilityThresholds {
  if (profile === "triton_v4") {
    return getTritonRankingEligibilityThresholds();
  }
  return getDemeterRankingEligibilityThresholds();
}

/** Demeter periodic loop cadence + defensive triggers per pipeline. */
export type PipelineLoopThresholds = {
  harvestIntervalMs: number;
  changeStrategyIntervalMs: number;
  priceCheckIntervalMs: number;
  priceDropThresholdPct: number;
  minVolumeH12Usd: number;
  scheduledChangeMinWeightedScore: number;
  ranking: RankingEligibilityThresholds;
};

/** Float V3 and Float V4 — both use {@link getMergedConfig} / demeter-config thresholds. */
export function getPipelineLoopThresholds(pipelineId: "v3" | "v4"): PipelineLoopThresholds {
  const o = getMergedConfig();
  return {
    harvestIntervalMs: o.harvestIntervalMs,
    changeStrategyIntervalMs: o.changeStrategyIntervalMs,
    priceCheckIntervalMs: o.priceCheckIntervalMs,
    priceDropThresholdPct: o.priceDropThresholdPct,
    minVolumeH12Usd: o.minVolumeH12Usd,
    scheduledChangeMinWeightedScore: o.scheduledChangeMinWeightedScore,
    ranking: getRankingEligibilityThresholds(pipelineId === "v4" ? "float_v4" : "float_v3"),
  };
}

/** UFloat / LiquidStratMinV4 — triton-config loop + ranking thresholds (not Float V4 Demeter). */
export function getTritonPipelineLoopThresholds(): PipelineLoopThresholds {
  const ranking = getTritonRankingEligibilityThresholds();
  return {
    harvestIntervalMs: getTritonHarvestIntervalMs(),
    changeStrategyIntervalMs: getTritonChangeStrategyIntervalMs(),
    priceCheckIntervalMs: getTritonFloatPriceCheckIntervalMs(),
    priceDropThresholdPct: getTritonPriceDropThresholdPct(),
    minVolumeH12Usd: ranking.minVolumeH12Usd,
    scheduledChangeMinWeightedScore: getTritonScheduledChangeMinWeightedScore(),
    ranking,
  };
}

/** Shortest harvest interval across active Float pipelines (shared harvest loop). */
export function getCombinedHarvestIntervalMs(pipelineIds: Array<"v3" | "v4">): number {
  if (pipelineIds.length === 0) {
    return getMergedConfig().harvestIntervalMs;
  }
  return Math.min(...pipelineIds.map((id) => getPipelineLoopThresholds(id).harvestIntervalMs));
}
