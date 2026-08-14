import { getStrategyMode } from "../action-providers/keeper-strategy-action-provider";
import { FLOAT_STRATEGY_MODE } from "../abi/contract-enums";
import {
  fetchTokenComparison,
  POOL_ADDRESS_BY_TOKEN_V4,
  TRITON_V4_TOKEN_ADDRESS_ARRAY,
} from "../action-providers/coingecko-action-provider";
import type { FloatManagerStrategyKey } from "../action-providers/float-action-provider";
import type { TokenRankingMetricsMap } from "./demeter-config";
import {
  getFloatContractManagerAddress,
  getFloatContractManagerV4Address,
  getFloatV4KeeperAddress,
  getFloatV4RunEveryNLoops,
  getFloatV4StrategyIds,
  getFloatPipelineStaggerMs,
  getKeeperAddress,
  getStrategyIds,
  getTokenRankingMetrics,
  isFloatV4RunEveryNLoopsGateEnabled,
} from "./demeter-config";

export type FloatKeeperPipelineId = "v3" | "v4";

/** Keeper/offensive pass order when multiple Float pipelines are active (V3 before V4). */
export const FLOAT_PIPELINE_RUN_ORDER: readonly FloatKeeperPipelineId[] = ["v3", "v4"];

/**
 * `runEveryNLoops` for a pipeline. V4 uses {@link getFloatV4RunEveryNLoops} only when
 * {@link isFloatV4RunEveryNLoopsGateEnabled} (reserved for a future third Float pipeline).
 */
export function resolvePipelineRunEveryNLoops(
  pipelineId: FloatKeeperPipelineId
): number | undefined {
  if (pipelineId !== "v4" || !isFloatV4RunEveryNLoopsGateEnabled()) return undefined;
  return getFloatV4RunEveryNLoops();
}

/** Stagger offset (ms) before this pipeline's upkeep/periodic/harvest pass (0 for first in order). */
export function floatPipelineStaggerOffsetMs(
  pipelineId: FloatKeeperPipelineId,
  activePipelineIds: readonly FloatKeeperPipelineId[]
): number {
  const base = getFloatPipelineStaggerMs();
  if (base <= 0 || activePipelineIds.length <= 1) return 0;
  const order = FLOAT_PIPELINE_RUN_ORDER.filter((id) => activePipelineIds.includes(id));
  const idx = order.indexOf(pipelineId);
  return idx <= 0 ? 0 : base * idx;
}

export async function sleepFloatPipelineStagger(
  pipelineId: FloatKeeperPipelineId,
  activePipelineIds: readonly FloatKeeperPipelineId[],
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const ms = floatPipelineStaggerOffsetMs(pipelineId, activePipelineIds);
  if (ms > 0) await sleep(ms);
}

/** Loop kinds that honor {@link FloatKeeperPipeline.runEveryNLoops}. Harvest is not gated. */
export type FloatPipelineLoopKind = "upkeep" | "periodic" | "runCycle";

const pipelineLoopCounters = new Map<string, number>();

/**
 * Advance per-pipeline loop counter; return whether this iteration should run keeper/offensive work.
 * `runEveryNLoops` of 1 (default for V3) runs every iteration.
 * For N &gt; 1, runs on wakes 1, N+1, 2N+1, … (first wake after start/restart runs immediately).
 */
export function tickFloatPipelineLoopGate(
  pipeline: Pick<FloatKeeperPipeline, "id" | "label" | "runEveryNLoops">,
  kind: FloatPipelineLoopKind
): { shouldRun: boolean; loopNumber: number; runEvery: number } {
  const runEvery = Math.max(1, Math.floor(Number(pipeline.runEveryNLoops) || 1));
  if (runEvery <= 1) {
    return { shouldRun: true, loopNumber: 0, runEvery: 1 };
  }
  const key = `${pipeline.id}:${kind}`;
  const loopNumber = (pipelineLoopCounters.get(key) ?? 0) + 1;
  pipelineLoopCounters.set(key, loopNumber);
  const shouldRun = (loopNumber - 1) % runEvery === 0;
  return { shouldRun, loopNumber, runEvery };
}

