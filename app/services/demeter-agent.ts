/**
 * Demeter Agent Service
 *
 * This is the main service that runs Demeter, the AI agent for managing
 * FloatStrategy Uniswap V3 concentrated liquidity positions.
 *
 * It replaces the simple bot logic from index.js with AI-powered decision making.
 *
 * Run with --coingecko to fetch token data via coingecko_getTokenData and exit.
 */

import { EvmWalletProvider } from "@coinbase/agentkit";
import type { Address } from "viem";
import { getWalletProvider, initDemeterWalletProvider } from "../api/agent/create-agent";
import { prepareAgentkitAndWalletProvider } from "../api/agent/prepare-agentkit";
import { fetchTokenData, fetchTokenComparison } from "../action-providers/coingecko-action-provider";
import {
  getStrategyMode,
  KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS,
  executeKeeperHarvestWithConfirmation,
  executeKeeperHarvestWithConfirmationFromPrivateKey,
  getKeeperStrategyHarvestTimestamps,
  sendKeeperPerformUpkeep,
  sendKeeperPerformUpkeepBatch,
  sendKeeperPerformUpkeepBatchFromPrivateKey,
  sendKeeperPerformUpkeepFromPrivateKey,
  sendKeeperSnapshotVaultPoolValue,
} from "../action-providers/keeper-strategy-action-provider";
import {
  getFloatAssetAddress,
  getFloatPoolValue,
  getLastHarvestTimestamp,
  sendChangeStrategyAsset,
} from "../action-providers/float-action-provider";
import {
  defensiveStableChosenToken,
  isBlockedV4ChangeStrategyTokenAddress,
  shouldRunFloatV4MarketBreadthStableExit,
  shouldSkipPeriodicDefensivePoolFetch,
  tryFloatDefensiveStableParkWhenNoPick,
  tryFloatV4MarketBreadthStableExit,
} from "./float-market-breadth-stable";
import { FLOAT_STRATEGY_STABLE_MODE, STABLE_V4_WETH_ADDRESS } from "../config/demeter-config";
import { getRpcUrlOptional, WETH_ADDRESS } from "../config/chain-config";
import {
  buildFloatKeeperPipelines,
  sleepFloatPipelineStagger,
  FLOAT_STRATEGY_OFFENSIVE_MODE,
  formatFloatChangeStrategyLogTag,
  formatFloatPipelineLoopRunLog,
  formatFloatPipelineLoopSkipLog,
  isAnyFloatPipelineStrategyOffensive,
  shouldLogFloatPipelineLoopSkip,
  tickFloatPipelineLoopGate,
  type FloatKeeperPipeline,
} from "../config/float-keeper-pipeline";
import {
  getCombinedHarvestIntervalMs,
  getPipelineLoopThresholds,
} from "../config/ranking-eligibility";
import {
  getFloatPipelineStaggerMs,
  getMergedConfig,
  getOffensiveTokenRankingMetrics,
  getTopActionableOffensiveScore,
  passesChangeStrategyVolatilityH24Band,
  isStableUsdcTokenAddress,
  isFloatV4RunEveryNLoopsGateEnabled,
  buySellBuyPressureScore,
  pickStrongestBuyPressureCandidate,
  DEFAULT_POLL_MS,
  formatChangeStrategyIntervalForLog,
  type TokenRankingMetricsMap,
} from "../config/demeter-config";
import { getDemeterTxGasHeadroomBps, getTxMinGasLimit } from "../config/demeter-tx-gas";
import { getOperatorRegistryAddress } from "../config/operator-registry-config";
import {
  enqueueDemeterOperatorTx,
  getDemeterOperatorWalletIds,
  getDemeterWalletForStrategyId,
  isDemeterOperatorShardingEnabled,
  resolveDemeterOperatorWallets,
} from "./demeter-operator-pool";
import { groupStrategyIdsByShard } from "./operator-shard";
import { assertOperatorWalletsRegistered } from "./operator-registry";
import {
  checkDemeterStopSignal,
  clearDemeterStopSignal,
  sleepWithStopCheck,
} from "../config/demeter-stop";
import {
  appendDemeterDefensiveOffensiveLog,
  buildOldTokenEntry,
  ensureDemeterDefensiveOffensiveLogFile,
  formatDemeterLogTimestamps,
  getDemeterDefensiveOffensiveLogPath,
  type DemeterChangeStrategyAuditContext,
  type DemeterChosenTokenMetrics,
  weightedCompositeScoreForSymbol,
  type WeightedRankingRowForLog,
} from "./demeter-defensive-offensive-log";
import {
  buildMetricCalibrationFields,
  buildTokenCalibrationMetrics,
} from "./metric-calibration/calibration-snapshots";
import { shouldRecordCalibrationEvent } from "./metric-calibration/calibration-candidates";
import { ensureMetricCalibrationLogDir } from "./metric-calibration/calibration-log";
import { metricCalibrationLoop } from "./metric-calibration/calibration-loop";
import { metricCalibrationTuningLoop } from "./metric-calibration/calibration-tuning-loop";
import { appendDemeterPoolValueLog } from "./demeter-pool-value-log";
import {
  areDemeterLoopsEnabled,
  demeterLoopsDisabledMessage,
  loadDemeterEnv,
} from "../config/demeter-loops";
import { isAutoKeeperEnabled } from "../config/auto-keeper-config";
import {
  isLiquidStratMinV4LoopEnabled,
  isUfloatKeeperEnabled,
} from "../config/triton-config";
import { autoKeeperLoop } from "./auto-keeper-loop";
import { tritonLiquidLoop } from "./triton-liquid-loop";
import { ufloatKeeperLoop } from "./ufloat-keeper-loop";
import { resolveUfloatTxWallets } from "./ufloat-wallet-pool";

loadDemeterEnv();

/** Min 1 minute. Default 1 hour. Override: DEMETER_POOL_VALUE_LOG_INTERVAL_MS */
const POOL_VALUE_LOG_INTERVAL_MS = (() => {
  const raw = process.env.DEMETER_POOL_VALUE_LOG_INTERVAL_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 60_000) return n;
  }
  return 60 * 60 * 1000;
})();

