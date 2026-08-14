import { customActionProvider, WalletProvider, EvmWalletProvider } from "@coinbase/agentkit";
import { z } from "zod";
import type { Abi, Address, TransactionReceipt } from "viem";
import { createPublicClient, encodeFunctionData, http, parseEventLogs, zeroAddress } from "viem";

import floatKeeperArtifact from "../abi/FloatKeeper.json";
import floatKeeperV4Artifact from "../abi/FloatKeeperV4.json";
import floatStrategyV4Artifact from "../abi/FloatStrategyV4.json";
import { getViemChain } from "../config/chain-config";
import { getFloatV4KeeperAddress } from "../config/demeter-config";
import {
  type FloatManagerStrategyKey,
  getFloatStrategyStatsAtAddress,
  getStrategyHarvestTimestampsAtAddress,
  getStrategyUniswapFeesCollectedAtAddress,
  isFloatV4HarvestSettled,
  shouldStopFloatHarvestRetryAttempts,
} from "./float-action-provider";
import { sendEvmTxWithGasHeadroom, sendEvmTxWithGasHeadroomFromPrivateKey } from "../services/demeter-wallet-tx";

/**
 * KeeperStrategy Action Provider
 *
 * Provides actions for interacting with the FloatKeeper / FloatKeeperV4 contracts.
 * Strategy id = 0-based index into keeper.watched[].
 */
const KEEPER_ABI = floatKeeperArtifact.abi as Abi;
const KEEPER_V4_ABI = floatKeeperV4Artifact.abi as Abi;
const FLOAT_STRATEGY_V4_ABI = floatStrategyV4Artifact.abi as Abi;

/** FloatStrategyV4.mode — NEUTRAL (3); used for logging only. Harvest runs in NORMAL/DEFENSIVE/OFFENSIVE per keeper. */
export const FLOAT_STRATEGY_V4_NEUTRAL_MODE = 3;

export type KeeperPipelineId = "v3" | "v4";

/** Keeper contract ABI — prefer `pipelineId`; falls back to V4 keeper address match. */
export function resolveKeeperAbi(
  keeperAddress: Address,
  pipelineId?: KeeperPipelineId
): Abi {
  if (pipelineId === "v4") return KEEPER_V4_ABI;
  if (pipelineId === "v3") return KEEPER_ABI;
  return keeperAddress.toLowerCase() === getFloatV4KeeperAddress().toLowerCase()
    ? KEEPER_V4_ABI
    : KEEPER_ABI;
}

const HARVEST_RECEIPT_TIMEOUT_MS = 120_000;
const HARVEST_LAST_HARVEST_POLL_MS = 2_000;
const HARVEST_LAST_HARVEST_POLL_MAX_MS = 60_000;
/** Extra read after poll window when receipt shows didAct=false (RPC/index lag). */
const HARVEST_DEFERRED_CONFIRM_MS = 8_000;

export type KeeperWatchedRow = {
  strategyAddress: Address;
  minIntervalSec: number;
  lastActionSec: number;
  active: boolean;
};

/** FloatKeeper.watched(id) — used for harvest pacing and minInterval diagnostics. */
export async function getKeeperWatchedRow(
  keeperAddress: Address,
  strategyId: number,
  rpcUrl: string,
  pipelineId?: KeeperPipelineId
): Promise<KeeperWatchedRow> {
  const client = createPublicClient({ chain: getViemChain(), transport: http(rpcUrl) });
  const keeperAbi = resolveKeeperAbi(keeperAddress, pipelineId);
  const row = await client.readContract({
    address: keeperAddress,
    abi: keeperAbi,
    functionName: "watched",
    args: [BigInt(strategyId)],
  });
  const [stratAddr, minInterval, lastAction, active] = row as readonly [
    Address,
    number,
    number,
    boolean,
  ];
  if (!stratAddr || stratAddr === zeroAddress) {
    throw new Error(`No strategy at keeper index ${strategyId}`);
  }
  return {
    strategyAddress: stratAddr,
    minIntervalSec: Number(minInterval),
    lastActionSec: Number(lastAction),
    active: Boolean(active),
  };
}

/**
 * Keeper `performHarvest` / `performUpkeep` emit `UpkeepPerformed` with `didAct`.
 * `didAct=false` means the keeper returned without a successful `harvestBoolean` (interval gate, inactive, or revert).
 */
