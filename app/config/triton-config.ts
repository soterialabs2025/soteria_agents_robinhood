/**
 * Triton / Float V4 — agent-driven `changeAsset` (no Float keeper) and V4 ranking / loop thresholds.
 * Float V3 equivalents live in {@link demeter-config}.
 * Wallet: `TRITON_PRIVATE_KEY` (expected address {@link TRITON_WALLET_ADDRESS}).
 */

import {
  DEFAULT_OFFENSIVE_ABSOLUTE_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE,
  getOffensiveWeightedScoreNormalization,
  getTokenRankingMetrics,
  type TokenRankingMetricsMap,
} from "./demeter-config";
import type { RankingEligibilityThresholds } from "./ranking-eligibility";
import { loadTritonOverrides } from "./triton-overrides";


/** WETH on Robinhood Chain (defensive parking asset). */
export const TRITON_WETH_ADDRESS = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;


/** Float V4 / Triton loop + ranking defaults (mirror demeter-config; tune independently)
 * Volume / liquidity / volatility / price-drawdown mins & maxes below apply to UFloat offensive-metrics
 * — not UFloat DEFENSIVE ranking ({@link getUfloatDefensiveRankingEligibilityThresholds}).
 */

/** UFloatKeeper (Triton wallet) — performUpkeepBatch cadence. */
export const DEFAULT_UFLOAT_KEEPER_UPKEEP_INTERVAL_MS = 1 * 60 * 1000; // 1 min
/** UFloatKeeper (Triton wallet) — performHarvest cadence. */
export const DEFAULT_UFLOAT_KEEPER_HARVEST_INTERVAL_MS = 6 * 60 * 60 * 1000; //  hours
/** UFloat offensive-metrics loop (NORMAL only). */
export const DEFAULT_UFLOAT_OFFENSIVE_INTERVAL_MS = 2 * 60 * 1000;
/** Legacy Triton pipeline metadata — not used by UFloat keeper changeAsset throttle. */
export const DEFAULT_TRITON_CHANGE_STRATEGY_INTERVAL_MS = 3 * 60 * 1000;
/** Float V4 periodic defensive check interval (m30 drop, low 12h volume).*/
export const DEFAULT_TRITON_FLOAT_PRICE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * UFloat DEFENSIVE token ranking —  MAX Possible Weighted Score is 0.71 copied from Float {@link DEFAULT_TOKEN_RANKING_METRICS} in demeter-config.
 * Used when UFloatStrategy.mode() is DEFENSIVE: compare only `allowedTokens` from the strategy contract.
 */
export const UFLOAT_DEFAULT_TOKEN_RANKING_METRICS = {
  volume_h6: {
    weight: 0.02,
    higherIsBetter: true,
    description: "6h trading volume. Fee generation, trading activity.",
  },
  volume_h1: {
    weight: 0.00,
    higherIsBetter: true,
    description:
      "1h pool volume (USD). Default Float composite does not use it (weight 0); available for overrides / Offensive.",
  },
  volume_h12: {
    weight: 0.00,
    higherIsBetter: true,
    description: "12h trading volume. Fee generation, trading activity.",
  },
  volume_m5: {
    weight: 0.00,
    higherIsBetter: true,
    description: "5m pool volume (USD). Onchain pool volume_usd.m5; default Float weight 0.",
  },
  volume_m15: {
    weight: 0.00,
    higherIsBetter: true,
    description: "15m pool volume (USD). Onchain pool volume_usd.m15; default Float weight 0.",
  },
  volume_m30: {
    weight: 0.00,
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
    weight: 0.00,
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
    description:
      "1h price change %. Default Float composite does not use it (weight 0); available for overrides / Offensive.",
  },
  price_change_h12: {
    weight: 0.04,
    higherIsBetter: true,
    description:
      "12h price change % (pool; interpolated from h6/h24 when API omits h12). Higher = price went up = good.",
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
    weight: 0.1,
    higherIsBetter: true,
    description:
      "6h pool volume / liquidity (6h turnover). Small tie-break for execution quality; not a substitute for short price %.",
  },
} as const;

/**
 * Triton / LiquidStratMinV4 + UFloat ranking defaults ({@link getTritonRankingEligibilityThresholds}).
 *
 * **Not UFloatKeeper harvest** — that uses {@link DEFAULT_UFLOAT_KEEPER_HARVEST_INTERVAL_MS}.
 * **UFloat DEFENSIVE** zeros volume/liquidity/volatility/drawdown floors via
 * {@link getUfloatDefensiveRankingEligibilityThresholds}; it does not use the gates below as written.
 *
 * **UFloat offensive-metrics** (NORMAL) — uses volume / liquidity / volatility / drawdown / momentum /
 * score floor from this block (via `fetchTokenComparisonV4` + {@link pickOffensiveMetricsForAllowlist}).
 * Market-breadth defaults are in the bundle but UFloat’s cached V4 fetch usually disables breadth.
 */
