/**
 * Owner-only adaptive `targetAssetBps`.
 * Measures the mix remint would flatten and steps 3000 / 5000 / 7000 toward that mix.
 * Writes belong in the band loop and immediately before remint — never harvest.
 * Signed by a registered operator (Owner still works).
 */
import type { Abi, Address, PublicClient } from "viem";
import { erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  createTritonPublicClient,
  createTritonWalletClient,
} from "../action-providers/liquid-strat-min-v4-action-provider";
import {
  getAutoHarvestDustTvlWei,
  getAutoHarvestIntervalMsForTvlWei,
  getAutoTargetBpsConfig,
  isAutoAdaptiveTargetEnabled,
  type AutoTargetBpsConfig,
} from "../config/auto-keeper-config";
import { getWethAddress, explorerTxUrl } from "../config/chain-config";
import { resolveTxGasLimit } from "../config/demeter-tx-gas";
import type { AutoAmmKind } from "../config/rh-keeper-pipelines";
import { enqueueSerializedAddressTx } from "./operator-tx-queue";
import {
  sendWithOperatorFailover,
  type OperatorSigner,
} from "./operator-eth-failover";

export const AUTO_STRATEGY_TARGET_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "targetAssetBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "setTargetAssetBps",
    stateMutability: "nonpayable",
    inputs: [{ name: "bps", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "hasBandBase",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "lastBandBaseTick",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int24" }],
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
    name: "reservedAsset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "reservedWeth",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOfPool",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "assetAmt", type: "uint256" },
      { name: "wethAmt", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "balanceOfIdle",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "poolValue",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "poolValueTwap",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lastRebalanceTime",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ASSET",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "refTick",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int24" }],
  },
  {
    type: "function",
    name: "pool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "poolKey",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
    ],
  },
] as const satisfies Abi;