export function parsePerformHarvestUpkeepDidAct(
  receipt: Pick<TransactionReceipt, "logs">,
  keeperAddress: Address,
  strategyId: number,
  pipelineId?: KeeperPipelineId
): boolean | null {
  const keeperAbi = resolveKeeperAbi(keeperAddress, pipelineId);
  const events = parseEventLogs({
    abi: keeperAbi,
    eventName: "UpkeepPerformed",
    logs: receipt.logs,
  });
  const matches = events.filter((e) => {
    const args = e.args as { id?: bigint; didAct?: boolean };
    return args.id != null && Number(args.id) === strategyId;
  });
  if (matches.length === 0) return null;
  return matches.some((e) => (e.args as { didAct?: boolean }).didAct === true);
}

export type KeeperHarvestConfirmationResult =
  | {
      ok: true;
      txHash: string;
      strategyAddress: string;
      baselineLastHarvest: number;
      lastHarvest: number;
      prevHarvestTime: number;
      /** How success was detected (V4 often never bumps `lastHarvest` on fee-collection harvests). */
      harvestSignal?: "lastHarvest" | "prevHarvestTime" | "uniswapFees" | "keeperDidAct";
    }
  | {
      ok: false;
      reason: string;
      txHash?: string;
      receiptStatus?: "success" | "reverted";
      strategyAddress?: string;
      baselineLastHarvest?: number;
      lastHarvest?: number;
      prevHarvestTime?: number;
      /** When true, skip 1-minute harvest retries (preflight sim failed or harvestBoolean reverts in keeper). */
      v4SkipRapidHarvestRetry?: boolean;
    };

/**
 * Submit performHarvest, wait for receipt, then poll strategy `lastHarvest` until it advances (or timeout).
 * Demeter used to only wait 3s after `sendTransaction` (hash returned before mine) — that caused false retries.
 */