/** Legacy LiquidStrat / Triton pipeline harvest metadata — not {@link getUfloatKeeperHarvestIntervalMs}. */
export const DEFAULT_TRITON_HARVEST_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Legacy LiquidStrat / Triton periodic defensive price-drop trigger — not UFloatKeeper. */
export const DEFAULT_TRITON_PRICE_DROP_THRESHOLD_PCT = -5;
/** UFloat offensive + LiquidStrat: min 12h pool volume (USD) for eligibility / actionable pick. */
export const DEFAULT_TRITON_MIN_VOLUME_H12_USD = 1000;
/** UFloat offensive + LiquidStrat: min pool liquidity (USD). */
export const DEFAULT_TRITON_MIN_POOL_LIQUIDITY_USD = 50_000;
/** UFloat offensive + LiquidStrat: min 24h turnover (vol/liq). */
export const DEFAULT_TRITON_MIN_VOLITILITY_H24_USD = 0.02;
/** UFloat offensive + LiquidStrat: max 24h turnover (vol/liq). */
export const DEFAULT_TRITON_MAX_VOLITILITY_H24_USD = 2.8;
/** UFloat offensive + LiquidStrat: max negative 24h pool Δ% (more negative = excluded). */
export const DEFAULT_TRITON_MAX_NEGATIVE_PRICE_CHANGE_H24_PCT = -20;
/** UFloat offensive + LiquidStrat: max negative m5/m15/m30/h1 pool Δ%. */
export const DEFAULT_TRITON_MAX_NEGATIVE_PRICE_CHANGE_M5_M15_M30_H1_PCT = -2;
/**
 * UFloat offensive score floor when {@link DEFAULT_UFLOAT_APPLY_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE} is on;
 * also LiquidStrat scheduled-change min weighted score.
 */
export const DEFAULT_TRITON_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE = 0.45;
/** UFloat offensive + LiquidStrat: absolute momentum gate (m5 pool Δ%). */
export const DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MIN_M5_PCT = 0.05;
export const DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MAX_M5_PCT = 4.2;
export const DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MIN_M15_PCT = 0.04;
export const DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MAX_M15_PCT = 10;
export const DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MIN_M30_PCT = 0.02;
export const DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MAX_M30_PCT = 12;
export const DEFAULT_TRITON_OFFENSIVE_MOMENTUM_VOLUME_OVER_SPREAD_RATIO = 1.0;
export const DEFAULT_TRITON_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H24_PCT_GTE = 20;
export const DEFAULT_TRITON_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H12_PCT_GTE = 16;
/** In Triton ranking bundle; UFloat cached V4 compare usually sets `disableMarketBreadth: true`. */
export const DEFAULT_TRITON_MARKET_BREADTH_NEGATIVE_H24_FRACTION_GTE = 0.9;
export const DEFAULT_TRITON_MARKET_BREADTH_REQUIRE_CURRENT_ASSET_NEGATIVE_H24 = false;
/** UFloat offensive: when true, require top pick score ≥ {@link DEFAULT_TRITON_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE}. */
export const DEFAULT_UFLOAT_APPLY_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE = true;

