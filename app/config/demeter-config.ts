
import * as fs from "fs";
import * as path from "path";

import type { Address } from "viem";

import { FLOAT_STRATEGY_MODE } from "../abi/contract-enums";
import { DEFAULT_USDG_ADDRESS, DEFAULT_WETH_ADDRESS, getUsdgAddress, getWethAddress } from "./chain-config";
import { pickAddr } from "./env-address";

// =============================================================================
// Default token ranking metrics (weights must sum to 1.0) - MAX SCORE - .72
// =============================================================================
//
// **Market breadth (24h):** `fetchTokenComparison` / `buildTokenComparison` evaluates the full
// `tokens_summary` cohort first. When at least {@link DEFAULT_MARKET_BREADTH_NEGATIVE_H24_FRACTION_GTE} of tokens with a
// valid pool **24h** Δ% are **negative**, ranking may be bypassed for stable rotation: **Float V3** → {@link STABLE_USDC_WETH_PAIR}
// and `changeStrategyAsset(USDC)`; **Float V4** → {@link STABLE_V4_WETH_ADDRESS} and `FloatContractManagerV4.exitStrategyToStable()`
// (100% WETH, on-chain mode STABLE). By default ({@link DEFAULT_MARKET_BREADTH_REQUIRE_CURRENT_ASSET_NEGATIVE_H24}) the current
// strategy token must also have **negative** 24h pool Δ%; otherwise no stable rotation. When breadth clears, normal
// {@link DEFAULT_TOKEN_RANKING_METRICS} / offensive metrics apply again. See {@link computeMarketH24BreadthFromTokenSummary}.

const DEFAULT_TOKEN_RANKING_METRICS = {
  volume_h6: {
    weight: 0.02,
    higherIsBetter: true,
    description: "6h trading volume. Fee generation, trading activity.",
  },
  volume_h1: {
    weight: .0,
    higherIsBetter: true,
    description: "1h pool volume (USD). Default Float composite does not use it (weight 0); available for overrides / Offensive.",
  },
  volume_h12: {
    weight: 0.03,
    higherIsBetter: true,
    description: "12h trading volume. Fee generation, trading activity.",
  },
  volume_m5: {
    weight: 0.00,
    higherIsBetter: true,
    description: "5m pool volume (USD). Onchain pool volume_usd.m5; default Float weight 0.",
  },
  volume_m15: {
    weight: 0.0,
    higherIsBetter: true,
    description: "15m pool volume (USD). Onchain pool volume_usd.m15; default Float weight 0.",
  },
  volume_m30: {
    weight: 0.0,
    higherIsBetter: true,
    description: "30m pool volume (USD). Onchain pool volume_usd.m30; default Float weight 0.",
  },
  buy_sell_ratio_h6: {
    weight: 0.07,
    higherIsBetter: true,
    description:
      "Buy ratio (0-1), buy volume share vs sells. Higher = more buy-side flow (good). Lower = heavier selling (bad). Sole input when choosing the final token among the top 4 ranked candidates (highest 6h ratio = strongest buy pressure).",
  },
  buy_sell_ratio_h24: {
    weight: 0.0,
    higherIsBetter: false,
    description:
      "24h buy ratio (0-1), buy volume share vs sells. Lower = oversold (good, likely to bounce). Higher = overbought (bad). Contributes to weighted composite alongside other metrics.",
  },
  price_change_h6: {
    weight: 0.12,
    higherIsBetter: true,
    description: "6h price change %. Higher = price went up = good.",
  },
  price_change_h1: {
    weight: 0.18,
    higherIsBetter: true,
    description: "1h price change %. Default Float composite does not use it (weight 0); available for overrides / Offensive.",
  },
  price_change_h12: {
    weight: 0.04,
    higherIsBetter: true,
    description: "12h price change % (pool; interpolated from h6/h24 when API omits h12). Higher = price went up = good.",
  },
  price_change_m5_pct: {
    weight: 0.01,
    higherIsBetter: true,
    description: "5m pool price change %. Higher = up; default Float weight 0.",
  },
  price_change_m15_pct: {
    weight: 0.02,
    higherIsBetter: true,
    description: "15m pool price change %. Higher = up; default Float weight 0.",
  },
  price_change_m30_pct: {
    weight: 0.05,
    higherIsBetter: true,
    description: "30m pool price change %. Higher = up; default Float weight 0.",
  },
  price_stability_h24: {
    weight: 0.08,
    higherIsBetter: true,
    description: "24h price stability. Lower |price change| = more stable = good.",
  },
  volatility_h6: {
    weight: 0.10,
    higherIsBetter: true,
    description: "6h pool volume / liquidity (6h turnover). Higher = more 6h activity per unit liquidity.",
  },
} as const;

/**
 * x402 paid token-score — **own defaults**, independent of Float {@link DEFAULT_TOKEN_RANKING_METRICS}.
 * Tune these weights for LP-position ranking without changing Demeter Float composites.
 * API responses expose `score_normalized` = score / sum(weights). Max score is 1.0.
 */
export const X402_TOKEN_RANKING_METRICS = {
  volume_m5: {
    weight: 0.01,
    higherIsBetter: true,
    description: "5m pool volume (USD).",
  },
  volume_m15: {
    weight: 0.02,
    higherIsBetter: true,
    description: "15m pool volume (USD).",
  },
  volume_m30: {
    weight: 0.06,
    higherIsBetter: true,
    description: "30m pool volume (USD).",
  },
  volume_h1: {
    weight: 0.10,
    higherIsBetter: true,
    description: "1h pool volume (USD).",
  },
  volume_h6: {
    weight: 0.08,
    higherIsBetter: true,
    description: "6h trading volume. Fee generation, trading activity.",
  },
  volume_h12: {
    weight: 0.05,
    higherIsBetter: true,
    description: "12h trading volume. Fee generation, trading activity.",
  },
  buy_sell_ratio_h6: {
    weight: 0.08,
    higherIsBetter: true,
    description:
      "Buy ratio (0-1), buy volume share vs sells. Higher = more buy-side flow (good for LP entry).",
  },
  buy_sell_ratio_h24: {
    weight: 0.08,
    higherIsBetter: false,
    description:
      "24h buy ratio (0-1). Lower = more sell-heavy / oversold (good when enabled).",
  },
  price_change_m5_pct: {
    weight: 0.01,
    higherIsBetter: true,
    description: "5m pool price change %. Higher = up.",
  },
  price_change_m15_pct: {
    weight: 0.02,
    higherIsBetter: true,
    description: "15m pool price change %. Higher = up.",
  },
  price_change_m30_pct: {
    weight: 0.05,
    higherIsBetter: true,
    description: "30m pool price change %. Higher = up.",
  },
  price_change_h1: {
    weight: 0.08,
    higherIsBetter: true,
    description: "1h price change %. Higher = price went up = good.",
  },
  price_change_h6: {
    weight: 0.08,
    higherIsBetter: true,
    description: "6h price change %. Higher = price went up = good.",
  },
  price_change_h12: {
    weight: 0.04,
    higherIsBetter: true,
    description:
      "12h price change % (pool; interpolated from h6/h24 when API omits h12). Higher = up = good.",
  },
  price_stability_h24: {
    weight: 0.12,
    higherIsBetter: true,
    description: "24h price stability. Lower |price change| = more stable = good for LPs.",
  },
  volatility_h6: {
    weight: 0.12,
    higherIsBetter: true,
    description:
      "6h pool volume / liquidity (6h turnover). Higher = more fee opportunity per unit liquidity.",
  },
} as const;

type DefaultTokenRankingMetricKeys = keyof typeof DEFAULT_TOKEN_RANKING_METRICS;

/** Same keys as Float metrics; each entry allows any weight/description (Offensive defaults differ). */
type TokenRankingMetricsConfig = {
  [K in DefaultTokenRankingMetricKeys]: {
    weight: number;
    higherIsBetter: boolean;
    description: string;
  };
};

/**
 * **Scheduled Float** offensive weighted ranking — **5m/15m/30m pool price %** is the main ignition signal; **5m is weighted
 * above 30m** so the freshest leg matters more than the half-hour tape. **6h/12h pool price %** carry material weight so a
 * token **down hard on the tape** (e.g. −5% / 6h, −10% / 12h) cannot float to a top composite on short green blips alone.
 * 1h price and volumes stay light context. **24h buy/sell skew** (overbought guard). 6h buy ratio (composite), stability:
 * weight 0. Active weights sum to 1.0.
 *
 * **Momentum layer (scheduled path):** tokens must pass absolute **up** moves on m5/m15/m30 (when data exists) and
 * optionally short-volume vs spread-from-h12 checks to **appear** in `weighted_ranking.ranked`. The offensive composite for
 * each row is Σ weight × normalized metric vs **all pre-momentum eligible** tokens (same volume/liquidity/short-horizon
 * exclusions, before momentum). Default normalization is **cohort min–max**; optional **baseline** mode centers each metric on a
 * fixed μ (e.g. means from labeled “bought right time” trades) at score 0.5 with spread from the cohort range — see
 * {@link getOffensiveWeightedScoreNormalization}. Passing momentum alone does not define the score. If no token passes momentum, `weighted_ranking.ranked` is empty.
 */
const DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS: TokenRankingMetricsConfig = {
  volume_h1: {
    ...DEFAULT_TOKEN_RANKING_METRICS.volume_h1,
    weight: 0.01,
    description:
      "1h pool volume (USD). Secondary to short price; kept small so flow does not mimic a 5–30m momentum leg.",
  },
  volume_m5: {
    ...DEFAULT_TOKEN_RANKING_METRICS.volume_m5,
    weight: 0.02,
    description: "5m pool volume (USD). Confirms activity behind m5 price; low weight vs price_change m5.",
  },
  volume_m15: {
    ...DEFAULT_TOKEN_RANKING_METRICS.volume_m15,
    weight: 0.05,
    description: "15m pool volume (USD). Short-horizon participation; supports m15 price signal.",
  },
  volume_m30: {
    ...DEFAULT_TOKEN_RANKING_METRICS.volume_m30,
    weight: 0.05,
    description: "30m pool volume (USD). Context for m30 price move.",
  },
  volume_h6: {
    ...DEFAULT_TOKEN_RANKING_METRICS.volume_h6,
    weight: 0.01,
    description: "6h pool volume (USD). Light context only.",
  },
  volume_h12: {
    ...DEFAULT_TOKEN_RANKING_METRICS.volume_h12,
    weight: 0.01,
    description: "12h pool volume (USD). Light context only (eligibility still uses 12h vol floors off-ranking).",
  },
  buy_sell_ratio_h6: {
    ...DEFAULT_TOKEN_RANKING_METRICS.buy_sell_ratio_h6,
    weight: 0,
    description:
      "Unused in Offensive composite (weight 0). Scheduled offensive on-chain pick follows weighted rank order (no buy-pressure tie-break).",
  },
  price_change_m5_pct: {
    ...DEFAULT_TOKEN_RANKING_METRICS.price_change_m5_pct,
    weight: 0.0,
    description:
      "5m pool price change %. Weighted above m30 — freshest ignition leg; still paired with m15 so noise alone does not dominate.",
  },
  price_change_m15_pct: {
    ...DEFAULT_TOKEN_RANKING_METRICS.price_change_m15_pct,
    weight: 0.36,
    description: "15m pool price change %. Largest single weight — core short trend window between m5 and m30.",
  },
  price_change_m30_pct: {
    ...DEFAULT_TOKEN_RANKING_METRICS.price_change_m30_pct,
    weight: 0.32,
    description:
      "30m pool price change %. Context vs m5/m15; deliberately below m5 so the 5m leg drives rank more than the 30m tape.",
  },
  price_change_h1: {
    ...DEFAULT_TOKEN_RANKING_METRICS.price_change_h1,
    weight: 0.08,
    description:
      "1h pool price change %. Light confirmation only — avoids overweighting a mild 1h grind vs true 5–30m pops.",
  },
  price_change_h6: {
    ...DEFAULT_TOKEN_RANKING_METRICS.price_change_h6,
    weight: 0.02,
    description:
      "6h pool price change %. Meaningful tape context — e.g. −5% / 6h should drag the offensive score vs. short pops.",
  },
  price_change_h12: {
    ...DEFAULT_TOKEN_RANKING_METRICS.price_change_h12,
    weight: 0.01,
    description:
      "12h pool price change % (interpolated from h6/h24 when h12 omitted). Penalizes sustained dumps so −10% / 12h hurts the composite.",
  },
  buy_sell_ratio_h24: {
    ...DEFAULT_TOKEN_RANKING_METRICS.buy_sell_ratio_h24,
    weight: 0.04,
    description:
      "24h buy ratio (0–1), higherIsBetter=false. **Overbought guard**: penalizes extreme buy-heavy days; favors skew with room for a fresh leg up.",
  },
  price_stability_h24: {
    ...DEFAULT_TOKEN_RANKING_METRICS.price_stability_h24,
    weight: 0.02,
    description: "Unused for Offensive ranking (24h stability works against ‘moment’ trading).",
  },
  volatility_h6: {
    ...DEFAULT_TOKEN_RANKING_METRICS.volatility_h6,
    weight: 0.02,
    description:
      "6h pool volume / liquidity (6h turnover). Small tie-break for execution quality; not a substitute for short price %.",
  },
};

/**
 * Offensive ranking weights for `absolute` normalization (evidence-based, volume-led). Seeded from the Float codebase's
 * 2026-07-16 calibration (auc_proportional); re-derive from THIS codebase's UFloat calibration logs once collected.
 * Only active when {@link getOffensiveWeightedScoreNormalization} === `"absolute"` (env
 * `OFFENSIVE_WEIGHTED_SCORE_NORMALIZATION=absolute`); otherwise {@link DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS} is used.
 * Bounds live in {@link OFFENSIVE_ABSOLUTE_SCORE_BOUNDS}; gate in {@link DEFAULT_OFFENSIVE_ABSOLUTE_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE}.
 */
const DEFAULT_OFFENSIVE_ABSOLUTE_TOKEN_RANKING_METRICS: TokenRankingMetricsConfig = {
  // Buy pressure = 0.26. Near-random on fresh data (AUC ~0.48–0.55); kept modest because the >=0.5 eligibility gate
  // already enforces net buying and product intent still values fresh buy pressure.
  buy_sell_ratio_h6: {
    ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.buy_sell_ratio_h6,
    weight: 0.13,
    higherIsBetter: true,
    description: "6h buy ratio (0–1). Confirmation signal (trimmed — near-random AUC on fresh data).",
  },
  buy_sell_ratio_h24: {
    ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.buy_sell_ratio_h24,
    weight: 0.13,
    higherIsBetter: true,
    description: "24h buy ratio (0–1). Confirmation signal (trimmed — near-random AUC on fresh data).",
  },
  // Volume = 0.50. volume_h1 is the single strongest separator (AUC 0.66) → dominant weight.
  volume_h1: {
    ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.volume_h1,
    weight: 0.3,
    higherIsBetter: true,
    description: "1h volume. Strongest winner-vs-loser separator (AUC 0.66) — dominant offensive weight.",
  },
  volume_m30: { ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.volume_m30, weight: 0.06, higherIsBetter: true },
  volume_m15: { ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.volume_m15, weight: 0.05, higherIsBetter: true },
  volume_h12: { ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.volume_h12, weight: 0.04, higherIsBetter: true },
  volume_m5: { ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.volume_m5, weight: 0.03, higherIsBetter: true },
  volume_h6: { ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.volume_h6, weight: 0.02, higherIsBetter: true },
  // Price change (momentum) = 0.14. Fresh-ignition legs; small positive weight, higherIsBetter (no inversion).
  price_change_h1: {
    ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.price_change_h1,
    weight: 0.06,
    higherIsBetter: true,
    description: "1h pool price change %. Fresh ignition leg (higher = better).",
  },
  price_change_m5_pct: {
    ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.price_change_m5_pct,
    weight: 0.05,
    higherIsBetter: true,
    description: "5m pool price change %. Fresh-ignition confirmation (higher = better).",
  },
  price_change_m30_pct: {
    ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.price_change_m30_pct,
    weight: 0.03,
    higherIsBetter: true,
  },
  price_change_m15_pct: { ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.price_change_m15_pct, weight: 0, higherIsBetter: true },
  // h6/h12 "buy-the-dip" inversion stays DISABLED (weight 0) — product rule: offensive rotates INTO strength, never
  // rewards falling tokens. Re-derive from OFFENSIVE-trigger-only winners before ever re-enabling.
  price_change_h6: {
    ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.price_change_h6,
    weight: 0,
    higherIsBetter: true,
    description: "6h pool price change %. Disabled (weight 0) — no dip inversion.",
  },
  price_change_h12: {
    ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.price_change_h12,
    weight: 0,
    higherIsBetter: true,
    description: "12h pool price change %. Disabled (weight 0) — no dip inversion.",
  },
  // Stability = 0.10. Kept modest for sustainability intent only.
  price_stability_h24: {
    ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.price_stability_h24,
    weight: 0.1,
    higherIsBetter: true,
  },
  volatility_h6: { ...DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS.volatility_h6, weight: 0, higherIsBetter: true },
};

/**
 * Fixed per-metric absolute `{lo, hi}` reference bounds for `absolute` normalization. `axis01 = clamp01((raw − lo)/(hi − lo))`,
 * then the metric's `higherIsBetter` flip — **independent of the current cohort** (no min–max, no single-token 1.0 shortcut),
 * so a lone weak token scores on its own merit and two weak moves both score low. Seeded from the Float codebase's ALL/V4
 * segment (2026-07-16); rebuild from THIS codebase's UFloat calibration data via the tuner.
 */
export const OFFENSIVE_ABSOLUTE_SCORE_BOUNDS: Record<string, { lo: number; hi: number }> = {
  volume_h1: { lo: 136.74, hi: 2176.7639 },
  volume_m5: { lo: 0, hi: 16.1464 },
  volume_m15: { lo: 0.0117, hi: 1074.0825 },
  volume_m30: { lo: 14.1396, hi: 1643.5368 },
  volume_h6: { lo: 5405.3664, hi: 12419.1139 },
  volume_h12: { lo: 13259.8564, hi: 36955.1814 },
  price_change_m15_pct: { lo: -0.9415, hi: 0 },
  price_change_m30_pct: { lo: 0, hi: 2.2225 },
  price_change_h1: { lo: 0, hi: 5.2475 },
  price_change_h6: { lo: -14.786, hi: 5.5412 },
  price_change_h12: { lo: -9.9172, hi: 8.4927 },
  price_change_m5_pct: { lo: 0, hi: 2 },
  // Neutral-centered: 0.5 = balanced buys/sells scores 0, only genuine buy pressure (>0.5) earns axis > 0. Prevents a
  // net-selling token (ratio < 0.5) from maxing the axis.
  buy_sell_ratio_h6: { lo: 0.5, hi: 0.7 },
  buy_sell_ratio_h24: { lo: 0.5, hi: 0.65 },
  price_stability_h24: { lo: 0.0585, hi: 0.1501 },
};

/**
 * μ per offensive ranking metric key (`TokenSummaryRow` field names) for baseline weighted scoring.
 * Populate from aggregates of manually labeled “bought right time” snapshots, or leave empty and set
 * `OFFENSIVE_WEIGHTED_SCORE_BASELINE_JSON` instead.
 */
export const OFFENSIVE_RIGHT_TIME_BASELINE_RAW_MEANS: Record<string, number> = {};

export type OffensiveWeightedScoreNormalization = "cohort_minmax" | "baseline" | "absolute";

/**
 * `cohort_minmax` (default): each metric is 0–1 via min–max across the eligible cohort.
 * `baseline`: same cohort spread (`max − min`) per metric, but raw values are centered so **μ maps to 0.5** before direction flip.
 * `absolute`: each metric is 0–1 via fixed {@link OFFENSIVE_ABSOLUTE_SCORE_BOUNDS} `(raw − lo)/(hi − lo)` — no cohort dependence;
 *   also swaps in {@link DEFAULT_OFFENSIVE_ABSOLUTE_TOKEN_RANKING_METRICS} weights + {@link DEFAULT_OFFENSIVE_ABSOLUTE_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE} gate.
 * Enable via env `OFFENSIVE_WEIGHTED_SCORE_NORMALIZATION=absolute` (`baseline`/`right_time` for baseline) plus JSON or {@link OFFENSIVE_RIGHT_TIME_BASELINE_RAW_MEANS}.
 */
export function getOffensiveWeightedScoreNormalization(): OffensiveWeightedScoreNormalization {
  const v = process.env.OFFENSIVE_WEIGHTED_SCORE_NORMALIZATION?.trim().toLowerCase();
  if (v === "absolute") return "absolute";
  if (v === "baseline" || v === "right_time") return "baseline";
  return "cohort_minmax";
}