export async function executeKeeperHarvestWithConfirmation(
  walletProvider: EvmWalletProvider,
  keeperAddress: Address,
  strategyId: number,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey,
  pipelineId?: KeeperPipelineId,
  skipIncreaseLiquidity = false
): Promise<KeeperHarvestConfirmationResult> {
  const isV4 = strategyRegistryKey === "FloatStrategyV4";
  let baseline: Awaited<ReturnType<typeof getKeeperStrategyHarvestTimestamps>>;
  let baselineFeesCollected = 0n;
  let baselineWatched: KeeperWatchedRow | null = null;
  try {
    baseline = await getKeeperStrategyHarvestTimestamps(
      keeperAddress,
      strategyId,
      rpcUrl,
      strategyRegistryKey,
      pipelineId
    );
    baselineWatched = await getKeeperWatchedRow(keeperAddress, strategyId, rpcUrl, pipelineId);
    if (isV4) {
      baselineFeesCollected = await getStrategyUniswapFeesCollectedAtAddress(
        baseline.strategyAddress as Address,
        rpcUrl,
        strategyRegistryKey
      );
    }
  } catch (e) {
    return {
      ok: false,
      reason: `baseline harvest read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (baselineWatched && !baselineWatched.active) {
    return {
      ok: false,
      reason: `keeper watched[${strategyId}] is inactive — performHarvest will no-op`,
      strategyAddress: baseline.strategyAddress,
      baselineLastHarvest: baseline.lastHarvest,
    };
  }

  if (isV4) {
    const preflight = await preflightFloatV4KeeperHarvest(
      keeperAddress,
      baseline.strategyAddress as Address,
      rpcUrl,
      skipIncreaseLiquidity
    );
    if (!preflight.canHarvest) {
      return {
        ok: false,
        reason: preflight.reason,
        strategyAddress: baseline.strategyAddress,
        baselineLastHarvest: baseline.lastHarvest,
        v4SkipRapidHarvestRetry: preflight.skipRapidRetry,
      };
    }
  }

  let txHash: string;
  try {
    txHash = await sendKeeperPerformHarvest(
      walletProvider,
      keeperAddress,
      strategyId,
      skipIncreaseLiquidity,
      pipelineId
    );
  } catch (e) {
    return {
      ok: false,
      reason: `performHarvest submit failed: ${e instanceof Error ? e.message : String(e)}`,
      strategyAddress: baseline.strategyAddress,
      baselineLastHarvest: baseline.lastHarvest,
    };
  }

  return confirmKeeperHarvestTx(
    txHash,
    keeperAddress,
    strategyId,
    rpcUrl,
    strategyRegistryKey,
    pipelineId,
    baseline,
    baselineFeesCollected,
    baselineWatched,
    isV4
  );
}

/**
 * Same as {@link executeKeeperHarvestWithConfirmation} but signs with an operator shard private key.
 */
export async function executeKeeperHarvestWithConfirmationFromPrivateKey(
  privateKey: string,
  keeperAddress: Address,
  strategyId: number,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey,
  pipelineId?: KeeperPipelineId,
  skipIncreaseLiquidity = false
): Promise<KeeperHarvestConfirmationResult> {
  const isV4 = strategyRegistryKey === "FloatStrategyV4";
  let baseline: Awaited<ReturnType<typeof getKeeperStrategyHarvestTimestamps>>;
  let baselineFeesCollected = 0n;
  let baselineWatched: KeeperWatchedRow | null = null;
  try {
    baseline = await getKeeperStrategyHarvestTimestamps(
      keeperAddress,
      strategyId,
      rpcUrl,
      strategyRegistryKey,
      pipelineId
    );
    baselineWatched = await getKeeperWatchedRow(keeperAddress, strategyId, rpcUrl, pipelineId);
    if (isV4) {
      baselineFeesCollected = await getStrategyUniswapFeesCollectedAtAddress(
        baseline.strategyAddress as Address,
        rpcUrl,
        strategyRegistryKey
      );
    }
  } catch (e) {
    return {
      ok: false,
      reason: `baseline harvest read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (baselineWatched && !baselineWatched.active) {
    return {
      ok: false,
      reason: `keeper watched[${strategyId}] is inactive — performHarvest will no-op`,
      strategyAddress: baseline.strategyAddress,
      baselineLastHarvest: baseline.lastHarvest,
    };
  }

  if (isV4) {
    const preflight = await preflightFloatV4KeeperHarvest(
      keeperAddress,
      baseline.strategyAddress as Address,
      rpcUrl,
      skipIncreaseLiquidity
    );
    if (!preflight.canHarvest) {
      return {
        ok: false,
        reason: preflight.reason,
        strategyAddress: baseline.strategyAddress,
        baselineLastHarvest: baseline.lastHarvest,
        v4SkipRapidHarvestRetry: preflight.skipRapidRetry,
      };
    }
  }

  let txHash: string;
  try {
    txHash = await sendKeeperPerformHarvestFromPrivateKey(
      privateKey,
      keeperAddress,
      strategyId,
      skipIncreaseLiquidity,
      pipelineId,
      rpcUrl
    );
  } catch (e) {
    return {
      ok: false,
      reason: `performHarvest submit failed: ${e instanceof Error ? e.message : String(e)}`,
      strategyAddress: baseline.strategyAddress,
      baselineLastHarvest: baseline.lastHarvest,
    };
  }

  return confirmKeeperHarvestTx(
    txHash,
    keeperAddress,
    strategyId,
    rpcUrl,
    strategyRegistryKey,
    pipelineId,
    baseline,
    baselineFeesCollected,
    baselineWatched,
    isV4
  );
}

async function confirmKeeperHarvestTx(
  txHash: string,
  keeperAddress: Address,
  strategyId: number,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey,
  pipelineId: KeeperPipelineId | undefined,
  baseline: Awaited<ReturnType<typeof getKeeperStrategyHarvestTimestamps>>,
  baselineFeesCollected: bigint,
  baselineWatched: KeeperWatchedRow | null,
  isV4: boolean
): Promise<KeeperHarvestConfirmationResult> {
  const client = createPublicClient({ chain: getViemChain(), transport: http(rpcUrl) });
  let receiptStatus: "success" | "reverted" = "success";
  let receipt: TransactionReceipt | null = null;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash: txHash as `0x${string}`,
      timeout: HARVEST_RECEIPT_TIMEOUT_MS,
    });
    receiptStatus = receipt.status;
    if (receipt.status === "reverted") {
      return {
        ok: false,
        reason: "performHarvest tx reverted on-chain",
        txHash,
        receiptStatus: "reverted",
        strategyAddress: baseline.strategyAddress,
        baselineLastHarvest: baseline.lastHarvest,
      };
    }
  } catch (e) {
    return {
      ok: false,
      reason: `receipt wait failed: ${e instanceof Error ? e.message : String(e)}`,
      txHash,
      strategyAddress: baseline.strategyAddress,
      baselineLastHarvest: baseline.lastHarvest,
    };
  }

  const upkeepDidAct =
    receipt != null
      ? parsePerformHarvestUpkeepDidAct(receipt, keeperAddress, strategyId, pipelineId)
      : null;

  const pollUntil = Date.now() + HARVEST_LAST_HARVEST_POLL_MAX_MS;
  let lastTs = baseline;
  let lastFeesCollected = baselineFeesCollected;
  while (Date.now() <= pollUntil) {
    try {
      lastTs = await getKeeperStrategyHarvestTimestamps(
        keeperAddress,
        strategyId,
        rpcUrl,
        strategyRegistryKey,
        pipelineId
      );
      if (lastTs.lastHarvest > baseline.lastHarvest) {
        return {
          ok: true,
          txHash,
          strategyAddress: lastTs.strategyAddress,
          baselineLastHarvest: baseline.lastHarvest,
          lastHarvest: lastTs.lastHarvest,
          prevHarvestTime: lastTs.prevHarvestTime,
          harvestSignal: "lastHarvest",
        };
      }
      if (lastTs.prevHarvestTime > baseline.prevHarvestTime) {
        return {
          ok: true,
          txHash,
          strategyAddress: lastTs.strategyAddress,
          baselineLastHarvest: baseline.lastHarvest,
          lastHarvest: lastTs.lastHarvest,
          prevHarvestTime: lastTs.prevHarvestTime,
          harvestSignal: "prevHarvestTime",
        };
      }
      if (
        shouldStopFloatHarvestRetryAttempts(
          baseline.lastHarvest,
          lastTs.lastHarvest,
          lastTs.prevHarvestTime
        )
      ) {
        return {
          ok: true,
          txHash,
          strategyAddress: lastTs.strategyAddress,
          baselineLastHarvest: baseline.lastHarvest,
          lastHarvest: lastTs.lastHarvest,
          prevHarvestTime: lastTs.prevHarvestTime,
          harvestSignal: "prevHarvestTime",
        };
      }
      if (isV4) {
        lastFeesCollected = await getStrategyUniswapFeesCollectedAtAddress(
          lastTs.strategyAddress as Address,
          rpcUrl,
          strategyRegistryKey
        );
        if (isFloatV4HarvestSettled(baselineFeesCollected, lastFeesCollected)) {
          return {
            ok: true,
            txHash,
            strategyAddress: lastTs.strategyAddress,
            baselineLastHarvest: baseline.lastHarvest,
            lastHarvest: lastTs.lastHarvest,
            prevHarvestTime: lastTs.prevHarvestTime,
            harvestSignal: "uniswapFees",
          };
        }
      }
      if (upkeepDidAct === true) {
        return {
          ok: true,
          txHash,
          strategyAddress: lastTs.strategyAddress,
          baselineLastHarvest: baseline.lastHarvest,
          lastHarvest: lastTs.lastHarvest,
          prevHarvestTime: lastTs.prevHarvestTime,
          harvestSignal: "keeperDidAct",
        };
      }
    } catch {
      /* retry poll */
    }
    await new Promise((r) => setTimeout(r, HARVEST_LAST_HARVEST_POLL_MS));
  }

  if (isV4 && isFloatV4HarvestSettled(baselineFeesCollected, lastFeesCollected)) {
    return {
      ok: true,
      txHash,
      strategyAddress: lastTs.strategyAddress,
      baselineLastHarvest: baseline.lastHarvest,
      lastHarvest: lastTs.lastHarvest,
      prevHarvestTime: lastTs.prevHarvestTime,
      harvestSignal: "uniswapFees",
    };
  }

  if (upkeepDidAct === true) {
    return {
      ok: true,
      txHash,
      strategyAddress: lastTs.strategyAddress,
      baselineLastHarvest: baseline.lastHarvest,
      lastHarvest: lastTs.lastHarvest,
      prevHarvestTime: lastTs.prevHarvestTime,
      harvestSignal: "keeperDidAct",
    };
  }

  let watchedAfter: KeeperWatchedRow | null = null;
  try {
    watchedAfter = await getKeeperWatchedRow(keeperAddress, strategyId, rpcUrl, pipelineId);
  } catch {
    /* optional detail */
  }
  const keeperIntervalBlocked =
    baselineWatched != null &&
    watchedAfter != null &&
    baselineWatched.lastActionSec > 0 &&
    baselineWatched.minIntervalSec > 0 &&
    watchedAfter.lastActionSec === baselineWatched.lastActionSec;

  const noopDetail =
    upkeepDidAct === false
      ? "UpkeepPerformed.didAct=false"
      : upkeepDidAct === null
        ? "no UpkeepPerformed event in receipt"
        : keeperIntervalBlocked
          ? `keeper minInterval not elapsed (lastAction=${baselineWatched?.lastActionSec}, minInterval=${baselineWatched?.minIntervalSec}s)`
          : "harvestBoolean reverted inside keeper try/catch (check strategy _harvest / _collectAllFees / increaseLiquidity)";

  await new Promise((r) => setTimeout(r, HARVEST_DEFERRED_CONFIRM_MS));
  try {
    const deferredTs = await getKeeperStrategyHarvestTimestamps(
      keeperAddress,
      strategyId,
      rpcUrl,
      strategyRegistryKey,
      pipelineId
    );
    if (deferredTs.lastHarvest > baseline.lastHarvest) {
      return {
        ok: true,
        txHash,
        strategyAddress: deferredTs.strategyAddress,
        baselineLastHarvest: baseline.lastHarvest,
        lastHarvest: deferredTs.lastHarvest,
        prevHarvestTime: deferredTs.prevHarvestTime,
        harvestSignal: "lastHarvest",
      };
    }
    if (deferredTs.prevHarvestTime > baseline.prevHarvestTime) {
      return {
        ok: true,
        txHash,
        strategyAddress: deferredTs.strategyAddress,
        baselineLastHarvest: baseline.lastHarvest,
        lastHarvest: deferredTs.lastHarvest,
        prevHarvestTime: deferredTs.prevHarvestTime,
        harvestSignal: "prevHarvestTime",
      };
    }
    if (isV4) {
      const deferredFees = await getStrategyUniswapFeesCollectedAtAddress(
        deferredTs.strategyAddress as Address,
        rpcUrl,
        strategyRegistryKey
      );
      if (isFloatV4HarvestSettled(baselineFeesCollected, deferredFees)) {
        return {
          ok: true,
          txHash,
          strategyAddress: deferredTs.strategyAddress,
          baselineLastHarvest: baseline.lastHarvest,
          lastHarvest: deferredTs.lastHarvest,
          prevHarvestTime: deferredTs.prevHarvestTime,
          harvestSignal: "uniswapFees",
        };
      }
    }
    lastTs = deferredTs;
  } catch {
    /* use last poll values in failure reason */
  }

  let v4Mode: number | undefined;
  if (isV4) {
    try {
      const client = createPublicClient({ chain: getViemChain(), transport: http(rpcUrl) });
      v4Mode = Number(
        await client.readContract({
          address: lastTs.strategyAddress as Address,
          abi: FLOAT_STRATEGY_V4_ABI,
          functionName: "mode",
        })
      );
    } catch {
      /* optional */
    }
  }

  return {
    ok: false,
    reason: isV4
      ? `performHarvest mined but strategy harvest state unchanged — ${noopDetail} (mode=${v4Mode ?? "?"}; strategy ${lastTs.strategyAddress})`
      : "performHarvest mined but lastHarvest did not advance within poll window (keeper minInterval / no fees / wrong strategy id?)",
    txHash,
    receiptStatus,
    strategyAddress: lastTs.strategyAddress,
    baselineLastHarvest: baseline.lastHarvest,
    lastHarvest: lastTs.lastHarvest,
    prevHarvestTime: lastTs.prevHarvestTime,
    v4SkipRapidHarvestRetry:
      isV4 && upkeepDidAct === false && !keeperIntervalBlocked,
  };
}