/** LiquidStratMinV4 price tick interval (ms). */
export const DEFAULT_TRITON_PRICE_CHECK_INTERVAL_MS = 30_000;

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envNumWithLegacy(primaryEnv: string, legacyEnv: string | undefined, fallback: number): number {
  const primary = process.env[primaryEnv]?.trim();
  if (primary) {
    const n = Number(primary);
    if (Number.isFinite(n)) return n;
  }
  if (legacyEnv) {
    const legacy = process.env[legacyEnv]?.trim();
    if (legacy) {
      const n = Number(legacy);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function tritonOverrideNum(
  key: keyof ReturnType<typeof loadTritonOverrides>,
  envName: string,
  fallback: number,
  min: number,
  max: number
): number {
  const o = loadTritonOverrides();
  const fromJson = o[key];
  if (typeof fromJson === "number" && Number.isFinite(fromJson)) {
    return clampNumber(fromJson, fallback, min, max);
  }
  return clampNumber(envNum(envName, fallback), fallback, min, max);
}

function tritonOverrideBool(
  key: keyof ReturnType<typeof loadTritonOverrides>,
  envName: string,
  fallback: boolean
): boolean {
  const o = loadTritonOverrides();
  const fromJson = o[key];
  if (typeof fromJson === "boolean") return fromJson;
  if (envFlagTrue(envName)) return true;
  if (envFlagFalse(envName)) return false;
  return fallback;
}

export function getTritonDefensiveExitRules(): TritonDefensiveExitRules {
  return {
    peakTierHighPct: envNum("TRITON_PEAK_TIER_HIGH_PCT", DEFAULT_TRITON_PEAK_TIER_HIGH_PCT),
    peakTierHighTrailDrawdownPct: envNumWithLegacy(
      "TRITON_PEAK_TIER_HIGH_TRAIL_DRAWDOWN_PCT",
      "TRITON_TRAIL_DRAWDOWN_FROM_PEAK_PCT",
      DEFAULT_TRITON_PEAK_TIER_HIGH_TRAIL_DRAWDOWN_PCT
    ),
    peakTierMidPct: envNum("TRITON_PEAK_TIER_MID_PCT", DEFAULT_TRITON_PEAK_TIER_MID_PCT),
    peakTierMidTrailDrawdownPct: envNum(
      "TRITON_PEAK_TIER_MID_TRAIL_DRAWDOWN_PCT",
      DEFAULT_TRITON_PEAK_TIER_MID_TRAIL_DRAWDOWN_PCT
    ),
    peakTierLowPct: envNum("TRITON_PEAK_TIER_LOW_PCT", DEFAULT_TRITON_PEAK_TIER_LOW_PCT),
    peakTierLowTrailDrawdownPct: envNum(
      "TRITON_PEAK_TIER_LOW_TRAIL_DRAWDOWN_PCT",
      DEFAULT_TRITON_PEAK_TIER_LOW_TRAIL_DRAWDOWN_PCT
    ),
    belowLowTierExitPct: envNumWithLegacy(
      "TRITON_BELOW_LOW_TIER_EXIT_PCT",
      "TRITON_NO_RALLY_EXIT_PCT",
      DEFAULT_TRITON_BELOW_LOW_TIER_EXIT_PCT
    ),
  };
}

export function getTritonHarvestIntervalMs(): number {
  const o = loadTritonOverrides();
  if (typeof o.harvestIntervalMs === "number" && Number.isFinite(o.harvestIntervalMs) && o.harvestIntervalMs >= 60_000) {
    return Math.floor(o.harvestIntervalMs);
  }
  const raw = process.env.TRITON_HARVEST_INTERVAL_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 60_000) return Math.floor(n);
  }
  return DEFAULT_TRITON_HARVEST_INTERVAL_MS;
}

/** Weighted metrics for UFloat DEFENSIVE — live {@link getTokenRankingMetrics} (default Float weights + overrides). */
export function getUfloatTokenRankingMetrics(): TokenRankingMetricsMap {
  return getTokenRankingMetrics();
}

/** UFloatKeeper performUpkeepBatch interval (Triton wallet). */
export function getUfloatKeeperUpkeepIntervalMs(): number {
  const raw = process.env.UFLOAT_KEEPER_UPKEEP_INTERVAL_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 30_000) return Math.floor(n);
  }
  return DEFAULT_UFLOAT_KEEPER_UPKEEP_INTERVAL_MS;
}

/** UFloatKeeper performHarvest interval (Triton wallet). */
export function getUfloatKeeperHarvestIntervalMs(): number {
  const raw = process.env.UFLOAT_KEEPER_HARVEST_INTERVAL_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 60_000) return Math.floor(n);
  }
  return DEFAULT_UFLOAT_KEEPER_HARVEST_INTERVAL_MS;
}

let ufloatStableEntryIntervalDeprecatedWarned = false;

function warnUfloatStableEntryIntervalDeprecated(): void {
  if (ufloatStableEntryIntervalDeprecatedWarned) return;
  ufloatStableEntryIntervalDeprecatedWarned = true;
  console.warn(
    "[triton-config] UFLOAT_STABLE_ENTRY_INTERVAL_MS / triton.overrides ufloatStableEntryIntervalMs is deprecated and ignored. " +
      "DEFENSIVE scan cadence: UFLOAT_KEEPER_UPKEEP_INTERVAL_MS (post-upkeep pass)."
  );
}

/**
 * @deprecated Removed separate STABLE timer loop. DEFENSIVE default-metrics run after each
 * {@link getUfloatKeeperUpkeepIntervalMs} upkeep pass. Returns upkeep interval for API compat only.
 */
export function getUfloatStableEntryIntervalMs(): number {
  const o = loadTritonOverrides();
  const hasOverride =
    typeof o.ufloatStableEntryIntervalMs === "number" &&
    Number.isFinite(o.ufloatStableEntryIntervalMs);
  if (hasOverride || process.env.UFLOAT_STABLE_ENTRY_INTERVAL_MS?.trim()) {
    warnUfloatStableEntryIntervalDeprecated();
  }
  return getUfloatKeeperUpkeepIntervalMs();
}