function buildChosenMetrics(
  chosen: {
    buy_sell_ratio_h6: number | null;
    buy_sell_ratio_h24: number | null;
    symbol: string;
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

const isCoingeckoMode = process.argv.includes("--coingecko");
const isCompareMode = process.argv.includes("--compare");

// Configuration from demeter-config (edit app/config/demeter-config.ts or use chat)
const RPC_URL = getRpcUrlOptional();
const FLOAT_PIPELINES: FloatKeeperPipeline[] = isCoingeckoMode ? [] : buildFloatKeeperPipelines();
// WETH on Robinhood Chain – never select as strategy asset; contract's WETH path fails gas estimation
const WETH_BASE = WETH_ADDRESS;

function hasActiveNonFloatKeeperLoops(): boolean {
  return (
    isUfloatKeeperEnabled() || isLiquidStratMinV4LoopEnabled() || isAutoKeeperEnabled()
  );
}

if (!isCoingeckoMode && FLOAT_PIPELINES.length === 0 && !hasActiveNonFloatKeeperLoops()) {
  throw new Error(
    "No keeper loops enabled. For UFloat-only: set TRITON_PRIVATE_KEY (and optional TRITON_TWO_PRIVATE_KEY), " +
      "TRITON_UFLOAT_KEEPER_ENABLED=true, empty strategyIds/floatV4StrategyIds in config.overrides.json. " +
      "For AutoKeeper: set AUTO_KEEPER_ENABLED=true and DEMETER_TWO_PRIVATE_KEY."
  );
}

const { pollMs } = getMergedConfig();
const harvestIntervalMs = getCombinedHarvestIntervalMs(FLOAT_PIPELINES.map((p) => p.id));

/** Strategy mode: 0=NORMAL, 1=DEFENSIVE, 2=OFFENSIVE, 3=NEUTRAL, 4=STABLE */
const DEFENSIVE_MODE = 1;
const OFFENSIVE_MODE = FLOAT_STRATEGY_OFFENSIVE_MODE;
const NEUTRAL_MODE = 3;
const STABLE_MODE = FLOAT_STRATEGY_STABLE_MODE;

function floatComparisonFetchOptions(audit: DemeterChangeStrategyAuditContext | null | undefined): {
  forceMarketBreadthStable?: boolean;
  disableMarketBreadth?: boolean;
} {
  return {
    forceMarketBreadthStable: audit?.trigger === "DEFENSIVE",
    disableMarketBreadth: audit?.trigger === "STABLE",
  };
}

async function readFloatStrategyMode(
  pipeline: FloatKeeperPipeline,
  strategyId: number
): Promise<number | null> {
  if (!RPC_URL || !pipeline.keeperAddress) return null;
  try {
    return await getStrategyMode(pipeline.keeperAddress, strategyId, RPC_URL, pipeline.id);
  } catch (e) {
    console.warn(`[Demeter] [${pipeline.label}] Could not read strategy ${strategyId} mode:`, e);
    return null;
  }
}

async function runFloatDefaultMetricsChangeStrategy(
  pipeline: FloatKeeperPipeline,
  trigger: "DEFENSIVE" | "STABLE",
  strategyId?: number
): Promise<ChangeStrategyResult | undefined> {
  let currentAsset: string | null = null;
  try {
    currentAsset = await getFloatAssetAddress(
      pipeline.contractManagerAddress,
      RPC_URL!,
      pipeline.strategyRegistryKey
    );
  } catch (e) {
    console.warn(`[Demeter] [${pipeline.label}] Could not fetch current asset:`, e);
  }
  return withDemeterWalletExclusive(() =>
    executeChangeStrategy(
      currentAsset,
      true,
      {
        trigger,
        strategyId,
        keeperPipeline: pipeline.auditKeeperPipeline,
      },
      undefined,
      undefined,
      pipeline
    )
  );
}

async function isAnyFloatStrategyOffensive(pipeline: FloatKeeperPipeline): Promise<boolean> {
  return isAnyFloatPipelineStrategyOffensive(pipeline, RPC_URL ?? "");
}

/** Last FloatKeeper.snapshotVaultPoolValue submission (ms); throttled in upkeep loop. */
let lastKeeperSnapshotVaultPoolValueAtMs = 0;

/**
 * Serialized **wallet-facing** Demeter steps across parallel loops (upkeep / float periodic / harvest).
 * One logical unit finishes (including confirmations / retries inside the callback) before the next runs.
 */
let demeterWalletWorkChain: Promise<void> = Promise.resolve();

function withDemeterWalletExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = demeterWalletWorkChain.then(fn);
  demeterWalletWorkChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Fetch and display token data (tokens + pools with price_change_percentage, liquidity, volume, etc).
 * With --compare: also runs weighted ranking and returns full comparison.
 */
async function runCoingeckoTokenData() {
  if (isCompareMode) {
    console.log("[Demeter] Fetching token comparison with weighted ranking...\n");
    const data = await fetchTokenComparison();
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log("[Demeter] Fetching token data (coingecko_getTokenData)...\n");
    const data = await fetchTokenData();
    console.log(JSON.stringify(data, null, 2));
  }
  console.log("\n[Demeter] Done.");
}

/**
 * Main upkeep loop - calls performUpkeep (single) or performUpkeepBatch (multiple).
 * FloatKeeper.snapshotVaultPoolValue when {@link KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS} is finite (currently disabled).
 * Snapshot, performUpkeep, and defensive `executeChangeStrategy` run under {@link withDemeterWalletExclusive} so they queue behind harvest / float periodic strategy changes.
 * If strategy is DEFENSIVE after upkeep, runs fetchTokenComparison → top ranked → float_changeStrategyAsset; no pick → park stable.
 * If strategy is STABLE after upkeep, runs the same default-metrics comparison as DEFENSIVE for alt re-entry (upkeep loop only — not periodic m30/volume).
 * OFFENSIVE (mode {@link OFFENSIVE_MODE}) never triggers change from this loop; `executeChangeStrategy` also refuses when any strategy is OFFENSIVE.
 * FloatKeeper id = 0-based index into watched[].
 */
async function upkeepLoop(pipeline: FloatKeeperPipeline) {
  const { strategyIds, keeperAddress, contractManagerAddress } = pipeline;
  const runEvery = pipeline.runEveryNLoops ?? 1;
  console.log(
    `[Demeter] Starting ${pipeline.label} upkeep loop — keeper ${keeperAddress}, ids [${strategyIds.join(", ") || "none"}], polling every ${pollMs}ms` +
      (runEvery > 1
        ? `, performUpkeep every ${runEvery} upkeep wakes (~${(runEvery * pollMs) / 60000} min at ${pollMs / 1000}s poll; FLOAT_V4_RUN_EVERY_N_LOOPS=1 for every wake)`
        : "")
  );

  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log(`[Demeter] [${pipeline.label}] Stop signal received, exiting upkeep loop`);
      return;
    }

    const upkeepGate = tickFloatPipelineLoopGate(pipeline, "upkeep");
    if (!upkeepGate.shouldRun) {
      if (shouldLogFloatPipelineLoopSkip(upkeepGate.loopNumber, upkeepGate.runEvery)) {
        console.log(
          formatFloatPipelineLoopSkipLog(
            pipeline,
            "upkeep",
            upkeepGate.loopNumber,
            upkeepGate.runEvery
          )
        );
      }
      await sleepWithStopCheck(pollMs);
      continue;
    }
    console.log(
      formatFloatPipelineLoopRunLog(pipeline, "upkeep", upkeepGate.loopNumber, upkeepGate.runEvery)
    );

    await sleepFloatPipelineStagger(
      pipeline.id,
      FLOAT_PIPELINES.map((p) => p.id),
      sleepWithStopCheck
    );

    try {
      await withDemeterWalletExclusive(async () => {
        const wpSnap = getWalletProvider();
        if (
          wpSnap instanceof EvmWalletProvider &&
          keeperAddress &&
          Date.now() - lastKeeperSnapshotVaultPoolValueAtMs >= KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS
        ) {
          try {
            const snapTx = await sendKeeperSnapshotVaultPoolValue(wpSnap, keeperAddress, pipeline.id);
            lastKeeperSnapshotVaultPoolValueAtMs = Date.now();
            console.log(
              `[Demeter] [${pipeline.label}] snapshotVaultPoolValue tx:`,
              snapTx,
              "https://robinhoodchain.blockscout.com/tx/" + snapTx
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[Demeter] [${pipeline.label}] snapshotVaultPoolValue failed:`, msg);
          }
        }
      });

      if (strategyIds.length > 0 && keeperAddress) {
        if (isDemeterOperatorShardingEnabled() && RPC_URL) {
          const walletIds = getDemeterOperatorWalletIds();
          const groups = groupStrategyIdsByShard(strategyIds, walletIds);
          await Promise.all(
            resolveDemeterOperatorWallets().map(async (wallet) => {
              const shardIds = groups.get(wallet.id) ?? [];
              if (shardIds.length === 0) return;
              const upkeepTx = await enqueueDemeterOperatorTx(wallet.id, () =>
                shardIds.length > 1
                  ? sendKeeperPerformUpkeepBatchFromPrivateKey(
                      wallet.privateKey,
                      keeperAddress,
                      shardIds,
                      pipeline.id,
                      RPC_URL
                    )
                  : sendKeeperPerformUpkeepFromPrivateKey(
                      wallet.privateKey,
                      keeperAddress,
                      shardIds[0]!,
                      pipeline.id,
                      RPC_URL
                    )
              );
              console.log(
                `[Demeter] [${pipeline.label}] [${wallet.id}] Upkeep (ids ${shardIds.join(", ")}) tx ${upkeepTx} https://robinhoodchain.blockscout.com/tx/${upkeepTx}`
              );
            })
          );
        } else {
          await withDemeterWalletExclusive(async () => {
            const wp = getWalletProvider();
            if (!(wp instanceof EvmWalletProvider)) {
              console.error(`[Demeter] [${pipeline.label}] Upkeep skipped: wallet provider not EVM`);
              return;
            }

            const upkeepTx =
              strategyIds.length > 1
                ? await sendKeeperPerformUpkeepBatch(wp, keeperAddress, strategyIds, pipeline.id)
                : await sendKeeperPerformUpkeep(wp, keeperAddress, strategyIds[0]!, pipeline.id);

            console.log(
              `[Demeter] [${pipeline.label}] Upkeep (ids ${strategyIds.join(", ")}) tx ${upkeepTx} https://robinhoodchain.blockscout.com/tx/${upkeepTx}`
            );
          });
        }
      }

      if (RPC_URL && keeperAddress && strategyIds.length > 0) {
        await new Promise((r) => setTimeout(r, 8000));
        let postUpkeepTrigger: "DEFENSIVE" | "STABLE" | null = null;
        let postUpkeepStrategyId: number | undefined;
        for (const id of strategyIds) {
          const mode = await readFloatStrategyMode(pipeline, id);
          if (mode === DEFENSIVE_MODE) {
            postUpkeepTrigger = "DEFENSIVE";
            postUpkeepStrategyId = id;
            console.log(
              `[Demeter] [${pipeline.label}] strategy ${id} DEFENSIVE — token comparison for asset change` +
                (pipeline.id === "v4"
                  ? " (V4 universe + default ranking metrics, not offensive momentum)"
                  : "")
            );
            break;
          }
          if (mode === STABLE_MODE) {
            postUpkeepTrigger = "STABLE";
            postUpkeepStrategyId = id;
            console.log(
              `[Demeter] [${pipeline.label}] strategy ${id} STABLE — default-metrics re-entry scan` +
                (pipeline.id === "v4"
                  ? " (V4 universe + default ranking metrics, not offensive momentum)"
                  : "")
            );
            break;
          }
        }
        if (postUpkeepTrigger) {
          await runFloatDefaultMetricsChangeStrategy(
            pipeline,
            postUpkeepTrigger,
            postUpkeepStrategyId
          );
        }
      }
    } catch (error) {
      console.error(`[Demeter] [${pipeline.label}] Upkeep loop error:`, error);
    }

    await sleepWithStopCheck(pollMs);
  }
}

/**
 * Sleep until keeper watched strategy `lastHarvest` + per-pipeline harvestIntervalMs.
 * Uses {@link getKeeperStrategyHarvestTimestamps} (not manager registry alone) so pacing matches `performHarvest` target.
 * Also enforces at least {@link harvestIntervalMs} wall time since `previousHarvestBatchCompletedAtMs` when set.
 */
async function sleepAlignedToFloatStrategyLastHarvest(
  verboseStartup: boolean,
  previousHarvestBatchCompletedAtMs?: number | null
): Promise<boolean> {
  if (!RPC_URL || FLOAT_PIPELINES.length === 0) {
    await sleepWithStopCheck(harvestIntervalMs);
    return !checkDemeterStopSignal();
  }
  try {
    let waitMs = harvestIntervalMs;
    for (const pipeline of FLOAT_PIPELINES) {
      const pipelineHarvestMs = getPipelineLoopThresholds(pipeline.id).harvestIntervalMs;
      for (const strategyId of pipeline.strategyIds) {
        const ts = await getKeeperStrategyHarvestTimestamps(
          pipeline.keeperAddress,
          strategyId,
          RPC_URL,
          pipeline.strategyRegistryKey,
          pipeline.id
        );
        const anchorSec = Math.max(ts.lastHarvest, ts.prevHarvestTime);
        const dueAtMs = anchorSec * 1000 + pipelineHarvestMs;
        waitMs = Math.min(waitMs, Math.max(0, dueAtMs - Date.now()));
      }
    }
    if (!verboseStartup && previousHarvestBatchCompletedAtMs != null) {
      const wallRemainMs = Math.max(
        0,
        harvestIntervalMs - (Date.now() - previousHarvestBatchCompletedAtMs)
      );
      if (wallRemainMs > waitMs) {
        console.log(
          `[Demeter] Harvest spacing: extra wait ${Math.round(wallRemainMs / 60000)} min (${Math.round(harvestIntervalMs / 60000)} min wall-clock since previous batch end; avoids immediate re-harvest when chain read lags)`
        );
      }
      waitMs = Math.max(waitMs, wallRemainMs);
    }
    if (verboseStartup) {
      console.log(
        `[Demeter] Float harvest pacing (${FLOAT_PIPELINES.length} pipeline(s)): next wake in ${Math.round(waitMs / 60000)} min`
      );
    } else if (waitMs > 60_000) {
      console.log(
        `[Demeter] Harvest pacing from lastHarvest: sleep ${Math.round(waitMs / 60000)} min until next due window`
      );
    }
    await sleepWithStopCheck(waitMs);
    return !checkDemeterStopSignal();
  } catch (e) {
    console.warn("[Demeter] Could not read FloatStrategy.lastHarvest for harvest pacing, using fixed interval:", e);
    await sleepWithStopCheck(harvestIntervalMs);
    return !checkDemeterStopSignal();
  }
}

