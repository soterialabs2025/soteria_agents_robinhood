import * as fs from "fs/promises";

import {
  getMergedConfig,
  saveOverrides,
  type ConfigOverrides,
} from "../../config/demeter-config";
import { getTritonMergedConfig } from "../../config/triton-config";
import { saveTritonOverrides, type TritonOverrides } from "../../config/triton-overrides";
import type { DemeterChosenTokenMetrics } from "../demeter-defensive-offensive-log";
import {
  CALIBRATION_TUNING_MAX_SCALAR_DELTA_FRACTION,
  CALIBRATION_TUNING_MAX_WEIGHT_DELTA,
  CALIBRATION_TUNING_MIN_SAMPLES,
  getCalibrationRetentionMs,
  getCalibrationTuningWindowMs,
  getCalibrationEventsPath,
  getCalibrationOptimalPath,
  getCalibrationOutcomesPath,
  getCalibrationTuningRunsPath,
  getCalibrationTuningStatePath,
  isCalibrationAutoApplyEnabled,
} from "./calibration-config";
import type { MetricCalibrationEventEntry } from "./calibration-log";
import type { MetricCalibrationOptimalRow } from "./outcome-collector";
import { appendJsonlLine, pruneJsonlByIsoField, readJsonlFile } from "./jsonl";

const OFFENSIVE_METRIC_KEYS = [
  "volume_h1",
  "volume_h6",
  "volume_h12",
  "volume_m5",
  "volume_m15",
  "volume_m30",
  "buy_sell_ratio_h6",
  "buy_sell_ratio_h24",
  "price_change_h1",
  "price_change_h6",
  "price_change_h12",
  "price_change_m5_pct",
  "price_change_m15_pct",
  "price_change_m30_pct",
  "price_stability_h24",
  "volatility_h6",
] as const;

type OffensiveMetricKey = (typeof OFFENSIVE_METRIC_KEYS)[number];

export type CalibrationTuningSegmentStats = {
  sampleCount: number;
  chosenMatchedWinnerCount: number;
  avgWinnerForwardReturnPct: number;
  metricAdvantage: Record<string, number>;
  winnerMomentumP10: { m5?: number; m15?: number; m30?: number };
  winnerMomentumP90: { m5?: number; m15?: number; m30?: number };
  winnerCompositeP25?: number;
  winnerVolumeH12P5?: number;
  winnerLiquidityP5?: number;
};

export type MetricCalibrationTuningReport = {
  runAtUtc: string;
  windowMs: number;
  totalSamples: number;
  applied: boolean;
  applySkippedReason?: string;
  autoApplyEnabled: boolean;
  floatV3: CalibrationTuningSegmentStats;
  floatV4: CalibrationTuningSegmentStats;
  proposedDemeterOverrides: ConfigOverrides;
  proposedTritonOverrides: TritonOverrides;
  prune?: { events: number; outcomes: number; optimal: number };
};

export type RunMetricCalibrationTuningOptions = {
  /** When false, only produce a report (default). */
  apply?: boolean;
  /** Override analysis window (ms). */
  windowMs?: number;
  /** Prune JSONL older than retention after a successful analysis run. */
  pruneAfter?: boolean;
  /**
   * When false, do NOT append tuning-runs.jsonl or write tuning-state.json (so this run does not mark the cycle
   * "done"). Used by the LLM pass, which calls this only for analysis and manages its own run record/state so a
   * failed LLM cycle stays due and retries. Default true.
   */
  writeState?: boolean;
};

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}