/** UFloat OFFENSIVE mode rotation scan interval ({@link DEFAULT_UFLOAT_OFFENSIVE_INTERVAL_MS}). */
export function getUfloatOffensiveIntervalMs(): number {
  const o = loadTritonOverrides();
  if (
    typeof o.ufloatOffensiveIntervalMs === "number" &&
    Number.isFinite(o.ufloatOffensiveIntervalMs) &&
    o.ufloatOffensiveIntervalMs >= 30_000
  ) {
    return Math.floor(o.ufloatOffensiveIntervalMs);
  }
  return DEFAULT_UFLOAT_OFFENSIVE_INTERVAL_MS;
}

/**
 * Legacy Triton pipeline scheduled-change interval (Float periodic / getTritonPipelineLoopThresholds).
 * UFloat keeper does not use this — see {@link getUfloatChangeAssetCooldownMs}.
 */
export function getTritonChangeStrategyIntervalMs(): number {
  const o = loadTritonOverrides();
  if (
    typeof o.changeStrategyIntervalMs === "number" &&
    Number.isFinite(o.changeStrategyIntervalMs) &&
    o.changeStrategyIntervalMs >= 30_000
  ) {
    return Math.floor(o.changeStrategyIntervalMs);
  }
  const raw = process.env.TRITON_CHANGE_STRATEGY_INTERVAL_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 30_000) return Math.floor(n);
  }
  return DEFAULT_TRITON_CHANGE_STRATEGY_INTERVAL_MS;
}

/**
 * UFloat DEFENSIVE + offensive-metrics changeAsset throttle (ms between successful swaps per strategy).
 * `0` = disabled — swap allowed every loop wake. Not `TRITON_CHANGE_STRATEGY_INTERVAL_MS`.
 * Optional env: `UFLOAT_CHANGE_ASSET_COOLDOWN_MS` (0 or ≥ 30_000).
 */
export function getUfloatChangeAssetCooldownMs(): number {
  const raw = process.env.UFLOAT_CHANGE_ASSET_COOLDOWN_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n === 0) return 0;
    if (Number.isFinite(n) && n >= 30_000) return Math.floor(n);
  }
  const o = loadTritonOverrides();
  if (
    typeof o.ufloatChangeAssetCooldownMs === "number" && 
    Number.isFinite(o.ufloatChangeAssetCooldownMs)
  ) {
    const n = o.ufloatChangeAssetCooldownMs;
    if (n === 0) return 0;
    if (n >= 30_000) return Math.floor(n);
  }
  return 0;
}

/** Float V4 periodic defensive interval (Demeter floatPeriodicLoop for V4). */
export function getTritonFloatPriceCheckIntervalMs(): number {
  const o = loadTritonOverrides();
  if (
    typeof o.floatPriceCheckIntervalMs === "number" &&
    Number.isFinite(o.floatPriceCheckIntervalMs) &&
    o.floatPriceCheckIntervalMs >= 60_000
  ) {
    return Math.floor(o.floatPriceCheckIntervalMs);
  }
  const raw = process.env.TRITON_FLOAT_PRICE_CHECK_INTERVAL_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 60_000) return Math.floor(n);
  }
  return DEFAULT_TRITON_FLOAT_PRICE_CHECK_INTERVAL_MS;
}

export function getTritonPriceDropThresholdPct(): number {
  const o = loadTritonOverrides();
  if (typeof o.priceDropThresholdPct === "number" && Number.isFinite(o.priceDropThresholdPct)) {
    return o.priceDropThresholdPct;
  }
  return envNum("TRITON_PRICE_DROP_THRESHOLD_PCT", DEFAULT_TRITON_PRICE_DROP_THRESHOLD_PCT);
}

export function getTritonMinVolumeH12Usd(): number {
  return tritonOverrideNum("minVolumeH12Usd", "TRITON_MIN_VOLUME_H12_USD", DEFAULT_TRITON_MIN_VOLUME_H12_USD, 0, 1e12);
}

export function getTritonMinPoolLiquidityUsd(): number {
  return tritonOverrideNum(
    "minPoolLiquidityUsd",
    "TRITON_MIN_POOL_LIQUIDITY_USD",
    DEFAULT_TRITON_MIN_POOL_LIQUIDITY_USD,
    0,
    1e12
  );
}

export function getTritonMinVolatilityH24Usd(): number {
  return tritonOverrideNum(
    "minVolatilityH24Usd",
    "TRITON_MIN_VOLITILITY_H24_USD",
    DEFAULT_TRITON_MIN_VOLITILITY_H24_USD,
    0,
    1000
  );
}