/**
 * Harvest loop - calls performHarvest with skipIncreaseLiquidity=false (compound fees).
 * Pacing uses FloatStrategy.lastHarvest + harvestIntervalMs plus a **wall-clock floor** so two harvest batches are never closer than `harvestIntervalMs` (guards RPC lag / mismatched manager vs keeper strategy reads).
 * Submits performHarvest via wallet directly; confirms via on-chain lastHarvest / PrevHarvestTime (see retries).
 */
async function harvestLoop() {
  console.log(
    `[Demeter] Starting harvest loop — interval ${harvestIntervalMs / 1000 / 60} min from FloatStrategy.lastHarvest`
  );

  if (!(await sleepAlignedToFloatStrategyLastHarvest(true))) {
    console.log("[Demeter] Stop signal received, exiting harvest loop");
    return;
  }

  /** Wall-clock anchor for spacing harvest batches (see {@link sleepAlignedToFloatStrategyLastHarvest}). */
  let previousHarvestBatchCompletedAtMs = Date.now();

  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[Demeter] Stop signal received, exiting harvest loop");
      return;
    }
    try {
      console.log("[Demeter] Starting harvest cycle for all Float pipelines");
      let harvestBatchHadSuccess = false;

      const activePipelineIds = FLOAT_PIPELINES.map((p) => p.id);
      for (const pipeline of FLOAT_PIPELINES) {
        await sleepFloatPipelineStagger(pipeline.id, activePipelineIds, sleepWithStopCheck);
        for (const strategyId of pipeline.strategyIds) {
        for (;;) {
          if (checkDemeterStopSignal()) {
            console.log("[Demeter] Stop signal received, exiting harvest loop");
            return;
          }
          try {
            const result = isDemeterOperatorShardingEnabled() && RPC_URL
              ? await enqueueDemeterOperatorTx(
                  getDemeterWalletForStrategyId(strategyId).id,
                  () => {
                    const opWallet = getDemeterWalletForStrategyId(strategyId);
                    return executeKeeperHarvestWithConfirmationFromPrivateKey(
                      opWallet.privateKey,
                      pipeline.keeperAddress,
                      strategyId,
                      RPC_URL,
                      pipeline.strategyRegistryKey,
                      pipeline.id,
                      false
                    );
                  }
                )
              : await withDemeterWalletExclusive(() => {
                  const wp = getWalletProvider();
                  if (!(wp instanceof EvmWalletProvider)) {
                    throw new Error("Wallet provider not available or not EVM");
                  }
                  if (!RPC_URL) {
                    throw new Error("RPC_URL required for harvest confirmation");
                  }
                  return executeKeeperHarvestWithConfirmation(
                    wp,
                    pipeline.keeperAddress,
                    strategyId,
                    RPC_URL,
                    pipeline.strategyRegistryKey,
                    pipeline.id,
                    false
                  );
                });

            if (result.ok) {
              harvestBatchHadSuccess = true;
              const signal =
                result.harvestSignal != null ? ` signal=${result.harvestSignal}` : "";
              const lhNote =
                result.harvestSignal === "lastHarvest"
                  ? ` lastHarvest ${result.baselineLastHarvest} → ${result.lastHarvest}`
                  : result.harvestSignal === "uniswapFees" ||
                      result.harvestSignal === "keeperDidAct"
                    ? ` (lastHarvest unchanged at ${result.lastHarvest}; V4 harvest via ${result.harvestSignal})`
                    : ` lastHarvest ${result.baselineLastHarvest} → ${result.lastHarvest}`;
              console.log(
                `[Demeter] [${pipeline.label}] Strategy ${strategyId} harvest ok — tx ${result.txHash} strategy ${result.strategyAddress}${lhNote}${signal} https://robinhoodchain.blockscout.com/tx/${result.txHash}`
              );
              await new Promise((r) => setTimeout(r, 1000));
              break;
            }

            if (result.v4SkipRapidHarvestRetry) {
              console.warn(
                `[Demeter] [${pipeline.label}] Strategy ${strategyId} harvest — skipping 1m retries (next batch not wall-locked 6h): ${result.reason}`
              );
              break;
            }

            const detail =
              result.txHash != null
                ? `tx ${result.txHash} status=${result.receiptStatus ?? "n/a"} strategy=${result.strategyAddress ?? "?"} lastHarvest=${result.lastHarvest ?? "?"} (baseline ${result.baselineLastHarvest ?? "?"})`
                : "no tx";
            console.warn(
              `[Demeter] [${pipeline.label}] Strategy ${strategyId} harvest failed: ${result.reason} (${detail}) — retry in ${HARVEST_TX_RETRY_MS / 1000 / 60} min`
            );
            await sleepWithStopCheck(HARVEST_TX_RETRY_MS);
          } catch (error) {
            console.error(`[Demeter] [${pipeline.label}] Strategy ${strategyId} harvest error:`, error);
            await sleepWithStopCheck(HARVEST_TX_RETRY_MS);
          }
        }
        }
      }

      if (harvestBatchHadSuccess) {
        previousHarvestBatchCompletedAtMs = Date.now();
      }
      const wallAnchorMs = harvestBatchHadSuccess ? previousHarvestBatchCompletedAtMs : null;
      if (!(await sleepAlignedToFloatStrategyLastHarvest(false, wallAnchorMs))) {
        console.log("[Demeter] Stop signal received, exiting harvest loop");
        return;
      }
      if (!harvestBatchHadSuccess) {
        console.warn(
          `[Demeter] Harvest batch: no strategy succeeded — ${HARVEST_FAILED_BATCH_BACKOFF_MS / 60_000} min backoff (chain pacing only; no 6h wall-clock lock)`
        );
        await sleepWithStopCheck(HARVEST_FAILED_BATCH_BACKOFF_MS);
      }
    } catch (error) {
      console.error("[Demeter] Harvest loop error:", error);
      if (!(await sleepAlignedToFloatStrategyLastHarvest(false, previousHarvestBatchCompletedAtMs))) {
        console.log("[Demeter] Stop signal received, exiting harvest loop");
        return;
      }
    }
  }
}

const TOP_N_FOR_PRICE_PICK = 3;

/** Delay between retries when `changeStrategyAsset` submission fails (e.g. gas estimation). */
const CHANGE_STRATEGY_TX_RETRY_MS = 30_000; // 30 seconds

/** Delay between harvest retries when the on-chain tx did not update harvest timestamps. */
const HARVEST_TX_RETRY_MS = 60_000;

/** When a full harvest batch fails, avoid locking the loop for 6h via wall-clock spacing. */
const HARVEST_FAILED_BATCH_BACKOFF_MS = 15 * 60 * 1000;

/** Maximum number of `changeStrategyAsset` attempts per chosen token before trying the next ranked candidate. */
const CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN = 5;

type ChangeStrategyResult =
  | { outcome: "success"; address: string; marketBreadthDefensiveActive?: boolean }
  | { outcome: "skipped"; reason: string; marketBreadthDefensiveActive?: boolean }
  | { outcome: "failed"; error: string; marketBreadthDefensiveActive?: boolean };

function marketBreadthDefensiveActiveFromComparison(comparison: unknown): boolean {
  return (
    comparison != null &&
    typeof comparison === "object" &&
    (comparison as { market_breadth_defensive_active?: unknown }).market_breadth_defensive_active === true
  );
}

type DefensiveStableParkLogMode = (entry: {
  changeStrategyTransaction: string | null;
  topThreeTokens: Array<{ symbol: string; address: string }>;
  oldToken: { address: string; symbol: string | null };
  chosenToken: { symbol: string; address: string } | null;
  chosenTokenMetrics?: DemeterChosenTokenMetrics | null;
  changeSummary?: string | null;
  outcome: "success" | "skipped" | "failed";
  details?: string;
}) => Promise<void>;

/**
 * DEFENSIVE upkeep pass: no qualifying alt token → park V3 (USDC) or V4 (WETH via exitStrategyToStable).
 */