const UNIV3_POOL_ABI = [
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const satisfies Abi;

export type TargetOffset = -1 | 0 | 1;

export type TargetTrigger = "remint" | "band";

export type TargetDecision =
  | { kind: "write"; bps: number; nextOffset: TargetOffset; reason: string }
  | { kind: "skip"; reason: string };

function normalizePk(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function subOrZero(bal: bigint, reserved: bigint): bigint {
  return bal > reserved ? bal - reserved : 0n;
}

export function targetBpsFromOffset(offset: TargetOffset, cfg: AutoTargetBpsConfig): number {
  return cfg.baseBps + offset * cfg.stepBps;
}

/** Snap an on-chain bps to the nearest stack offset. */
export function offsetFromTargetBps(bps: number, cfg: AutoTargetBpsConfig): TargetOffset {
  const asMin = Math.abs(bps - cfg.minBps);
  const asBase = Math.abs(bps - cfg.baseBps);
  const asMax = Math.abs(bps - cfg.maxBps);
  if (asMax < asBase && asMax < asMin) return 1;
  if (asMin < asBase && asMin <= asMax) return -1;
  return 0;
}

export function desiredBpsFromMix(mixBps: number, cfg: AutoTargetBpsConfig): number {
  const skew = mixBps - cfg.baseBps;
  if (Math.abs(skew) < cfg.deadbandBps) return cfg.baseBps;
  return skew > 0 ? cfg.maxBps : cfg.minBps;
}

function stepToward(
  currentOffset: TargetOffset,
  desiredBps: number,
  cfg: AutoTargetBpsConfig
): TargetOffset {
  const desiredOffset = offsetFromTargetBps(desiredBps, cfg);
  if (desiredOffset === currentOffset) return currentOffset;
  return (currentOffset + Math.sign(desiredOffset - currentOffset)) as TargetOffset;
}

export function decideTargetWrite(params: {
  onChainBps: number;
  persistedOffset: TargetOffset;
  mixBps: number;
  trigger: TargetTrigger;
  remintsSinceWrite: boolean;
  quietRestore: boolean;
  cfg?: AutoTargetBpsConfig;
}): TargetDecision {
  const cfg = params.cfg ?? getAutoTargetBpsConfig();
  const desiredBps = desiredBpsFromMix(params.mixBps, cfg);
  const currentOffset = offsetFromTargetBps(params.onChainBps, cfg);
  const adopted =
    currentOffset === params.persistedOffset ? params.persistedOffset : currentOffset;

  if (params.onChainBps === desiredBps) {
    return { kind: "skip", reason: `on-chain already ${desiredBps}` };
  }

  const allowStep =
    params.trigger === "remint" || params.remintsSinceWrite || params.quietRestore;
  if (!allowStep) {
    return { kind: "skip", reason: "no remint since last write (band wake)" };
  }

  const restore = params.quietRestore && desiredBps === cfg.baseBps;
  const nextOffset = restore ? 0 : stepToward(adopted, desiredBps, cfg);
  const nextBps = targetBpsFromOffset(nextOffset, cfg);

  if (nextBps === params.onChainBps) {
    return { kind: "skip", reason: `step already on-chain ${nextBps}` };
  }

  const delta = Math.abs(nextBps - params.onChainBps);
  const isRestoreToBase = nextBps === cfg.baseBps;
  if (delta !== cfg.stepBps && !isRestoreToBase) {
    return {
      kind: "skip",
      reason: `reject jump on-chain ${params.onChainBps} → ${nextBps} (need ±${cfg.stepBps} or restore to ${cfg.baseBps})`,
    };
  }

  const reason = restore
    ? `restore ${params.onChainBps} → ${nextBps} (quiet + mix in deadband)`
    : `step ${params.onChainBps} → ${nextBps} (mix ${params.mixBps} desired ${desiredBps})`;
  return { kind: "write", bps: nextBps, nextOffset, reason };
}

export function mixBpsFromValues(assetValue: bigint, wethValue: bigint): number | null {
  const total = assetValue + wethValue;
  if (total <= 0n) return null;
  return Number((10_000n * assetValue) / total);
}

function lpAssetValueWeth(poolValue: bigint, poolWeth: bigint): bigint {
  return poolValue > poolWeth ? poolValue - poolWeth : 0n;
}

function priceAssetInWeth(
  assetAmt: bigint,
  poolAsset: bigint,
  poolWeth: bigint,
  poolValue: bigint
): bigint | null {
  if (assetAmt === 0n) return 0n;
  const lpAssetWeth = lpAssetValueWeth(poolValue, poolWeth);
  if (poolAsset === 0n || lpAssetWeth === 0n) return null;
  return (assetAmt * lpAssetWeth) / poolAsset;
}

type SideHint = {
  assetDumped: boolean | null;
  exitedHigh: boolean;
  exitedLow: boolean;
  assetIsToken0: boolean | null;
};

async function readSideHint(
  client: PublicClient,
  stratAddr: Address,
  amm: AutoAmmKind,
  asset: Address
): Promise<SideHint> {
  const empty: SideHint = {
    assetDumped: null,
    exitedHigh: false,
    exitedLow: false,
    assetIsToken0: null,
  };
  try {
    const [hasBase, lastBase, innerBelow, innerAbove] = await Promise.all([
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "hasBandBase",
      }),
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "lastBandBaseTick",
      }),
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "innerBelowTicks",
      }),
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "innerAboveTicks",
      }),
    ]);
    if (!hasBase) return empty;

    let tick: number;
    let assetIsToken0: boolean;
    if (amm === "v4") {
      const [refTick, poolKey] = await Promise.all([
        client.readContract({
          address: stratAddr,
          abi: AUTO_STRATEGY_TARGET_ABI,
          functionName: "refTick",
        }),
        client.readContract({
          address: stratAddr,
          abi: AUTO_STRATEGY_TARGET_ABI,
          functionName: "poolKey",
        }),
      ]);
      tick = Number(refTick);
      assetIsToken0 = poolKey.currency0.toLowerCase() === asset.toLowerCase();
    } else {
      const pool = (await client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "pool",
      })) as Address;
      const [token0, slot0] = await Promise.all([
        client.readContract({
          address: pool,
          abi: UNIV3_POOL_ABI,
          functionName: "token0",
        }),
        client.readContract({
          address: pool,
          abi: UNIV3_POOL_ABI,
          functionName: "slot0",
        }),
      ]);
      tick = Number(slot0[1]);
      assetIsToken0 = token0.toLowerCase() === asset.toLowerCase();
    }

    const base = Number(lastBase);
    const exitedHigh = tick > base + Number(innerAbove);
    const exitedLow = tick < base - Number(innerBelow);
    const assetDumped = assetIsToken0 ? exitedLow : exitedHigh;
    return { assetDumped, exitedHigh, exitedLow, assetIsToken0 };
  } catch {
    return empty;
  }
}

export type TargetSnapshot = {
  onChainBps: number;
  mixBps: number;
  poolValue: bigint;
  lastRebalanceSec: number;
  usedPoolMix: boolean;
  onChainOwner: Address;
};