export function getTritonMaxVolatilityH24Usd(): number {
  return tritonOverrideNum(
    "maxVolatilityH24Usd",
    "TRITON_MAX_VOLITILITY_H24_USD",
    DEFAULT_TRITON_MAX_VOLITILITY_H24_USD,
    0,
    1000
  );
}

export function getTritonMaxNegativePriceChangeH24Pct(): number {
  const o = loadTritonOverrides();
  if (typeof o.maxNegativePriceChangeH24Pct === "number" && Number.isFinite(o.maxNegativePriceChangeH24Pct)) {
    return o.maxNegativePriceChangeH24Pct;
  }
  return envNum("TRITON_MAX_NEGATIVE_PRICE_CHANGE_H24_PCT", DEFAULT_TRITON_MAX_NEGATIVE_PRICE_CHANGE_H24_PCT);
}

export function getTritonMaxNegativePriceChangeM5M15M30Pct(): number {
  const o = loadTritonOverrides();
  if (
    typeof o.maxNegativePriceChangeM5M15M30Pct === "number" &&
    Number.isFinite(o.maxNegativePriceChangeM5M15M30Pct)
  ) {
    return o.maxNegativePriceChangeM5M15M30Pct;
  }
  return envNum(
    "TRITON_MAX_NEGATIVE_PRICE_CHANGE_M5_M15_M30_PCT",
    DEFAULT_TRITON_MAX_NEGATIVE_PRICE_CHANGE_M5_M15_M30_H1_PCT
  );
}

export function getTritonScheduledChangeMinWeightedScore(): number {
  // When offensive scoring is `absolute`, the composite is not cohort-relative, so it needs its own (lower) bar.
  // Override / TRITON_* env still win; this only changes the default fallback for the live UFloat offensive path.
  const fallback =
    getOffensiveWeightedScoreNormalization() === "absolute"
      ? DEFAULT_OFFENSIVE_ABSOLUTE_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE
      : DEFAULT_TRITON_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE;
  return tritonOverrideNum(
    "scheduledChangeMinWeightedScore",
    "TRITON_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE",
    fallback,
    0,
    1
  );
}

export function getTritonOffensiveMomentumMinM5Pct(): number {
  return tritonOverrideNum(
    "offensiveMomentumMinM5Pct",
    "TRITON_OFFENSIVE_MOMENTUM_MIN_M5_PCT",
    DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MIN_M5_PCT,
    0,
    100
  );
}

export function getTritonOffensiveMomentumMaxM5Pct(): number {
  return tritonOverrideNum(
    "offensiveMomentumMaxM5Pct",
    "TRITON_OFFENSIVE_MOMENTUM_MAX_M5_PCT",
    DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MAX_M5_PCT,
    0,
    100
  );
}

export function getTritonOffensiveMomentumMinM15Pct(): number {
  return tritonOverrideNum(
    "offensiveMomentumMinM15Pct",
    "TRITON_OFFENSIVE_MOMENTUM_MIN_M15_PCT",
    DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MIN_M15_PCT,
    0,
    100
  );
}

export function getTritonOffensiveMomentumMaxM15Pct(): number {
  return tritonOverrideNum(
    "offensiveMomentumMaxM15Pct",
    "TRITON_OFFENSIVE_MOMENTUM_MAX_M15_PCT",
    DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MAX_M15_PCT,
    0,
    100
  );
}

export function getTritonOffensiveMomentumMinM30Pct(): number {
  return tritonOverrideNum(
    "offensiveMomentumMinM30Pct",
    "TRITON_OFFENSIVE_MOMENTUM_MIN_M30_PCT",
    DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MIN_M30_PCT,
    0,
    100
  );
}

export function getTritonOffensiveMomentumMaxM30Pct(): number {
  return tritonOverrideNum(
    "offensiveMomentumMaxM30Pct",
    "TRITON_OFFENSIVE_MOMENTUM_MAX_M30_PCT",
    DEFAULT_TRITON_OFFENSIVE_MOMENTUM_MAX_M30_PCT,
    0,
    100
  );
}

export function getTritonOffensiveMomentumVolumeOverSpreadRatio(): number {
  return tritonOverrideNum(
    "offensiveMomentumVolumeOverSpreadRatio",
    "TRITON_OFFENSIVE_MOMENTUM_VOLUME_OVER_SPREAD_RATIO",
    DEFAULT_TRITON_OFFENSIVE_MOMENTUM_VOLUME_OVER_SPREAD_RATIO,
    0,
    100
  );
}