async function parkFloatDefensiveToStableOnNoPick(
  pipeline: FloatKeeperPipeline,
  oldToken: { address: string; symbol: string | null },
  logMode: DefensiveStableParkLogMode,
  noPickDetails: string,
  marketBreadthDefensiveActive: boolean
): Promise<ChangeStrategyResult> {
  const stableChosen = defensiveStableChosenToken(pipeline.strategyRegistryKey);
  const logTag = formatFloatChangeStrategyLogTag(pipeline);
  const parkDetails = `${noPickDetails}; parking DEFENSIVE to ${stableChosen.symbol}`;

  const rpcUrl = getRpcUrlOptional();
  const wp = getWalletProvider();
  if (!rpcUrl) {
    await logMode({
      changeStrategyTransaction: null,
      topThreeTokens: [stableChosen],
      oldToken,
      chosenToken: stableChosen,
      chosenTokenMetrics: null,
      changeSummary: buildChangeSummary(oldToken, stableChosen),
      outcome: "failed",
      details: "RPC_URL is not set",
    });
    return { outcome: "failed", error: "RPC_URL is not set", marketBreadthDefensiveActive };
  }
  if (!wp || !(wp instanceof EvmWalletProvider)) {
    await logMode({
      changeStrategyTransaction: null,
      topThreeTokens: [stableChosen],
      oldToken,
      chosenToken: stableChosen,
      chosenTokenMetrics: null,
      changeSummary: buildChangeSummary(oldToken, stableChosen),
      outcome: "failed",
      details: "Wallet provider not available or not EVM",
    });
    return {
      outcome: "failed",
      error: "Wallet provider not available or not EVM",
      marketBreadthDefensiveActive,
    };
  }

  const onChainLabel =
    pipeline.strategyRegistryKey === "FloatStrategyV4" ? "exitStrategyToStable" : "changeStrategyAsset(USDC)";
  console.log(`[Demeter] ${logTag} DEFENSIVE no qualifying alt — ${onChainLabel}`);

  for (;;) {
    if (checkDemeterStopSignal()) {
      return {
        outcome: "failed",
        error: `stop signal during ${onChainLabel} retry`,
        marketBreadthDefensiveActive,
      };
    }

    const stableResult = await tryFloatDefensiveStableParkWhenNoPick(wp, pipeline, rpcUrl);
    if (stableResult.kind === "skipped") {
      await logMode({
        changeStrategyTransaction: null,
        topThreeTokens: [stableChosen],
        oldToken,
        chosenToken: stableChosen,
        chosenTokenMetrics: null,
        changeSummary: buildChangeSummary(oldToken, stableChosen),
        outcome: "skipped",
        details: `${parkDetails}; ${stableResult.reason}`,
      });
      return {
        outcome: "skipped",
        reason: stableResult.reason,
        marketBreadthDefensiveActive,
      };
    }
    if (stableResult.kind === "sent") {
      console.log(
        `[Demeter] ${logTag} ${onChainLabel} tx ${stableResult.txHash} https://robinhoodchain.blockscout.com/tx/${stableResult.txHash}`
      );
      await logMode({
        changeStrategyTransaction: stableResult.txHash,
        topThreeTokens: [stableChosen],
        oldToken,
        chosenToken: stableChosen,
        chosenTokenMetrics: null,
        changeSummary: buildChangeSummary(oldToken, stableChosen),
        outcome: "success",
        details: parkDetails,
      });
      return {
        outcome: "success",
        address: stableChosen.address,
        marketBreadthDefensiveActive,
      };
    }
    if (stableResult.kind === "not_applicable") {
      break;
    }

    console.error(`[Demeter] ${logTag} ${onChainLabel} failed:`, stableResult.error);
    await logMode({
      changeStrategyTransaction: null,
      topThreeTokens: [stableChosen],
      oldToken,
      chosenToken: stableChosen,
      chosenTokenMetrics: null,
      changeSummary: buildChangeSummary(oldToken, stableChosen),
      outcome: "failed",
      details: stableResult.error,
    });
    console.warn(`[Demeter] Retrying ${onChainLabel} in ${CHANGE_STRATEGY_TX_RETRY_MS / 1000}s…`);
    await new Promise((r) => setTimeout(r, CHANGE_STRATEGY_TX_RETRY_MS));
  }

  await logMode({
    changeStrategyTransaction: null,
    topThreeTokens: [],
    oldToken,
    chosenToken: null,
    chosenTokenMetrics: null,
    changeSummary: null,
    outcome: "skipped",
    details: noPickDetails,
  });
  return { outcome: "skipped", reason: noPickDetails, marketBreadthDefensiveActive };
}

/**
 * Float changeStrategyAsset: fetch comparison → top ranked (after filters) → strongest 6h buy pressure among top N → on-chain change.
 * Retries every 30s on submit failure until success or stop signal.
 * @param rankingMetrics - When set, drives `weighted_ranking` (scheduled loop uses {@link getOffensiveTokenRankingMetrics}): composite scores normalize each metric vs **all pre-momentum eligible** tokens (cohort min–max or optional baseline μ via env — {@link getOffensiveWeightedScoreNormalization}); `ranked` lists only tokens that passed {@link passesOffensiveMomentumGates}, sorted by that score. Also enables stricter short-horizon exclusion in `fetchTokenComparison` (any m5/m15/m30/h1 ≤ {@link getMaxNegativePriceChangeM5M15M30Pct}). When omitted, uses Float default ({@link getTokenRankingMetrics} via `fetchTokenComparison`).
 * @param options.minWeightedScore - If &gt; 0, require top actionable token’s composite score ≥ this (scheduled loop passes {@link getScheduledChangeMinWeightedScore}). Omit for other triggers.
 *
 * Skips (no `changeStrategyAsset`) when {@link isAnyFloatStrategyOffensive} is true — compares chain `mode()` to {@link OFFENSIVE_MODE} only (no second numeric literal).
 */