/** Raw μ map from env JSON (`OFFENSIVE_WEIGHTED_SCORE_BASELINE_JSON`) or non-empty {@link OFFENSIVE_RIGHT_TIME_BASELINE_RAW_MEANS}. */
export function getOffensiveWeightedScoreBaselineRaw(): Record<string, number> | null {
  const json = process.env.OFFENSIVE_WEIGHTED_SCORE_BASELINE_JSON?.trim();
  if (json) {
    try {
      const o = JSON.parse(json) as Record<string, unknown>;
      const out: Record<string, number> = {};
      for (const [k, val] of Object.entries(o)) {
        if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
      }
      if (Object.keys(out).length > 0) return out;
    } catch {
      /* invalid JSON — fall through */
    }
  }
  const embedded = OFFENSIVE_RIGHT_TIME_BASELINE_RAW_MEANS;
  return Object.keys(embedded).length > 0 ? { ...embedded } : null;
}

/**
 * `explicit === null` forces cohort min–max. Non-empty `explicit` wins. Otherwise baseline comes from env when normalization mode is `baseline`.
 */
export function resolveWeightedScoreBaseline(
  explicit?: Record<string, number> | null
): Record<string, number> | undefined {
  if (explicit === null) return undefined;
  if (explicit && Object.keys(explicit).length > 0) return explicit;
  if (getOffensiveWeightedScoreNormalization() !== "baseline") return undefined;
  return getOffensiveWeightedScoreBaselineRaw() ?? undefined;
}

/** Per-metric `{lo, hi}` bounds from env JSON (`OFFENSIVE_WEIGHTED_SCORE_BOUNDS_JSON`) or non-empty {@link OFFENSIVE_ABSOLUTE_SCORE_BOUNDS}. */
export function getOffensiveWeightedScoreBounds(): Record<string, { lo: number; hi: number }> | null {
  const json = process.env.OFFENSIVE_WEIGHTED_SCORE_BOUNDS_JSON?.trim();
  if (json) {
    try {
      const o = JSON.parse(json) as Record<string, unknown>;
      const out: Record<string, { lo: number; hi: number }> = {};
      for (const [k, val] of Object.entries(o)) {
        if (val && typeof val === "object") {
          const lo = (val as { lo?: unknown }).lo;
          const hi = (val as { hi?: unknown }).hi;
          if (typeof lo === "number" && typeof hi === "number" && Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
            out[k] = { lo, hi };
          }
        }
      }
      if (Object.keys(out).length > 0) return out;
    } catch {
      /* invalid JSON — fall through */
    }
  }
  const embedded = OFFENSIVE_ABSOLUTE_SCORE_BOUNDS;
  return Object.keys(embedded).length > 0 ? { ...embedded } : null;
}

/**
 * `explicit === null` forces cohort/baseline (no absolute bounds). Non-empty `explicit` wins. Otherwise absolute bounds
 * are used only when normalization mode is `absolute`.
 */
export function resolveWeightedScoreBounds(
  explicit?: Record<string, { lo: number; hi: number }> | null
): Record<string, { lo: number; hi: number }> | undefined {
  if (explicit === null) return undefined;
  if (explicit && Object.keys(explicit).length > 0) return explicit;
  if (getOffensiveWeightedScoreNormalization() !== "absolute") return undefined;
  return getOffensiveWeightedScoreBounds() ?? undefined;
}

export type TokenRankingMetricsMap = Record<
  string,
  { weight: number; higherIsBetter: boolean; description?: string }
>;

/** Minimal token row for {@link getTopActionableOffensiveScore} (scheduled score gate). */
export type ActionableTokenSummaryForScoreGate = {
  symbol: string;
  address: string;
  volume_h12?: number;
  liquidity_usd?: number | null;
  /** Pool 24h volume ÷ liquidity (see {@link getMinVolatilityH24Usd}); used with scheduled score gate when &gt; 0. */
  volatility_h24?: number;
};

/** True when `volatility_h24` satisfies active min/max USD ratio gates (each side disabled when its bound is ≤ 0). */
export function passesVolatilityH24Band(volatilityH24: unknown, minUsd: number, maxUsd: number): boolean {
  if (minUsd > 0) {
    if (typeof volatilityH24 !== "number" || !Number.isFinite(volatilityH24) || volatilityH24 < minUsd) {
      return false;
    }
  }
  if (maxUsd > 0) {
    if (typeof volatilityH24 !== "number" || !Number.isFinite(volatilityH24) || volatilityH24 > maxUsd) {
      return false;
    }
  }
  return true;
}

/** V3 market-breadth stable token — WETH/USDC pool turnover can exceed {@link DEFAULT_MAX_VOLATILITY_H24_USD}. */
export function isStableUsdcTokenAddress(tokenAddress: string | undefined | null): boolean {
  if (!tokenAddress?.trim()) return false;
  return tokenAddress.trim().toLowerCase() === getStableUsdcWethPair().tokenAddress.toLowerCase();
}

/**
 * Volatility gate for `changeStrategyAsset` / scheduled pick eligibility.
 * {@link STABLE_USDC_WETH_PAIR} USDC is exempt so risk-off rotation is not blocked by WETH/USDC pool turnover.
 */
export function passesChangeStrategyVolatilityH24Band(
  volatilityH24: unknown,
  minUsd: number,
  maxUsd: number,
  tokenAddress?: string | undefined | null
): boolean {
  if (isStableUsdcTokenAddress(tokenAddress)) return true;
  return passesVolatilityH24Band(volatilityH24, minUsd, maxUsd);
}

/**
 * First `weighted_ranking.ranked` entry that could become a Float changeStrategy candidate (not WETH, meets volume/liquidity/volatility floors when configured).
 * On the scheduled path, `ranked` lists momentum-qualified tokens sorted by composite score, where each `score` was computed
 * vs the full pre-momentum eligible cohort in `fetchTokenComparison` (offensive momentum flags on), using cohort min–max or
 * baseline-centered normalization per {@link getOffensiveWeightedScoreNormalization}.
 * Used to compare offensive composite `score` against {@link getScheduledChangeMinWeightedScore} on the scheduled loop only.
 */
export function getTopActionableOffensiveScore(
  ranked: Array<{ symbol: string; score: number }>,
  tokens: ActionableTokenSummaryForScoreGate[] | undefined,
  opts: {
    minVolumeH12Usd: number;
    minPoolLiquidityUsd: number;
    minVolatilityH24Usd: number;
    maxVolatilityH24Usd: number;
    wethLower: string;
  }
): { symbol: string; score: number } | null {
  for (const r of ranked) {
    const token = tokens?.find((t) => t.symbol === r.symbol);
    const addr = token?.address?.toLowerCase();
    if (!addr) continue;
    if (addr === opts.wethLower) continue;
    if (token && typeof token.volume_h12 === "number" && token.volume_h12 < opts.minVolumeH12Usd) continue;
    if (token && (typeof token.liquidity_usd !== "number" || token.liquidity_usd < opts.minPoolLiquidityUsd)) continue;
    if (
      !passesChangeStrategyVolatilityH24Band(
        token?.volatility_h24,
        opts.minVolatilityH24Usd,
        opts.maxVolatilityH24Usd,
        token?.address
      )
    ) {
      continue;
    }
    return { symbol: r.symbol, score: r.score };
  }
  return null;
}

/**
 * 6h buy/sell ratio for the final pick among the top-N ranked candidates (no extra API).
 * Higher = more buy volume vs sells. Missing data → 0.5 (neutral on the 0–1 scale).
 * {@link pickStrongestBuyPressureCandidate} maximizes this among top-N (ties keep earlier candidate).
 */
export function buySellBuyPressureScore(buySellRatioH6: number | null | undefined): number {
  return buySellRatioH6 ?? 0.5;
}

type BuySellRatios = {
  buy_sell_ratio_h6: number | null;
  buy_sell_ratio_h24: number | null;
};

/** Among pre-filtered top-N candidates (same order as weighted rank), pick the highest 6h buy/sell ratio (buys good); on tie, keep the earlier candidate. */
export function pickStrongestBuyPressureCandidate<T extends BuySellRatios>(candidates: T[]): T {
  if (candidates.length === 0) {
    throw new Error("pickStrongestBuyPressureCandidate: empty candidates");
  }
  return candidates.reduce((best, c) => {
    const sC = buySellBuyPressureScore(c.buy_sell_ratio_h6);
    const sB = buySellBuyPressureScore(best.buy_sell_ratio_h6);
    if (sC > sB) return c;
    if (sC < sB) return best;
    return best;
  });
}

/** Minimal token row from comparison for weighted-rank / buy-pressure helpers. */
export type OffensiveTokenSummaryRow = {
  symbol: string;
  address: string;
  volume_h12?: number;
  /** Total USD liquidity (base+quote) for the token’s ranked pool; used with {@link getMinPoolLiquidityUsd}. */
  liquidity_usd?: number | null;
  /** Pool 24h volume ÷ liquidity; used with {@link getMinVolatilityH24Usd} when &gt; 0. */
  volatility_h24?: number;
  buy_sell_ratio_h6?: number | null;
  buy_sell_ratio_h24?: number | null;
};

export type OffensiveWeightedPick = BuySellRatios & { symbol: string; address: string };

/**
 * First eligible token in weighted `ranked` order (no buy-pressure tie-break among top N).
 * FloatStrategy defensive-style changeStrategy uses {@link pickStrongestBuyPressureCandidate}; scheduled offensive uses weighted order only.
 * `topForLog` is the first `topNForLog` eligible entries for audit trails.
 */
export function pickTopWeightedOffensiveCandidate(
  ranked: Array<{ symbol: string }>,
  tokens: OffensiveTokenSummaryRow[] | undefined,
  opts: {
    minVolumeH12Usd: number;
    minPoolLiquidityUsd: number;
    minVolatilityH24Usd: number;
    maxVolatilityH24Usd: number;
    wethLower: string;
    currentLower: string | undefined;
    forceChangeIfTopIsCurrent: boolean;
    topNForLog?: number;
  }
): { chosen: OffensiveWeightedPick | null; topForLog: Array<{ symbol: string; address: string }> } {
  const topN = opts.topNForLog ?? 3;
  const topForLog: Array<{ symbol: string; address: string }> = [];
  let chosen: OffensiveWeightedPick | null = null;

  if (!tokens?.length) {
    return { chosen: null, topForLog };
  }

  for (const { symbol } of ranked) {
    const token = tokens.find((t) => t.symbol === symbol);
    const addr = token?.address?.toLowerCase();
    if (!addr) continue;
    if (addr === opts.wethLower) continue;
    if (token && typeof token.volume_h12 === "number" && token.volume_h12 < opts.minVolumeH12Usd) {
      continue;
    }
    if (
      token &&
      (typeof token.liquidity_usd !== "number" || token.liquidity_usd < opts.minPoolLiquidityUsd)
    ) {
      continue;
    }
    if (
      !passesChangeStrategyVolatilityH24Band(
        token?.volatility_h24,
        opts.minVolatilityH24Usd,
        opts.maxVolatilityH24Usd,
        token?.address
      )
    ) {
      continue;
    }
    if (opts.forceChangeIfTopIsCurrent && opts.currentLower && addr === opts.currentLower) {
      continue;
    }

    const row: OffensiveWeightedPick = {
      symbol,
      address: token!.address,
      buy_sell_ratio_h6: token?.buy_sell_ratio_h6 ?? null,
      buy_sell_ratio_h24: token?.buy_sell_ratio_h24 ?? null,
    };
    if (!chosen) {
      chosen = row;
    }
    if (topForLog.length < topN) {
      topForLog.push({ symbol, address: token!.address });
    }
  }

  return { chosen, topForLog };
}