export function getTritonOffensiveMomentumExcludePriceChangeH24PctGte(): number {
  return tritonOverrideNum(
    "offensiveMomentumExcludePriceChangeH24PctGte",
    "TRITON_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H24_PCT_GTE",
    DEFAULT_TRITON_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H24_PCT_GTE,
    0,
    1000
  );
}

export function getTritonOffensiveMomentumExcludePriceChangeH12PctGte(): number {
  return tritonOverrideNum(
    "offensiveMomentumExcludePriceChangeH12PctGte",
    "TRITON_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H12_PCT_GTE",
    DEFAULT_TRITON_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H12_PCT_GTE,
    0,
    1000
  );
}

export function getTritonMarketBreadthNegativeH24FractionGte(): {
  fractionGte: number;
  requireCurrentAssetNegativeH24: boolean;
} {
  const o = loadTritonOverrides();
  const fractionGte = clampNumber(
    o.marketBreadthNegativeH24FractionGte ??
      envNum("TRITON_MARKET_BREADTH_NEGATIVE_H24_FRACTION_GTE", DEFAULT_TRITON_MARKET_BREADTH_NEGATIVE_H24_FRACTION_GTE),
    DEFAULT_TRITON_MARKET_BREADTH_NEGATIVE_H24_FRACTION_GTE,
    0.5,
    1
  );
  const requireCurrentAssetNegativeH24 =
    o.marketBreadthRequireCurrentAssetNegativeH24 ??
    (process.env.TRITON_MARKET_BREADTH_REQUIRE_CURRENT_ASSET_NEGATIVE_H24?.trim().toLowerCase() === "true"
      ? true
      : process.env.TRITON_MARKET_BREADTH_REQUIRE_CURRENT_ASSET_NEGATIVE_H24?.trim().toLowerCase() === "false"
        ? false
        : DEFAULT_TRITON_MARKET_BREADTH_REQUIRE_CURRENT_ASSET_NEGATIVE_H24);
  return { fractionGte, requireCurrentAssetNegativeH24 };
}

/** When true, UFloat offensive-metrics enforces {@link getTritonScheduledChangeMinWeightedScore}. */
export function getUfloatApplyScheduledChangeMinWeightedScore(): boolean {
  return tritonOverrideBool(
    "ufloatApplyScheduledChangeMinWeightedScore",
    "UFLOAT_APPLY_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE",
    DEFAULT_UFLOAT_APPLY_SCHEDULED_CHANGE_MIN_WEIGHTED_SCORE
  );
}

/** Full V4 / Triton ranking + momentum threshold bundle for CoinGecko comparison. */
export function getTritonRankingEligibilityThresholds(): RankingEligibilityThresholds {
  const breadth = getTritonMarketBreadthNegativeH24FractionGte();
  return {
    minVolumeH12Usd: getTritonMinVolumeH12Usd(),
    minPoolLiquidityUsd: getTritonMinPoolLiquidityUsd(),
    minVolatilityH24Usd: getTritonMinVolatilityH24Usd(),
    maxVolatilityH24Usd: getTritonMaxVolatilityH24Usd(),
    maxNegativePriceChangeH24Pct: getTritonMaxNegativePriceChangeH24Pct(),
    maxNegativePriceChangeM5M15M30Pct: getTritonMaxNegativePriceChangeM5M15M30Pct(),
    scheduledChangeMinWeightedScore: getTritonScheduledChangeMinWeightedScore(),
    offensiveMomentumMinM5Pct: getTritonOffensiveMomentumMinM5Pct(),
    offensiveMomentumMaxM5Pct: getTritonOffensiveMomentumMaxM5Pct(),
    offensiveMomentumMinM15Pct: getTritonOffensiveMomentumMinM15Pct(),
    offensiveMomentumMaxM15Pct: getTritonOffensiveMomentumMaxM15Pct(),
    offensiveMomentumMinM30Pct: getTritonOffensiveMomentumMinM30Pct(),
    offensiveMomentumMaxM30Pct: getTritonOffensiveMomentumMaxM30Pct(),
    offensiveMomentumVolumeOverSpreadRatio: getTritonOffensiveMomentumVolumeOverSpreadRatio(),
    offensiveMomentumExcludePriceChangeH24PctGte: getTritonOffensiveMomentumExcludePriceChangeH24PctGte(),
    offensiveMomentumExcludePriceChangeH12PctGte: getTritonOffensiveMomentumExcludePriceChangeH12PctGte(),
    marketBreadthNegativeH24FractionGte: breadth.fractionGte,
    marketBreadthRequireCurrentAssetNegativeH24: breadth.requireCurrentAssetNegativeH24,
  };
}

