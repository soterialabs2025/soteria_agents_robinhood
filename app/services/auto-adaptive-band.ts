/**
 * AutoKeeper adaptive outer/inner bands (±1 tickSpacing).
 * Owner-only: RH deployer/owner key must equal strategy.owner().
 * Apply is one atomic `setBandParams` (not Base’s two-step setters).
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
  getAutoBandOwnerAddress,
  getAutoBandOwnerPrivateKey,
  getAutoBandWidenRemints,
  getAutoBandWidenWindowMs,
  getAutoHarvestIntervalMsForTvlWei,
  isAutoAdaptiveBandEnabled,
} from "../config/auto-keeper-config";
import { resolveTxGasLimit } from "../config/demeter-tx-gas";
import { getSoteriaRepoRoot } from "../config/soteria-runtime-paths";
import { explorerTxUrl } from "../config/chain-config";
import { enqueueSerializedAddressTx } from "./operator-tx-queue";
import { readStrategyPoolValueWei } from "./strategy-pool-value-eligibility";

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
  if (!isAutoAdaptiveBandEnabled() || strategyIds.length === 0) return;
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
  mergePendingRemints(key, existing, nowMs);
  return existing;
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

async function applyBandParams(
  rpcUrl: string,
  stratAddr: Address,
  privateKey: string,
  target: {
    outerBelow: number;
    outerAbove: number;
    innerBelow: number;
    innerAbove: number;
  },
  logTag: string,
  strategyId: number
): Promise<void> {
  const account = privateKeyToAccount(normalizePk(privateKey));
  const wallet = createTritonWalletClient(privateKey, rpcUrl);
  const publicClient = createTritonPublicClient(rpcUrl);
  const args = [
    BigInt(target.outerBelow),
    BigInt(target.outerAbove),
    BigInt(target.innerBelow),
    BigInt(target.innerAbove),
  ] as const;

  await enqueueSerializedAddressTx(account.address, async () => {
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
      `[${logTag}] band setBandParams id=${strategyId} outer=${target.outerBelow}/${target.outerAbove} inner=${target.innerBelow}/${target.innerAbove} tx ${hash} ${explorerTxUrl(hash)}`
    );
  });
}

export type AutoBandRow = {
  id: number;
  stratAddr: Address;
  lastHarvest: number;
};

/** One band-controller pass for active Auto strategies in a pipeline. */
export async function runAutoAdaptiveBandPass(params: {
  rpcUrl: string;
  pipelineId: string;
  logTag: string;
  rows: readonly AutoBandRow[];
}): Promise<void> {
  if (!isAutoAdaptiveBandEnabled()) return;

  const privateKey = getAutoBandOwnerPrivateKey();
  if (!privateKey) return;

  const ownerSigner = getAutoBandOwnerAddress();
  const client = createTritonPublicClient(params.rpcUrl);
  const widenNeed = getAutoBandWidenRemints();
  const widenWindowMs = getAutoBandWidenWindowMs();
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  for (const row of params.rows) {
    try {
      const owner = (await client.readContract({
        address: row.stratAddr,
        abi: AUTO_STRATEGY_BAND_ABI,
        functionName: "owner",
      })) as Address;

      if (owner.toLowerCase() !== ownerSigner.toLowerCase()) {
        loadState();
        const key = stateKey(params.pipelineId, row.id);
        let st = memoryState.byKey[key];
        if (!st) {
          st = {
            bandOffset: 0,
            baselineOuterBelow: DEFAULT_AUTO_BAND_OUTER_TICKS,
            baselineOuterAbove: DEFAULT_AUTO_BAND_OUTER_TICKS,
            baselineInnerBelow: DEFAULT_AUTO_BAND_INNER_TICKS,
            baselineInnerAbove: DEFAULT_AUTO_BAND_INNER_TICKS,
            tickSpacing: DEFAULT_AUTO_BAND_TICK_SPACING,
            remintAtMs: [],
            lastTightenCheckMs: nowMs,
            ownerSkipLogged: true,
            baselinesLocked: false,
          };
          memoryState.byKey[key] = st;
          saveState();
          console.log(
            `[${params.logTag}] Band skip id=${row.id}: owner ${owner} ≠ Deployer ${ownerSigner}`
          );
        } else if (!st.ownerSkipLogged) {
          st.ownerSkipLogged = true;
          saveState();
          console.log(
            `[${params.logTag}] Band skip id=${row.id}: owner ${owner} ≠ Deployer ${ownerSigner}`
          );
        }
        continue;
      }

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
        Number(rangeBelow) === target.outerBelow &&
        Number(rangeAbove) === target.outerAbove &&
        Number(innerBelow) === target.innerBelow &&
        Number(innerAbove) === target.innerAbove
      ) {
        continue;
      }

      await applyBandParams(
        params.rpcUrl,
        row.stratAddr,
        privateKey,
        target,
        params.logTag,
        row.id
      );
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