// =============================================================================
// Keeper & deployment (edit here; chat overrides in config.overrides.json)
// =============================================================================

/** FloatKeeper (V3) contract address. */
export const DEFAULT_KEEPER_ADDRESS = "0x2Db9Cc1947593BF5056d12592989D3fc96C1fE4C";

/** FloatContractManager (V3) contract address (single source of truth; not from env). */
export const FLOAT_CONTRACT_MANAGER_ADDRESS =
  "0x8b8a48Db78e6f1d1e465b3abaBea88f2532c7154" as const;

/** FloatKeeperV4 contract address. */
export const DEFAULT_FLOAT_V4_KEEPER_ADDRESS =
  "0xC76520DC0B70b708D4c45F0c04d7dF9A07082983" as const;

/** FloatContractManager V4 contract address. */
export const FLOAT_CONTRACT_MANAGER_V4_ADDRESS =
  "0xD12D64925340Ffc277d79b02A212Dd576701EaC9" as const;

/** Returns FloatContractManager (V3) address (no env, no fallback). */
export function getFloatContractManagerAddress(): `0x${string}` {
  return FLOAT_CONTRACT_MANAGER_ADDRESS as `0x${string}`;
}

/** Returns FloatContractManager V4 address. */
export function getFloatContractManagerV4Address(): `0x${string}` {
  return FLOAT_CONTRACT_MANAGER_V4_ADDRESS as `0x${string}`;
}

/** Comma-separated keeper strategy indices (0-based into watched[]) for FloatStrategy V3 upkeep/harvest. */
export const DEFAULT_STRATEGY_IDS = "";

/** Comma-separated keeper strategy indices for FloatStrategy V4 upkeep/harvest (0-based into keeper.watched[]). */
export const DEFAULT_FLOAT_V4_STRATEGY_IDS = "";

/**
 * Reserved for a future third Float pipeline: run keeper upkeep + offensive/periodic every N loop iterations (1 = every loop).
 * **Not applied** while {@link isFloatV4RunEveryNLoopsGateEnabled} is false (V3 and V4 both run every poll today).
 * When enabled, override via `.env` `FLOAT_V4_RUN_EVERY_N_LOOPS` or `config.overrides.json` `floatV4RunEveryNLoops`.
 */
export const DEFAULT_FLOAT_V4_RUN_EVERY_N_LOOPS = 1;

/**
 * Delay (ms) between Float pipeline passes when V3 and V4 run in parallel (V4 after V3, harvest/runCycle sequential).
 * Override via `.env` `FLOAT_PIPELINE_STAGGER_MS`.
 */
export const DEFAULT_FLOAT_PIPELINE_STAGGER_MS = 15_000;

/** Network ID — Robinhood Chain mainnet (4663). */
export const DEFAULT_NETWORK_ID = "robinhood-mainnet";

// =============================================================================
// Default Demeter behavior
// =============================================================================

/** Upkeep poll interval (ms) for FloatStrategy keeper ids. */
export const DEFAULT_POLL_MS = 3 * 60 * 1000; // 

/** Harvest interval (ms). */
export const DEFAULT_HARVEST_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

/**
 * ## Demeter loop cadence (avoid stacking CoinGecko + txs)
 *
 * | Loop | Default | Notes |
 * |------|---------|--------|
 * | Float upkeep | {@link DEFAULT_POLL_MS} | On-chain keeper; V3 then V4 staggered by {@link DEFAULT_FLOAT_PIPELINE_STAGGER_MS} when both active. snapshotVaultPoolValue currently disabled (see KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS). |
 * | **Float periodic** (merged) | `min(priceCheckIntervalMs, changeStrategyIntervalMs)` wake; scheduled offensive uses `changeStrategyIntervalMs` | One task: m30/volume **defensive** checks then optional **SCHEDULED** offensive path — avoids two loops waking together. Default **6m** scheduled + **30m** defensive ⇒ wake **6m** and **5 wakes = 30m** (phase-aligned, no extra collision beyond defensive-first skip). |
 * | Harvest | {@link DEFAULT_HARVEST_INTERVAL_MS} | Independent of Float periodic wake. |
 * | Pool value log | env / default 60m | Light RPC read. |
 */
/**
 * Change strategy (scheduled) interval (ms). FloatStrategy: demeter-agent **float periodic** loop runs the offensive comparison on this cadence (override: changeStrategyIntervalMs).
 * Uses {@link getOffensiveTokenRankingMetrics} and {@link getScheduledChangeMinWeightedScore} (**0** disables score gate).
 *
 * **Default six minutes:** with {@link DEFAULT_PRICE_CHECK_INTERVAL_MS} (30m), `min(30, 6)` wake is **6m** — exactly **5**
 * wakes per defensive window, so scheduled checks stay evenly spaced against the existing 30m price/volume pass without a
 * second loop. (5m would also divide 30; 6m is slightly gentler on CoinGecko.) Defensive still runs first on a tick; if it
 * fires `changeStrategyAsset`, scheduled is skipped that wake (unchanged).
 */
export const DEFAULT_CHANGE_STRATEGY_INTERVAL_MS = 2 * 60 * 1000; //  minutes

/** Human-readable label for Float scheduled change-strategy interval (logs / start action message). */
export function formatChangeStrategyIntervalForLog(ms: number): string {
  const oneHour = 60 * 60 * 1000;
  if (ms >= oneHour && ms % oneHour === 0) return `${ms / oneHour} h`;
  if (ms >= oneHour) {
    const hours = ms / oneHour;
    const text = hours.toFixed(2).replace(/\.?0+$/, "");
    return `${text} h`;
  }
  return `${Math.round(ms / 60000)} min`;
}

/**
 * Minimum offensive weighted composite score (0–1) for the **scheduled** Float `floatPeriodicLoop` offensive step to attempt an asset change.
 * The score is {@link getTopActionableOffensiveScore}: first `weighted_ranking` row that is not WETH and passes volume/liquidity floors, using its `score`
 * (Σ weight × min–max normalized metric vs **all pre-momentum eligible** tokens in the same snapshot — momentum only filters who may be ranked).
 * **Set to 0** (override) to disable this gate.
 * Override: `scheduledChangeMinWeightedScore` in config.overrides.json / demeter_updateConfig.
 */
export const DEFAULT_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE = 0.90;

/**
 * Offensive score gate used **only** when {@link getOffensiveWeightedScoreNormalization} === `"absolute"`. The absolute
 * composite is not cohort-relative, so it needs its own bar. Seeded from the Float codebase's 2026-07-16 derivation
 * (Youden J-optimal cut ~0.43 under volume-led weights, composite AUC ~0.61); re-derive from THIS codebase's UFloat
 * calibration pulls. Override: `scheduledChangeMinWeightedScore`.
 */
export const DEFAULT_OFFENSIVE_ABSOLUTE_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE = 0.43;

/**
 * Float **defensive** price/volume check interval (ms). Runs inside the merged **float periodic** loop each wake when `min(price, change)` fires.
 * With default {@link DEFAULT_CHANGE_STRATEGY_INTERVAL_MS} (6m), Float periodic wake is `min(this, 6m)` = **6m**; defensive logic still runs only when this 30m interval has elapsed.
 */
export const DEFAULT_PRICE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/** Trigger change strategy when m30 price change <= this (%). e.g. -3 = down 3% or more in 30 minutes. */
export const DEFAULT_PRICE_DROP_THRESHOLD_PCT = -3;

/** Minimum 12h volume (USD) for a token to be included in weighted ranking. Tokens below this are excluded from weighted_ranking. If config.overrides.json has minVolumeH12Usd, that value is used instead. */
export const DEFAULT_MIN_VOLUME_H12_USD = 5000;

/**
 * Float: minimum total pool liquidity (USD) for the token’s primary pool (token/WETH on Base for configured pairs).
 * CoinGecko supplies base+quote side USD liquidity; sum must be at least this for weighted_ranking eligibility.
 * LiquidStratMinV4 / Triton uses {@link DEFAULT_TRITON_MIN_POOL_LIQUIDITY_USD} in triton-config.
 * Override: `minPoolLiquidityUsd` in config.overrides.json / demeter_updateConfig.
 */
export const DEFAULT_MIN_POOL_LIQUIDITY_USD = 200_000;

/**
 * Minimum **24h pool turnover** (dimensionless ratio) for weighted ranking: `pool volume_usd.h24 ÷ pool USD liquidity`.
 * Liquidity prefers CoinGecko `reserve_in_usd` on the ranked pool; when missing or zero, falls back to
 * `base_token_liquidity_usd + quote_token_liquidity_usd` (same components as {@link getMinPoolLiquidityUsd} eligibility).
 * **≤ 0** via override disables the floor. Pair with {@link DEFAULT_MAX_VOLITILITY_H24_USD} / {@link getMaxVolatilityH24Usd}
 * for a ceiling (**≤ 0** disables the cap).
 *
 * Overrides: `minVolatilityH24Usd`, `maxVolatilityH24Usd` in config.overrides.json / demeter_updateConfig.
 */
export const DEFAULT_MIN_VOLITILITY_H24_USD = 0.02;

/**
 * Maximum **24h pool turnover** ratio for weighted ranking (same units as {@link DEFAULT_MIN_VOLITILITY_H24_USD}).
 * **≤ 0** disables the ceiling (no upper bound). Default **0** = only the minimum gate applies.
 *
 * Override: `maxVolatilityH24Usd` in config.overrides.json / demeter_updateConfig.
 */
export const DEFAULT_MAX_VOLITILITY_H24_USD = 3.2;

/** Exclude from weighted ranking tokens whose 24h price change is at or below this (%). e.g. -6 excludes tokens down 6% or more over 24h. Override via config.overrides.json or demeter_updateConfig. */
export const DEFAULT_MAX_NEGATIVE_PRICE_CHANGE_H24_PCT = -6;

/**
 * Short-horizon pool price gate (%), from `getMaxNegativePriceChangeM5M15M30Pct()`.
 * **Default Float ranking:** exclude only when m5, m15, m30, and h1 are all present and each is at or below this value.
 * **Scheduled changeStrategy (offensive metrics):** exclude when **any** of those windows with data is at or below this value (before offensive weighted ranking). Use `0` via override to exclude any non‑positive move on a present window.
 */
