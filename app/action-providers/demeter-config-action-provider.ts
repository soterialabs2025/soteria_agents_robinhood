import { customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { getMergedConfig, saveOverrides, type ConfigOverrides } from "../config/demeter-config";
import {
  isCalibrationAutoApplyEnabled,
  CALIBRATION_TUNING_MIN_SAMPLES,
} from "../services/metric-calibration/calibration-config";
import { runMetricCalibrationTuning } from "../services/metric-calibration/calibration-tuner";

const METRIC_KEYS = [
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

/**
 * Demeter Config Action Provider
 * Allows the agent to read and update config via chat.
 */
export function demeterConfigActionProvider() {
  return customActionProvider([
    {
      name: "demeter_getConfig",
      description:
        "Get the current Demeter configuration (token ranking weights, min 12h volume, min pool liquidity (USD) for ranking, min and max 24h pool turnover ratio (pool h24 volume ÷ reserve or base+quote liq) for ranking, max negative 24h and m5/m15/m30/h1 pool price change for ranking, scheduled offensive momentum gates (min m5/m15/m30 % and volume vs spread), poll interval, harvest interval, change strategy interval, price check interval, price drop threshold). Use when the user asks to see or review config.",
      schema: z.object({}),
      invoke: async () => {
        try {
          const config = getMergedConfig();
          const metricRecord = (m: Record<string, { weight: number; description?: string }>) => {
            const out: Record<string, { weight: number; description: string }> = {};
            for (const k of Object.keys(m)) {
              const row = m[k];
              if (row && typeof row === "object" && "weight" in row) {
                out[k] = { weight: row.weight, description: row.description ?? "" };
              }
            }
            return out;
          };
          const tokenRankingMetrics = metricRecord(config.tokenRankingMetrics);
          const offensiveTokenRankingMetrics = metricRecord(config.offensiveTokenRankingMetrics);
          return JSON.stringify({
            success: true,
            config: {
              keeperAddress: config.keeperAddress,
              strategyIds: config.strategyIds,
              networkId: config.networkId,
              tokenRankingMetrics,
              offensiveTokenRankingMetrics,
              minVolumeH12Usd: config.minVolumeH12Usd,
              minPoolLiquidityUsd: config.minPoolLiquidityUsd,
              minVolatilityH24Usd: config.minVolatilityH24Usd,
              maxVolatilityH24Usd: config.maxVolatilityH24Usd,
              maxNegativePriceChangeH24Pct: config.maxNegativePriceChangeH24Pct,
              maxNegativePriceChangeM5M15M30Pct: config.maxNegativePriceChangeM5M15M30Pct,
              scheduledChangeMinWeightedScore: config.scheduledChangeMinWeightedScore,
              offensiveMomentumMinM5Pct: config.offensiveMomentumMinM5Pct,
              offensiveMomentumMaxM5Pct: config.offensiveMomentumMaxM5Pct,
              offensiveMomentumMinM15Pct: config.offensiveMomentumMinM15Pct,
              offensiveMomentumMaxM15Pct: config.offensiveMomentumMaxM15Pct,
              offensiveMomentumMinM30Pct: config.offensiveMomentumMinM30Pct,
              offensiveMomentumMaxM30Pct: config.offensiveMomentumMaxM30Pct,
              offensiveMomentumVolumeOverSpreadRatio: config.offensiveMomentumVolumeOverSpreadRatio,
              offensiveMomentumExcludePriceChangeH24PctGte: config.offensiveMomentumExcludePriceChangeH24PctGte,
              offensiveMomentumExcludePriceChangeH12PctGte: config.offensiveMomentumExcludePriceChangeH12PctGte,
              marketBreadthNegativeH24FractionGte: config.marketBreadthNegativeH24FractionGte,
              marketBreadthRequireCurrentAssetNegativeH24: config.marketBreadthRequireCurrentAssetNegativeH24,
              pollMs: config.pollMs,
              harvestIntervalMs: config.harvestIntervalMs,
              changeStrategyIntervalMs: config.changeStrategyIntervalMs,
              priceCheckIntervalMs: config.priceCheckIntervalMs,
              priceDropThresholdPct: config.priceDropThresholdPct,
            },
            note: "Restart the demeter-agent service for interval changes (pollMs, harvestIntervalMs, changeStrategyIntervalMs, priceCheckIntervalMs, etc.) to take effect in the loops.",
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error reading config",
          });
        }
      },
    },
    {
      name: "demeter_updateConfig",
      description:
        "Update Demeter configuration. Use when the user asks to change token ranking weights, min 12h volume, min pool liquidity (USD) for ranking, min/max 24h pool turnover ratio for ranking, max negative 24h or m5/m15/m30/h1 pool price change for ranking, scheduled offensive momentum bands (min/max m5/m15/m30 pool Δ%, volume acceleration ratio, exclude when 12h/24h up-move exceeds a %), intervals, or price drop threshold. Valid metric keys: volume_h1, volume_h6, volume_h12, buy_sell_ratio_h6, buy_sell_ratio_h24, price_change_h1, price_change_h6, price_change_h12, price_stability_h24, volatility_h6. Weights should sum to 1.0.",
      schema: z.object({
        tokenRankingMetrics: z
          .record(z.string(), z.object({ weight: z.number().min(0).max(1) }))
          .nullable()
          .optional()
          .describe("FloatStrategy metric weights to update (e.g. { price_change_h6: { weight: 0.35 } })"),
        offensiveTokenRankingMetrics: z
          .record(z.string(), z.object({ weight: z.number().min(0).max(1) }))
          .nullable()
          .optional()
          .describe("Scheduled Float offensive ranking metric weights (same keys as Float metrics)"),
        pollMs: z.number().positive().nullable().optional().describe("Float upkeep poll interval in milliseconds"),
        harvestIntervalMs: z.number().positive().nullable().optional().describe("Harvest interval in milliseconds"),
        changeStrategyIntervalMs: z.number().positive().nullable().optional().describe("FloatStrategy scheduled changeStrategyAsset interval in milliseconds"),
        priceCheckIntervalMs: z.number().positive().nullable().optional().describe("Float price check interval in milliseconds"),
        priceDropThresholdPct: z.number().nullable().optional().describe("Trigger change when m30 price change <= this (e.g. -10)"),
        minVolumeH12Usd: z.number().min(0).nullable().optional().describe("Minimum 12h volume (USD) for a token to be included in weighted ranking (e.g. 5000)"),
        minPoolLiquidityUsd: z
          .number()
          .min(0)
          .nullable()
          .optional()
          .describe("Minimum total token/WETH pool liquidity (USD) for weighted ranking eligibility (e.g. 250000)"),
        minVolatilityH24Usd: z
          .number()
          .nullable()
          .optional()
          .describe(
            "Minimum pool 24h turnover ratio (pool volume_usd.h24 ÷ USD liquidity; liquidity = reserve_in_usd when positive else base+quote). ≤0 disables."
          ),
        maxVolatilityH24Usd: z
          .number()
          .nullable()
          .optional()
          .describe(
            "Maximum pool 24h turnover ratio (same units as minVolatilityH24Usd). ≤0 disables the ceiling."
          ),
        maxNegativePriceChangeH24Pct: z.number().nullable().optional().describe("Exclude from ranking tokens with 24h price change <= this % (e.g. -7 excludes tokens down 7% or more)"),
        maxNegativePriceChangeM5M15M30Pct: z
          .number()
          .nullable()
          .optional()
          .describe(
            "Short m5/m15/m30/h1 gate (%): default Float ranking excludes only when all four are present and each <= this; scheduled offensive changeStrategy excludes if any present window <= this (0 = any non-positive move on a present window)"
          ),
        scheduledChangeMinWeightedScore: z
          .number()
          .min(0)
          .max(1)
          .nullable()
          .optional()
          .describe(
            "Scheduled Float changeStrategy: min offensive composite 0–1 for top actionable token; 0 disables (e.g. 0.55)"
          ),
        offensiveMomentumMinM5Pct: z
          .number()
          .min(-50)
          .max(50)
          .nullable()
          .optional()
          .describe("Scheduled offensive: m5 pool Δ% band floor when m5 is present (must be ≥ this)"),
        offensiveMomentumMaxM5Pct: z
          .number()
          .min(0)
          .max(500)
          .nullable()
          .optional()
          .describe("Scheduled offensive: m5 pool Δ% band ceiling when m5 is present; ≤0 disables"),
        offensiveMomentumMinM15Pct: z
          .number()
          .min(0)
          .max(100)
          .nullable()
          .optional()
          .describe("Scheduled offensive: m15 pool Δ% band floor (e.g. 0.06)"),
        offensiveMomentumMaxM15Pct: z
          .number()
          .min(0)
          .max(500)
          .nullable()
          .optional()
          .describe("Scheduled offensive: m15 pool Δ% band ceiling; ≤0 disables"),
        offensiveMomentumMinM30Pct: z
          .number()
          .min(0)
          .max(100)
          .nullable()
          .optional()
          .describe("Scheduled offensive: m30 pool Δ% band floor"),
        offensiveMomentumMaxM30Pct: z
          .number()
          .min(0)
          .max(500)
          .nullable()
          .optional()
          .describe("Scheduled offensive: m30 pool Δ% band ceiling; ≤0 disables"),
        offensiveMomentumVolumeOverSpreadRatio: z
          .number()
          .min(1)
          .max(20)
          .nullable()
          .optional()
          .describe(
            "Scheduled offensive: m15 and m30 pool USD volume each must be ≥ this × spread-implied rate from 12h volume (default ~1.2)"
          ),
        offensiveMomentumExcludePriceChangeH24PctGte: z
          .number()
          .min(0)
          .max(500)
          .nullable()
          .optional()
          .describe(
            "Scheduled offensive: exclude tokens whose 24h pool price Δ% is ≥ this (default 12; raise toward 500 to effectively disable)"
          ),
        offensiveMomentumExcludePriceChangeH12PctGte: z
          .number()
          .min(0)
          .max(500)
          .nullable()
          .optional()
          .describe(
            "Scheduled offensive: exclude tokens whose 12h pool price Δ% is ≥ this (default 10; raise toward 500 to effectively disable)"
          ),
        marketBreadthNegativeH24FractionGte: z
          .number()
          .min(0.5)
          .max(1)
          .nullable()
          .optional()
          .describe(
            "Cohort risk-off: min fraction (0.5–1) of tokens with finite 24h pool Δ% that must be negative to force stable rotation — V3: USDC, V4: WETH via exitStrategyToStable (default 0.9)"
          ),
        marketBreadthRequireCurrentAssetNegativeH24: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            "When true, stable rotation only if current strategy token’s 24h pool Δ% is negative; false = cohort fraction only (V3: USDC, V4: WETH exitStrategyToStable)"
          ),
        keeperAddress: z.string().nullable().optional().describe("FloatKeeper contract address"),
        strategyIds: z.string().nullable().optional().describe("Comma-separated keeper strategy indices (FloatStrategy; e.g. 0,1)"),
        networkId: z.string().nullable().optional().describe("Network ID (e.g. base-mainnet)"),
      }),
      invoke: async (
        _walletProvider,
        args: {
          tokenRankingMetrics?: Record<string, { weight: number }>;
          offensiveTokenRankingMetrics?: Record<string, { weight: number }>;
          pollMs?: number;
          harvestIntervalMs?: number;
          changeStrategyIntervalMs?: number;
          priceCheckIntervalMs?: number;
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
          keeperAddress?: string;
          strategyIds?: string;
          networkId?: string;
        }
      ) => {
        try {
          const overrides: ConfigOverrides = {};
          if (args.tokenRankingMetrics && Object.keys(args.tokenRankingMetrics).length > 0) {
            const validated: ConfigOverrides["tokenRankingMetrics"] = {};
            for (const k of Object.keys(args.tokenRankingMetrics)) {
              if (METRIC_KEYS.includes(k as (typeof METRIC_KEYS)[number])) {
                const w = args.tokenRankingMetrics[k]?.weight;
                if (typeof w === "number" && w >= 0 && w <= 1) {
                  validated[k as (typeof METRIC_KEYS)[number]] = { weight: w };
                }
              }
            }
            if (Object.keys(validated).length > 0) {
              overrides.tokenRankingMetrics = validated;
            }
          }
          if (args.offensiveTokenRankingMetrics && Object.keys(args.offensiveTokenRankingMetrics).length > 0) {
            const validated: ConfigOverrides["offensiveTokenRankingMetrics"] = {};
            for (const k of Object.keys(args.offensiveTokenRankingMetrics)) {
              if (METRIC_KEYS.includes(k as (typeof METRIC_KEYS)[number])) {
                const w = args.offensiveTokenRankingMetrics[k]?.weight;
                if (typeof w === "number" && w >= 0 && w <= 1) {
                  validated[k as (typeof METRIC_KEYS)[number]] = { weight: w };
                }
              }
            }
            if (Object.keys(validated).length > 0) {
              overrides.offensiveTokenRankingMetrics = validated;
            }
          }
          if (args.keeperAddress != null) overrides.keeperAddress = args.keeperAddress;
          if (args.strategyIds != null) overrides.strategyIds = args.strategyIds;
          if (args.networkId != null) overrides.networkId = args.networkId;
          if (args.pollMs != null) overrides.pollMs = args.pollMs;
          if (args.harvestIntervalMs != null) overrides.harvestIntervalMs = args.harvestIntervalMs;
          if (args.changeStrategyIntervalMs != null) overrides.changeStrategyIntervalMs = args.changeStrategyIntervalMs;
          if (args.priceCheckIntervalMs != null) overrides.priceCheckIntervalMs = args.priceCheckIntervalMs;
          if (args.priceDropThresholdPct != null) overrides.priceDropThresholdPct = args.priceDropThresholdPct;
          if (args.minVolumeH12Usd != null) overrides.minVolumeH12Usd = args.minVolumeH12Usd;
          if (args.minPoolLiquidityUsd != null) overrides.minPoolLiquidityUsd = args.minPoolLiquidityUsd;
          if (args.minVolatilityH24Usd != null) overrides.minVolatilityH24Usd = args.minVolatilityH24Usd;
          if (args.maxVolatilityH24Usd != null) overrides.maxVolatilityH24Usd = args.maxVolatilityH24Usd;
          if (args.maxNegativePriceChangeH24Pct != null) overrides.maxNegativePriceChangeH24Pct = args.maxNegativePriceChangeH24Pct;
          if (args.maxNegativePriceChangeM5M15M30Pct != null)
            overrides.maxNegativePriceChangeM5M15M30Pct = args.maxNegativePriceChangeM5M15M30Pct;
          if (args.scheduledChangeMinWeightedScore != null)
            overrides.scheduledChangeMinWeightedScore = args.scheduledChangeMinWeightedScore;
          if (args.offensiveMomentumMinM5Pct != null) overrides.offensiveMomentumMinM5Pct = args.offensiveMomentumMinM5Pct;
          if (args.offensiveMomentumMaxM5Pct != null) overrides.offensiveMomentumMaxM5Pct = args.offensiveMomentumMaxM5Pct;
          if (args.offensiveMomentumMinM15Pct != null)
            overrides.offensiveMomentumMinM15Pct = args.offensiveMomentumMinM15Pct;
          if (args.offensiveMomentumMaxM15Pct != null)
            overrides.offensiveMomentumMaxM15Pct = args.offensiveMomentumMaxM15Pct;
          if (args.offensiveMomentumMinM30Pct != null)
            overrides.offensiveMomentumMinM30Pct = args.offensiveMomentumMinM30Pct;
          if (args.offensiveMomentumMaxM30Pct != null)
            overrides.offensiveMomentumMaxM30Pct = args.offensiveMomentumMaxM30Pct;
          if (args.offensiveMomentumVolumeOverSpreadRatio != null)
            overrides.offensiveMomentumVolumeOverSpreadRatio = args.offensiveMomentumVolumeOverSpreadRatio;
          if (args.offensiveMomentumExcludePriceChangeH24PctGte != null)
            overrides.offensiveMomentumExcludePriceChangeH24PctGte = args.offensiveMomentumExcludePriceChangeH24PctGte;
          if (args.offensiveMomentumExcludePriceChangeH12PctGte != null)
            overrides.offensiveMomentumExcludePriceChangeH12PctGte = args.offensiveMomentumExcludePriceChangeH12PctGte;
          if (args.marketBreadthNegativeH24FractionGte != null)
            overrides.marketBreadthNegativeH24FractionGte = args.marketBreadthNegativeH24FractionGte;
          if (args.marketBreadthRequireCurrentAssetNegativeH24 != null)
            overrides.marketBreadthRequireCurrentAssetNegativeH24 = args.marketBreadthRequireCurrentAssetNegativeH24;

          if (Object.keys(overrides).length === 0) {
            return JSON.stringify({
              success: false,
              error: "No valid updates provided. Check metric keys and values.",
            });
          }

          saveOverrides(overrides);
          return JSON.stringify({
            success: true,
            message: "Config updated. Token ranking changes apply immediately. Restart demeter-agent for interval changes.",
            updated: overrides,
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error updating config",
          });
        }
      },
    },
    {
      name: "demeter_getCalibrationReport",
      description:
        "Analyze metric calibration data (6h forward-return winners in optimal.jsonl) and return proposed config changes for Float V3 (config.overrides.json) and Float V4 (triton.overrides.json). Does not write overrides. Use when reviewing auto-tuning or before applying calibration updates.",
      schema: z.object({}),
      invoke: async () => {
        try {
          const report = await runMetricCalibrationTuning({ apply: false, pruneAfter: false });
          return JSON.stringify({
            success: true,
            report,
            note:
              `Report-only. ${CALIBRATION_TUNING_MIN_SAMPLES}+ optimal rows required to apply. ` +
              "Use demeter_runMetricCalibration with apply=true and CALIBRATION_AUTO_APPLY=1 to write overrides.",
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error running calibration report",
          });
        }
      },
    },
    {
      name: "demeter_runMetricCalibration",
      description:
        "Run the 3-day metric calibration analyzer and optionally apply bounded changes to offensive ranking weights and eligibility thresholds. Requires CALIBRATION_AUTO_APPLY=1 env var when apply=true.",
      schema: z.object({
        apply: z
          .boolean()
          .optional()
          .describe("When true, write config.overrides.json / triton.overrides.json if CALIBRATION_AUTO_APPLY=1 and enough samples exist"),
      }),
      invoke: async (_walletProvider, args: { apply?: boolean }) => {
        try {
          const apply = args.apply === true;
          const report = await runMetricCalibrationTuning({ apply, pruneAfter: true });
          return JSON.stringify({
            success: true,
            applied: report.applied,
            applySkippedReason: report.applySkippedReason,
            autoApplyEnabled: isCalibrationAutoApplyEnabled(),
            report,
            note: report.applied
              ? "Overrides written. Ranking thresholds apply on next loop read."
              : apply
                ? `Not applied: ${report.applySkippedReason ?? "no changes"}`
                : "Report only (apply=false).",
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error running calibration",
          });
        }
      },
    },
  ]);
}