async function executeChangeStrategy(
  currentAssetAddress?: string | null,
  forceChangeIfTopIsCurrent = false,
  audit: DemeterChangeStrategyAuditContext | null = null,
  rankingMetrics?: TokenRankingMetricsMap,
  options?: { minWeightedScore?: number },
  pipeline: FloatKeeperPipeline = FLOAT_PIPELINES[0]!
): Promise<ChangeStrategyResult> {
  const { timestampUtc, timestampPacific } = formatDemeterLogTimestamps();

  type ComparisonShape = {
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
    offensive_momentum_gates_active?: boolean;
    pre_momentum_eligible_count?: number;
    weighted_ranking_eligible?: number;
    excluded_offensive_momentum?: Array<{ symbol: string; reason: string }>;
    market_breadth_defensive_active?: boolean;
    market_breadth_on_chain_action?: string;
  };

  let comparison: ComparisonShape | undefined;

  const logMode = async (entry: {
    changeStrategyTransaction: string | null;
    topThreeTokens: Array<{ symbol: string; address: string }>;
    oldToken: { address: string; symbol: string | null };
    chosenToken: { symbol: string; address: string } | null;
    chosenTokenMetrics?: DemeterChosenTokenMetrics | null;
    changeSummary?: string | null;
    outcome: "success" | "skipped" | "failed";
    details?: string;
  }) => {
    if (!audit) return;
    try {
      const calibrationExtras =
        entry.outcome === "success" &&
        shouldRecordCalibrationEvent(entry.topThreeTokens) &&
        comparison != null
          ? buildMetricCalibrationFields(
              entry.topThreeTokens,
              comparison.weighted_ranking?.ranked,
              (comparison.tokens_summary ?? []) as unknown as Array<Record<string, unknown>>,
              comparison.weighted_ranking,
              new Date(timestampUtc),
              { omitBuyPressureScore: rankingMetrics != null }
            )
          : {};
      await appendDemeterDefensiveOffensiveLog({
        trigger: audit.trigger,
        upkeepTransaction: audit.upkeepTransaction ?? null,
        strategyId: audit.strategyId,
        keeperPipeline: audit.keeperPipeline ?? "float",
        timestampUtc,
        timestampPacific,
        ...entry,
        ...calibrationExtras,
      });
    } catch (e) {
      console.error("[Demeter] Failed to write DEFENSIVE/OFFENSIVE audit log:", e);
    }
  };

  if (await isAnyFloatStrategyOffensive(pipeline)) {
    const msg = `[${pipeline.label}] Skipping changeStrategyAsset: at least one strategy is OFFENSIVE (mode=${OFFENSIVE_MODE})`;
    console.log(`[Demeter] ${msg}`);
    const earlyOldToken = buildOldTokenEntry(currentAssetAddress ?? null, undefined);
    await logMode({
      changeStrategyTransaction: null,
      topThreeTokens: [],
      oldToken: earlyOldToken,
      chosenToken: null,
      chosenTokenMetrics: null,
      changeSummary: null,
      outcome: "skipped",
      details: msg,
    });
    return { outcome: "skipped", reason: msg, marketBreadthDefensiveActive: false };
  }

  comparison = (await pipeline.fetchComparison(
    currentAssetAddress ?? null,
    rankingMetrics,
    floatComparisonFetchOptions(audit)
  )) as ComparisonShape;

  const marketBreadthDefensiveActive = marketBreadthDefensiveActiveFromComparison(comparison);
  const tokensEarly = comparison?.tokens_summary;
  const oldToken = buildOldTokenEntry(currentAssetAddress ?? null, tokensEarly);

  if (
    audit?.trigger !== "STABLE" &&
    (shouldRunFloatV4MarketBreadthStableExit(pipeline.strategyRegistryKey, {
      market_breadth_defensive_active: marketBreadthDefensiveActive,
    }) ||
      (marketBreadthDefensiveActive &&
        (comparison as { market_breadth_on_chain_action?: string }).market_breadth_on_chain_action ===
          "exitStrategyToStable"))
  ) {
    const rpcUrl = getRpcUrlOptional();
    const wp = getWalletProvider();
    const logTag = formatFloatChangeStrategyLogTag(pipeline);
    const stableChosen = {
      symbol: "WETH",
      address: STABLE_V4_WETH_ADDRESS,
    };

    if (!rpcUrl) {
      await logMode({
        changeStrategyTransaction: null,
        topThreeTokens: [stableChosen],
        oldToken,
        chosenToken: stableChosen,
        chosenTokenMetrics: null,
        changeSummary: buildChangeSummary(oldToken, stableChosen),
        outcome: "failed",
        details: "RPC_URL is not set",
      });
      return {
        outcome: "failed",
        error: "RPC_URL is not set",
        marketBreadthDefensiveActive: true,
      };
    }
    if (!wp || !(wp instanceof EvmWalletProvider)) {
      await logMode({
        changeStrategyTransaction: null,
        topThreeTokens: [stableChosen],
        oldToken,
        chosenToken: stableChosen,
        chosenTokenMetrics: null,
        changeSummary: buildChangeSummary(oldToken, stableChosen),
        outcome: "failed",
        details: "Wallet provider not available or not EVM",
      });
      return {
        outcome: "failed",
        error: "Wallet provider not available or not EVM",
        marketBreadthDefensiveActive: true,
      };
    }

    for (;;) {
      if (checkDemeterStopSignal()) {
        return {
          outcome: "failed",
          error: "stop signal during exitStrategyToStable retry",
          marketBreadthDefensiveActive: true,
        };
      }

      const stableResult = await tryFloatV4MarketBreadthStableExit(wp, pipeline, rpcUrl);
      if (stableResult.kind === "skipped") {
        await logMode({
          changeStrategyTransaction: null,
          topThreeTokens: [stableChosen],
          oldToken,
          chosenToken: stableChosen,
          chosenTokenMetrics: null,
          changeSummary: buildChangeSummary(oldToken, stableChosen),
          outcome: "skipped",
          details: stableResult.reason,
        });
        return {
          outcome: "skipped",
          reason: stableResult.reason,
          marketBreadthDefensiveActive: true,
        };
      }
      if (stableResult.kind === "sent") {
        console.log(
          `[Demeter] ${logTag} exitStrategyToStable tx ${stableResult.txHash} https://robinhoodchain.blockscout.com/tx/${stableResult.txHash}`
        );
        await logMode({
          changeStrategyTransaction: stableResult.txHash,
          topThreeTokens: [stableChosen],
          oldToken,
          chosenToken: stableChosen,
          chosenTokenMetrics: null,
          changeSummary: buildChangeSummary(oldToken, stableChosen),
          outcome: "success",
        });
        return {
          outcome: "success",
          address: STABLE_V4_WETH_ADDRESS,
          marketBreadthDefensiveActive: true,
        };
      }
      if (stableResult.kind === "not_applicable") {
        break;
      }

      console.error(`[Demeter] ${logTag} exitStrategyToStable failed:`, stableResult.error);
      await logMode({
        changeStrategyTransaction: null,
        topThreeTokens: [stableChosen],
        oldToken,
        chosenToken: stableChosen,
        chosenTokenMetrics: null,
        changeSummary: buildChangeSummary(oldToken, stableChosen),
        outcome: "failed",
        details: stableResult.error,
      });
      console.warn(
        `[Demeter] Retrying exitStrategyToStable in ${CHANGE_STRATEGY_TX_RETRY_MS / 1000}s…`
      );
      await new Promise((r) => setTimeout(r, CHANGE_STRATEGY_TX_RETRY_MS));
    }
  }

  const ranked = comparison?.weighted_ranking?.ranked;
  const tokens = tokensEarly;

  if (!ranked?.length || !tokens?.length) {
    if (comparison?.offensive_momentum_gates_active && (comparison.pre_momentum_eligible_count ?? 0) > 0) {
      const pre = comparison.pre_momentum_eligible_count;
      const post = comparison.weighted_ranking_eligible ?? 0;
      const mom = comparison.excluded_offensive_momentum;
      console.warn(
        `[Demeter] No ranked tokens after offensive momentum gates (${pre} passed volume/liquidity/volatility/short-horizon pre-screen, ${post} after momentum); skipping changeStrategyAsset`
      );
      if (mom?.length) {
        const lines = mom.slice(0, 12).map((m) => `  ${m.symbol}: ${m.reason}`);
        if (mom.length > 12) lines.push(`  … and ${mom.length - 12} more`);
        console.warn("[Demeter] Offensive momentum rejections:\n" + lines.join("\n"));
      }
    } else {
      console.warn("[Demeter] No ranked tokens from comparison, skipping changeStrategyAsset");
    }
    const skipDetails = (() => {
      const mom = comparison?.excluded_offensive_momentum;
      if (comparison?.offensive_momentum_gates_active && mom?.length) {
        const summary = mom.map((m) => `${m.symbol}: ${m.reason}`).join("; ");
        return `No ranked tokens after offensive momentum (${comparison.pre_momentum_eligible_count} pre-momentum eligible). Rejections: ${summary}`.slice(
          0,
          4000
        );
      }
      return "No ranked tokens from comparison";
    })();
    if (audit?.trigger === "DEFENSIVE") {
      return parkFloatDefensiveToStableOnNoPick(
        pipeline,
        oldToken,
        logMode,
        skipDetails,
        marketBreadthDefensiveActive
      );
    }
    await logMode({
      changeStrategyTransaction: null,
      topThreeTokens: [],
      oldToken,
      chosenToken: null,
      chosenTokenMetrics: null,
      changeSummary: null,
      outcome: "skipped",
      details: skipDetails,
    });
    return {
      outcome: "skipped",
      reason:
        comparison?.offensive_momentum_gates_active && (comparison.pre_momentum_eligible_count ?? 0) > 0
          ? "No ranked tokens after offensive momentum gates (see logs / audit details for per-symbol reasons)"
          : "No ranked tokens from comparison",
      marketBreadthDefensiveActive,
    };
  }

  const loopCfg = getPipelineLoopThresholds(pipeline.id);
  const ranking = loopCfg.ranking;
  const minVol = ranking.minVolumeH12Usd;
  const minLiq = ranking.minPoolLiquidityUsd;
  const minVolatilityH24 = ranking.minVolatilityH24Usd;
  const maxVolatilityH24 = ranking.maxVolatilityH24Usd;
  const scoreFloor = options?.minWeightedScore;
  if (typeof scoreFloor === "number" && scoreFloor > 0) {
    const topActionable = getTopActionableOffensiveScore(ranked, tokens, {
      minVolumeH12Usd: minVol,
      minPoolLiquidityUsd: minLiq,
      minVolatilityH24Usd: minVolatilityH24,
      maxVolatilityH24Usd: maxVolatilityH24,
      wethLower: WETH_BASE.toLowerCase(),
    });
    if (topActionable && topActionable.score < scoreFloor) {
      console.log(
        `[Demeter] Skipping changeStrategy: top actionable offensive composite ${topActionable.score.toFixed(3)} < min ${scoreFloor} (${topActionable.symbol})`
      );
      await logMode({
        changeStrategyTransaction: null,
        topThreeTokens: [],
        oldToken,
        chosenToken: null,
        chosenTokenMetrics: null,
        changeSummary: null,
        outcome: "skipped",
        details: `Offensive composite score ${topActionable.score.toFixed(3)} < scheduled min ${scoreFloor} (${topActionable.symbol})`,
      });
      return {
        outcome: "skipped",
        reason: `Offensive composite below scheduledChangeMinWeightedScore (${topActionable.score.toFixed(3)} < ${scoreFloor})`,
        marketBreadthDefensiveActive,
      };
    }
  }
  const wethLower = WETH_BASE.toLowerCase();
  const currentLower = currentAssetAddress?.toLowerCase();
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
    if (addr === wethLower) {
      console.log(`[Demeter] Skipping WETH (${symbol}) – contract changeStrategyAsset WETH path fails gas estimation`);
      continue;
    }
    if (audit?.trigger === "STABLE") {
      if (isStableUsdcTokenAddress(token?.address)) {
        console.log(`[Demeter] Skipping ${symbol} — STABLE re-entry excludes USDC stable token`);
        continue;
      }
      if (
        pipeline.strategyRegistryKey === "FloatStrategyV4" &&
        addr === STABLE_V4_WETH_ADDRESS.toLowerCase()
      ) {
        console.log(`[Demeter] Skipping ${symbol} — STABLE re-entry excludes parked WETH`);
        continue;
      }
    }
    if (
      pipeline.strategyRegistryKey === "FloatStrategyV4" &&
      isBlockedV4ChangeStrategyTokenAddress(token?.address)
    ) {
      console.log(
        `[Demeter] [${pipeline.label}] Skipping ${symbol} – V4 stable is exitStrategyToStable (WETH), not changeStrategyAsset(USDC)`
      );
      continue;
    }
    if (token && typeof token.volume_h12 === "number" && token.volume_h12 < minVol) {
      console.warn(`[Demeter] Skipping ${symbol}: volume_h12 ${token.volume_h12} < min ${minVol}`);
      continue;
    }
    if (token && (typeof token.liquidity_usd !== "number" || token.liquidity_usd < minLiq)) {
      console.warn(
        `[Demeter] Skipping ${symbol}: pool liquidity_usd ${token.liquidity_usd ?? "n/a"} < min $${minLiq}`
      );
      continue;
    }
    if (
      !passesChangeStrategyVolatilityH24Band(
        token?.volatility_h24,
        minVolatilityH24,
        maxVolatilityH24,
        token?.address
      )
    ) {
      if (!isStableUsdcTokenAddress(token?.address)) {
        const v = token?.volatility_h24;
        const vLabel = typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : String(v ?? "n/a");
        if (minVolatilityH24 > 0 && (typeof v !== "number" || !Number.isFinite(v) || v < minVolatilityH24)) {
          console.warn(
            `[Demeter] Skipping ${symbol}: volatility_h24 ${vLabel} < min ${minVolatilityH24} (pool h24 vol ÷ reserve or base+quote liq)`
          );
        } else if (maxVolatilityH24 > 0) {
          console.warn(
            `[Demeter] Skipping ${symbol}: volatility_h24 ${vLabel} > max ${maxVolatilityH24} (pool h24 vol ÷ reserve or base+quote liq)`
          );
        } else {
          console.warn(`[Demeter] Skipping ${symbol}: volatility_h24 ${vLabel} outside turnover band`);
        }
      }
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
    console.warn("[Demeter] No eligible ranked token (excluding WETH, volume / liquidity / volatility filter), skipping changeStrategyAsset");
    const skipDetails =
      "No eligible ranked token (WETH / volume / liquidity / volatility / force-skip current)";
    if (audit?.trigger === "DEFENSIVE") {
      return parkFloatDefensiveToStableOnNoPick(
        pipeline,
        oldToken,
        logMode,
        skipDetails,
        marketBreadthDefensiveActive
      );
    }
    await logMode({
      changeStrategyTransaction: null,
      topThreeTokens,
      oldToken,
      chosenToken: null,
      chosenTokenMetrics: null,
      changeSummary: null,
      outcome: "skipped",
      details: skipDetails,
    });
    return {
      outcome: "skipped",
      reason: skipDetails,
      marketBreadthDefensiveActive,
    };
  }

  const offensiveWeightedPick = rankingMetrics != null;
  const logTag = formatFloatChangeStrategyLogTag(pipeline);

  const wp = getWalletProvider();
  if (!wp || !(wp instanceof EvmWalletProvider)) {
    console.error("[Demeter] Wallet provider not available or not EVM – cannot call changeStrategyAsset");
    await logMode({
      changeStrategyTransaction: null,
      topThreeTokens,
      oldToken,
      chosenToken: null,
      chosenTokenMetrics: null,
      changeSummary: null,
      outcome: "failed",
      details: "Wallet provider not available or not EVM",
    });
    return {
      outcome: "failed",
      error: "Wallet provider not available or not EVM",
      marketBreadthDefensiveActive,
    };
  }

  // Try top-ranked candidates in order. If one token is misconfigured on-chain (e.g. PoolKey revert),
  // do not stall the entire agent for hours — cap retries per token and move on.
  for (const chosen of candidates) {
    const topSymbol = chosen.symbol;
    const topAddress = chosen.address;
    const chosenMetricsOpts = { omitBuyPressureScore: offensiveWeightedPick };
    const chosenMetricsBase = () => ({
      ...chosenMetricsOpts,
      weightedCompositeScore: weightedCompositeScoreForSymbol(ranked, chosen.symbol),
    });

    if (!forceChangeIfTopIsCurrent && currentLower && topAddress.toLowerCase() === currentLower) {
      console.log(
        `[Demeter] Chosen token ${topSymbol} (${offensiveWeightedPick ? "top weighted rank" : `strongest 6h buy pressure in top ${TOP_N_FOR_PRICE_PICK}`}) is already current asset, skipping changeStrategyAsset`
      );
      await logMode({
        changeStrategyTransaction: null,
        topThreeTokens,
        oldToken,
        chosenToken: { symbol: topSymbol, address: topAddress },
        chosenTokenMetrics: buildChosenMetrics(chosen, chosenMetricsBase()),
        changeSummary: buildChangeSummary(oldToken, { symbol: topSymbol, address: topAddress }),
        outcome: "skipped",
        details: "Chosen token already current asset (scheduled path)",
      });
      return {
        outcome: "skipped",
        reason: "Chosen token already current asset (scheduled path)",
        marketBreadthDefensiveActive,
      };
    }

    if (offensiveWeightedPick) {
      console.log(
        `[Demeter] ${logTag} — changeStrategyAsset(${topAddress}) offensive pick ${topSymbol}`
      );
    } else {
      const bpScore = buySellBuyPressureScore(chosen.buy_sell_ratio_h6);
      console.log(
        `[Demeter] ${logTag} — changeStrategyAsset(${topAddress}) ${topSymbol} (buyPressureScore ${bpScore})`
      );
    }

    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN; attempt++) {
      if (checkDemeterStopSignal()) {
        await logMode({
          changeStrategyTransaction: null,
          topThreeTokens,
          oldToken,
          chosenToken: { symbol: topSymbol, address: topAddress },
          chosenTokenMetrics: buildChosenMetrics(chosen, chosenMetricsBase()),
          changeSummary: buildChangeSummary(oldToken, { symbol: topSymbol, address: topAddress }),
          outcome: "failed",
          details: "Stopped during changeStrategyAsset retry (demeter stop signal)",
        });
        return {
          outcome: "failed",
          error: "stop signal during changeStrategyAsset retry",
          marketBreadthDefensiveActive,
        };
      }

      if (
        pipeline.strategyRegistryKey === "FloatStrategyV4" &&
        isBlockedV4ChangeStrategyTokenAddress(topAddress)
      ) {
        console.warn(
          `[Demeter] ${logTag} refusing changeStrategyAsset(USDC) on V4 — use exitStrategyToStable (WETH/STABLE)`
        );
        const stableResult = await tryFloatV4MarketBreadthStableExit(wp, pipeline, getRpcUrlOptional() ?? "");
        if (stableResult.kind === "sent") {
          await logMode({
            changeStrategyTransaction: stableResult.txHash,
            topThreeTokens,
            oldToken,
            chosenToken: { symbol: "WETH", address: STABLE_V4_WETH_ADDRESS },
            chosenTokenMetrics: buildChosenMetrics(chosen, chosenMetricsBase()),
            changeSummary: buildChangeSummary(oldToken, { symbol: "WETH", address: STABLE_V4_WETH_ADDRESS }),
            outcome: "success",
          });
          return {
            outcome: "success",
            address: STABLE_V4_WETH_ADDRESS,
            marketBreadthDefensiveActive,
          };
        }
        lastErr = stableResult.kind === "failed" ? stableResult.error : "exitStrategyToStable not sent";
        console.error(`[Demeter] ${logTag} exitStrategyToStable failed:`, lastErr);
        continue;
      }

      const result = await sendChangeStrategyAsset(wp, pipeline.contractManagerAddress, topAddress);
      if (result.success) {
        console.log(
          `[Demeter] ${logTag} changeStrategyAsset tx ${result.transactionHash} https://robinhoodchain.blockscout.com/tx/${result.transactionHash}`
        );
        await logMode({
          changeStrategyTransaction: result.transactionHash ?? null,
          topThreeTokens,
          oldToken,
          chosenToken: { symbol: topSymbol, address: topAddress },
          chosenTokenMetrics: buildChosenMetrics(chosen, {
            ...chosenMetricsBase(),
            ...buildTokenCalibrationMetrics(
              chosen.symbol,
              ranked,
              tokensEarly as unknown as Array<Record<string, unknown>>,
              comparison?.weighted_ranking,
              tokensEarly?.find((t) => t.symbol === chosen.symbol),
              { omitBuyPressureScore: offensiveWeightedPick }
            ),
          }),
          changeSummary: buildChangeSummary(oldToken, { symbol: topSymbol, address: topAddress }),
          outcome: "success",
        });
        return { outcome: "success", address: topAddress, marketBreadthDefensiveActive };
      }

      lastErr = result.error ?? "changeStrategyAsset failed";
      console.error(`[Demeter] ${logTag} changeStrategyAsset failed:`, lastErr);
      await logMode({
        changeStrategyTransaction: null,
        topThreeTokens,
        oldToken,
        chosenToken: { symbol: topSymbol, address: topAddress },
        chosenTokenMetrics: buildChosenMetrics(chosen, chosenMetricsBase()),
        changeSummary: buildChangeSummary(oldToken, { symbol: topSymbol, address: topAddress }),
        outcome: "failed",
        details: lastErr,
      });

      if (attempt < CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN) {
        console.warn(
          `[Demeter] Retrying changeStrategyAsset in ${CHANGE_STRATEGY_TX_RETRY_MS / 1000}s (attempt ${attempt}/${CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN}; same token ${topSymbol})…`
        );
        await sleepWithStopCheck(CHANGE_STRATEGY_TX_RETRY_MS);
      }
    }

    console.warn(
      `[Demeter] ${logTag} changeStrategyAsset: giving up after ${CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN} attempts for ${topSymbol}; trying next ranked token` +
        (lastErr ? ` (last error: ${lastErr})` : "")
    );
  }

  await logMode({
    changeStrategyTransaction: null,
    topThreeTokens,
    oldToken,
    chosenToken: null,
    chosenTokenMetrics: null,
    changeSummary: null,
    outcome: "failed",
    details: `All candidates failed changeStrategyAsset (max ${CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN} tries each)`,
  });
  return {
    outcome: "failed",
    error: `All candidates failed changeStrategyAsset (max ${CHANGE_STRATEGY_MAX_TRIES_PER_TOKEN} tries each)`,
    marketBreadthDefensiveActive,
  };
}