/** Mode label for V4 harvest logs. */
function floatV4ModeLabel(mode: number): string {
  const modeNames: Record<number, string> = {
    0: "NORMAL",
    1: "DEFENSIVE",
    2: "OFFENSIVE",
    3: "NEUTRAL",
    4: "STABLE",
  };
  return modeNames[mode] ?? String(mode);
}

/**
 * Simulate keeper → harvestBoolean before spending gas. Keeper harvests in NORMAL/DEFENSIVE/OFFENSIVE
 * (not NEUTRAL/STABLE); strategy MustBeNeutral applies only to resumeNormalFromVault().
 */
export async function preflightFloatV4KeeperHarvest(
  keeperAddress: Address,
  strategyAddress: Address,
  rpcUrl: string,
  skipIncreaseLiquidity: boolean
): Promise<{
  canHarvest: boolean;
  reason: string;
  skipRapidRetry: boolean;
  mode: number;
}> {
  const client = createPublicClient({ chain: getViemChain(), transport: http(rpcUrl) });
  const mode = Number(
    await client.readContract({
      address: strategyAddress,
      abi: FLOAT_STRATEGY_V4_ABI,
      functionName: "mode",
    })
  );

  if (mode === FLOAT_STRATEGY_V4_NEUTRAL_MODE || mode === 4) {
    return {
      canHarvest: false,
      skipRapidRetry: true,
      mode,
      reason:
        `Float V4 keeper performHarvest skips NEUTRAL/STABLE (mode=${mode} ${floatV4ModeLabel(mode)}). ` +
        `Harvest via vault neutral path or resume to LP mode first.`,
    };
  }

  try {
    await client.simulateContract({
      address: strategyAddress,
      abi: FLOAT_STRATEGY_V4_ABI,
      functionName: "harvestBoolean",
      args: [skipIncreaseLiquidity],
      account: keeperAddress,
    });
    return { canHarvest: true, skipRapidRetry: false, mode, reason: "ok" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      canHarvest: false,
      skipRapidRetry: true,
      mode,
      reason:
        `Float V4 harvestBoolean simulation failed (keeper caller, mode=${mode} ${floatV4ModeLabel(mode)}): ${msg}. ` +
        `If performHarvest still mines, keeper catch yields didAct=false; fix strategy _harvest (_noteHarvestActivity after fees) or revert in collect/increase.`,
    };
  }
}