export const DEFAULT_MAX_NEGATIVE_PRICE_CHANGE_M5_M15_M30_H1_PCT = -1;

/**
 * Scheduled offensive: pool **m5** Δ% band — pass when **min ≤ m5 ≤ max** (percent units).
 * When m5 is missing from the API, the m5 band is skipped. **max ≤ 0** disables the ceiling.
 *
 * Default band: **≥ 0.02%** and **≤ 4%** (filters flat CoinGecko `0%` prints and very large short spikes).
 * Overrides: `offensiveMomentumMinM5Pct`, `offensiveMomentumMaxM5Pct`.
 */
export const DEFAULT_OFFENSIVE_MOMENTUM_MIN_M5_PCT = -2;
export const DEFAULT_OFFENSIVE_MOMENTUM_MAX_M5_PCT = 5;

/**
 * Scheduled offensive: pool **m15** Δ% band — pass when **min ≤ m15 ≤ max** (m15 required).
 * **max ≤ 0** disables the ceiling. Overrides: `offensiveMomentumMinM15Pct`, `offensiveMomentumMaxM15Pct`.
 */
export const DEFAULT_OFFENSIVE_MOMENTUM_MIN_M15_PCT = -2;
export const DEFAULT_OFFENSIVE_MOMENTUM_MAX_M15_PCT = 10;

/**
 * Scheduled offensive: pool **m30** Δ% band — pass when **min ≤ m30 ≤ max** (m30 required).
 * **max ≤ 0** disables the ceiling. Overrides: `offensiveMomentumMinM30Pct`, `offensiveMomentumMaxM30Pct`.
 */
export const DEFAULT_OFFENSIVE_MOMENTUM_MIN_M30_PCT = -3;
export const DEFAULT_OFFENSIVE_MOMENTUM_MAX_M30_PCT = 12;

/**
 * Scheduled offensive: **m15** and **m30** pool USD volume must each be at least this multiple of the **spread‑implied**
 * rate from **12h** pool volume (assuming volume were spread evenly across time: one 15m slot = `h12 / 48`, one 30m slot = `h12 / 24`).
 *
 * **Why 1.0?** **1.1** required short windows **10% above** a flat h12 baseline; early ramps often have price leading volume
 * for one or two 15m ticks. **1.0** means “at least the implied average rate” — still blocks obviously dead pools when
 * both short volumes are positive and h12 is valid. Raise toward **1.1–1.2** if price-only pops become a problem.
 *
 * **Example:** `volume_h12 = $240,000` → implied per **30m** = **$10,000**. With ratio **1.0**, `volume_m30` must be ≥ **$10,000**.
 *
 * **When skipped:** if either `volume_m15` or `volume_m30` is ≤ 0 after parsing (API omitted short buckets before
 * breakdown was requested, or truly no prints), the spread-implied volume check is **not applied** — m15/m30 **price**
 * gates still apply.
 *
 * Override: `offensiveMomentumVolumeOverSpreadRatio` in config.overrides.json / demeter_updateConfig.
 */
export const DEFAULT_OFFENSIVE_MOMENTUM_VOLUME_OVER_SPREAD_RATIO = 0;

/**
 * Float scheduled offensive: exclude tokens whose **24h** pool Δ% is **≥** this (already extended pump).
 * LiquidStratMinV4 / Triton uses {@link DEFAULT_TRITON_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H24_PCT_GTE} in triton-config.
 * Override: `offensiveMomentumExcludePriceChangeH24PctGte` in config.overrides.json / demeter_updateConfig.
 */
export const DEFAULT_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H24_PCT_GTE = 18;

/**
 * Cohort risk-off: when this **fraction** (0–1) or more of tokens in the snapshot that have a finite **24h** pool Δ%
 * are **negative**, Demeter treats the market as broad risk-off — `buildTokenComparison` forces a stable pick (V3: USDC via
 * {@link STABLE_USDC_WETH_PAIR}; V4: WETH via {@link STABLE_V4_WETH_ADDRESS}) before per-token offensive momentum gates.
 * Same threshold is evaluated first in {@link offensiveMomentumExcludeReason} when a caller passes `{ marketBreadthDefensive: true }`.
 *
 * Override: `marketBreadthNegativeH24FractionGte` in config.overrides.json / demeter_updateConfig.
 */
export const DEFAULT_MARKET_BREADTH_NEGATIVE_H24_FRACTION_GTE = 0.90;

/**
 * When **true** (default), cohort risk-off alone is not enough: stable rotation applies only if the **current** strategy
 * token (passed into `fetchTokenComparison` as `currentStrategyTokenAddress`) has a finite pool **24h** Δ% **&lt; 0**.
 * If the current asset is flat or up on 24h, ranking stays normal even when the cohort fraction gate fires.
 *
 * Override: `marketBreadthRequireCurrentAssetNegativeH24` in config.overrides.json / demeter_updateConfig (`false` = cohort-only).
 */
export const DEFAULT_MARKET_BREADTH_REQUIRE_CURRENT_ASSET_NEGATIVE_H24 = false;

/** On-chain FloatStrategy / FloatStrategyV4 mode when parked in stable (V4: set by exitStrategyToStable). */
/** Float V4 STABLE={@link FLOAT_STRATEGY_MODE.Stable}; UFloat STABLE is {@link UFLOAT_STRATEGY_MODE.Stable} in contract-enums.ts. */
export const FLOAT_STRATEGY_STABLE_MODE = FLOAT_STRATEGY_MODE.Stable;

/**
 * Float V3 market-breadth stable: USDG via `changeStrategyAsset` (WETH/USDG v3 pool, fee 100).
 * Overrides: `USDG_ADDRESS`, `STABLE_USDG_WETH_POOL`.
 */
export const DEFAULT_STABLE_USDG_WETH_POOL = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca" as const;

export const STABLE_USDC_WETH_PAIR = {
  tokenAddress: DEFAULT_USDG_ADDRESS,
  poolAddress: DEFAULT_STABLE_USDG_WETH_POOL,
} as const;

export function getStableUsdcWethPair(): { tokenAddress: Address; poolAddress: Address } {
  return {
    tokenAddress: getUsdgAddress(),
    poolAddress: pickAddr("STABLE_USDG_WETH_POOL", DEFAULT_STABLE_USDG_WETH_POOL),
  };
}

/**
 * Float V4 market-breadth stable: 100% WETH via `FloatContractManagerV4.exitStrategyToStable()` (mode STABLE, registry ASSET=WETH).
 * Override: `WETH_ADDRESS` or `STABLE_V4_WETH_ADDRESS`.
 */
export const STABLE_V4_WETH_ADDRESS = DEFAULT_WETH_ADDRESS;

export function getStableV4WethAddress(): Address {
  return pickAddr("STABLE_V4_WETH_ADDRESS", getWethAddress());
}

/** `buildTokenComparison` stable synthetic row + on-chain action for market breadth. */
export type MarketBreadthStableMode = "v3_usdc" | "v4_weth";

/**
 * Scheduled offensive: exclude tokens whose **12h** pool Δ% is **≥** this (already extended pump).
 * Override: `offensiveMomentumExcludePriceChangeH12PctGte` in config.overrides.json / demeter_updateConfig.
 */
export const DEFAULT_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H12_PCT_GTE = 16;

import type { RankingEligibilityThresholds } from "./ranking-eligibility";

/** Optional cohort context for {@link offensiveMomentumExcludeReason} (market-wide 24h breadth runs before per-token rules). */
export type OffensiveMomentumExcludeContext = {
  /** True when ≥ cohort fractionGte of tokens with 24h data have negative pool Δ%. */
  marketBreadthDefensive?: boolean;
  /**
   * When set (LiquidStratMinV4 / Triton), use instead of {@link getOffensiveMomentumExcludePriceChangeH24PctGte}.
   * Float scheduled offensive omits this and uses demeter-config + overrides.json.
   */
  excludePriceChangeH24PctGte?: number;
  /** Full threshold bundle for Float V4 / Triton; omit for Float V3 (uses demeter-config getters). */
  thresholds?: RankingEligibilityThresholds;
};

/** Row fields required for {@link passesOffensiveMomentumGates} / {@link offensiveMomentumExcludeReason}. */
export type OffensiveMomentumTokenRow = {
  symbol?: string;
  /** When present, tokens at or above {@link getOffensiveMomentumExcludePriceChangeH24PctGte} fail momentum (extended 24h rally). */
  price_change_h24_pct?: number | null;
  /** When present, tokens at or above {@link getOffensiveMomentumExcludePriceChangeH12PctGte} fail momentum (extended 12h rally). */
  price_change_h12_pct?: number | null;
  price_change_m5_pct: number | null;
  price_change_m15_pct: number | null;
  price_change_m30_pct: number | null;
  volume_m15: number;
  volume_m30: number;
  volume_h12: number;
};

export type MarketH24BreadthSnapshot = {
  tokensWithH24: number;
  negativeH24Count: number;
  /** `null` when no token had finite 24h pool Δ% (breadth not applied). */
  fractionNegative: number | null;
  /** True when {@link fractionNegative} is finite and ≥ {@link getMarketBreadthNegativeH24FractionGte}.fractionGte. */
  defensive: boolean;
};

/**
 * Share of snapshot tokens with **negative** pool `price_change_h24_pct` among those with finite 24h data.
 * Used for Float default ranking and scheduled offensive (stable rotation when `defensive`).
 */
export function computeMarketH24BreadthFromTokenSummary(
  rows: ReadonlyArray<{ price_change_h24_pct: number | null | undefined }>,
  options?: { fractionGte?: number }
): MarketH24BreadthSnapshot {
  const withData = rows.filter(
    (r) => r.price_change_h24_pct != null && Number.isFinite(r.price_change_h24_pct as number)
  );
  if (withData.length === 0) {
    return { tokensWithH24: 0, negativeH24Count: 0, fractionNegative: null, defensive: false };
  }
  const neg = withData.filter((r) => (r.price_change_h24_pct as number) < 0).length;
  const frac = neg / withData.length;
  const threshold = options?.fractionGte ?? getMarketBreadthNegativeH24FractionGte().fractionGte;
  return {
    tokensWithH24: withData.length,
    negativeH24Count: neg,
    fractionNegative: frac,
    defensive: frac >= threshold,
  };
}