/**
 * Float periodic loop: single wake cadence `min(priceCheckIntervalMs, changeStrategyIntervalMs)` so defensive m30/volume
 * and scheduled offensive checks do not sleep independently and fire the same CoinGecko + tx stack on one tick.
 * Defensive runs when `priceCheckIntervalMs` has elapsed (m30/volume on current alt only; skipped when mode=STABLE — STABLE re-entry uses upkeep loop like DEFENSIVE);
 * scheduled offensive when `changeStrategyIntervalMs` has elapsed.
 * If defensive triggers a change on a tick, scheduled is skipped that tick.
 * Scheduled path **re-reads** `FloatContractManager` ASSET on every tick (no cross-tick cache) so logs and “already current” checks match chain after external or upkeep-loop switches.
 * `executeChangeStrategy` calls use {@link withDemeterWalletExclusive} (same global queue as upkeep + harvest).
 */
async function floatPeriodicLoop(pipeline: FloatKeeperPipeline) {
  const loopCfg = getPipelineLoopThresholds(pipeline.id);
  const minVolH12Usd = loopCfg.minVolumeH12Usd;
  const priceCheckIntervalMs = loopCfg.priceCheckIntervalMs;
  const changeStrategyIntervalMs = loopCfg.changeStrategyIntervalMs;
  const priceDropThresholdPct = loopCfg.priceDropThresholdPct;
  const marketBreadthFraction = loopCfg.ranking.marketBreadthNegativeH24FractionGte;
  let marketBreadthDefensiveMode = false;
  const baseWakeMs = () =>
    Math.min(
      priceCheckIntervalMs,
      marketBreadthDefensiveMode ? DEFAULT_POLL_MS : changeStrategyIntervalMs
    );
  const effectiveScheduledMs = () =>
    marketBreadthDefensiveMode ? DEFAULT_POLL_MS : changeStrategyIntervalMs;

  const periodicRunEvery = pipeline.runEveryNLoops ?? 1;
  console.log(
    `[Demeter] [${pipeline.label}] Starting periodic loop — wake min(price, scheduled) (scheduled = ${formatChangeStrategyIntervalForLog(changeStrategyIntervalMs)}, or ${DEFAULT_POLL_MS / 60000} min while ≥${(marketBreadthFraction * 100).toFixed(0)}% cohort negative 24h); defensive every ${priceCheckIntervalMs / 1000 / 60} min (m30≤${priceDropThresholdPct}%, 12h vol<$${minVolH12Usd})` +
      (periodicRunEvery > 1
        ? `; offensive/defensive every ${periodicRunEvery} periodic wakes (FLOAT_V4_RUN_EVERY_N_LOOPS=1 for every wake)`
        : "")
  );

  let lastDefensiveAt = Date.now();
  let lastScheduledAt = Date.now();

  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[Demeter] Stop signal received, exiting Float periodic loop");
      return;
    }
    try {
      await sleepWithStopCheck(baseWakeMs());

      const periodicGate = tickFloatPipelineLoopGate(pipeline, "periodic");
      if (!periodicGate.shouldRun) {
        if (shouldLogFloatPipelineLoopSkip(periodicGate.loopNumber, periodicGate.runEvery)) {
          console.log(
            formatFloatPipelineLoopSkipLog(
              pipeline,
              "periodic",
              periodicGate.loopNumber,
              periodicGate.runEvery
            )
          );
        }
        continue;
      }
      console.log(
        formatFloatPipelineLoopRunLog(
          pipeline,
          "periodic",
          periodicGate.loopNumber,
          periodicGate.runEvery
        )
      );

      await sleepFloatPipelineStagger(
        pipeline.id,
        FLOAT_PIPELINES.map((p) => p.id),
        sleepWithStopCheck
      );

      if (!RPC_URL) continue;

      const tickStart = Date.now();

      let defensiveTriggered = false;

      if (tickStart - lastDefensiveAt >= priceCheckIntervalMs) {
        lastDefensiveAt = tickStart;

        let skipPeriodicPriceCheck = false;
        for (const strategyId of pipeline.strategyIds) {
          const mode = await readFloatStrategyMode(pipeline, strategyId);
          if (mode === STABLE_MODE) {
            skipPeriodicPriceCheck = true;
            console.log(
              `[Demeter] [${pipeline.label}] periodic (defensive): skipping m30/volume — strategy ${strategyId} STABLE (default-metrics re-entry runs on upkeep loop)`
            );
            break;
          }
        }

        if (!skipPeriodicPriceCheck) {
        let currentAssetAddress: string;
        try {
          currentAssetAddress = await getFloatAssetAddress(
            pipeline.contractManagerAddress,
            RPC_URL,
            pipeline.strategyRegistryKey
          );
        } catch (e) {
          console.warn(`[Demeter] [${pipeline.label}] periodic (defensive): could not fetch current asset:`, e);
          continue;
        }

        const defensivePoolSkip = shouldSkipPeriodicDefensivePoolFetch(
          pipeline.strategyRegistryKey,
          currentAssetAddress
        );
        if (defensivePoolSkip.skip) {
          console.log(
            `[Demeter] [${pipeline.label}] periodic (defensive): skipping CoinGecko pool fetch for ${currentAssetAddress} — ${defensivePoolSkip.reason}`
          );
          continue;
        }

        const data = (await fetchTokenData([currentAssetAddress], undefined, {
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
          console.log(
            `[Demeter] Float periodic (defensive): 12h pool volume $${volumeH12Usd.toFixed(0)} < $${minVolH12Usd} (min), triggering changeStrategy`
          );
          const r = await withDemeterWalletExclusive(() =>
            executeChangeStrategy(
              currentAssetAddress,
              true,
              {
                trigger: "PRICE_CHECK_LOW_VOLUME_12H",
                keeperPipeline: pipeline.auditKeeperPipeline,
              },
              undefined,
              undefined,
              pipeline
            )
          );
          marketBreadthDefensiveMode = r.marketBreadthDefensiveActive === true;
          defensiveTriggered = true;
        } else if (volumeH12Usd === null) {
          console.log(
            "[Demeter] Float periodic (defensive): no 12h pool volume data for current asset (skipping volume rule)"
          );
        }

        if (!defensiveTriggered) {
          const m30Str = pool?.price_change_percentage?.m30;
          const m30 = m30Str != null ? parseFloat(String(m30Str)) : null;

          if (m30 === null) {
            console.log("[Demeter] Float periodic (defensive): no m30 price change data for current asset");
          } else if (m30 <= priceDropThresholdPct) {
            console.log(
              `[Demeter] Float periodic (defensive): m30 price change ${m30}% <= ${priceDropThresholdPct}%, triggering changeStrategy`
            );
            const r = await withDemeterWalletExclusive(() =>
              executeChangeStrategy(
                currentAssetAddress,
                true,
                {
                  trigger: "PRICE_CHECK_M30",
                  keeperPipeline: pipeline.auditKeeperPipeline,
                },
                undefined,
                undefined,
                pipeline
              )
            );
            marketBreadthDefensiveMode = r.marketBreadthDefensiveActive === true;
            defensiveTriggered = true;
          }
        }

        }

      }

      if (defensiveTriggered) {
        continue;
      }

      if (tickStart - lastScheduledAt >= effectiveScheduledMs()) {
        lastScheduledAt = tickStart;

        /** Always read ASSET from chain — never reuse a stale address after manual/upkeep/other-path switches. */
        let scheduledCurrentAsset: string | null = null;
        try {
          scheduledCurrentAsset = await getFloatAssetAddress(
            pipeline.contractManagerAddress,
            RPC_URL,
            pipeline.strategyRegistryKey
          );
          console.log(
            `[Demeter] [${pipeline.label}] periodic (scheduled): current asset (ASSET): ${scheduledCurrentAsset}`
          );
        } catch (e) {
          console.warn(
            `[Demeter] [${pipeline.label}] periodic (scheduled): could not fetch current asset:`,
            e
          );
        }

        if (scheduledCurrentAsset === null) {
          console.warn("[Demeter] Float periodic (scheduled): skipping offensive comparison (no ASSET from chain)");
        } else {
          console.log("[Demeter] Float periodic (scheduled): token comparison (offensive metrics)...");
          const changeResult = await withDemeterWalletExclusive(() =>
            executeChangeStrategy(
              scheduledCurrentAsset,
              false,
              {
                trigger: "SCHEDULED",
                keeperPipeline: pipeline.auditKeeperPipeline,
              },
              getOffensiveTokenRankingMetrics(),
              { minWeightedScore: loopCfg.scheduledChangeMinWeightedScore },
              pipeline
            )
          );
          marketBreadthDefensiveMode = changeResult.marketBreadthDefensiveActive === true;
        }
        if (marketBreadthDefensiveMode) {
          console.log(
            `[Demeter] Float periodic: market breadth defensive (stable path) — using ${DEFAULT_POLL_MS / 60000} min scheduled cadence until cohort 24h breadth recovers`
          );
        }
      }
    } catch (error) {
      console.error(`[Demeter] [${pipeline.label}] Float periodic loop error:`, error);
    }
  }
}