/** `watched(uint256)` return tuple per FloatKeeper.json (full ABI widens readContract inference). */
type FloatKeeperWatchedRow = readonly [Address, number, number, boolean];

function floatKeeperWatchedStratAddr(row: unknown): Address {
  const [stratAddr] = row as FloatKeeperWatchedRow;
  return stratAddr;
}

/** IOutOfRangeStrategy.mode() - 0=NORMAL, 1=DEFENSIVE, 2=OFFENSIVE, 3=NEUTRAL, 4=STABLE (V4) */
const STRATEGY_MODE_ABI = [
  {
    inputs: [],
    name: "mode",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view" as const,
    type: "function" as const,
  },
] as const;

/**
 * Read strategy mode from chain. 0=NORMAL, 1=DEFENSIVE, 2=OFFENSIVE, 3=NEUTRAL.
 */
export async function getStrategyMode(
  keeperAddress: Address,
  strategyId: number,
  rpcUrl: string,
  pipelineId?: KeeperPipelineId
): Promise<number> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  const keeperAbi = resolveKeeperAbi(keeperAddress, pipelineId);
  const stratAddr = floatKeeperWatchedStratAddr(
    await client.readContract({
      address: keeperAddress,
      abi: keeperAbi,
      functionName: "watched",
      args: [BigInt(strategyId)],
    })
  );
  if (!stratAddr || stratAddr === "0x0000000000000000000000000000000000000000") {
    throw new Error(`No strategy at index ${strategyId}`);
  }
  const mode = await client.readContract({
    address: stratAddr as Address,
    abi: STRATEGY_MODE_ABI,
    functionName: "mode",
  });
  return Number(mode);
}