/** Next wake number (inclusive) that will pass the runEveryNLoops gate. */
export function nextFloatPipelineGatedWake(loopNumber: number, runEvery: number): number {
  if (runEvery <= 1) return loopNumber;
  const mod = (loopNumber - 1) % runEvery;
  if (mod === 0) return loopNumber;
  return loopNumber + (runEvery - mod);
}

export function formatFloatPipelineLoopSkipLog(
  pipeline: Pick<FloatKeeperPipeline, "label">,
  kind: FloatPipelineLoopKind,
  loopNumber: number,
  runEvery: number
): string {
  const next = nextFloatPipelineGatedWake(loopNumber, runEvery);
  return (
    `[Demeter] [${pipeline.label}] ${kind} wake #${loopNumber} — skip keeper/offensive ` +
    `(FLOAT_V4_RUN_EVERY_N_LOOPS=${runEvery}; next run at wake #${next})`
  );
}

export function formatFloatPipelineLoopRunLog(
  pipeline: Pick<FloatKeeperPipeline, "label">,
  kind: FloatPipelineLoopKind,
  loopNumber: number,
  runEvery: number
): string {
  if (runEvery <= 1) {
    return `[Demeter] [${pipeline.label}] ${kind} wake #${loopNumber} — run keeper/offensive`;
  }
  return (
    `[Demeter] [${pipeline.label}] ${kind} wake #${loopNumber} — run keeper/offensive ` +
    `(every ${runEvery} wakes; set FLOAT_V4_RUN_EVERY_N_LOOPS=1 for every wake)`
  );
}

/** Avoid logging a skip on every poll when runEveryNLoops &gt; 1 (log start + last skip before run). */
export function shouldLogFloatPipelineLoopSkip(loopNumber: number, runEvery: number): boolean {
  if (runEvery <= 1) return false;
  const mod = (loopNumber - 1) % runEvery;
  if (mod === 0) return false;
  return mod === 1 || mod === runEvery - 1;
}

/** On-chain `mode()` value for OFFENSIVE (FloatStrategy / FloatStrategyV4). */
export const FLOAT_STRATEGY_OFFENSIVE_MODE = FLOAT_STRATEGY_MODE.Offensive;

/** Log prefix for changeStrategyAsset txs in demeter-out.log. */
export function formatFloatChangeStrategyLogTag(
  pipeline: Pick<FloatKeeperPipeline, "label" | "contractManagerAddress">
): string {
  return `[${pipeline.label}] manager ${pipeline.contractManagerAddress}`;
}

export async function isAnyFloatPipelineStrategyOffensive(
  pipeline: FloatKeeperPipeline,
  rpcUrl: string
): Promise<boolean> {
  if (!pipeline.keeperAddress || !rpcUrl || pipeline.strategyIds.length === 0) return false;
  for (const sid of pipeline.strategyIds) {
    try {
      const mode = await getStrategyMode(pipeline.keeperAddress, sid, rpcUrl, pipeline.id);
      if (mode === FLOAT_STRATEGY_OFFENSIVE_MODE) return true;
    } catch (e) {
      console.warn(
        `[Demeter] [${pipeline.label}] Mode read failed for strategy ${sid} (not treating as OFFENSIVE):`,
        e
      );
    }
  }
  return false;
}

export type FloatKeeperPipeline = {
  id: FloatKeeperPipelineId;
  label: string;
  keeperAddress: `0x${string}`;
  contractManagerAddress: `0x${string}`;
  strategyIds: number[];
  keeperTools: {
    performUpkeep: string;
    performUpkeepBatch: string;
    performHarvest: string;
  };
  auditKeeperPipeline: "float" | "float_v4";
  /** FloatContractManager `getAddress` registry key for the strategy contract. */
  strategyRegistryKey: FloatManagerStrategyKey;
  fetchComparison: (
    currentAssetAddress?: string | null,
    rankingMetrics?: TokenRankingMetricsMap,
    options?: { forceMarketBreadthStable?: boolean; disableMarketBreadth?: boolean }
  ) => Promise<unknown>;
  /** Run keeper upkeep + periodic offensive/defensive checks every N loop wakes (1 = every wake). */
  runEveryNLoops?: number;
};