/**
 * Append FloatStrategy.poolValue() to logs/demeter-pool-value.jsonl on an interval (default hourly).
 * Timestamps: UTC + America/Los_Angeles (same formatter as defensive/offensive audit).
 */
async function poolValueLogLoop() {
  if (!RPC_URL) {
    console.warn("[Demeter] poolValue log: RPC_URL missing — idle until stop signal");
    for (;;) {
      if (checkDemeterStopSignal()) {
        console.log("[Demeter] Stop signal received, exiting pool value log loop");
        return;
      }
      await sleepWithStopCheck(POOL_VALUE_LOG_INTERVAL_MS);
    }
  }
  console.log(
    `[Demeter] Starting pool value log loop — every ${Math.round(POOL_VALUE_LOG_INTERVAL_MS / 1000 / 60)} min → logs/demeter-pool-value.jsonl`
  );
  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[Demeter] Stop signal received, exiting pool value log loop");
      return;
    }
    try {
      const activePipelineIds = FLOAT_PIPELINES.map((p) => p.id);
      for (const pipeline of FLOAT_PIPELINES) {
        await sleepFloatPipelineStagger(pipeline.id, activePipelineIds, sleepWithStopCheck);
        const { strategyAddress, poolValue } = await getFloatPoolValue(
          pipeline.contractManagerAddress,
          RPC_URL,
          pipeline.strategyRegistryKey
        );
        const { timestampUtc, timestampPacific } = formatDemeterLogTimestamps();
        await appendDemeterPoolValueLog({
          kind: "pool_value",
          timestampUtc,
          timestampPacific,
          floatContractManagerAddress: pipeline.contractManagerAddress,
          strategyAddress,
          poolValue,
        });
        console.log(
          `[Demeter] [${pipeline.label}] poolValue=${poolValue} (strategy ${strategyAddress}) logged`
        );
      }
    } catch (e) {
      console.error("[Demeter] poolValue log error:", e);
    }
    await sleepWithStopCheck(POOL_VALUE_LOG_INTERVAL_MS);
  }
}

/**
 * Run Triton without taking down Float/keeper loops if LiquidStrat startup fails
 * (bad key, tritonAddr mismatch, RPC, etc.).
 */
async function tritonLiquidLoopSafe(): Promise<void> {
  try {
    await tritonLiquidLoop();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[Demeter] Triton / LiquidStratMinV4 loop failed at startup or runtime:", msg);
    console.error("[Demeter] Float keeper loops continue. Fix TRITON_* / contract / .env, then restart.");
    await new Promise<void>(() => {
      /* block Promise.race so Demeter stays up without Triton */
    });
  }
}

async function ufloatKeeperLoopSafe(): Promise<void> {
  try {
    await ufloatKeeperLoop();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[Demeter] UFloatKeeper loop failed at startup or runtime:", msg);
    console.error("[Demeter] Float keeper loops continue. Fix TRITON_* / UFloatKeeper registry / OperatorRegistry / .env, then restart.");
    await new Promise<void>(() => {
      /* block Promise.race */
    });
  }
}