export function offensiveMomentumExcludeReason(
  t: OffensiveMomentumTokenRow,
  ctx?: OffensiveMomentumExcludeContext
): string | null {
  const th = ctx?.thresholds;
  const breadthFraction =
    th?.marketBreadthNegativeH24FractionGte ?? getMarketBreadthNegativeH24FractionGte().fractionGte;

  if (ctx?.marketBreadthDefensive) {
    const pct = (breadthFraction * 100).toFixed(0);
    return `market breadth: ≥${pct}% of cohort negative on 24h pool Δ% (risk-off; V3→USDC / V4→WETH exitStrategyToStable — before per-token momentum gates)`;
  }

  const excludeH24Gte =
    ctx?.excludePriceChangeH24PctGte ??
    th?.offensiveMomentumExcludePriceChangeH24PctGte ??
    getOffensiveMomentumExcludePriceChangeH24PctGte();
  const excludeH12Gte =
    th?.offensiveMomentumExcludePriceChangeH12PctGte ?? getOffensiveMomentumExcludePriceChangeH12PctGte();
  const h24 = t.price_change_h24_pct;
  if (h24 != null && h24 >= excludeH24Gte) {
    return `price_change_h24_pct ${h24}% >= ${excludeH24Gte}% (offensive momentum extended 24h up-move)`;
  }
  const h12Chg = t.price_change_h12_pct;
  if (h12Chg != null && h12Chg >= excludeH12Gte) {
    return `price_change_h12_pct ${h12Chg}% >= ${excludeH12Gte}% (offensive momentum extended 12h up-move)`;
  }

  const minM5 = th?.offensiveMomentumMinM5Pct ?? getOffensiveMomentumMinM5Pct();
  const maxM5 = th?.offensiveMomentumMaxM5Pct ?? getOffensiveMomentumMaxM5Pct();
  const minM15 = th?.offensiveMomentumMinM15Pct ?? getOffensiveMomentumMinM15Pct();
  const maxM15 = th?.offensiveMomentumMaxM15Pct ?? getOffensiveMomentumMaxM15Pct();
  const minM30 = th?.offensiveMomentumMinM30Pct ?? getOffensiveMomentumMinM30Pct();
  const maxM30 = th?.offensiveMomentumMaxM30Pct ?? getOffensiveMomentumMaxM30Pct();
  const volRatio =
    th?.offensiveMomentumVolumeOverSpreadRatio ?? getOffensiveMomentumVolumeOverSpreadRatio();

  const m15 = t.price_change_m15_pct;
  const m30 = t.price_change_m30_pct;
  if (m15 == null || m30 == null) return "missing m15 or m30 pool price %";
  const m15Band = offensiveMomentumPoolPctBandExcludeReason("m15", m15, minM15, maxM15);
  if (m15Band) return m15Band;
  const m30Band = offensiveMomentumPoolPctBandExcludeReason("m30", m30, minM30, maxM30);
  if (m30Band) return m30Band;

  const m5 = t.price_change_m5_pct;
  if (m5 != null) {
    const m5Band = offensiveMomentumPoolPctBandExcludeReason("m5", m5, minM5, maxM5);
    if (m5Band) return m5Band;
  }

  const v15 = t.volume_m15;
  const v30 = t.volume_m30;
  if (!Number.isFinite(v15) || !Number.isFinite(v30)) return "volume_m15 or volume_m30 not finite";

  // Non-positive m15/m30 → treat as missing short-window pool volume (see DEFAULT_OFFENSIVE_MOMENTUM_VOLUME_OVER_SPREAD_RATIO).
  if (v15 > 0 && v30 > 0) {
    const h12 = t.volume_h12;
    if (typeof h12 !== "number" || !Number.isFinite(h12) || h12 <= 0) {
      return "volume_h12 missing or not positive (cannot score volume acceleration)";
    }
    const implied15 = h12 / 48;
    const implied30 = h12 / 24;
    if (v15 < volRatio * implied15) {
      return `volume_m15 $${Math.round(v15)} < ${volRatio}× implied-from-h12 $${Math.round(implied15)} ($/15m)`;
    }
    if (v30 < volRatio * implied30) {
      return `volume_m30 $${Math.round(v30)} < ${volRatio}× implied-from-h12 $${Math.round(implied30)} ($/30m)`;
    }
  }

  return null;
}

export function passesOffensiveMomentumGates(t: OffensiveMomentumTokenRow, ctx?: OffensiveMomentumExcludeContext): boolean {
  return offensiveMomentumExcludeReason(t, ctx) === null;
}

/** True when pool Δ% is within offensive momentum min/max band (max disabled when `maxPct <= 0`). */
export function passesOffensiveMomentumPoolPctBand(pct: number, minPct: number, maxPct: number): boolean {
  if (!Number.isFinite(pct)) return false;
  if (pct < minPct) return false;
  if (maxPct > 0 && pct > maxPct) return false;
  return true;
}

/** Human-readable reject for one short-window pool Δ% vs min/max band; `null` if in band. */
export function offensiveMomentumPoolPctBandExcludeReason(
  window: "m5" | "m15" | "m30",
  pct: number,
  minPct: number,
  maxPct: number
): string | null {
  if (!Number.isFinite(pct)) return `${window} pool price % not finite`;
  if (pct < minPct) {
    return `${window} ${pct}% < offensive momentum min ${minPct}%`;
  }
  if (maxPct > 0 && pct > maxPct) {
    return `${window} ${pct}% > offensive momentum max ${maxPct}%`;
  }
  return null;
}

// =============================================================================
// Overrides (config.overrides.json) – chat-updatable
// =============================================================================

export type ConfigOverrides = {
  tokenRankingMetrics?: Partial<Record<keyof typeof DEFAULT_TOKEN_RANKING_METRICS, { weight?: number }>>;
  /** Per-metric weight overrides for scheduled Float offensive ranking (see {@link getOffensiveTokenRankingMetrics}). */
  offensiveTokenRankingMetrics?: Partial<Record<keyof typeof DEFAULT_TOKEN_RANKING_METRICS, { weight?: number }>>;
  keeperAddress?: string;
  strategyIds?: string;
  /** FloatKeeperV4 address override. */
  floatV4KeeperAddress?: string;
  /** Float V4 watched[] indices override (comma-separated). */
  floatV4StrategyIds?: string;
  /** Float V4: run upkeep + periodic offensive/defensive checks every N loops (1 = no throttle). */
  floatV4RunEveryNLoops?: number;
  /** When true, honor {@link getFloatV4RunEveryNLoops} on V4 (reserved for future third Float pipeline). */
  floatV4RunEveryNLoopsGateEnabled?: boolean;
  /** Stagger (ms) between V3 and V4 keeper/API work when both pipelines are active. */
  floatPipelineStaggerMs?: number;
  networkId?: string;
  pollMs?: number;
  harvestIntervalMs?: number;
  changeStrategyIntervalMs?: number;
  priceCheckIntervalMs?: number;
  priceDropThresholdPct?: number;
  /** Minimum 12h volume (USD) for a token to be included in weighted ranking. */
  minVolumeH12Usd?: number;
  /** Minimum total pool liquidity (USD) for the token/WETH (primary) pool to be included in weighted ranking. */
  minPoolLiquidityUsd?: number;
  /**
   * Minimum pool 24h turnover ratio (pool `volume_usd.h24` ÷ liquidity, liquidity = `reserve_in_usd` when positive else base+quote).
   * **≤ 0** disables the floor.
   */
  minVolatilityH24Usd?: number;
  /**
   * Maximum pool 24h turnover ratio (same units as `minVolatilityH24Usd`). **≤ 0** disables the ceiling.
   */
  maxVolatilityH24Usd?: number;
  /** Exclude tokens with 24h price change <= this (%). e.g. -7 = exclude if down 7% or more. */
  maxNegativePriceChangeH24Pct?: number;
  /**
   * Pool m5/m15/m30/h1 gate (%). **Float default ranking:** exclude only when all four windows are present and each is <= this value.
   * **Scheduled changeStrategy (offensive):** exclude if **any** present window is <= this value (stricter). Use `0` to drop tokens with any non‑positive short‑horizon move.
   */
  maxNegativePriceChangeM5M15M30Pct?: number;
  /**
   * Scheduled Float changeStrategy: require top actionable token’s offensive composite score >= this (0–1). **0** = disable gate.
   */
  scheduledChangeMinWeightedScore?: number;
  /** Scheduled offensive: min m5 pool Δ% band floor when m5 is present (must be ≥). */
  offensiveMomentumMinM5Pct?: number;
  /** Scheduled offensive: max m5 pool Δ% band ceiling when m5 is present; **≤ 0** disables. */
  offensiveMomentumMaxM5Pct?: number;
  /** Scheduled offensive: min m15 pool Δ% band floor (must be ≥). */
  offensiveMomentumMinM15Pct?: number;
  /** Scheduled offensive: max m15 pool Δ% band ceiling; **≤ 0** disables. */
  offensiveMomentumMaxM15Pct?: number;
  /** Scheduled offensive: min m30 pool Δ% band floor (must be ≥). */
  offensiveMomentumMinM30Pct?: number;
  /** Scheduled offensive: max m30 pool Δ% band ceiling; **≤ 0** disables. */
  offensiveMomentumMaxM30Pct?: number;
  /** Scheduled offensive: min volume_m15 / volume_m30 vs spread-implied rate from h12 (see DEFAULT_OFFENSIVE_MOMENTUM_VOLUME_OVER_SPREAD_RATIO). */
  offensiveMomentumVolumeOverSpreadRatio?: number;
  /** Scheduled offensive: exclude when 24h pool Δ% **≥** this (extended pump). */
  offensiveMomentumExcludePriceChangeH24PctGte?: number;
  /** Scheduled offensive: exclude when 12h pool Δ% **≥** this (extended pump). */
  offensiveMomentumExcludePriceChangeH12PctGte?: number;
  /**
   * Cohort risk-off: minimum fraction (0–1) of tokens with finite 24h pool Δ% that must be **negative** to force
   * stable rotation (V3: {@link STABLE_USDC_WETH_PAIR}; V4: {@link STABLE_V4_WETH_ADDRESS} / exitStrategyToStable) and faster periodic re-checks.
   * Default {@link DEFAULT_MARKET_BREADTH_NEGATIVE_H24_FRACTION_GTE}.
   */
  marketBreadthNegativeH24FractionGte?: number;
  /**
   * When true (default), stable rotation requires current strategy token 24h pool Δ% &lt; 0. Set `false` for cohort-only risk-off.
   */
  marketBreadthRequireCurrentAssetNegativeH24?: boolean;
};

const OVERRIDES_PATH = path.join(process.cwd(), "app", "config", "config.overrides.json");

function loadOverrides(): ConfigOverrides {
  try {
    if (fs.existsSync(OVERRIDES_PATH)) {
      const raw = fs.readFileSync(OVERRIDES_PATH, "utf8");
      return JSON.parse(raw) as ConfigOverrides;
    }
  } catch {
    // ignore
  }
  return {};
}

