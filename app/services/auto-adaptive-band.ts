/**
 * AutoKeeper adaptive outer/inner bands (±1 tickSpacing).
 * Operator-signed (Owner still works): one atomic `setBandParams`.
 * Remint timestamps come from upkeep keeperCheck sims.
 */
import fs from "fs";
import path from "path";

import type { Abi, Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  createTritonPublicClient,
  createTritonWalletClient,
} from "../action-providers/liquid-strat-min-v4-action-provider";
import {
  DEFAULT_AUTO_BAND_INNER_TICKS,
  DEFAULT_AUTO_BAND_OUTER_TICKS,
  DEFAULT_AUTO_BAND_TICK_SPACING,
  getAutoBandLoopIntervalMs,
  getAutoBandOwnerSignerFallback,
  getAutoBandWidenRemints,
  getAutoBandWidenWindowMs,
  getAutoHarvestIntervalMsForTvlWei,
  isAutoAdaptiveBandEnabled,
  isAutoAdaptiveTargetEnabled,
} from "../config/auto-keeper-config";
import { resolveTxGasLimit } from "../config/demeter-tx-gas";
import { getSoteriaRepoRoot } from "../config/soteria-runtime-paths";
import { explorerTxUrl } from "../config/chain-config";
import { enqueueSerializedAddressTx } from "./operator-tx-queue";
import {
  sendWithOperatorFailover,
  type OperatorSigner,
} from "./operator-eth-failover";
import { readStrategyPoolValueWei } from "./strategy-pool-value-eligibility";
import {
  applyAdaptiveTarget,
  type TargetOffset,
} from "./auto-adaptive-target";
import type { AutoAmmKind } from "../config/rh-keeper-pipelines";