/**
 * Read `lastHarvest` / `PrevHarvestTime` on FloatKeeper.watched[strategyId] (same ABI as FloatStrategy).
 */
export async function getKeeperStrategyHarvestTimestamps(
  keeperAddress: Address,
  strategyId: number,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey = "FloatStrategy",
  pipelineId?: KeeperPipelineId
): Promise<{ lastHarvest: number; prevHarvestTime: number; strategyAddress: string }> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  const keeperAbi = resolveKeeperAbi(keeperAddress, pipelineId);
  const stratAddr = floatKeeperWatchedStratAddr(
    await client.readContract({
      address: keeperAddress,
      abi: keeperAbi,
      functionName: "watched",
      args: [BigInt(strategyId)],
    })
  );
  if (!stratAddr || stratAddr === "0x0000000000000000000000000000000000000000") {
    throw new Error(`No strategy at index ${strategyId}`);
  }
  const ts = await getStrategyHarvestTimestampsAtAddress(
    stratAddr as Address,
    rpcUrl,
    strategyRegistryKey
  );
  return { ...ts, strategyAddress: stratAddr as string };
}

/**
 * Full FloatStrategy stats for FloatKeeper.watched[strategyId] (same shape as float_getStrategyStats for the manager’s FloatStrategy).
 */
export async function getKeeperStrategyStats(
  keeperAddress: Address,
  strategyId: number,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey = "FloatStrategy",
  pipelineId?: KeeperPipelineId
): Promise<Awaited<ReturnType<typeof getFloatStrategyStatsAtAddress>>> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  const keeperAbi = resolveKeeperAbi(keeperAddress, pipelineId);
  const stratAddr = floatKeeperWatchedStratAddr(
    await client.readContract({
      address: keeperAddress,
      abi: keeperAbi,
      functionName: "watched",
      args: [BigInt(strategyId)],
    })
  );
  if (!stratAddr || stratAddr === zeroAddress) {
    throw new Error(`No strategy at index ${strategyId}`);
  }
  return getFloatStrategyStatsAtAddress(stratAddr as Address, rpcUrl, strategyRegistryKey);
}