export function saveOverrides(overrides: ConfigOverrides): void {
  const current = loadOverrides();
  const merged: ConfigOverrides = {
    ...current,
    ...(overrides.keeperAddress !== undefined && { keeperAddress: overrides.keeperAddress }),
    ...(overrides.strategyIds !== undefined && { strategyIds: overrides.strategyIds }),
    ...(overrides.floatV4KeeperAddress !== undefined && {
      floatV4KeeperAddress: overrides.floatV4KeeperAddress,
    }),
    ...(overrides.floatV4StrategyIds !== undefined && {
      floatV4StrategyIds: overrides.floatV4StrategyIds,
    }),
    ...(overrides.floatV4RunEveryNLoops !== undefined && {
      floatV4RunEveryNLoops: overrides.floatV4RunEveryNLoops,
    }),
    ...(overrides.floatV4RunEveryNLoopsGateEnabled !== undefined && {
      floatV4RunEveryNLoopsGateEnabled: overrides.floatV4RunEveryNLoopsGateEnabled,
    }),
    ...(overrides.floatPipelineStaggerMs !== undefined && {
      floatPipelineStaggerMs: overrides.floatPipelineStaggerMs,
    }),
    ...(overrides.networkId !== undefined && { networkId: overrides.networkId }),
    ...(overrides.pollMs !== undefined && { pollMs: overrides.pollMs }),
    ...(overrides.harvestIntervalMs !== undefined && { harvestIntervalMs: overrides.harvestIntervalMs }),
    ...(overrides.changeStrategyIntervalMs !== undefined && { changeStrategyIntervalMs: overrides.changeStrategyIntervalMs }),
    ...(overrides.priceCheckIntervalMs !== undefined && { priceCheckIntervalMs: overrides.priceCheckIntervalMs }),
    ...(overrides.priceDropThresholdPct !== undefined && { priceDropThresholdPct: overrides.priceDropThresholdPct }),
    ...(overrides.minVolumeH12Usd !== undefined && { minVolumeH12Usd: overrides.minVolumeH12Usd }),
    ...(overrides.minPoolLiquidityUsd !== undefined && { minPoolLiquidityUsd: overrides.minPoolLiquidityUsd }),
    ...(overrides.minVolatilityH24Usd !== undefined && { minVolatilityH24Usd: overrides.minVolatilityH24Usd }),
    ...(overrides.maxVolatilityH24Usd !== undefined && { maxVolatilityH24Usd: overrides.maxVolatilityH24Usd }),
    ...(overrides.maxNegativePriceChangeH24Pct !== undefined && { maxNegativePriceChangeH24Pct: overrides.maxNegativePriceChangeH24Pct }),
    ...(overrides.maxNegativePriceChangeM5M15M30Pct !== undefined && {
      maxNegativePriceChangeM5M15M30Pct: overrides.maxNegativePriceChangeM5M15M30Pct,
    }),
    ...(overrides.scheduledChangeMinWeightedScore !== undefined && {
      scheduledChangeMinWeightedScore: overrides.scheduledChangeMinWeightedScore,
    }),
    ...(overrides.offensiveMomentumMinM5Pct !== undefined && {
      offensiveMomentumMinM5Pct: overrides.offensiveMomentumMinM5Pct,
    }),
    ...(overrides.offensiveMomentumMaxM5Pct !== undefined && {
      offensiveMomentumMaxM5Pct: overrides.offensiveMomentumMaxM5Pct,
    }),
    ...(overrides.offensiveMomentumMinM15Pct !== undefined && {
      offensiveMomentumMinM15Pct: overrides.offensiveMomentumMinM15Pct,
    }),
    ...(overrides.offensiveMomentumMaxM15Pct !== undefined && {
      offensiveMomentumMaxM15Pct: overrides.offensiveMomentumMaxM15Pct,
    }),
    ...(overrides.offensiveMomentumMinM30Pct !== undefined && {
      offensiveMomentumMinM30Pct: overrides.offensiveMomentumMinM30Pct,
    }),
    ...(overrides.offensiveMomentumMaxM30Pct !== undefined && {
      offensiveMomentumMaxM30Pct: overrides.offensiveMomentumMaxM30Pct,
    }),
    ...(overrides.offensiveMomentumVolumeOverSpreadRatio !== undefined && {
      offensiveMomentumVolumeOverSpreadRatio: overrides.offensiveMomentumVolumeOverSpreadRatio,
    }),
    ...(overrides.offensiveMomentumExcludePriceChangeH24PctGte !== undefined && {
      offensiveMomentumExcludePriceChangeH24PctGte: overrides.offensiveMomentumExcludePriceChangeH24PctGte,
    }),
    ...(overrides.offensiveMomentumExcludePriceChangeH12PctGte !== undefined && {
      offensiveMomentumExcludePriceChangeH12PctGte: overrides.offensiveMomentumExcludePriceChangeH12PctGte,
    }),
    ...(overrides.marketBreadthNegativeH24FractionGte !== undefined && {
      marketBreadthNegativeH24FractionGte: overrides.marketBreadthNegativeH24FractionGte,
    }),
    ...(overrides.marketBreadthRequireCurrentAssetNegativeH24 !== undefined && {
      marketBreadthRequireCurrentAssetNegativeH24: overrides.marketBreadthRequireCurrentAssetNegativeH24,
    }),
    ...(overrides.tokenRankingMetrics && {
      tokenRankingMetrics: { ...current.tokenRankingMetrics, ...overrides.tokenRankingMetrics },
    }),
    ...(overrides.offensiveTokenRankingMetrics && {
      offensiveTokenRankingMetrics: {
        ...current.offensiveTokenRankingMetrics,
        ...overrides.offensiveTokenRankingMetrics,
      },
    }),
  };
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(merged, null, 2), "utf8");
}

// Merge defaults + overrides (called each time so chat updates apply)
export function getTokenRankingMetrics(): TokenRankingMetricsMap {
  const overrides = loadOverrides().tokenRankingMetrics ?? {};
  const result = { ...DEFAULT_TOKEN_RANKING_METRICS };
  for (const key of Object.keys(overrides) as (keyof typeof DEFAULT_TOKEN_RANKING_METRICS)[]) {
    const o = overrides[key];
    if (o?.weight !== undefined && key in result) {
      (result as Record<string, unknown>)[key] = { ...result[key], weight: o.weight };
    }
  }
  return result as TokenRankingMetricsMap;
}

/**
 * Weighted metrics for scheduled offensive comparison (separate default weights from {@link getTokenRankingMetrics}).
 * When {@link getOffensiveWeightedScoreNormalization} === `"absolute"`, uses the evidence-based
 * {@link DEFAULT_OFFENSIVE_ABSOLUTE_TOKEN_RANKING_METRICS} (auc weights + corrected directions) instead.
 */
export function getOffensiveTokenRankingMetrics(): TokenRankingMetricsMap {
  const overrides = loadOverrides().offensiveTokenRankingMetrics ?? {};
  const base =
    getOffensiveWeightedScoreNormalization() === "absolute"
      ? DEFAULT_OFFENSIVE_ABSOLUTE_TOKEN_RANKING_METRICS
      : DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS;
  const result = { ...base };
  for (const key of Object.keys(overrides) as (keyof typeof DEFAULT_OFFENSIVE_TOKEN_RANKING_METRICS)[]) {
    const o = overrides[key];
    if (o?.weight !== undefined && key in result) {
      (result as Record<string, unknown>)[key] = { ...result[key], weight: o.weight };
    }
  }
  return result as TokenRankingMetricsMap;
}

/** Weighted metrics for x402 token-score (LP-position ranking). No chat overrides in v1. */
export function getX402TokenRankingMetrics(): TokenRankingMetricsMap {
  return { ...X402_TOKEN_RANKING_METRICS } as TokenRankingMetricsMap;
}

/** Sum of metric weights in {@link getX402TokenRankingMetrics} (for score_normalized). */
export function getX402TokenRankingWeightSum(): number {
  const m = getX402TokenRankingMetrics();
  let sum = 0;
  for (const k of Object.keys(m)) {
    const w = m[k]?.weight;
    if (typeof w === "number" && Number.isFinite(w)) sum += w;
  }
  return sum > 0 ? sum : 1;
}

/** Backward compat – use getTokenRankingMetrics() for dynamic (chat-updatable) config. */
export const TOKEN_RANKING_METRICS = getTokenRankingMetrics();

/** For demeter-agent – reads overrides at load. Restart demeter-agent for changes. */
export const CHANGE_STRATEGY_INTERVAL_MS =
  loadOverrides().changeStrategyIntervalMs ?? DEFAULT_CHANGE_STRATEGY_INTERVAL_MS;
export const PRICE_CHECK_INTERVAL_MS =
  loadOverrides().priceCheckIntervalMs ?? DEFAULT_PRICE_CHECK_INTERVAL_MS;
export const PRICE_DROP_THRESHOLD_PCT =
  loadOverrides().priceDropThresholdPct ?? DEFAULT_PRICE_DROP_THRESHOLD_PCT;

/** Resolved keeper/strategy/network (demeter-config + overrides). */
export function getKeeperAddress(): string {
  return loadOverrides().keeperAddress ?? DEFAULT_KEEPER_ADDRESS;
}
export function getFloatV4KeeperAddress(): string {
  return loadOverrides().floatV4KeeperAddress ?? DEFAULT_FLOAT_V4_KEEPER_ADDRESS;
}
export function getStrategyIds(): string {
  return loadOverrides().strategyIds ?? DEFAULT_STRATEGY_IDS;
}
export function getFloatV4StrategyIds(): string {
  return loadOverrides().floatV4StrategyIds ?? DEFAULT_FLOAT_V4_STRATEGY_IDS;
}

export function getFloatV4RunEveryNLoops(): number {
  const raw = process.env.FLOAT_V4_RUN_EVERY_N_LOOPS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  const o = loadOverrides().floatV4RunEveryNLoops;
  if (o !== undefined && Number.isFinite(o) && o >= 1) return Math.floor(o);
  return DEFAULT_FLOAT_V4_RUN_EVERY_N_LOOPS;
}

/**
 * When false (default), V3 and V4 upkeep/periodic/runCycle run every poll with stagger only.
 * Set `FLOAT_V4_RUN_EVERY_N_LOOPS_GATE_ENABLED=true` (or overrides) when adding a third Float pipeline.
 */
export function isFloatV4RunEveryNLoopsGateEnabled(): boolean {
  const raw = process.env.FLOAT_V4_RUN_EVERY_N_LOOPS_GATE_ENABLED?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return loadOverrides().floatV4RunEveryNLoopsGateEnabled === true;
}