export const AUTO_STRATEGY_BAND_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "tickSpacing",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int24" }],
  },
  {
    type: "function",
    name: "rangeBelowTicks",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "rangeAboveTicks",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "innerBelowTicks",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "innerAboveTicks",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "setBandParams",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_rangeBelowTicks", type: "uint256" },
      { name: "_rangeAboveTicks", type: "uint256" },
      { name: "_innerBelowTicks", type: "uint256" },
      { name: "_innerAboveTicks", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

type BandOffset = -1 | 0 | 1;

type BandStrategyState = {
  bandOffset: BandOffset;
  targetOffset: TargetOffset;
  lastTargetWriteMs: number;
  baselineOuterBelow: number;
  baselineOuterAbove: number;
  baselineInnerBelow: number;
  baselineInnerAbove: number;
  tickSpacing: number;
  remintAtMs: number[];
  lastTightenCheckMs: number;
  ownerSkipLogged?: boolean;
  baselinesLocked?: boolean;
};

type BandPersisted = {
  version: 1;
  byKey: Record<string, BandStrategyState>;
};

const pendingRemints = new Map<string, number[]>();

function stateKey(pipelineId: string, strategyId: number): string {
  return `${pipelineId}:${strategyId}`;
}

function bandStatePath(): string {
  return path.join(getSoteriaRepoRoot(), "logs", "auto-adaptive-band-state.json");
}

let memoryState: BandPersisted = { version: 1, byKey: {} };
let loaded = false;

function loadState(): void {
  if (loaded) return;
  loaded = true;
  try {
    const p = bandStatePath();
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as BandPersisted;
    if (raw?.version === 1 && raw.byKey && typeof raw.byKey === "object") {
      memoryState = raw;
      for (const st of Object.values(memoryState.byKey)) {
        if (st.targetOffset !== -1 && st.targetOffset !== 0 && st.targetOffset !== 1) {
          st.targetOffset = 0;
        }
        if (typeof st.lastTargetWriteMs !== "number") {
          st.lastTargetWriteMs = 0;
        }
      }
    }
  } catch (e) {
    console.warn("[AutoBand] failed to load state:", e instanceof Error ? e.message : e);
  }
}

function saveState(): void {
  try {
    const p = bandStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(memoryState, null, 2), "utf8");
  } catch (e) {
    console.warn("[AutoBand] failed to save state:", e instanceof Error ? e.message : e);
  }
}

function pruneRemints(arr: number[], nowMs: number, windowMs: number): number[] {
  return arr.filter((t) => nowMs - t <= windowMs * 2);
}

/** Record remint-true strategy ids from an upkeep simulate pass. */
export function recordAutoRemintHits(
  pipelineId: string,
  strategyIds: readonly number[],
  nowMs = Date.now()
): void {
  if (
    (!isAutoAdaptiveBandEnabled() && !isAutoAdaptiveTargetEnabled()) ||
    strategyIds.length === 0
  ) {
    return;
  }
  loadState();
  const windowMs = getAutoBandWidenWindowMs();
  for (const id of strategyIds) {
    const key = stateKey(pipelineId, id);
    const st = memoryState.byKey[key];
    if (st) {
      st.remintAtMs.push(nowMs);
      st.remintAtMs = pruneRemints(st.remintAtMs, nowMs, windowMs);
    } else {
      const pending = pendingRemints.get(key) ?? [];
      pending.push(nowMs);
      pendingRemints.set(key, pruneRemints(pending, nowMs, windowMs));
    }
  }
  saveState();
}

function mergePendingRemints(key: string, st: BandStrategyState, nowMs: number): void {
  const pending = pendingRemints.get(key);
  if (!pending?.length) return;
  st.remintAtMs.push(...pending);
  st.remintAtMs = pruneRemints(st.remintAtMs, nowMs, getAutoBandWidenWindowMs());
  pendingRemints.delete(key);
}

function getOrCreateState(
  pipelineId: string,
  strategyId: number,
  baselines: {
    outerBelow: number;
    outerAbove: number;
    innerBelow: number;
    innerAbove: number;
    tickSpacing: number;
  },
  nowMs: number
): BandStrategyState {
  loadState();
  const key = stateKey(pipelineId, strategyId);
  let existing = memoryState.byKey[key];
  if (!existing) {
    existing = {
      bandOffset: 0,
      targetOffset: 0,
      lastTargetWriteMs: 0,
      baselineOuterBelow: baselines.outerBelow,
      baselineOuterAbove: baselines.outerAbove,
      baselineInnerBelow: baselines.innerBelow,
      baselineInnerAbove: baselines.innerAbove,
      tickSpacing: baselines.tickSpacing,
      remintAtMs: [],
      lastTightenCheckMs: nowMs,
      baselinesLocked: true,
    };
    memoryState.byKey[key] = existing;
    mergePendingRemints(key, existing, nowMs);
    saveState();
    return existing;
  }
  if (!existing.baselinesLocked) {
    existing.baselineOuterBelow = baselines.outerBelow;
    existing.baselineOuterAbove = baselines.outerAbove;
    existing.baselineInnerBelow = baselines.innerBelow;
    existing.baselineInnerAbove = baselines.innerAbove;
    existing.tickSpacing = baselines.tickSpacing;
    existing.baselinesLocked = true;
  }
  existing.tickSpacing = baselines.tickSpacing || existing.tickSpacing;
  if (existing.targetOffset !== -1 && existing.targetOffset !== 0 && existing.targetOffset !== 1) {
    existing.targetOffset = 0;
  }
  if (typeof existing.lastTargetWriteMs !== "number") {
    existing.lastTargetWriteMs = 0;
  }
  mergePendingRemints(key, existing, nowMs);
  return existing;
}

function emptyAdaptiveState(nowMs: number): BandStrategyState {
  return {
    bandOffset: 0,
    targetOffset: 0,
    lastTargetWriteMs: 0,
    baselineOuterBelow: DEFAULT_AUTO_BAND_OUTER_TICKS,
    baselineOuterAbove: DEFAULT_AUTO_BAND_OUTER_TICKS,
    baselineInnerBelow: DEFAULT_AUTO_BAND_INNER_TICKS,
    baselineInnerAbove: DEFAULT_AUTO_BAND_INNER_TICKS,
    tickSpacing: DEFAULT_AUTO_BAND_TICK_SPACING,
    remintAtMs: [],
    lastTightenCheckMs: nowMs,
    baselinesLocked: false,
  };
}

function ensureAdaptiveState(
  pipelineId: string,
  strategyId: number,
  nowMs: number
): BandStrategyState {
  loadState();
  const key = stateKey(pipelineId, strategyId);
  let st = memoryState.byKey[key];
  if (!st) {
    st = emptyAdaptiveState(nowMs);
    memoryState.byKey[key] = st;
    mergePendingRemints(key, st, nowMs);
    saveState();
    return st;
  }
  if (st.targetOffset !== -1 && st.targetOffset !== 0 && st.targetOffset !== 1) {
    st.targetOffset = 0;
  }
  if (typeof st.lastTargetWriteMs !== "number") {
    st.lastTargetWriteMs = 0;
  }
  mergePendingRemints(key, st, nowMs);
  return st;
}

function latestRemintMs(st: BandStrategyState): number {
  if (st.remintAtMs.length === 0) return 0;
  return Math.max(...st.remintAtMs);
}

async function runTargetForRow(params: {
  rpcUrl: string;
  pipelineId: string;
  logTag: string;
  amm: AutoAmmKind;
  row: AutoBandRow;
  trigger: "remint" | "band";
  nowMs: number;
  wallets: readonly OperatorSigner[];
}): Promise<void> {
  if (!isAutoAdaptiveTargetEnabled()) return;

  const st = ensureAdaptiveState(params.pipelineId, params.row.id, params.nowMs);
  if (
    params.trigger === "band" &&
    st.lastTargetWriteMs > 0 &&
    params.nowMs - st.lastTargetWriteMs < 60_000
  ) {
    return;
  }
  const lastRemint = latestRemintMs(st);
  const remintsSinceWrite = lastRemint > 0 && lastRemint > st.lastTargetWriteMs;

  try {
    const result = await applyAdaptiveTarget({
      rpcUrl: params.rpcUrl,
      logTag: params.logTag,
      strategyId: params.row.id,
      stratAddr: params.row.stratAddr,
      amm: params.amm,
      trigger: params.trigger,
      persistedOffset: st.targetOffset,
      remintsSinceWrite,
      lastRemintMs: lastRemint,
      nowMs: params.nowMs,
      wallets: params.wallets,
    });
    if (result.wrote) {
      st.targetOffset = result.wrote.offset;
      st.lastTargetWriteMs = params.nowMs;
      saveState();
    } else if (result.skipped && params.trigger === "remint") {
      console.log(
        `[${params.logTag}] Target skip id=${params.row.id} (before remint): ${result.skipped} — operator remint will use on-chain target`
      );
    }
  } catch (e) {
    console.warn(
      `[${params.logTag}] Target pass id=${params.row.id} failed:`,
      e instanceof Error ? e.message : e
    );
  }
}

function targetBands(st: BandStrategyState): {
  outerBelow: number;
  outerAbove: number;
  innerBelow: number;
  innerAbove: number;
} {
  const delta = st.bandOffset * st.tickSpacing;
  const outerBelow = Math.max(st.tickSpacing, st.baselineOuterBelow + delta);
  const outerAbove = Math.max(st.tickSpacing, st.baselineOuterAbove + delta);
  let innerBelow = Math.max(st.tickSpacing, st.baselineInnerBelow + delta);
  let innerAbove = Math.max(st.tickSpacing, st.baselineInnerAbove + delta);
  innerBelow = Math.min(innerBelow, outerBelow);
  innerAbove = Math.min(innerAbove, outerAbove);
  return { outerBelow, outerAbove, innerBelow, innerAbove };
}

function normalizePk(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function resolveBandTargetSigners(operators: readonly OperatorSigner[]): OperatorSigner[] {
  if (operators.length > 0) return [...operators];
  const owner = getAutoBandOwnerSignerFallback();
  return owner ? [owner] : [];
}

async function applyBandParams(
  rpcUrl: string,
  stratAddr: Address,
  wallets: readonly OperatorSigner[],
  target: {
    outerBelow: number;
    outerAbove: number;
    innerBelow: number;
    innerAbove: number;
  },
  logTag: string,
  strategyId: number
): Promise<void> {
  const publicClient = createTritonPublicClient(rpcUrl);
  const args = [
    BigInt(target.outerBelow),
    BigInt(target.outerAbove),
    BigInt(target.innerBelow),
    BigInt(target.innerAbove),
  ] as const;

  await sendWithOperatorFailover({
    wallets,
    strategyId,
    rpcUrl,
    logTag,
    action: "setBandParams",
    fn: async (signer) => {
      const account = privateKeyToAccount(normalizePk(signer.privateKey));
      const wallet = createTritonWalletClient(signer.privateKey, rpcUrl);
      await enqueueSerializedAddressTx(signer.address, async () => {
        const gasEst = await publicClient.estimateContractGas({
          address: stratAddr,
          abi: AUTO_STRATEGY_BAND_ABI,
          functionName: "setBandParams",
          args,
          account,
        });
        const gas = resolveTxGasLimit(gasEst);
        const hash = await wallet.writeContract({
          address: stratAddr,
          abi: AUTO_STRATEGY_BAND_ABI,
          functionName: "setBandParams",
          args,
          gas,
          account,
          chain: wallet.chain,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "reverted") {
          throw new Error(`setBandParams reverted: ${hash}`);
        }
        console.log(
          `[${logTag}] band setBandParams id=${strategyId} signer=${signer.id} ${signer.address} outer=${target.outerBelow}/${target.outerAbove} inner=${target.innerBelow}/${target.innerAbove} tx ${hash} ${explorerTxUrl(hash)}`
        );
      });
    },
  });
}

export type AutoBandRow = {
  id: number;
  stratAddr: Address;
  lastHarvest: number;
};

/** Write-before-upkeep: one target step per remint-true id, then caller remints. */
export async function applyAdaptiveTargetsBeforeUpkeep(params: {
  rpcUrl: string;
  pipelineId: string;
  logTag: string;
  amm: AutoAmmKind;
  rows: readonly AutoBandRow[];
  wallets: readonly OperatorSigner[];
}): Promise<void> {
  if (!isAutoAdaptiveTargetEnabled() || params.rows.length === 0) return;
  const wallets = resolveBandTargetSigners(params.wallets);
  if (wallets.length === 0) {
    console.warn(`[${params.logTag}] Target before remint skipped — no operator/Owner signer`);
    return;
  }
  const nowMs = Date.now();
  for (const row of params.rows) {
    await runTargetForRow({
      rpcUrl: params.rpcUrl,
      pipelineId: params.pipelineId,
      logTag: params.logTag,
      amm: params.amm,
      row,
      trigger: "remint",
      nowMs,
      wallets,
    });
  }
}

/** One band-controller pass for active Auto strategies in a pipeline. */
export async function runAutoAdaptiveBandPass(params: {
  rpcUrl: string;
  pipelineId: string;
  logTag: string;
  amm: AutoAmmKind;
  rows: readonly AutoBandRow[];
  wallets: readonly OperatorSigner[];
}): Promise<void> {
  const bandOn = isAutoAdaptiveBandEnabled();
  const targetOn = isAutoAdaptiveTargetEnabled();
  if (!bandOn && !targetOn) return;

  const wallets = resolveBandTargetSigners(params.wallets);
  if (wallets.length === 0) {
    console.warn(`[${params.logTag}] Band pass skipped — no operator/Owner signer`);
    return;
  }

  const client = createTritonPublicClient(params.rpcUrl);
  const widenNeed = getAutoBandWidenRemints();
  const widenWindowMs = getAutoBandWidenWindowMs();
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  for (const row of params.rows) {
    try {
      if (bandOn) {
        const [tickSpacingRaw, rangeBelow, rangeAbove, innerBelow, innerAbove] = await Promise.all([
          client.readContract({
            address: row.stratAddr,
            abi: AUTO_STRATEGY_BAND_ABI,
            functionName: "tickSpacing",
          }),
          client.readContract({
            address: row.stratAddr,
            abi: AUTO_STRATEGY_BAND_ABI,
            functionName: "rangeBelowTicks",
          }),
          client.readContract({
            address: row.stratAddr,
            abi: AUTO_STRATEGY_BAND_ABI,
            functionName: "rangeAboveTicks",
          }),
          client.readContract({
            address: row.stratAddr,
            abi: AUTO_STRATEGY_BAND_ABI,
            functionName: "innerBelowTicks",
          }),
          client.readContract({
            address: row.stratAddr,
            abi: AUTO_STRATEGY_BAND_ABI,
            functionName: "innerAboveTicks",
          }),
        ]);

        const tickSpacing = Math.abs(Number(tickSpacingRaw)) || DEFAULT_AUTO_BAND_TICK_SPACING;
        const st = getOrCreateState(
          params.pipelineId,
          row.id,
          {
            outerBelow: Number(rangeBelow) || DEFAULT_AUTO_BAND_OUTER_TICKS,
            outerAbove: Number(rangeAbove) || DEFAULT_AUTO_BAND_OUTER_TICKS,
            innerBelow: Number(innerBelow) || DEFAULT_AUTO_BAND_INNER_TICKS,
            innerAbove: Number(innerAbove) || DEFAULT_AUTO_BAND_INNER_TICKS,
            tickSpacing,
          },
          nowMs
        );

        st.remintAtMs = pruneRemints(st.remintAtMs, nowMs, widenWindowMs);
        const remintsInWindow = st.remintAtMs.filter((t) => nowMs - t <= widenWindowMs).length;

        let nextOffset: BandOffset = st.bandOffset;

        if (st.bandOffset < 0 && remintsInWindow > 0) {
          nextOffset = 0;
          console.log(
            `[${params.logTag}] Band restore id=${row.id}: remint while tightened → offset 0`
          );
        } else if (remintsInWindow >= widenNeed && st.bandOffset < 1) {
          nextOffset = 1;
          console.log(
            `[${params.logTag}] Band widen id=${row.id}: ${remintsInWindow} remints in ${widenWindowMs / 60000}m → offset +1`
          );
        } else {
          const tvl = (await readStrategyPoolValueWei(row.stratAddr, params.rpcUrl)) ?? 0n;
          const harvestMs = getAutoHarvestIntervalMsForTvlWei(tvl);
          const quiet =
            remintsInWindow === 0 &&
            nowMs - st.lastTightenCheckMs >= harvestMs &&
            (row.lastHarvest === 0 || nowSec - row.lastHarvest >= Math.floor(harvestMs / 1000));
          if (quiet && st.bandOffset > -1) {
            nextOffset = (st.bandOffset - 1) as BandOffset;
            st.lastTightenCheckMs = nowMs;
            console.log(
              `[${params.logTag}] Band tighten id=${row.id}: stable ≥${harvestMs / 3600000}h → offset ${nextOffset}`
            );
          }
        }

        if (nextOffset !== st.bandOffset) {
          st.bandOffset = nextOffset;
          saveState();
        }

        const target = targetBands(st);
        if (
          Number(rangeBelow) !== target.outerBelow ||
          Number(rangeAbove) !== target.outerAbove ||
          Number(innerBelow) !== target.innerBelow ||
          Number(innerAbove) !== target.innerAbove
        ) {
          await applyBandParams(
            params.rpcUrl,
            row.stratAddr,
            wallets,
            target,
            params.logTag,
            row.id
          );
        }
      }

      await runTargetForRow({
        rpcUrl: params.rpcUrl,
        pipelineId: params.pipelineId,
        logTag: params.logTag,
        amm: params.amm,
        row,
        trigger: "band",
        nowMs,
        wallets,
      });
    } catch (e) {
      console.warn(
        `[${params.logTag}] Band pass id=${row.id} failed:`,
        e instanceof Error ? e.message : e
      );
    }
  }
}

export function getAutoBandLoopSleepMs(): number {
  return getAutoBandLoopIntervalMs();
}
