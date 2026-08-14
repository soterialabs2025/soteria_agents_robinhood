/**
 * Append-only JSONL log when Demeter successfully submits changeStrategyAsset (DEFENSIVE, OFFENSIVE, scheduled, or price/volume checks).
 * Default path: <cwd>/logs/demeter-defensive-offensive-strategy.jsonl
 * Override: DEMETER_DEFENSIVE_OFFENSIVE_LOG_PATH
 * Only lines with `outcome: "success"` are written — skipped/failed attempts are not logged here (console logs still apply).
 * Each line includes oldToken, chosenToken, topThreeTokens, optional chosenTokenMetrics (buy_sell_ratio_h6/h24,
 * optional weighted_composite_score, optional weighted_metric_scores / offensive_ranking_raw / chosen_token_tokens_summary
 * on success (full parsed CoinGecko row for chosen + top-3 calibration snapshots), optional buyPressureScore for non-offensive picks), changeSummary.
 * Successful rows with `eventId` are mirrored to `logs/metric-calibration/events.jsonl` for 6h forward-return tracking.
 */

import * as fs from "fs/promises";
import * as path from "path";

export type DemeterStrategyModeTrigger =
  | "DEFENSIVE"
  | "STABLE"
  | "OFFENSIVE"
  | "SCHEDULED"
  | "PRICE_CHECK_LOW_VOLUME_12H"
  | "PRICE_CHECK_M30"
  | "LIQUID_STRATEGY_M5_DROP"
  | "LIQUID_STRATEGY_TOKEN_METRIC_INTERVAL";

/** Passed into change-strategy when triggered by DEFENSIVE / OFFENSIVE / scheduled interval (enables JSONL audit log). */
export type DemeterChangeStrategyAuditContext = {
  trigger: DemeterStrategyModeTrigger;
  upkeepTransaction?: string | null;
  strategyId?: number;
  /** Float = FloatContractManager.changeStrategyAsset; liquid = LiquidContractManager.changeLiquidStrategyAsset */
  keeperPipeline?: "float" | "float_v4" | "offensive" | "liquid";
};

/** Metrics for the selected next asset (same semantics as token comparison / buy-pressure pick). */
export type DemeterChosenTokenMetrics = {
  buy_sell_ratio_h6: number | null;
  buy_sell_ratio_h24: number | null;
  /**
   * Min–max normalized weighted composite (0–1) for this symbol from `weighted_ranking.ranked` in the same comparison
   * snapshot. On the scheduled offensive path, normalization is vs the full pre-momentum eligible cohort; `ranked` only
   * includes momentum-qualified symbols. Present when the row exists (success / failed / skip-with-chosen paths).
   */
  weighted_composite_score?: number;
  /** buySellBuyPressureScore(h6); omitted when scheduled offensive pick uses weighted rank only (no buy-pressure tie-break). */
  buyPressureScore?: number;
  /**
   * Per-metric normalized scores (0–1 on the “goodness” axis) from `weighted_ranking.ranked[].metric_scores` for this
   * symbol — same keys as offensive composite min–max step. Logged on **SCHEDULED** `outcome: success` only for baseline calibration.
   */
  weighted_metric_scores?: Record<string, number>;
  /**
   * Raw `tokens_summary` values for each key in `weighted_ranking.metrics_used` for this symbol (null if missing on row).
   * Logged with {@link DemeterChosenTokenMetrics.weighted_metric_scores} on SCHEDULED success for absolute-range design.
   */
  offensive_ranking_raw?: Record<string, number | null>;
  /**
   * Full `tokens_summary` entry for the chosen token after `buildTokenComparison` (all parsed pool + token fields the
   * app uses: `volume_m5`–`volume_h12`, `price_change_m5_pct`–`price_change_h12_pct`, `liquidity_usd`, etc.). Logged on
   * **SCHEDULED** `outcome: success` only. Values are JSON-serializable primitives only (nested API blobs are not stored here).
   */
  chosen_token_tokens_summary?: Record<string, string | number | null>;
};

export type WeightedRankingRowForLog = {
  symbol: string;
  score: number;
  metric_scores?: Record<string, number>;
};