async function autoKeeperLoopSafe(): Promise<void> {
  try {
    await autoKeeperLoop();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[Demeter] AutoKeeper loop failed at startup or runtime:", msg);
    console.error(
      "[Demeter] Other keeper loops continue. Fix AUTO_KEEPER_* / DEMETER_TWO_PRIVATE_KEY / AutoKeeperV3Rh+AutoFactoryV3Rh / .env, then restart."
    );
    await new Promise<void>(() => {
      /* block Promise.race */
    });
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    if (isCoingeckoMode) {
      console.log("========================================");
      console.log("Demeter Agent - CoinGecko Token Data");
      console.log("========================================");
      console.log("========================================\n");
      await runCoingeckoTokenData();
      process.exit(0);
    }

    if (!areDemeterLoopsEnabled()) {
      console.log("[Demeter]", demeterLoopsDisabledMessage());
      process.exit(0);
    }

    const { walletProvider } = await prepareAgentkitAndWalletProvider({ toolProfile: "chat" });
    initDemeterWalletProvider(walletProvider);

    console.log("========================================");
    console.log("Demeter Agent - Starting...");
    console.log("========================================");
    console.log(
      "[Demeter] Loops use direct on-chain upkeep/harvest/changeStrategy (no OpenAI agent.invoke for keeper txs)"
    );
    const activePipelineIds = FLOAT_PIPELINES.map((p) => p.id);
    if (FLOAT_PIPELINES.length === 0) {
      console.log(
        "[Demeter] Float keeper pipelines disabled (empty STRATEGY_IDS / FLOAT_V4_STRATEGY_IDS in config.overrides.json)"
      );
    }
    for (const pipeline of FLOAT_PIPELINES) {
      const every = pipeline.runEveryNLoops ?? 1;
      console.log(
        `[${pipeline.label}] Keeper: ${pipeline.keeperAddress} | Manager: ${pipeline.contractManagerAddress} | ids: ${pipeline.strategyIds.join(", ")}` +
          (every > 1 ? ` | upkeep+periodic every ${every} loops` : "")
      );
    }
    if (activePipelineIds.length > 1) {
      const staggerMs = getFloatPipelineStaggerMs();
      const shardNote = isDemeterOperatorShardingEnabled()
        ? "; Float keeper txs sharded per operator wallet (parallel queues)"
        : "; wallet txs still serialized globally";
      console.log(
        `[Demeter] Float pipeline stagger: ${staggerMs}ms between V3 and V4 passes (FLOAT_PIPELINE_STAGGER_MS)${shardNote}`
      );
    }
    if (!isFloatV4RunEveryNLoopsGateEnabled()) {
      console.log(
        "[Demeter] V3 + V4 upkeep/periodic every poll (FLOAT_V4_RUN_EVERY_N_LOOPS gate off; enable FLOAT_V4_RUN_EVERY_N_LOOPS_GATE_ENABLED for future third pipeline)"
      );
    }
    if (FLOAT_PIPELINES.length > 0) {
      console.log(`Float upkeep poll: ${pollMs}ms`);
      console.log(
        Number.isFinite(KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS)
          ? `FloatKeeper snapshotVaultPoolValue: at most every ${KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS / (60 * 60 * 1000)} h (upkeep loop)`
          : `FloatKeeper snapshotVaultPoolValue: disabled (KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS)`
      );
      console.log(`Harvest Interval: ${harvestIntervalMs / 1000 / 60} minutes (min across pipelines)`);
      for (const pipeline of FLOAT_PIPELINES) {
        const loopCfg = getPipelineLoopThresholds(pipeline.id);
        console.log(
          `[${pipeline.label}] harvest every ${loopCfg.harvestIntervalMs / 1000 / 60} min (keeper performHarvest skipIncreaseLiquidity=false); periodic: scheduled ${formatChangeStrategyIntervalForLog(loopCfg.changeStrategyIntervalMs)}; defensive every ${loopCfg.priceCheckIntervalMs / 1000 / 60}m; m30≤${loopCfg.priceDropThresholdPct}%`
        );
      }
      console.log(
        `Pool value log: every ${Math.round(POOL_VALUE_LOG_INTERVAL_MS / 1000 / 60)} min → logs/demeter-pool-value.jsonl (override DEMETER_POOL_VALUE_LOG_INTERVAL_MS)`
      );
    }
    console.log("========================================");
    console.log(`[Demeter] Wallet (Float / keeper primary): ${walletProvider.getAddress()}`);
    console.log(`[Demeter] Network: ${walletProvider.getNetwork().networkId}`);
    if (isDemeterOperatorShardingEnabled() && RPC_URL) {
      const demeterOps = resolveDemeterOperatorWallets();
      console.log(`[Demeter] OperatorRegistry: ${getOperatorRegistryAddress()}`);
      const checks = await assertOperatorWalletsRegistered(demeterOps, RPC_URL);
      for (const check of checks) {
        console.log(`[Demeter] Operator wallet ${check.id}: ${check.address} (registered)`);
      }
      console.log(
        `[Demeter] Float keeper sharding: ${demeterOps.length} operator wallet(s) — upkeep/harvest by strategy id % ${demeterOps.length}`
      );
    }
    if (isUfloatKeeperEnabled()) {
      const ufloatOps = resolveUfloatTxWallets();
      console.log(
        `[Demeter] UFloatKeeperV4 loop enabled (${ufloatOps.length} Triton operator wallet${ufloatOps.length === 1 ? "" : "s"})`
      );
    } else if (isLiquidStratMinV4LoopEnabled()) {
      console.log("[Demeter] LiquidStratMinV4 loop enabled (TRITON_PRIVATE_KEY)");
    } else if (process.env.TRITON_PRIVATE_KEY?.trim() || process.env.TRITON_TWO_PRIVATE_KEY?.trim()) {
      console.log("[Demeter] Triton operator key(s) set but UFloat + LiquidStrat loops disabled via env/overrides");
    }
    if (isAutoKeeperEnabled()) {
      console.log("[Demeter] AutoKeeper (AutoVault) loop enabled (DEMETER_TWO_PRIVATE_KEY)");
    }
    console.log("[Demeter] Wallet initialized for loop operations");
    console.log(
      `[Demeter] Tx gas: ${getDemeterTxGasHeadroomBps() / 1000}× headroom, min ${getTxMinGasLimit()} (DEMETER_TX_GAS_HEADROOM_BPS / DEMETER_TX_MIN_GAS_LIMIT)`
    );
    clearDemeterStopSignal();

    try {
      await ensureDemeterDefensiveOffensiveLogFile();
      await ensureMetricCalibrationLogDir();
      console.log(
        `[Demeter] Defensive/offensive audit JSONL: ${getDemeterDefensiveOffensiveLogPath()} (set DEMETER_DEFENSIVE_OFFENSIVE_LOG_PATH to override)`
      );
      console.log(
        "[Demeter] Metric calibration events: logs/metric-calibration/events.jsonl (6h top-3 forward return)"
      );
      console.log(
        "[Demeter] Metric calibration tuning: interval from CALIBRATION_TUNING_WINDOW_MS / CALIBRATION_TUNING_POLL_MS → config.overrides.json / triton.overrides.json (CALIBRATION_AUTO_APPLY=1)"
      );
    } catch (e) {
      console.error("[Demeter] Could not create defensive/offensive audit log file:", e);
    }

    const idleLoopPromise = new Promise<void>(() => {
      /* idle — loop disabled */
    });
    const upkeepPromises = FLOAT_PIPELINES.map((p) => upkeepLoop(p));
    const harvestPromise = FLOAT_PIPELINES.length > 0 ? harvestLoop() : idleLoopPromise;
    const floatPeriodicPromises = FLOAT_PIPELINES.map((p) => floatPeriodicLoop(p));
    const poolValuePromise = FLOAT_PIPELINES.length > 0 ? poolValueLogLoop() : idleLoopPromise;
    const metricCalibrationPromise = metricCalibrationLoop();
    const metricCalibrationTuningPromise = metricCalibrationTuningLoop();
    const tritonPromise = isLiquidStratMinV4LoopEnabled()
      ? tritonLiquidLoopSafe()
      : idleLoopPromise;
    const ufloatKeeperPromise = isUfloatKeeperEnabled()
      ? ufloatKeeperLoopSafe()
      : idleLoopPromise;
    const autoKeeperPromise = isAutoKeeperEnabled() ? autoKeeperLoopSafe() : idleLoopPromise;
    // Each promise must never resolve during normal operation; otherwise main exits ("Loops stopped").
    await Promise.race([
      ...upkeepPromises,
      harvestPromise,
      ...floatPeriodicPromises,
      poolValuePromise,
      metricCalibrationPromise,
      metricCalibrationTuningPromise,
      tritonPromise,
      ufloatKeeperPromise,
      autoKeeperPromise,
    ]);
    console.log("[Demeter] Loops stopped, exiting");
    process.exit(0);
  } catch (error) {
    console.error("[Demeter] Fatal error:", error);
    process.exit(1);
  }
}

/**
 * @coinbase/agentkit fires analytics to cca-lite.coinbase.com without awaiting;
 * a 400 there becomes an unhandledRejection and kills PM2/Node (strict mode).
 * Analytics is optional — never take the keeper loops down for it.
 */
function isAgentKitAnalyticsRejection(reason: unknown): boolean {
  const parts: string[] = [];
  if (reason instanceof Error) {
    parts.push(reason.message, reason.stack ?? "");
    const details = (reason as { details?: string }).details;
    if (typeof details === "string") parts.push(details);
  } else {
    parts.push(String(reason));
  }
  const text = parts.join(" ");
  return (
    /sendAnalyticsEvent/i.test(text) ||
    /cca-lite\.coinbase\.com/i.test(text) ||
    (/HTTP error! status:\s*400/i.test(text) && /analytics|agentkit/i.test(text))
  );
}

process.on("unhandledRejection", (reason) => {
  if (isAgentKitAnalyticsRejection(reason)) {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.warn(`[Demeter] Ignoring AgentKit analytics failure (CCA): ${msg}`);
    return;
  }
  console.error("[Demeter] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  if (isAgentKitAnalyticsRejection(error)) {
    console.warn(`[Demeter] Ignoring AgentKit analytics uncaughtException (CCA): ${error.message}`);
    return;
  }
  console.error("[Demeter] Uncaught exception:", error);
  process.exit(1);
});

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[Demeter] Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[Demeter] Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

// Start the agent
main().catch((error) => {
  console.error("[Demeter] Unhandled error:", error);
  process.exit(1);
});