/**
 * FloatKeeper.snapshotVaultPoolValue throttle for upkeep-aligned loops (keeper-service + Demeter upkeep).
 * **Disabled** (`Infinity` → never fires). Set a finite ms (e.g. `6 * 60 * 60 * 1000`) to re-enable.
 */
export const KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS = Number.POSITIVE_INFINITY;

/**
 * FloatKeeper.snapshotVaultPoolValue() — no args; records vault pool value on the keeper.
 */
export async function sendKeeperSnapshotVaultPoolValue(
  walletProvider: EvmWalletProvider,
  keeperAddress: Address,
  pipelineId?: KeeperPipelineId
): Promise<string> {
  const keeperAbi = resolveKeeperAbi(keeperAddress, pipelineId);
  const data = encodeFunctionData({
    abi: keeperAbi,
    functionName: "snapshotVaultPoolValue",
    args: [],
  });
  return sendEvmTxWithGasHeadroom(walletProvider, { to: keeperAddress, data });
}

/** FloatKeeper.performUpkeep(strategyId) — direct on-chain call (Demeter loops, no LLM). */
export async function sendKeeperPerformUpkeep(
  walletProvider: EvmWalletProvider,
  keeperAddress: Address,
  strategyId: number,
  pipelineId?: KeeperPipelineId
): Promise<string> {
  const data = encodeFunctionData({
    abi: resolveKeeperAbi(keeperAddress, pipelineId),
    functionName: "performUpkeep",
    args: [BigInt(strategyId)],
  });
  return sendEvmTxWithGasHeadroom(walletProvider, { to: keeperAddress, data });
}

/** FloatKeeper.performUpkeepBatch(strategyIds) — direct on-chain call (Demeter loops, no LLM). */
export async function sendKeeperPerformUpkeepBatch(
  walletProvider: EvmWalletProvider,
  keeperAddress: Address,
  strategyIds: number[],
  pipelineId?: KeeperPipelineId
): Promise<string> {
  if (strategyIds.length === 0) {
    throw new Error("strategyIds must not be empty");
  }
  const data = encodeFunctionData({
    abi: resolveKeeperAbi(keeperAddress, pipelineId),
    functionName: "performUpkeepBatch",
    args: [strategyIds.map((id) => BigInt(id))],
  });
  return sendEvmTxWithGasHeadroom(walletProvider, { to: keeperAddress, data });
}

/** FloatKeeper.performHarvest(strategyId, skipIncreaseLiquidity) — direct on-chain call (Demeter loops, no LLM). */
export async function sendKeeperPerformHarvest(
  walletProvider: EvmWalletProvider,
  keeperAddress: Address,
  strategyId: number,
  skipIncreaseLiquidity = false,
  pipelineId?: KeeperPipelineId
): Promise<string> {
  const data = encodeFunctionData({
    abi: resolveKeeperAbi(keeperAddress, pipelineId),
    functionName: "performHarvest",
    args: [BigInt(strategyId), skipIncreaseLiquidity],
  });
  return sendEvmTxWithGasHeadroom(walletProvider, { to: keeperAddress, data });
}

/** performHarvest via operator private key (wallet sharding). */
export async function sendKeeperPerformHarvestFromPrivateKey(
  privateKey: string,
  keeperAddress: Address,
  strategyId: number,
  skipIncreaseLiquidity = false,
  pipelineId?: KeeperPipelineId,
  rpcUrl?: string
): Promise<string> {
  const data = encodeFunctionData({
    abi: resolveKeeperAbi(keeperAddress, pipelineId),
    functionName: "performHarvest",
    args: [BigInt(strategyId), skipIncreaseLiquidity],
  });
  return sendEvmTxWithGasHeadroomFromPrivateKey(privateKey, { to: keeperAddress, data }, rpcUrl);
}

/** performUpkeepBatch via operator private key (wallet sharding). */
export async function sendKeeperPerformUpkeepBatchFromPrivateKey(
  privateKey: string,
  keeperAddress: Address,
  strategyIds: number[],
  pipelineId?: KeeperPipelineId,
  rpcUrl?: string
): Promise<string> {
  if (strategyIds.length === 0) {
    throw new Error("strategyIds must not be empty");
  }
  const data = encodeFunctionData({
    abi: resolveKeeperAbi(keeperAddress, pipelineId),
    functionName: "performUpkeepBatch",
    args: [strategyIds.map((id) => BigInt(id))],
  });
  return sendEvmTxWithGasHeadroomFromPrivateKey(privateKey, { to: keeperAddress, data }, rpcUrl);
}