function percentile(nums: number[], p: number): number | undefined {
  if (nums.length === 0) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function clampScalarDelta(current: number, target: number, maxFraction: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return current;
  const maxDelta = Math.abs(current) * maxFraction + 1e-9;
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return round4(target);
  return round4(current + Math.sign(delta) * maxDelta);
}

function parseIsoMs(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function numFromSummary(
  summary: Record<string, string | number | null> | undefined,
  key: string
): number | undefined {
  if (!summary) return undefined;
  const v = summary[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function rawMetric(
  metrics: DemeterChosenTokenMetrics,
  key: string
): number | undefined {
  const fromRaw = metrics.offensive_ranking_raw?.[key];
  if (typeof fromRaw === "number" && Number.isFinite(fromRaw)) return fromRaw;
  return numFromSummary(metrics.chosen_token_tokens_summary, key);
}

function emptySegmentStats(): CalibrationTuningSegmentStats {
  return {
    sampleCount: 0,
    chosenMatchedWinnerCount: 0,
    avgWinnerForwardReturnPct: 0,
    metricAdvantage: {},
    winnerMomentumP10: {},
    winnerMomentumP90: {},
  };
}

function pipelineSegment(
  keeperPipeline: MetricCalibrationOptimalRow["keeperPipeline"]
): "floatV3" | "floatV4" {
  return keeperPipeline === "float_v4" ? "floatV4" : "floatV3";
}

function buildSegmentStats(
  optimalRows: MetricCalibrationOptimalRow[],
  eventsById: Map<string, MetricCalibrationEventEntry>
): { floatV3: CalibrationTuningSegmentStats; floatV4: CalibrationTuningSegmentStats } {
  const segments = {
    floatV3: emptySegmentStats(),
    floatV4: emptySegmentStats(),
  };

  const metricWinnerSums: Record<"floatV3" | "floatV4", Record<string, { w: number; l: number }>> = {
    floatV3: {},
    floatV4: {},
  };
  const m5Vals: Record<"floatV3" | "floatV4", number[]> = { floatV3: [], floatV4: [] };
  const m15Vals: Record<"floatV3" | "floatV4", number[]> = { floatV3: [], floatV4: [] };
  const m30Vals: Record<"floatV3" | "floatV4", number[]> = { floatV3: [], floatV4: [] };
  const compositeVals: Record<"floatV3" | "floatV4", number[]> = { floatV3: [], floatV4: [] };
  const volH12Vals: Record<"floatV3" | "floatV4", number[]> = { floatV3: [], floatV4: [] };
  const liqVals: Record<"floatV3" | "floatV4", number[]> = { floatV3: [], floatV4: [] };
  const forwardReturns: Record<"floatV3" | "floatV4", number[]> = { floatV3: [], floatV4: [] };

  for (const row of optimalRows) {
    const seg = pipelineSegment(row.keeperPipeline);
    const stats = segments[seg];
    stats.sampleCount++;
    if (row.chosenMatchedWinner) stats.chosenMatchedWinnerCount++;
    forwardReturns[seg].push(row.winnerForwardReturnPct);

    const wm = row.winnerMetrics;
    const composite = wm.weighted_composite_score;
    if (typeof composite === "number" && Number.isFinite(composite)) {
      compositeVals[seg].push(composite);
    }

    const m5 = rawMetric(wm, "price_change_m5_pct");
    const m15 = rawMetric(wm, "price_change_m15_pct");
    const m30 = rawMetric(wm, "price_change_m30_pct");
    if (m5 != null) m5Vals[seg].push(m5);
    if (m15 != null) m15Vals[seg].push(m15);
    if (m30 != null) m30Vals[seg].push(m30);

    const volH12 = rawMetric(wm, "volume_h12") ?? numFromSummary(wm.chosen_token_tokens_summary, "volume_h12");
    const liq =
      rawMetric(wm, "liquidity_usd") ?? numFromSummary(wm.chosen_token_tokens_summary, "liquidity_usd");
    if (volH12 != null && volH12 > 0) volH12Vals[seg].push(volH12);
    if (liq != null && liq > 0) liqVals[seg].push(liq);

    const event = eventsById.get(row.eventId);
    if (!event?.topThreeTokenSnapshots?.length) continue;

    const winnerSnap = event.topThreeTokenSnapshots.find(
      (s) => s.address.toLowerCase() === row.winnerAddress.toLowerCase()
    );
    if (!winnerSnap) continue;

    const loserSnaps = event.topThreeTokenSnapshots.filter(
      (s) => s.address.toLowerCase() !== row.winnerAddress.toLowerCase()
    );
    if (loserSnaps.length === 0) continue;

    const winnerScores = winnerSnap.metrics.weighted_metric_scores ?? {};
    for (const key of Object.keys(winnerScores)) {
      const wScore = winnerScores[key];
      if (typeof wScore !== "number" || !Number.isFinite(wScore)) continue;
      const loserScores = loserSnaps
        .map((s) => s.metrics.weighted_metric_scores?.[key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (loserScores.length === 0) continue;
      const lAvg = loserScores.reduce((a, b) => a + b, 0) / loserScores.length;
      const bucket = metricWinnerSums[seg][key] ?? { w: 0, l: 0 };
      bucket.w += wScore - lAvg;
      bucket.l++;
      metricWinnerSums[seg][key] = bucket;
    }
  }

  for (const seg of ["floatV3", "floatV4"] as const) {
    const stats = segments[seg];
    const n = forwardReturns[seg].length;
    stats.avgWinnerForwardReturnPct =
      n > 0 ? round4(forwardReturns[seg].reduce((a, b) => a + b, 0) / n) : 0;

    for (const [key, { w, l }] of Object.entries(metricWinnerSums[seg])) {
      if (l > 0) stats.metricAdvantage[key] = round4(w / l);
    }

    stats.winnerMomentumP10 = {
      m5: percentile(m5Vals[seg], 0.1),
      m15: percentile(m15Vals[seg], 0.1),
      m30: percentile(m30Vals[seg], 0.1),
    };
    stats.winnerMomentumP90 = {
      m5: percentile(m5Vals[seg], 0.9),
      m15: percentile(m15Vals[seg], 0.9),
      m30: percentile(m30Vals[seg], 0.9),
    };
    stats.winnerCompositeP25 = percentile(compositeVals[seg], 0.25);
    stats.winnerVolumeH12P5 = percentile(volH12Vals[seg], 0.05);
    stats.winnerLiquidityP5 = percentile(liqVals[seg], 0.05);
  }

  return segments;
}

function proposeOffensiveWeightOverrides(
  segments: { floatV3: CalibrationTuningSegmentStats; floatV4: CalibrationTuningSegmentStats }
): ConfigOverrides["offensiveTokenRankingMetrics"] {
  const current = getMergedConfig().offensiveTokenRankingMetrics;
  const combinedAdvantage: Record<string, number> = {};
  let totalSamples = 0;

  for (const seg of [segments.floatV3, segments.floatV4]) {
    for (const [key, adv] of Object.entries(seg.metricAdvantage)) {
      combinedAdvantage[key] = (combinedAdvantage[key] ?? 0) + adv * seg.sampleCount;
    }
    totalSamples += seg.sampleCount;
  }
  if (totalSamples === 0) return undefined;

  for (const key of Object.keys(combinedAdvantage)) {
    combinedAdvantage[key] = combinedAdvantage[key]! / totalSamples;
  }

  const weights: Record<string, number> = {};
  let activeSum = 0;
  for (const key of OFFENSIVE_METRIC_KEYS) {
    const row = current[key];
    const w = row?.weight ?? 0;
    weights[key] = w;
    if (w > 0) activeSum += w;
  }
  if (activeSum <= 0) return undefined;

  for (const key of OFFENSIVE_METRIC_KEYS) {
    const currentW = weights[key] ?? 0;
    if (currentW <= 0) continue;
    const adv = combinedAdvantage[key] ?? 0;
    if (Math.abs(adv) < 0.02) continue;
    const nudge = Math.sign(adv) * Math.min(CALIBRATION_TUNING_MAX_WEIGHT_DELTA, Math.abs(adv) * 0.04);
    weights[key] = Math.max(0, currentW + nudge);
  }

  let newActiveSum = 0;
  for (const key of OFFENSIVE_METRIC_KEYS) {
    const w = weights[key] ?? 0;
    if (w > 0) newActiveSum += w;
  }
  if (newActiveSum <= 0) return undefined;

  const out: NonNullable<ConfigOverrides["offensiveTokenRankingMetrics"]> = {};
  for (const key of OFFENSIVE_METRIC_KEYS) {
    const w = weights[key] ?? 0;
    if (w <= 0) continue;
    const normalized = round4(w / newActiveSum);
    const prev = current[key]?.weight ?? 0;
    if (Math.abs(normalized - prev) >= 0.001) {
      out[key as OffensiveMetricKey] = { weight: normalized };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function proposeDemeterThresholdOverrides(
  seg: CalibrationTuningSegmentStats
): ConfigOverrides {
  if (seg.sampleCount < 3) return {};
  const current = getMergedConfig();
  const out: ConfigOverrides = {};
  const frac = CALIBRATION_TUNING_MAX_SCALAR_DELTA_FRACTION;

  const p10 = seg.winnerMomentumP10;
  const p90 = seg.winnerMomentumP90;

  if (p10.m5 != null) {
    const target = Math.max(0, Math.min(p10.m5, current.offensiveMomentumMinM5Pct * 1.5));
    const next = clampScalarDelta(current.offensiveMomentumMinM5Pct, target, frac);
    if (next !== current.offensiveMomentumMinM5Pct) out.offensiveMomentumMinM5Pct = next;
  }
  if (p90.m5 != null && current.offensiveMomentumMaxM5Pct > 0) {
    const target = Math.max(p90.m5 * 1.05, current.offensiveMomentumMinM5Pct + 0.5);
    const next = clampScalarDelta(current.offensiveMomentumMaxM5Pct, target, frac);
    if (next !== current.offensiveMomentumMaxM5Pct) out.offensiveMomentumMaxM5Pct = next;
  }
  if (p10.m15 != null) {
    const target = Math.max(0, Math.min(p10.m15, current.offensiveMomentumMinM15Pct * 1.5));
    const next = clampScalarDelta(current.offensiveMomentumMinM15Pct, target, frac);
    if (next !== current.offensiveMomentumMinM15Pct) out.offensiveMomentumMinM15Pct = next;
  }
  if (p90.m15 != null && current.offensiveMomentumMaxM15Pct > 0) {
    const target = Math.max(p90.m15 * 1.05, current.offensiveMomentumMinM15Pct + 0.5);
    const next = clampScalarDelta(current.offensiveMomentumMaxM15Pct, target, frac);
    if (next !== current.offensiveMomentumMaxM15Pct) out.offensiveMomentumMaxM15Pct = next;
  }
  if (p10.m30 != null) {
    const target = Math.max(0, Math.min(p10.m30, current.offensiveMomentumMinM30Pct * 1.5));
    const next = clampScalarDelta(current.offensiveMomentumMinM30Pct, target, frac);
    if (next !== current.offensiveMomentumMinM30Pct) out.offensiveMomentumMinM30Pct = next;
  }
  if (p90.m30 != null && current.offensiveMomentumMaxM30Pct > 0) {
    const target = Math.max(p90.m30 * 1.05, current.offensiveMomentumMinM30Pct + 0.5);
    const next = clampScalarDelta(current.offensiveMomentumMaxM30Pct, target, frac);
    if (next !== current.offensiveMomentumMaxM30Pct) out.offensiveMomentumMaxM30Pct = next;
  }

  if (seg.winnerCompositeP25 != null && current.scheduledChangeMinWeightedScore > 0) {
    const matchRate =
      seg.sampleCount > 0 ? seg.chosenMatchedWinnerCount / seg.sampleCount : 1;
    let target = seg.winnerCompositeP25;
    if (matchRate < 0.5) {
      target = Math.min(0.98, target + 0.02);
    } else if (matchRate > 0.85) {
      target = Math.max(0.75, target - 0.01);
    }
    const next = clampScalarDelta(current.scheduledChangeMinWeightedScore, target, frac);
    if (next !== current.scheduledChangeMinWeightedScore) {
      out.scheduledChangeMinWeightedScore = round4(next);
    }
  }

  if (seg.winnerVolumeH12P5 != null) {
    const target = Math.min(current.minVolumeH12Usd, Math.floor(seg.winnerVolumeH12P5 * 0.9));
    if (target >= 1000 && target < current.minVolumeH12Usd) {
      out.minVolumeH12Usd = target;
    }
  }
  if (seg.winnerLiquidityP5 != null) {
    const target = Math.min(current.minPoolLiquidityUsd, Math.floor(seg.winnerLiquidityP5 * 0.85));
    if (target >= 50_000 && target < current.minPoolLiquidityUsd) {
      out.minPoolLiquidityUsd = target;
    }
  }

  return out;
}

function proposeTritonThresholdOverrides(
  seg: CalibrationTuningSegmentStats
): TritonOverrides {
  if (seg.sampleCount < 3) return {};
  const current = getTritonMergedConfig();
  const out: TritonOverrides = {};
  const frac = CALIBRATION_TUNING_MAX_SCALAR_DELTA_FRACTION;

  const p10 = seg.winnerMomentumP10;
  const p90 = seg.winnerMomentumP90;

  if (p10.m5 != null) {
    const next = clampScalarDelta(
      current.offensiveMomentumMinM5Pct,
      Math.max(0, Math.min(p10.m5, current.offensiveMomentumMinM5Pct * 1.5)),
      frac
    );
    if (next !== current.offensiveMomentumMinM5Pct) out.offensiveMomentumMinM5Pct = next;
  }
  if (p90.m5 != null && current.offensiveMomentumMaxM5Pct > 0) {
    const next = clampScalarDelta(
      current.offensiveMomentumMaxM5Pct,
      Math.max(p90.m5 * 1.05, current.offensiveMomentumMinM5Pct + 0.5),
      frac
    );
    if (next !== current.offensiveMomentumMaxM5Pct) out.offensiveMomentumMaxM5Pct = next;
  }
  if (p10.m15 != null) {
    const next = clampScalarDelta(
      current.offensiveMomentumMinM15Pct,
      Math.max(0, Math.min(p10.m15, current.offensiveMomentumMinM15Pct * 1.5)),
      frac
    );
    if (next !== current.offensiveMomentumMinM15Pct) out.offensiveMomentumMinM15Pct = next;
  }
  if (p90.m15 != null && current.offensiveMomentumMaxM15Pct > 0) {
    const next = clampScalarDelta(
      current.offensiveMomentumMaxM15Pct,
      Math.max(p90.m15 * 1.05, current.offensiveMomentumMinM15Pct + 0.5),
      frac
    );
    if (next !== current.offensiveMomentumMaxM15Pct) out.offensiveMomentumMaxM15Pct = next;
  }
  if (p10.m30 != null) {
    const next = clampScalarDelta(
      current.offensiveMomentumMinM30Pct,
      Math.max(0, Math.min(p10.m30, current.offensiveMomentumMinM30Pct * 1.5)),
      frac
    );
    if (next !== current.offensiveMomentumMinM30Pct) out.offensiveMomentumMinM30Pct = next;
  }
  if (p90.m30 != null && current.offensiveMomentumMaxM30Pct > 0) {
    const next = clampScalarDelta(
      current.offensiveMomentumMaxM30Pct,
      Math.max(p90.m30 * 1.05, current.offensiveMomentumMinM30Pct + 0.5),
      frac
    );
    if (next !== current.offensiveMomentumMaxM30Pct) out.offensiveMomentumMaxM30Pct = next;
  }

  if (seg.winnerCompositeP25 != null && current.scheduledChangeMinWeightedScore > 0) {
    const matchRate =
      seg.sampleCount > 0 ? seg.chosenMatchedWinnerCount / seg.sampleCount : 1;
    let target = seg.winnerCompositeP25;
    if (matchRate < 0.5) target = Math.min(0.98, target + 0.02);
    else if (matchRate > 0.85) target = Math.max(0.75, target - 0.01);
    const next = clampScalarDelta(current.scheduledChangeMinWeightedScore, target, frac);
    if (next !== current.scheduledChangeMinWeightedScore) {
      out.scheduledChangeMinWeightedScore = round4(next);
    }
  }

  if (seg.winnerVolumeH12P5 != null) {
    const target = Math.min(current.minVolumeH12Usd, Math.floor(seg.winnerVolumeH12P5 * 0.9));
    if (target >= 1000 && target < current.minVolumeH12Usd) {
      out.minVolumeH12Usd = target;
    }
  }
  if (seg.winnerLiquidityP5 != null) {
    const target = Math.min(current.minPoolLiquidityUsd, Math.floor(seg.winnerLiquidityP5 * 0.85));
    if (target >= 50_000 && target < current.minPoolLiquidityUsd) {
      out.minPoolLiquidityUsd = target;
    }
  }

  return out;
}

function hasOverrideKeys(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length > 0;
}

export async function pruneCalibrationData(retentionMs = getCalibrationRetentionMs()): Promise<{
  events: number;
  outcomes: number;
  optimal: number;
}> {
  const cutoffMs = Date.now() - retentionMs;
  const events = await pruneJsonlByIsoField(getCalibrationEventsPath(), "timestampUtc", cutoffMs);
  const outcomes = await pruneJsonlByIsoField(getCalibrationOutcomesPath(), "collectedAtUtc", cutoffMs);
  const optimal = await pruneJsonlByIsoField(getCalibrationOptimalPath(), "collectedAtUtc", cutoffMs);
  return {
    events: events.removed,
    outcomes: outcomes.removed,
    optimal: optimal.removed,
  };
}

export async function runMetricCalibrationTuning(
  options: RunMetricCalibrationTuningOptions = {}
): Promise<MetricCalibrationTuningReport> {
  const windowMs = options.windowMs ?? getCalibrationTuningWindowMs();
  const cutoffMs = Date.now() - windowMs;
  const runAtUtc = new Date().toISOString();

  const [allOptimal, allEvents] = await Promise.all([
    readJsonlFile<MetricCalibrationOptimalRow>(getCalibrationOptimalPath()),
    readJsonlFile<MetricCalibrationEventEntry>(getCalibrationEventsPath()),
  ]);

  const optimalRows = allOptimal.filter((r) => parseIsoMs(r.collectedAtUtc) >= cutoffMs);
  const eventsById = new Map<string, MetricCalibrationEventEntry>();
  for (const e of allEvents) {
    if (e.eventId) eventsById.set(e.eventId, e);
  }

  const segments = buildSegmentStats(optimalRows, eventsById);
  const offensiveWeights = proposeOffensiveWeightOverrides(segments);

  const proposedDemeterOverrides: ConfigOverrides = {
    ...proposeDemeterThresholdOverrides(segments.floatV3),
    ...(offensiveWeights ? { offensiveTokenRankingMetrics: offensiveWeights } : {}),
  };
  const proposedTritonOverrides: TritonOverrides = proposeTritonThresholdOverrides(segments.floatV4);

  const totalSamples = optimalRows.length;
  const autoApplyEnabled = isCalibrationAutoApplyEnabled();
  const shouldApply = options.apply === true && autoApplyEnabled;
  let applySkippedReason: string | undefined;
  let applied = false;

  if (options.apply === true && !autoApplyEnabled) {
    applySkippedReason = "CALIBRATION_AUTO_APPLY is not enabled (set CALIBRATION_AUTO_APPLY=1 to write overrides)";
  } else if (shouldApply && totalSamples < CALIBRATION_TUNING_MIN_SAMPLES) {
    applySkippedReason = `Insufficient samples (${totalSamples} < ${CALIBRATION_TUNING_MIN_SAMPLES})`;
  } else if (
    shouldApply &&
    !hasOverrideKeys(proposedDemeterOverrides as Record<string, unknown>) &&
    !hasOverrideKeys(proposedTritonOverrides as Record<string, unknown>)
  ) {
    applySkippedReason = "No material threshold/weight changes proposed";
  } else if (shouldApply) {
    if (hasOverrideKeys(proposedDemeterOverrides as Record<string, unknown>)) {
      saveOverrides(proposedDemeterOverrides);
    }
    if (hasOverrideKeys(proposedTritonOverrides as Record<string, unknown>)) {
      saveTritonOverrides(proposedTritonOverrides);
    }
    applied = true;
  }

  let prune: MetricCalibrationTuningReport["prune"];
  if (options.pruneAfter !== false) {
    prune = await pruneCalibrationData();
  }

  const report: MetricCalibrationTuningReport = {
    runAtUtc,
    windowMs,
    totalSamples,
    applied,
    applySkippedReason,
    autoApplyEnabled,
    floatV3: segments.floatV3,
    floatV4: segments.floatV4,
    proposedDemeterOverrides,
    proposedTritonOverrides,
    prune,
  };

  if (options.writeState !== false) {
    await appendJsonlLine(getCalibrationTuningRunsPath(), report);
    await fs.writeFile(
      getCalibrationTuningStatePath(),
      JSON.stringify({ lastRunAtUtc: runAtUtc, lastReport: report }, null, 2),
      "utf8"
    );
  }

  return report;
}

export async function loadLastCalibrationTuningRunAt(): Promise<string | null> {
  try {
    const raw = await fs.readFile(getCalibrationTuningStatePath(), "utf8");
    const parsed = JSON.parse(raw) as { lastRunAtUtc?: string };
    return typeof parsed.lastRunAtUtc === "string" ? parsed.lastRunAtUtc : null;
  } catch {
    return null;
  }
}

export async function isCalibrationTuningDue(
  intervalMs = getCalibrationTuningWindowMs()
): Promise<boolean> {
  const last = await loadLastCalibrationTuningRunAt();
  if (!last) return true;
  const elapsed = Date.now() - Date.parse(last);
  return !Number.isFinite(elapsed) || elapsed >= intervalMs;
}