/**
 * UFloat DEFENSIVE post-upkeep ranking — all allowlist tokens scored; no volume/liquidity/volatility/drawdown exclusion.
 * Offensive-metrics still use {@link getTritonRankingEligibilityThresholds}.
 */
export function getUfloatDefensiveRankingEligibilityThresholds(): RankingEligibilityThresholds {
  const base = getTritonRankingEligibilityThresholds();
  return {
    ...base,
    minVolumeH12Usd: 0,
    minPoolLiquidityUsd: 0,
    minVolatilityH24Usd: 0,
    maxVolatilityH24Usd: 0,
    maxNegativePriceChangeH24Pct: -999,
    maxNegativePriceChangeM5M15M30Pct: -999,
  };
}

function envFlagTrue(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function envFlagFalse(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "false" || raw === "0" || raw === "no";
}

export function getTritonPrivateKeyFromEnv(): string {
  const pk = process.env.TRITON_PRIVATE_KEY?.trim();
  if (!pk) {
    throw new Error("TRITON_PRIVATE_KEY is required for Triton-wallet operations.");
  }
  return pk;
}

/** Optional second Triton operator shard (TRITON_TWO_PRIVATE_KEY). */
export function getTritonTwoPrivateKeyFromEnv(): string | null {
  return process.env.TRITON_TWO_PRIVATE_KEY?.trim() || null;
}

/** Any configured Triton operator key (primary or shard 2). */
export function getAnyTritonPrivateKeyFromEnv(): string {
  const pk =
    process.env.TRITON_PRIVATE_KEY?.trim() || process.env.TRITON_TWO_PRIVATE_KEY?.trim();
  if (!pk) {
    throw new Error("TRITON_PRIVATE_KEY or TRITON_TWO_PRIVATE_KEY is required for Triton operations.");
  }
  return pk;
}

/** TRITON_PRIVATE_KEY or TRITON_TWO_PRIVATE_KEY is set. */
export function isTritonEnabled(): boolean {
  return Boolean(
    process.env.TRITON_PRIVATE_KEY?.trim() || process.env.TRITON_TWO_PRIVATE_KEY?.trim()
  );
}

/** LiquidStratMinV4 price-tick loop. Default off. `tritonEnabled=false` in overrides also blocks it. */
export function isLiquidStratMinV4LoopEnabled(): boolean {
  if (!isTritonEnabled()) return false;
  const o = loadTritonOverrides();
  if (o.tritonEnabled === false) return false;
  if (o.liquidStratMinV4LoopEnabled === true) return true;
  if (o.liquidStratMinV4LoopEnabled === false) return false;
  if (envFlagTrue("TRITON_LIQUID_STRAT_LOOP_ENABLED")) return true;
  if (envFlagFalse("TRITON_LIQUID_STRAT_LOOP_ENABLED")) return false;
  return false;
}

/** UFloatKeeperV4 loop. Default on when any Triton operator key is set. */
export function isUfloatKeeperEnabled(): boolean {
  if (!isTritonEnabled()) return false;
  const o = loadTritonOverrides();
  if (o.ufloatKeeperEnabled === false) return false;
  if (envFlagFalse("TRITON_UFLOAT_KEEPER_ENABLED")) return false;
  return true;
}

/**
 * When false, Triton does not auto-enter tokens from WETH (`tryOffensiveEntry` skipped).
 * Defensive exit while holding a token still runs. Float offensive loops are unaffected.
 */
export function getTritonOffensiveEntryEnabled(): boolean {
  const o = loadTritonOverrides();
  if (typeof o.tritonOffensiveEntryEnabled === "boolean") return o.tritonOffensiveEntryEnabled;

  const raw = process.env.TRITON_OFFENSIVE_ENTRY_ENABLED?.trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return false;
}

/** LiquidStratMinV4 price tick interval (ms). */
export function getTritonPriceCheckIntervalMs(): number {
  const o = loadTritonOverrides();
  if (typeof o.tritonPriceCheckIntervalMs === "number") {
    const n = Math.floor(o.tritonPriceCheckIntervalMs);
    if (Number.isFinite(n) && n >= 5_000) return n;
  }

  const raw = process.env.TRITON_PRICE_CHECK_INTERVAL_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 5_000) return n;
  }

  return DEFAULT_TRITON_PRICE_CHECK_INTERVAL_MS;
}