export function getFloatPipelineStaggerMs(): number {
  const raw = process.env.FLOAT_PIPELINE_STAGGER_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const o = loadOverrides().floatPipelineStaggerMs;
  if (o !== undefined && Number.isFinite(o) && o >= 0) return Math.floor(o);
  return DEFAULT_FLOAT_PIPELINE_STAGGER_MS;
}

export function getNetworkId(): string {
  return loadOverrides().networkId ?? DEFAULT_NETWORK_ID;
}

/** Minimum 12h volume (USD) for a token to be included in weighted ranking. Override via config.overrides.json or demeter_updateConfig. */
export function getMinVolumeH12Usd(): number {
  return loadOverrides().minVolumeH12Usd ?? DEFAULT_MIN_VOLUME_H12_USD;
}

/** Minimum total pool liquidity (USD) for weighted ranking eligibility. Override via config.overrides.json or demeter_updateConfig. */
export function getMinPoolLiquidityUsd(): number {
  return loadOverrides().minPoolLiquidityUsd ?? DEFAULT_MIN_POOL_LIQUIDITY_USD;
}

/**
 * Minimum 24h pool turnover ratio for weighted ranking (pool volume h24 ÷ USD liquidity; see {@link DEFAULT_MIN_VOLITILITY_H24_USD}).
 * Override via config.overrides.json or demeter_updateConfig. **≤ 0** disables the gate.
 */
export function getMinVolatilityH24Usd(): number {
  return loadOverrides().minVolatilityH24Usd ?? DEFAULT_MIN_VOLITILITY_H24_USD;
}

/**
 * Maximum 24h pool turnover ratio for weighted ranking. Override via config.overrides.json or demeter_updateConfig.
 * **≤ 0** disables the ceiling.
 */
export function getMaxVolatilityH24Usd(): number {
  return loadOverrides().maxVolatilityH24Usd ?? DEFAULT_MAX_VOLITILITY_H24_USD;
}

/** Exclude from ranking tokens with 24h price change <= this (%). Override via config.overrides.json or demeter_updateConfig. */
export function getMaxNegativePriceChangeH24Pct(): number {
  return loadOverrides().maxNegativePriceChangeH24Pct ?? DEFAULT_MAX_NEGATIVE_PRICE_CHANGE_H24_PCT;
}

/** Exclude from ranking when m5, m15, m30, and 1h are all present and each Δ% <= this. Override via config.overrides.json or demeter_updateConfig. */
export function getMaxNegativePriceChangeM5M15M30Pct(): number {
  return (
    loadOverrides().maxNegativePriceChangeM5M15M30Pct ?? DEFAULT_MAX_NEGATIVE_PRICE_CHANGE_M5_M15_M30_H1_PCT
  );
}

/** Min offensive composite (0–1) for scheduled Float changeStrategy; **0** disables the gate. */
export function getScheduledChangeMinWeightedScore(): number {
  const o = loadOverrides().scheduledChangeMinWeightedScore;
  if (typeof o === "number" && Number.isFinite(o)) return Math.max(0, Math.min(1, o));
  return getOffensiveWeightedScoreNormalization() === "absolute"
    ? DEFAULT_OFFENSIVE_ABSOLUTE_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE
    : DEFAULT_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE;
}

function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

export function getOffensiveMomentumMinM5Pct(): number {
  return clampNumber(
    loadOverrides().offensiveMomentumMinM5Pct,
    DEFAULT_OFFENSIVE_MOMENTUM_MIN_M5_PCT,
    -50,
    50
  );
}

export function getOffensiveMomentumMaxM5Pct(): number {
  return clampNumber(
    loadOverrides().offensiveMomentumMaxM5Pct,
    DEFAULT_OFFENSIVE_MOMENTUM_MAX_M5_PCT,
    0,
    500
  );
}

export function getOffensiveMomentumMinM15Pct(): number {
  return clampNumber(
    loadOverrides().offensiveMomentumMinM15Pct,
    DEFAULT_OFFENSIVE_MOMENTUM_MIN_M15_PCT,
    0,
    100
  );
}

export function getOffensiveMomentumMaxM15Pct(): number {
  return clampNumber(
    loadOverrides().offensiveMomentumMaxM15Pct,
    DEFAULT_OFFENSIVE_MOMENTUM_MAX_M15_PCT,
    0,
    500
  );
}

export function getOffensiveMomentumMinM30Pct(): number {
  return clampNumber(
    loadOverrides().offensiveMomentumMinM30Pct,
    DEFAULT_OFFENSIVE_MOMENTUM_MIN_M30_PCT,
    0,
    100
  );
}

export function getOffensiveMomentumMaxM30Pct(): number {
  return clampNumber(
    loadOverrides().offensiveMomentumMaxM30Pct,
    DEFAULT_OFFENSIVE_MOMENTUM_MAX_M30_PCT,
    0,
    500
  );
}

export function getOffensiveMomentumVolumeOverSpreadRatio(): number {
  return clampNumber(
    loadOverrides().offensiveMomentumVolumeOverSpreadRatio,
    DEFAULT_OFFENSIVE_MOMENTUM_VOLUME_OVER_SPREAD_RATIO,
    1,
    20
  );
}

/** Scheduled offensive: exclude when 24h pool Δ% **≥** this. Override via config.overrides.json / demeter_updateConfig. */
export function getOffensiveMomentumExcludePriceChangeH24PctGte(): number {
  return clampNumber(
    loadOverrides().offensiveMomentumExcludePriceChangeH24PctGte,
    DEFAULT_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H24_PCT_GTE,
    0,
    500
  );
}

/** Scheduled offensive: exclude when 12h pool Δ% **≥** this. Override via config.overrides.json / demeter_updateConfig. */
export function getOffensiveMomentumExcludePriceChangeH12PctGte(): number {
  return clampNumber(
    loadOverrides().offensiveMomentumExcludePriceChangeH12PctGte,
    DEFAULT_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H12_PCT_GTE,
    0,
    500
  );
}

/** Resolved market-breadth stable-rotation knobs (fraction gate + current-asset 24h requirement). */
export type MarketBreadthNegativeH24FractionGteParams = {
  /** Minimum fraction (0–1) of cohort tokens with negative 24h pool Δ% to consider risk-off. Clamped to [0.5, 1]. */
  fractionGte: number;
  /**
   * When true, apply stable USDC path only if `currentStrategyTokenAddress` is provided to comparison and that token’s
   * pool `price_change_h24_pct` is finite and **&lt; 0**.
   */
  requireCurrentAssetNegativeH24: boolean;
};

/**
 * Market breadth stable-rotation settings. {@link MarketBreadthNegativeH24FractionGteParams.fractionGte} is the cohort
 * threshold; {@link MarketBreadthNegativeH24FractionGteParams.requireCurrentAssetNegativeH24} gates rotation on the
 * current asset’s 24h move.
 */
export function getMarketBreadthNegativeH24FractionGte(): MarketBreadthNegativeH24FractionGteParams {
  return {
    fractionGte: clampNumber(
      loadOverrides().marketBreadthNegativeH24FractionGte,
      DEFAULT_MARKET_BREADTH_NEGATIVE_H24_FRACTION_GTE,
      0.5,
      1
    ),
    requireCurrentAssetNegativeH24:
      loadOverrides().marketBreadthRequireCurrentAssetNegativeH24 ??
      DEFAULT_MARKET_BREADTH_REQUIRE_CURRENT_ASSET_NEGATIVE_H24,
  };
}

/** Full merged config for display / API. */
export function getMergedConfig(): {
  tokenRankingMetrics: TokenRankingMetricsMap;
  offensiveTokenRankingMetrics: TokenRankingMetricsMap;
  keeperAddress: string;
  strategyIds: string;
  floatV4KeeperAddress: string;
  floatV4StrategyIds: string;
  floatV4RunEveryNLoops: number;
  floatContractManagerV4Address: string;
  networkId: string;
  pollMs: number;
  harvestIntervalMs: number;
  changeStrategyIntervalMs: number;
  priceCheckIntervalMs: number;
  priceDropThresholdPct: number;
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
} {
  const o = loadOverrides();
  const marketBreadth = getMarketBreadthNegativeH24FractionGte();
  return {
    tokenRankingMetrics: getTokenRankingMetrics(),
    offensiveTokenRankingMetrics: getOffensiveTokenRankingMetrics(),
    keeperAddress: o.keeperAddress ?? DEFAULT_KEEPER_ADDRESS,
    strategyIds: o.strategyIds ?? DEFAULT_STRATEGY_IDS,
    floatV4KeeperAddress: o.floatV4KeeperAddress ?? DEFAULT_FLOAT_V4_KEEPER_ADDRESS,
    floatV4StrategyIds: o.floatV4StrategyIds ?? DEFAULT_FLOAT_V4_STRATEGY_IDS,
    floatV4RunEveryNLoops: getFloatV4RunEveryNLoops(),
    floatContractManagerV4Address: FLOAT_CONTRACT_MANAGER_V4_ADDRESS,
    networkId: o.networkId ?? DEFAULT_NETWORK_ID,
    pollMs: o.pollMs ?? DEFAULT_POLL_MS,
    harvestIntervalMs: o.harvestIntervalMs ?? DEFAULT_HARVEST_INTERVAL_MS,
    changeStrategyIntervalMs: o.changeStrategyIntervalMs ?? DEFAULT_CHANGE_STRATEGY_INTERVAL_MS,
    priceCheckIntervalMs: o.priceCheckIntervalMs ?? DEFAULT_PRICE_CHECK_INTERVAL_MS,
    priceDropThresholdPct: o.priceDropThresholdPct ?? DEFAULT_PRICE_DROP_THRESHOLD_PCT,
    minVolumeH12Usd: o.minVolumeH12Usd ?? DEFAULT_MIN_VOLUME_H12_USD,
    minPoolLiquidityUsd: o.minPoolLiquidityUsd ?? DEFAULT_MIN_POOL_LIQUIDITY_USD,
    minVolatilityH24Usd: o.minVolatilityH24Usd ?? DEFAULT_MIN_VOLITILITY_H24_USD,
    maxVolatilityH24Usd: getMaxVolatilityH24Usd(),
    maxNegativePriceChangeH24Pct: o.maxNegativePriceChangeH24Pct ?? DEFAULT_MAX_NEGATIVE_PRICE_CHANGE_H24_PCT,
    maxNegativePriceChangeM5M15M30Pct:
      o.maxNegativePriceChangeM5M15M30Pct ?? DEFAULT_MAX_NEGATIVE_PRICE_CHANGE_M5_M15_M30_H1_PCT,
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
    marketBreadthNegativeH24FractionGte: marketBreadth.fractionGte,
    marketBreadthRequireCurrentAssetNegativeH24: marketBreadth.requireCurrentAssetNegativeH24,
  };
}