export async function readTargetSnapshot(
  rpcUrl: string,
  stratAddr: Address,
  amm: AutoAmmKind,
  logTag: string,
  strategyId: number
): Promise<{ ok: TargetSnapshot } | { skip: string }> {
  const client = createTritonPublicClient(rpcUrl);
  const cfg = getAutoTargetBpsConfig();
  const dust = getAutoHarvestDustTvlWei();

  const owner = (await client.readContract({
    address: stratAddr,
    abi: AUTO_STRATEGY_TARGET_ABI,
    functionName: "owner",
  })) as Address;

  const hasBandBase = (await client.readContract({
    address: stratAddr,
    abi: AUTO_STRATEGY_TARGET_ABI,
    functionName: "hasBandBase",
  })) as boolean;
  if (!hasBandBase) {
    return { skip: "hasBandBase=false" };
  }

  if (amm === "v3") {
    try {
      const twap = (await client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "poolValueTwap",
      })) as bigint;
      if (twap === 0n) {
        return { skip: "poolValueTwap=0 (V3 remint would skip swap)" };
      }
    } catch {
      return { skip: "poolValueTwap unread" };
    }
  }

  const [onChainRaw, reservedAsset, reservedWeth, poolBal, poolValue, lastRebalance, asset] =
    await Promise.all([
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "targetAssetBps",
      }),
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "reservedAsset",
      }),
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "reservedWeth",
      }),
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "balanceOfPool",
      }),
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "poolValue",
      }),
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "lastRebalanceTime",
      }),
      client.readContract({
        address: stratAddr,
        abi: AUTO_STRATEGY_TARGET_ABI,
        functionName: "ASSET",
      }),
    ]);

  const poolValueWei = poolValue as bigint;
  if (poolValueWei < dust) {
    return { skip: `poolValue ${poolValueWei} < dust ${dust}` };
  }

  const assetAddr = asset as Address;
  const assetBal = (await client.readContract({
    address: assetAddr,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [stratAddr],
  })) as bigint;

  const wethBal =
    amm === "v4"
      ? await client.getBalance({ address: stratAddr })
      : ((await client.readContract({
          address: getWethAddress(),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [stratAddr],
        })) as bigint);

  const [poolAsset, poolWeth] = poolBal as readonly [bigint, bigint];
  const deployableAsset = subOrZero(assetBal, reservedAsset as bigint);
  const deployableWeth = subOrZero(wethBal, reservedWeth as bigint);
  const priced = priceAssetInWeth(deployableAsset, poolAsset, poolWeth, poolValueWei);
  if (priced === null && deployableAsset > 0n) {
    return { skip: "cannot price ASSET from poolValue/balanceOfPool" };
  }

  const idleAssetWeth = priced ?? 0n;
  const idleValue = idleAssetWeth + deployableWeth;
  let assetValue: bigint;
  let wethValue: bigint;
  let usedPoolMix = false;
  if (idleValue < cfg.minIdleWei) {
    assetValue = lpAssetValueWeth(poolValueWei, poolWeth);
    wethValue = poolWeth;
    usedPoolMix = true;
  } else {
    assetValue = idleAssetWeth;
    wethValue = deployableWeth;
  }

  const mixBps = mixBpsFromValues(assetValue, wethValue);
  if (mixBps === null) {
    return { skip: "zero mix (no deployable or pool inventory)" };
  }

  const side = await readSideHint(client, stratAddr, amm, assetAddr);
  if (side.assetDumped !== null) {
    const mixSaysAsset = mixBps > getAutoTargetBpsConfig().baseBps;
    if (side.assetDumped !== mixSaysAsset) {
      console.log(
        `[${logTag}] Target mix/side disagree id=${strategyId}: mix=${mixBps} assetDumped=${side.assetDumped} exitedHigh=${side.exitedHigh} exitedLow=${side.exitedLow} — trust mix`
      );
    }
  }

  return {
    ok: {
      onChainBps: Number(onChainRaw),
      mixBps,
      poolValue: poolValueWei,
      lastRebalanceSec: Number(lastRebalance),
      usedPoolMix,
      onChainOwner: owner,
    },
  };
}