/** Resolve {@link DemeterChosenTokenMetrics.weighted_composite_score} from `fetchTokenComparison`’s `weighted_ranking.ranked`. */
export function weightedCompositeScoreForSymbol(
  ranked: Array<{ symbol: string; score: number }> | undefined,
  symbol: string
): number | undefined {
  const row = ranked?.find((r) => r.symbol === symbol);
  if (!row || !Number.isFinite(row.score)) return undefined;
  return row.score;
}

/** Per-metric normalized scores from the same `weighted_ranking` row as {@link weightedCompositeScoreForSymbol}. */
export function weightedMetricScoresForSymbol(
  ranked: WeightedRankingRowForLog[] | undefined,
  symbol: string
): Record<string, number> | undefined {
  const row = ranked?.find((r) => r.symbol === symbol);
  const ms = row?.metric_scores;
  if (!ms || typeof ms !== "object") return undefined;
  return { ...ms };
}

/** Raw token-summary fields for offensive ranking keys (for calibrating absolute scales). */
export function offensiveRankingRawForSymbol(
  tokens: Array<Record<string, unknown>> | undefined,
  symbol: string,
  metricKeys: string[]
): Record<string, number | null> | undefined {
  if (!tokens?.length || !metricKeys.length) return undefined;
  const row = tokens.find((t) => t.symbol === symbol);
  if (!row) return undefined;
  const out: Record<string, number | null> = {};
  for (const k of metricKeys) {
    const v = row[k];
    if (v == null) {
      out[k] = null;
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
      continue;
    }
    if (typeof v === "string") {
      const n = parseFloat(v);
      out[k] = Number.isFinite(n) ? n : null;
      continue;
    }
    out[k] = null;
  }
  return out;
}

/**
 * Full `tokens_summary` row for one symbol (CoinGecko comparison snapshot) for JSONL / baselines.
 * Only string, number, and null are kept so the object is JSON-serializable.
 */