/** performUpkeep via operator private key (wallet sharding). */
export async function sendKeeperPerformUpkeepFromPrivateKey(
  privateKey: string,
  keeperAddress: Address,
  strategyId: number,
  pipelineId?: KeeperPipelineId,
  rpcUrl?: string
): Promise<string> {
  const data = encodeFunctionData({
    abi: resolveKeeperAbi(keeperAddress, pipelineId),
    functionName: "performUpkeep",
    args: [BigInt(strategyId)],
  });
  return sendEvmTxWithGasHeadroomFromPrivateKey(privateKey, { to: keeperAddress, data }, rpcUrl);
}

/**
 * KeeperStrategy Action Provider
 */
export function keeperStrategyActionProvider(
  keeperAddress: Address,
  options?: { toolPrefix?: string; pipelineId?: KeeperPipelineId }
) {
  const prefix = options?.toolPrefix ?? "keeperStrategy";
  return customActionProvider([
    {
      name: `${prefix}_performUpkeep`,
      description: `Perform upkeep on one strategy. id is 0-based index into FloatKeeper.watched[]. FloatKeeper at ${keeperAddress}.`,
      schema: z.object({
        strategyId: z
          .number()
          .int()
          .min(0)
          .describe("0-based index into keeper.watched[] (e.g., 0, 1, 2)"),
      }),
      invoke: async (walletProvider: WalletProvider, args: { strategyId: number }) => {
        try {
          if (!(walletProvider instanceof EvmWalletProvider)) {
            return JSON.stringify({
              success: false,
              error: "Wallet provider must be an EVM wallet provider",
            });
          }

          const txHash = await sendKeeperPerformUpkeep(
            walletProvider,
            keeperAddress,
            args.strategyId,
            options?.pipelineId
          );

          return JSON.stringify({
            success: true,
            data: {
              strategyId: args.strategyId,
              transactionHash: txHash,
              action: "performUpkeep",
              timestamp: new Date().toISOString(),
            },
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error performing upkeep",
          });
        }
      },
    },
    {
      name: `${prefix}_performUpkeepBatch`,
      description: `Perform upkeep on multiple strategies in one transaction. ids = array of 0-based indices into FloatKeeper.watched[] (e.g. [0, 1, 2]). FloatKeeper at ${keeperAddress}.`,
      schema: z.object({
        strategyIds: z
          .array(z.number().int().min(0))
          .describe("Array of 0-based indices into keeper.watched[] (e.g., [0, 1, 2])"),
      }),
      invoke: async (walletProvider: WalletProvider, args: { strategyIds: number[] }) => {
        try {
          if (!(walletProvider instanceof EvmWalletProvider)) {
            return JSON.stringify({
              success: false,
              error: "Wallet provider must be an EVM wallet provider",
            });
          }

          if (args.strategyIds.length === 0) {
            return JSON.stringify({
              success: false,
              error: "strategyIds must not be empty",
            });
          }

          const txHash = await sendKeeperPerformUpkeepBatch(
            walletProvider,
            keeperAddress,
            args.strategyIds,
            options?.pipelineId
          );

          return JSON.stringify({
            success: true,
            data: {
              strategyIds: args.strategyIds,
              transactionHash: txHash,
              action: "performUpkeepBatch",
              timestamp: new Date().toISOString(),
            },
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error performing upkeep batch",
          });
        }
      },
    },
    {
      name: `${prefix}_performHarvest`,
      description: `Harvest fees from a Float strategy and compound into the position (skipIncreaseLiquidity=false on-chain). id = 0-based index into FloatKeeper.watched[]. FloatKeeper at ${keeperAddress}.`,
      schema: z.object({
        strategyId: z
          .number()
          .int()
          .min(0)
          .describe("0-based index into keeper.watched[] (e.g., 0, 1, 2)"),
      }),
      invoke: async (walletProvider: WalletProvider, toolArgs: { strategyId: number }) => {
        try {
          if (!(walletProvider instanceof EvmWalletProvider)) {
            return JSON.stringify({
              success: false,
              error: "Wallet provider must be an EVM wallet provider",
            });
          }

          const skipIncreaseLiquidity = false;
          const txHash = await sendKeeperPerformHarvest(
            walletProvider,
            keeperAddress,
            toolArgs.strategyId,
            skipIncreaseLiquidity,
            options?.pipelineId
          );

          return JSON.stringify({
            success: true,
            data: {
              strategyId: toolArgs.strategyId,
              skipIncreaseLiquidity,
              transactionHash: txHash,
              action: "performHarvest",
              timestamp: new Date().toISOString(),
            },
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error performing harvest",
          });
        }
      },
    },
  ]);
}
