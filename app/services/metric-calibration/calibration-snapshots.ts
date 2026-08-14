import { randomUUID } from "crypto";

import type { DemeterChosenTokenMetrics } from "../demeter-defensive-offensive-log";
import {
  offensiveRankingRawForSymbol,
  scheduledSuccessBaselineMetrics,
  tokenSummarySnapshotForSymbol,
  weightedCompositeScoreForSymbol,
  weightedMetricScoresForSymbol,
  type WeightedRankingRowForLog,
} from "../demeter-defensive-offensive-log";
import { buySellBuyPressureScore } from "../../config/demeter-config";
import { getCalibrationOutcomeHorizonMs } from "./calibration-config";
import {
  filterCalibrationTopThree,
  shouldRecordCalibrationEvent,
} from "./calibration-candidates";

export type MetricCalibrationTokenSnapshot = {
  symbol: string;
  address: string;
  metrics: DemeterChosenTokenMetrics;
};

export type MetricCalibrationFields = {
  eventId: string;
  outcomeDueAtUtc: string;
  topThreeTokenSnapshots: MetricCalibrationTokenSnapshot[];
};

type TokenSummaryRow = {
  symbol: string;
  address: string;
  buy_sell_ratio_h6?: number | null;
  buy_sell_ratio_h24?: number | null;
};

export function createCalibrationEventId(): string {
  return randomUUID();
}

/** Full entry-time metrics for one candidate (same depth as SCHEDULED success baseline). */
export function buildTokenCalibrationMetrics(
  symbol: string,
  ranked: WeightedRankingRowForLog[] | undefined,
  tokens: Array<Record<string, unknown>> | undefined,
  weightedRanking: { ranked?: WeightedRankingRowForLog[]; metrics_used?: string[] } | undefined,
  tokenRow?: TokenSummaryRow | null,
  options?: { omitBuyPressureScore?: boolean }
): DemeterChosenTokenMetrics {
  const row = tokenRow ?? (tokens?.find((t) => t.symbol === symbol) as TokenSummaryRow | undefined);
  const baseline = scheduledSuccessBaselineMetrics(
    ranked,
    symbol,
    tokens,
    weightedRanking
  );
  const base: DemeterChosenTokenMetrics = {
    buy_sell_ratio_h6:
      row && "buy_sell_ratio_h6" in row ? (row.buy_sell_ratio_h6 as number | null) ?? null : null,
    buy_sell_ratio_h24:
      row && "buy_sell_ratio_h24" in row ? (row.buy_sell_ratio_h24 as number | null) ?? null : null,
    weighted_composite_score: weightedCompositeScoreForSymbol(ranked, symbol),
    ...baseline,
  };
  if (!base.chosen_token_tokens_summary) {
    const snap = tokenSummarySnapshotForSymbol(tokens, symbol);
    if (snap) base.chosen_token_tokens_summary = snap;
  }
  if (!base.weighted_metric_scores) {
    const scores = weightedMetricScoresForSymbol(ranked, symbol);
    if (scores) base.weighted_metric_scores = scores;
  }
  if (!base.offensive_ranking_raw && weightedRanking?.metrics_used?.length) {
    const raw = offensiveRankingRawForSymbol(tokens, symbol, weightedRanking.metrics_used);
    if (raw) base.offensive_ranking_raw = raw;
  }
  if (!options?.omitBuyPressureScore && base.buy_sell_ratio_h6 != null) {
    base.buyPressureScore = buySellBuyPressureScore(base.buy_sell_ratio_h6);
  }
  return base;
}

export function buildTopThreeTokenSnapshots(
  topThreeTokens: Array<{ symbol: string; address: string }>,
  ranked: WeightedRankingRowForLog[] | undefined,
  tokens: Array<Record<string, unknown>> | undefined,
  weightedRanking: { ranked?: WeightedRankingRowForLog[]; metrics_used?: string[] } | undefined,
  options?: { omitBuyPressureScore?: boolean }
): MetricCalibrationTokenSnapshot[] {
  return topThreeTokens.map((t) => ({
    symbol: t.symbol,
    address: t.address,
    metrics: buildTokenCalibrationMetrics(
      t.symbol,
      ranked,
      tokens,
      weightedRanking,
      tokens?.find((r) => r.symbol === t.symbol) as TokenSummaryRow | undefined,
      options
    ),
  }));
}

export function buildMetricCalibrationFields(
  topThreeTokens: Array<{ symbol: string; address: string }>,
  ranked: WeightedRankingRowForLog[] | undefined,
  tokens: Array<Record<string, unknown>> | undefined,
  weightedRanking: { ranked?: WeightedRankingRowForLog[]; metrics_used?: string[] } | undefined,
  eventAt = new Date(),
  options?: { omitBuyPressureScore?: boolean }
): MetricCalibrationFields | Record<string, never> {
  const eligible = filterCalibrationTopThree(topThreeTokens);
  if (!shouldRecordCalibrationEvent(topThreeTokens)) {
    return {};
  }
  return {
    eventId: createCalibrationEventId(),
    outcomeDueAtUtc: new Date(eventAt.getTime() + getCalibrationOutcomeHorizonMs()).toISOString(),
    topThreeTokenSnapshots: buildTopThreeTokenSnapshots(
      eligible,
      ranked,
      tokens,
      weightedRanking,
      options
    ),
  };
}