export function tokenSummarySnapshotForSymbol(
  tokens: Array<Record<string, unknown>> | undefined,
  symbol: string
): Record<string, string | number | null> | undefined {
  const row = tokens?.find((t) => t.symbol === symbol);
  if (!row) return undefined;
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (v === null) {
      out[k] = null;
    } else if (typeof v === "number") {
      out[k] = Number.isFinite(v) ? v : null;
    } else if (typeof v === "string") {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v ? 1 : 0;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Extras for JSONL when `trigger === "SCHEDULED"` and change strategy succeeds (offensive weighted path). */
export function scheduledSuccessBaselineMetrics(
  ranked: WeightedRankingRowForLog[] | undefined,
  chosenSymbol: string,
  tokens: Array<Record<string, unknown>> | undefined,
  weightedRanking: { ranked?: WeightedRankingRowForLog[]; metrics_used?: string[] } | undefined
): Pick<
  DemeterChosenTokenMetrics,
  "weighted_metric_scores" | "offensive_ranking_raw" | "chosen_token_tokens_summary"
> {
  const metricKeys = weightedRanking?.metrics_used?.length
    ? weightedRanking.metrics_used
    : Object.keys(weightedMetricScoresForSymbol(ranked, chosenSymbol) ?? {});
  const weighted_metric_scores = weightedMetricScoresForSymbol(ranked, chosenSymbol);
  const offensive_ranking_raw =
    metricKeys.length > 0 ? offensiveRankingRawForSymbol(tokens, chosenSymbol, metricKeys) : undefined;
  const chosen_token_tokens_summary = tokenSummarySnapshotForSymbol(tokens, chosenSymbol);
  const out: Pick<
    DemeterChosenTokenMetrics,
    "weighted_metric_scores" | "offensive_ranking_raw" | "chosen_token_tokens_summary"
  > = {};
  if (weighted_metric_scores && Object.keys(weighted_metric_scores).length > 0) {
    out.weighted_metric_scores = weighted_metric_scores;
  }
  if (offensive_ranking_raw && Object.keys(offensive_ranking_raw).length > 0) {
    out.offensive_ranking_raw = offensive_ranking_raw;
  }
  if (chosen_token_tokens_summary && Object.keys(chosen_token_tokens_summary).length > 0) {
    out.chosen_token_tokens_summary = chosen_token_tokens_summary;
  }
  return out;
}

export type DemeterDefensiveOffensiveLogEntry = {
  trigger: DemeterStrategyModeTrigger;
  /** performUpkeep tx when known (e.g. demeter_runCycle); may be null from agent upkeep path */
  upkeepTransaction: string | null;
  /** changeStrategyAsset tx hash when submitted successfully */
  changeStrategyTransaction: string | null;
  /** Up to 3 tokens considered after filters (same order as weighted rank) */
  topThreeTokens: Array<{ symbol: string; address: string }>;
  oldToken: { address: string; symbol: string | null };
  chosenToken: { symbol: string; address: string } | null;
  /** When set: 6h/12h buy-sell ratios; buyPressureScore omitted for offensive weighted-only picks. */
  chosenTokenMetrics?: DemeterChosenTokenMetrics | null;
  /** One-line old → new summary (for audits / quick diff vs token comparison). */
  changeSummary?: string | null;
  /** ISO-8601 in UTC (Z) */
  timestampUtc: string;
  /** Formatted in America/Los_Angeles (PST/PDT) */
  timestampPacific: string;
  outcome: "success" | "skipped" | "failed";
  details?: string;
  strategyId?: number;
  keeperPipeline?: "float" | "float_v4" | "offensive" | "liquid";
  /** Metric calibration: unique id for 6h forward-return tracking. */
  eventId?: string;
  /** UTC ISO when 6h outcome collection is due. */
  outcomeDueAtUtc?: string;
  /** Entry-time metrics for each top-3 candidate (calibration dataset). */
  topThreeTokenSnapshots?: Array<{
    symbol: string;
    address: string;
    metrics: DemeterChosenTokenMetrics;
  }>;
};

function defaultLogFilePath(): string {
  const override = process.env.DEMETER_DEFENSIVE_OFFENSIVE_LOG_PATH?.trim();
  if (override) return override;
  return path.join(process.cwd(), "logs", "demeter-defensive-offensive-strategy.jsonl");
}

/** Resolved path used for JSONL audit (for startup log / debugging). */
export function getDemeterDefensiveOffensiveLogPath(): string {
  return defaultLogFilePath();
}

/**
 * Ensures the log directory exists and the JSONL file exists (empty if new).
 * Call once at Demeter startup so the file is present even before the first change-strategy event.
 */
export async function ensureDemeterDefensiveOffensiveLogFile(): Promise<void> {
  const filePath = defaultLogFilePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, "", "utf8");
  }
}

export function formatDemeterLogTimestamps(now = new Date()): {
  timestampUtc: string;
  timestampPacific: string;
} {
  const timestampUtc = now.toISOString();
  const timestampPacific =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).format(now) + " (America/Los_Angeles)";
  return { timestampUtc, timestampPacific };
}

export async function appendDemeterDefensiveOffensiveLog(
  entry: DemeterDefensiveOffensiveLogEntry
): Promise<void> {
  if (entry.outcome !== "success") return;

  const filePath = defaultLogFilePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(filePath, line, "utf8");

  if (entry.eventId && entry.topThreeTokenSnapshots?.length) {
    const { appendMetricCalibrationEvent } = await import("./metric-calibration/calibration-log");
    await appendMetricCalibrationEvent({
      ...entry,
      eventId: entry.eventId,
      outcomeDueAtUtc: entry.outcomeDueAtUtc ?? entry.timestampUtc,
      topThreeTokenSnapshots: entry.topThreeTokenSnapshots,
    });
  }
}

export function resolveTokenSymbol(
  tokens: Array<{ symbol: string; address: string }> | undefined,
  addressLower: string | null | undefined
): string | null {
  if (!addressLower || !tokens?.length) return null;
  const t = tokens.find((x) => x.address?.toLowerCase() === addressLower);
  return t?.symbol ?? null;
}

export function buildOldTokenEntry(
  currentAssetAddress: string | null | undefined,
  tokens: Array<{ symbol: string; address: string }> | undefined
): { address: string; symbol: string | null } {
  const addr = (currentAssetAddress ?? "").trim();
  const symbol = addr ? resolveTokenSymbol(tokens, addr.toLowerCase()) : null;
  return { address: addr, symbol };
}
