import * as fs from "fs";
import * as path from "path";

export type TritonOverrides = {
  /** When false, disables LiquidStratMinV4 loop only (legacy name). UFloatKeeperV4 uses {@link ufloatKeeperEnabled}. */
  tritonEnabled?: boolean;
  /**
   * LiquidStratMinV4 price-tick loop (offensive entry + defensive exit). Default off — use UFloatKeeperV4 instead.
   * Requires Demeter restart. Env: `TRITON_LIQUID_STRAT_LOOP_ENABLED=true`.
   */
  liquidStratMinV4LoopEnabled?: boolean;
  /**
   * UFloatKeeperV4 upkeep/harvest/DEFENSIVE changeAsset loop. Default on when `TRITON_PRIVATE_KEY` is set.
   * Env: `TRITON_UFLOAT_KEEPER_ENABLED=false` to disable.
   */
  ufloatKeeperEnabled?: boolean;
  /**
   * @deprecated Ignored — DEFENSIVE scan uses upkeep interval ({@link getUfloatKeeperUpkeepIntervalMs}).
   * Kept for backward-compatible overrides only.
   */
  ufloatStableEntryIntervalMs?: number;
  /** UFloat offensive-metrics loop interval (ms). */
  ufloatOffensiveIntervalMs?: number;
  /** When true, Triton auto-enters tokens from WETH (`tryOffensiveEntry` on LiquidStratMinV4 only). */
  tritonOffensiveEntryEnabled?: boolean;
  /** LiquidStratMinV4 price tick interval (ms). */
  tritonPriceCheckIntervalMs?: number;
  /** Legacy Triton pipeline harvest metadata — UFloatKeeper uses {@link getUfloatKeeperHarvestIntervalMs}. */
  harvestIntervalMs?: number;
  /** UFloat changeAsset throttle (ms). `0` = disabled. Not TRITON_CHANGE_STRATEGY_INTERVAL_MS. */
  ufloatChangeAssetCooldownMs?: number;
  /** Legacy Triton pipeline — not UFloat. Env: TRITON_CHANGE_STRATEGY_INTERVAL_MS. */
  changeStrategyIntervalMs?: number;
  /** Float V4 periodic defensive price/volume check interval (ms). */
  floatPriceCheckIntervalMs?: number;
  /** Float V4 periodic defensive m30 drop trigger (%). */
  priceDropThresholdPct?: number;
  minVolumeH12Usd?: number;
  minPoolLiquidityUsd?: number;
  minVolatilityH24Usd?: number;
  maxVolatilityH24Usd?: number;
  maxNegativePriceChangeH24Pct?: number;
  maxNegativePriceChangeM5M15M30Pct?: number;
  scheduledChangeMinWeightedScore?: number;
  offensiveMomentumMinM5Pct?: number;
  offensiveMomentumMaxM5Pct?: number;
  offensiveMomentumMinM15Pct?: number;
  offensiveMomentumMaxM15Pct?: number;
  offensiveMomentumMinM30Pct?: number;
  offensiveMomentumMaxM30Pct?: number;
  offensiveMomentumVolumeOverSpreadRatio?: number;
  offensiveMomentumExcludePriceChangeH24PctGte?: number;
  offensiveMomentumExcludePriceChangeH12PctGte?: number;
  marketBreadthNegativeH24FractionGte?: number;
  marketBreadthRequireCurrentAssetNegativeH24?: boolean;
  /**
   * When true (default), UFloat offensive-metrics requires top pick score ≥
   * {@link scheduledChangeMinWeightedScore}. When false, any top ranked pick can rotate.
   */
  ufloatApplyScheduledChangeMinWeightedScore?: boolean;
};

const OVERRIDES_PATH = path.join(process.cwd(), "app", "config", "triton.overrides.json");

export function loadTritonOverrides(): TritonOverrides {
  try {
    if (fs.existsSync(OVERRIDES_PATH)) {
      const raw = fs.readFileSync(OVERRIDES_PATH, "utf8");
      return JSON.parse(raw) as TritonOverrides;
    }
  } catch {
    // ignore
  }
  return {};
}

export function saveTritonOverrides(overrides: TritonOverrides): void {
  const current = loadTritonOverrides();
  const merged: TritonOverrides = { ...current, ...overrides };
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(merged, null, 2), "utf8");
}