export function parseKeeperStrategyIdsFromConfig(raw: string, label: string): number[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Invalid ${label} entry: ${s}`);
      }
      return n;
    });
}

export function buildFloatKeeperPipelines(): FloatKeeperPipeline[] {
  const v3Ids = parseKeeperStrategyIdsFromConfig(getStrategyIds(), "STRATEGY_IDS");
  const v4Ids = parseKeeperStrategyIdsFromConfig(getFloatV4StrategyIds(), "FLOAT_V4_STRATEGY_IDS");

  const pipelines: FloatKeeperPipeline[] = [
    {
      id: "v3",
      label: "Float V3",
      keeperAddress: getKeeperAddress() as `0x${string}`,
      contractManagerAddress: getFloatContractManagerAddress(),
      strategyIds: v3Ids,
      keeperTools: {
        performUpkeep: "keeperStrategy_performUpkeep",
        performUpkeepBatch: "keeperStrategy_performUpkeepBatch",
        performHarvest: "keeperStrategy_performHarvest",
      },
      auditKeeperPipeline: "float",
      strategyRegistryKey: "FloatStrategy",
      fetchComparison: (currentAssetAddress, rankingMetrics, options) =>
        fetchTokenComparison(
          undefined,
          undefined,
          rankingMetrics
            ? {
                rankingMetrics,
                changeStrategyStrictShortHorizons: true,
                offensiveMomentumAbsoluteGates: true,
                currentStrategyTokenAddress: currentAssetAddress ?? null,
                forceMarketBreadthStable: options?.forceMarketBreadthStable,
                disableMarketBreadth: options?.disableMarketBreadth,
                marketBreadthStableMode: "v3_usdc",
                rankingProfile: "float_v3",
              }
            : {
                currentStrategyTokenAddress: currentAssetAddress ?? null,
                forceMarketBreadthStable: options?.forceMarketBreadthStable,
                disableMarketBreadth: options?.disableMarketBreadth,
                marketBreadthStableMode: "v3_usdc",
                rankingProfile: "float_v3",
              }
        ),
    },
    {
      id: "v4",
      label: "Float V4",
      keeperAddress: getFloatV4KeeperAddress() as `0x${string}`,
      contractManagerAddress: getFloatContractManagerV4Address(),
      strategyIds: v4Ids,
      keeperTools: {
        performUpkeep: "keeperStrategyV4_performUpkeep",
        performUpkeepBatch: "keeperStrategyV4_performUpkeepBatch",
        performHarvest: "keeperStrategyV4_performHarvest",
      },
      auditKeeperPipeline: "float_v4",
      strategyRegistryKey: "FloatStrategyV4",
      runEveryNLoops: resolvePipelineRunEveryNLoops("v4"),
      fetchComparison: (currentAssetAddress, rankingMetrics, options) => {
        const v4FetchBase = {
          poolByToken: POOL_ADDRESS_BY_TOKEN_V4,
          currentStrategyTokenAddress: currentAssetAddress ?? null,
          forceMarketBreadthStable: options?.forceMarketBreadthStable,
          disableMarketBreadth: options?.disableMarketBreadth,
          /** Scheduled + defensive: cohort risk-off → WETH via exitStrategyToStable (not USDC). */
          marketBreadthStableMode: "v4_weth" as const,
        };
        return rankingMetrics
          ? fetchTokenComparison(TRITON_V4_TOKEN_ADDRESS_ARRAY, undefined, {
              ...v4FetchBase,
              rankingMetrics,
              changeStrategyStrictShortHorizons: true,
              offensiveMomentumAbsoluteGates: true,
              rankingProfile: "float_v4",
            })
          : fetchTokenComparison(TRITON_V4_TOKEN_ADDRESS_ARRAY, undefined, {
              ...v4FetchBase,
              rankingMetrics: getTokenRankingMetrics(),
              rankingProfile: "float_v4",
            });
      },
    },
  ];

  return pipelines.filter((p) => p.strategyIds.length > 0);
}