/** Full merged Triton / Float V4 config for display / API. */
export function getTritonMergedConfig(): ReturnType<typeof getTritonRankingEligibilityThresholds> & {
  tritonEnabled: boolean;
  liquidStratMinV4LoopEnabled: boolean;
  ufloatKeeperEnabled: boolean;
  tritonOffensiveEntryEnabled: boolean;
  tritonPriceCheckIntervalMs: number;
  harvestIntervalMs: number;
  changeStrategyIntervalMs: number;
  /** Post-upkeep DEFENSIVE default-metrics scan cadence (= {@link getUfloatKeeperUpkeepIntervalMs}). */
  ufloatDefensiveStableScanIntervalMs: number;
  /** UFloat changeAsset throttle ms (0 = none). Not {@link getTritonChangeStrategyIntervalMs}. */
  ufloatDefensiveStableSwapCooldownMs: number;
  ufloatOffensiveIntervalMs: number;
  /** @deprecated Use {@link ufloatDefensiveStableScanIntervalMs}. Ignored if set via env/overrides. */
  ufloatStableEntryIntervalMs: number;
  floatPriceCheckIntervalMs: number;
  priceDropThresholdPct: number;
  ufloatApplyScheduledChangeMinWeightedScore: boolean;
} {
  const ranking = getTritonRankingEligibilityThresholds();
  return {
    tritonEnabled: isTritonEnabled(),
    liquidStratMinV4LoopEnabled: isLiquidStratMinV4LoopEnabled(),
    ufloatKeeperEnabled: isUfloatKeeperEnabled(),
    tritonOffensiveEntryEnabled: getTritonOffensiveEntryEnabled(),
    tritonPriceCheckIntervalMs: getTritonPriceCheckIntervalMs(),
    harvestIntervalMs: getTritonHarvestIntervalMs(),
    changeStrategyIntervalMs: getTritonChangeStrategyIntervalMs(),
    ufloatDefensiveStableScanIntervalMs: getUfloatKeeperUpkeepIntervalMs(),
    ufloatDefensiveStableSwapCooldownMs: getUfloatChangeAssetCooldownMs(),
    ufloatOffensiveIntervalMs: getUfloatOffensiveIntervalMs(),
    ufloatStableEntryIntervalMs: getUfloatStableEntryIntervalMs(),
    floatPriceCheckIntervalMs: getTritonFloatPriceCheckIntervalMs(),
    priceDropThresholdPct: getTritonPriceDropThresholdPct(),
    ufloatApplyScheduledChangeMinWeightedScore: getUfloatApplyScheduledChangeMinWeightedScore(),
    ...ranking,
  };
}


// =============================================================================
// Tiered defensive exit (LiquidStratMinV4 while holding a token)
// =============================================================================


/** Wallet for `TRITON_PRIVATE_KEY`; must match on-chain `tritonAddr` on LiquidStratMinV4. */
export const TRITON_WALLET_ADDRESS = "0x66d60E991D09447245d668671d079b57eB48f58E" as const;

/** LiquidStratMinV4 on Base. */
export const LIQUID_STRAT_MIN_V4_ADDRESS = "0x14CC9303f5FA8D3A5BDb08604e436A953A88f7cE" as const;

/** HIGH tier: peak ever ≥ this → exit when current ≤ peak − {@link DEFAULT_TRITON_PEAK_TIER_HIGH_TRAIL_DRAWDOWN_PCT}. */
export const DEFAULT_TRITON_PEAK_TIER_HIGH_PCT = 26;
export const DEFAULT_TRITON_PEAK_TIER_HIGH_TRAIL_DRAWDOWN_PCT = 4;

/** MEDIUM tier: peak ≥ this (below HIGH) → exit when current ≤ peak − {@link DEFAULT_TRITON_PEAK_TIER_MID_TRAIL_DRAWDOWN_PCT}. */
export const DEFAULT_TRITON_PEAK_TIER_MID_PCT = 18;
export const DEFAULT_TRITON_PEAK_TIER_MID_TRAIL_DRAWDOWN_PCT = 6;

/** LOW tier: peak ≥ this (below MEDIUM) → exit when current ≤ peak − {@link DEFAULT_TRITON_PEAK_TIER_LOW_TRAIL_DRAWDOWN_PCT}. */
export const DEFAULT_TRITON_PEAK_TIER_LOW_PCT = 10;
export const DEFAULT_TRITON_PEAK_TIER_LOW_TRAIL_DRAWDOWN_PCT = 4;

/** If peak never reached LOW tier (+10%), exit when current ≤ this % from entry. */
export const DEFAULT_TRITON_BELOW_LOW_TIER_EXIT_PCT = -4;

export type TritonDefensiveExitRules = {
  peakTierHighPct: number;
  peakTierHighTrailDrawdownPct: number;
  peakTierMidPct: number;
  peakTierMidTrailDrawdownPct: number;
  peakTierLowPct: number;
  peakTierLowTrailDrawdownPct: number;
  belowLowTierExitPct: number;
};