async function applyTargetAssetBps(
  rpcUrl: string,
  stratAddr: Address,
  wallets: readonly OperatorSigner[],
  bps: number,
  logTag: string,
  strategyId: number,
  reason: string
): Promise<void> {
  const publicClient = createTritonPublicClient(rpcUrl);
  const args = [BigInt(bps)] as const;

  await sendWithOperatorFailover({
    wallets,
    strategyId,
    rpcUrl,
    logTag,
    action: "setTargetAssetBps",
    fn: async (signer) => {
      const account = privateKeyToAccount(normalizePk(signer.privateKey));
      const wallet = createTritonWalletClient(signer.privateKey, rpcUrl);
      await enqueueSerializedAddressTx(signer.address, async () => {
        const gasEst = await publicClient.estimateContractGas({
          address: stratAddr,
          abi: AUTO_STRATEGY_TARGET_ABI,
          functionName: "setTargetAssetBps",
          args,
          account,
        });
        const gas = resolveTxGasLimit(gasEst);
        const hash = await wallet.writeContract({
          address: stratAddr,
          abi: AUTO_STRATEGY_TARGET_ABI,
          functionName: "setTargetAssetBps",
          args,
          gas,
          account,
          chain: wallet.chain,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "reverted") {
          throw new Error(`setTargetAssetBps reverted: ${hash}`);
        }
        const readback = (await publicClient.readContract({
          address: stratAddr,
          abi: AUTO_STRATEGY_TARGET_ABI,
          functionName: "targetAssetBps",
        })) as bigint;
        console.log(
          `[${logTag}] target setTargetAssetBps id=${strategyId} signer=${signer.id} ${signer.address} bps=${bps} readback=${readback} ${reason} tx ${hash} ${explorerTxUrl(hash)}`
        );
      });
    },
  });
}

export type TargetApplyInput = {
  rpcUrl: string;
  logTag: string;
  strategyId: number;
  stratAddr: Address;
  amm: AutoAmmKind;
  trigger: TargetTrigger;
  persistedOffset: TargetOffset;
  remintsSinceWrite: boolean;
  lastRemintMs: number;
  nowMs: number;
  wallets: readonly OperatorSigner[];
};

export type TargetApplyResult = {
  skipped?: string;
  wrote?: { bps: number; offset: TargetOffset };
  lastRebalanceSec?: number;
  mixBps?: number;
};

/**
 * Read mix, decide one step, write if allowed.
 * Caller persists `targetOffset` / `lastTargetWriteMs`.
 */
export async function applyAdaptiveTarget(input: TargetApplyInput): Promise<TargetApplyResult> {
  if (!isAutoAdaptiveTargetEnabled()) {
    return { skipped: "AUTO_ADAPTIVE_TARGET off" };
  }

  const snap = await readTargetSnapshot(
    input.rpcUrl,
    input.stratAddr,
    input.amm,
    input.logTag,
    input.strategyId
  );
  if ("skip" in snap) {
    return { skipped: snap.skip };
  }

  const cfg = getAutoTargetBpsConfig();
  const harvestMs = getAutoHarvestIntervalMsForTvlWei(snap.ok.poolValue);
  const lastRemintMs = Math.max(
    input.lastRemintMs,
    snap.ok.lastRebalanceSec > 0 ? snap.ok.lastRebalanceSec * 1000 : 0
  );
  const quiet =
    lastRemintMs > 0 &&
    input.nowMs - lastRemintMs >= harvestMs &&
    Math.abs(snap.ok.mixBps - cfg.baseBps) < cfg.deadbandBps;

  const decision = decideTargetWrite({
    onChainBps: snap.ok.onChainBps,
    persistedOffset: input.persistedOffset,
    mixBps: snap.ok.mixBps,
    trigger: input.trigger,
    remintsSinceWrite: input.remintsSinceWrite,
    quietRestore: quiet && input.trigger === "band",
    cfg,
  });

  if (decision.kind === "skip") {
    return {
      skipped: decision.reason,
      lastRebalanceSec: snap.ok.lastRebalanceSec,
      mixBps: snap.ok.mixBps,
    };
  }

  await applyTargetAssetBps(
    input.rpcUrl,
    input.stratAddr,
    input.wallets,
    decision.bps,
    input.logTag,
    input.strategyId,
    `${decision.reason}${snap.ok.usedPoolMix ? " pool-mix" : " idle-mix"}`
  );
  return {
    wrote: { bps: decision.bps, offset: decision.nextOffset },
    lastRebalanceSec: snap.ok.lastRebalanceSec,
    mixBps: snap.ok.mixBps,
  };
}
