import { customActionProvider, WalletProvider, EvmWalletProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { Address, createPublicClient, encodeFunctionData, formatUnits, http, zeroAddress } from "viem";
import type { Abi } from "viem";

import floatStrategyJson from "../abi/FloatStrategy.json";
import floatStrategyV4Json from "../abi/FloatStrategyV4.json";
import { getRpcUrlOptional, getUniswapV3Factory, getViemChain } from "../config/chain-config";
import { sendEvmTxWithGasHeadroom } from "../services/demeter-wallet-tx";

/** Canonical FloatStrategy ABI (keep in sync with deployed strategy — see `app/abi/FloatStrategy.json`). */
const FLOAT_STRATEGY_ABI = floatStrategyJson.abi as Abi;
const FLOAT_STRATEGY_V4_ABI = floatStrategyV4Json.abi as Abi;

/** FloatContractManager registry name for the deployed strategy contract. */
export type FloatManagerStrategyKey = "FloatStrategy" | "FloatStrategyV4";

function strategyAbiForKey(key: FloatManagerStrategyKey): Abi {
  return key === "FloatStrategyV4" ? FLOAT_STRATEGY_V4_ABI : FLOAT_STRATEGY_ABI;
}

/** Resolve strategy contract via manager `getAddress(strategyKey)`. */
export async function resolveFloatManagerStrategyAddress(
  floatContractManagerAddress: Address,
  rpcUrl: string,
  strategyKey: FloatManagerStrategyKey
): Promise<Address> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  const strategyAddress = await client.readContract({
    address: floatContractManagerAddress,
    abi: FLOAT_MANAGER_ABI,
    functionName: "getAddress",
    args: [strategyKey],
  });
  if (!strategyAddress || strategyAddress === zeroAddress) {
    throw new Error(
      `FloatContractManager ${floatContractManagerAddress} has no address for "${strategyKey}"`
    );
  }
  return strategyAddress as Address;
}

const FLOAT_MANAGER_ABI = [
  {
    inputs: [{ internalType: "address", name: "_newAssetAddr", type: "address" }],
    name: "changeStrategyAsset",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "string", name: "_name", type: "string" }],
    name: "getAddress",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "exitStrategyToStable",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * Minimal view ABI for LiquidStrategy (not in FloatStrategy.json — different contract).
 */
const LIQUID_STRATEGY_VIEW_ABI = [
  {
    inputs: [],
    name: "assetAddr",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "mode",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "baselineTick",
    outputs: [{ internalType: "int24", name: "", type: "int24" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "vaultValue",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "consecutiveOffensiveCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** 1% fee tier used by Demeter asset/WETH pool resolution (matches manager contract). */
const UNISWAP_V3_FEE_1_PCT = 10_000;

const UNISWAP_V3_FACTORY_ABI = [
  {
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
      { internalType: "uint24", name: "fee", type: "uint24" },
    ],
    name: "getPool",
    outputs: [{ internalType: "address", name: "pool", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const STRATEGY_CHANGE_ASSET_ABI = [
  {
    inputs: [
      { internalType: "address", name: "_newAssetAddr", type: "address" },
      { internalType: "address", name: "_newPoolV3Addr", type: "address" },
    ],
    name: "changeAsset",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const MODE_LABELS: Record<number, string> = {
  0: "NORMAL",
  1: "DEFENSIVE",
  2: "OFFENSIVE",
  3: "NEUTRAL",
  4: "STABLE"
};

/**
 * Current strategy token (ASSET).
 * V3: manager `getAddress("ASSET")`.
 * V4: manager `getAddress("FloatStrategyV4")` then strategy `ASSET()`.
 */
export async function getFloatAssetAddress(
  contractAddress: Address,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey = "FloatStrategy"
): Promise<string> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  if (strategyRegistryKey === "FloatStrategy") {
    const addr = await client.readContract({
      address: contractAddress,
      abi: FLOAT_MANAGER_ABI,
      functionName: "getAddress",
      args: ["ASSET"],
    });
    return addr as string;
  }
  const strategyAddress = await resolveFloatManagerStrategyAddress(
    contractAddress,
    rpcUrl,
    "FloatStrategyV4"
  );
  const addr = await client.readContract({
    address: strategyAddress,
    abi: FLOAT_STRATEGY_V4_ABI,
    functionName: "ASSET",
  });
  return addr as string;
}

const DECIMALS = 18;

/**
 * Get FloatStrategy lastHarvest timestamp (Unix seconds).
 * Used on launch to schedule next harvest at lastHarvest + harvestIntervalMs.
 */
/**
 * Read FloatStrategy.poolValue() only (via getAddress("FloatStrategy") on FloatContractManager).
 */
export async function getFloatPoolValue(
  floatContractManagerAddress: Address,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey = "FloatStrategy"
): Promise<{ strategyAddress: string; poolValue: string }> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  const strategyAddress = await resolveFloatManagerStrategyAddress(
    floatContractManagerAddress,
    rpcUrl,
    strategyRegistryKey
  );
  const poolValueRaw = await client.readContract({
    address: strategyAddress,
    abi: strategyAbiForKey(strategyRegistryKey),
    functionName: "poolValue",
  });
  return {
    strategyAddress: strategyAddress as string,
    poolValue: formatUnits(poolValueRaw as bigint, DECIMALS),
  };
}

export async function getLastHarvestTimestamp(
  floatContractManagerAddress: Address,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey = "FloatStrategy"
): Promise<number> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  const strategyAddress = await resolveFloatManagerStrategyAddress(
    floatContractManagerAddress,
    rpcUrl,
    strategyRegistryKey
  );
  const lastHarvest = await client.readContract({
    address: strategyAddress,
    abi: strategyAbiForKey(strategyRegistryKey),
    functionName: "lastHarvest",
  });
  return Number(lastHarvest);
}

const TWELVE_HOURS_SEC = 12 * 3600;

/** FloatStrategy `lastHarvest` and `PrevHarvestTime` (Unix seconds). */
export async function getFloatStrategyHarvestTimestamps(
  floatContractManagerAddress: Address,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey = "FloatStrategy"
): Promise<{ lastHarvest: number; prevHarvestTime: number }> {
  const strategyAddress = await resolveFloatManagerStrategyAddress(
    floatContractManagerAddress,
    rpcUrl,
    strategyRegistryKey
  );
  return getStrategyHarvestTimestampsAtAddress(strategyAddress, rpcUrl, strategyRegistryKey);
}

/**
 * Read `lastHarvest` / `PrevHarvestTime` on a strategy contract (e.g. FloatKeeper `watched[i]` → FloatStrategy / FloatStrategyV4).
 */
export async function getStrategyHarvestTimestampsAtAddress(
  strategyAddress: Address,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey = "FloatStrategy"
): Promise<{ lastHarvest: number; prevHarvestTime: number }> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  const strategyAbi = strategyAbiForKey(strategyRegistryKey);
  const [lastHarvest, prevHarvestTime] = await Promise.all([
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "lastHarvest",
    }),
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "PrevHarvestTime",
    }),
  ]);
  return { lastHarvest: Number(lastHarvest), prevHarvestTime: Number(prevHarvestTime) };
}

/** Cumulative Uniswap fees counter on FloatStrategy / FloatStrategyV4 (wei). */
export async function getStrategyUniswapFeesCollectedAtAddress(
  strategyAddress: Address,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey = "FloatStrategy"
): Promise<bigint> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  return (await client.readContract({
    address: strategyAddress,
    abi: strategyAbiForKey(strategyRegistryKey),
    functionName: "UniswapFeesCollected",
  })) as bigint;
}

/**
 * FloatStrategyV4 fee-collection harvests may not bump `lastHarvest` / `PrevHarvestTime` even when fees moved.
 * Only treat cumulative {@link UniswapFeesCollected} increase as a fee signal — not tx receipt success alone
 * (keeper `performHarvest` can mine with `UpkeepPerformed.didAct=false` when minInterval blocks or `harvestBoolean` reverts).
 */
export function isFloatV4HarvestSettled(
  baselineFeesCollected: bigint,
  currentFeesCollected: bigint
): boolean {
  return currentFeesCollected > baselineFeesCollected;
}

/**
 * Whether to stop retrying keeper harvest: `lastHarvest` advanced since `baselineLastHarvest`, or
 * `lastHarvest` is fresh (&lt;12h) and |lastHarvest − PrevHarvestTime| ≤ 12h (on-chain harvest window settled).
 */
export function shouldStopFloatHarvestRetryAttempts(
  baselineLastHarvest: number,
  lastHarvest: number,
  prevHarvestTime: number,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (lastHarvest > baselineLastHarvest) return true;
  if (lastHarvest <= 0 || nowSec - lastHarvest >= TWELVE_HOURS_SEC) return false;
  if (prevHarvestTime <= 0) return false;
  return Math.abs(lastHarvest - prevHarvestTime) <= TWELVE_HOURS_SEC;
}

export type StrategyRegistryKey = "FloatStrategy" | "FloatStrategyV4" | "LiquidStrategy";

/**
 * Resolve Uniswap V3 pool for asset / WETH at 1% fee (both token orderings).
 */
export async function resolveAssetWethPoolV3(
  rpcUrl: string,
  assetAddr: string,
  wethAddr: string
): Promise<Address | null> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  const factory = getUniswapV3Factory();
  let pool = (await client.readContract({
    address: factory,
    abi: UNISWAP_V3_FACTORY_ABI,
    functionName: "getPool",
    args: [assetAddr as Address, wethAddr as Address, UNISWAP_V3_FEE_1_PCT],
  })) as Address;
  if (pool === zeroAddress) {
    pool = (await client.readContract({
      address: factory,
      abi: UNISWAP_V3_FACTORY_ABI,
      functionName: "getPool",
      args: [wethAddr as Address, assetAddr as Address, UNISWAP_V3_FEE_1_PCT],
    })) as Address;
  }
  return pool === zeroAddress ? null : pool;
}

/**
 * Call LiquidContractManager.changeStrategyAsset(newAssetAddr). Manager must resolve pool and call LiquidStrategy internally.
 */
export async function sendChangeLiquidStrategyAsset(
  walletProvider: EvmWalletProvider,
  contractAddress: Address,
  newAssetAddr: string
): Promise<{ success: true; transactionHash: string } | { success: false; error: string }> {
  try {
    const data = encodeFunctionData({
      abi: FLOAT_MANAGER_ABI,
      functionName: "changeStrategyAsset",
      args: [newAssetAddr as Address],
    });
    const txHash = await sendEvmTxWithGasHeadroom(walletProvider, {
      to: contractAddress,
      data,
    });
    return { success: true, transactionHash: txHash };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error calling changeLiquidStrategyAsset",
    };
  }
}

/**
 * Call LiquidStrategy.changeAsset(newAsset, newPool) directly (legacy; prefer {@link sendChangeLiquidStrategyAsset} via manager).
 */
export async function sendOffensiveStrategyChangeAsset(
  walletProvider: EvmWalletProvider,
  liquidStrategyAddress: Address,
  newAssetAddr: string,
  newPoolV3Addr: string
): Promise<{ success: true; transactionHash: string } | { success: false; error: string }> {
  try {
    const data = encodeFunctionData({
      abi: STRATEGY_CHANGE_ASSET_ABI,
      functionName: "changeAsset",
      args: [newAssetAddr as Address, newPoolV3Addr as Address],
    });
    const txHash = await sendEvmTxWithGasHeadroom(walletProvider, {
      to: liquidStrategyAddress,
      data,
    });
    return { success: true, transactionHash: txHash };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error calling changeAsset",
    };
  }
}

/**
 * Read FloatStrategy stats at a concrete deployment address (e.g. FloatKeeper `watched[i]`).
 * Uses {@link FLOAT_STRATEGY_ABI} from `app/abi/FloatStrategy.json`.
 */
export async function getFloatStrategyStatsAtAddress(
  strategyAddress: Address,
  rpcUrl: string,
  strategyRegistryKey: FloatManagerStrategyKey = "FloatStrategy"
): Promise<{
  strategyAddress: string;
  balanceOfPool: { assetAmt: string; wethAmt: string };
  poolValue: string;
  vaultValue?: string;
  balanceOfIdle: string;
  /** V3 only — removed from FloatStrategyV4 ABI. */
  baselineTick: number | null;
  harvestOnDeposit: boolean;
  lastHarvest: bigint;
  baseTokenShareBps: bigint;
  UniswapFeesCollected: string;
  assetAddr: string;
  mode: string;
  lastRebalanceTime: bigint;
  consecutiveOffensiveCount?: bigint;
  /** FloatStrategyV4 mint band params (when present on deployed ABI). */
  targetAssetBps?: bigint;
  offensiveAssetBps?: bigint;
  rangeBelowBps?: bigint;
  rangeAboveBps?: bigint;
}> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });
  const strategyAbi = strategyAbiForKey(strategyRegistryKey);
  const isV4 = strategyRegistryKey === "FloatStrategyV4";
  const assetViewFn = isV4 ? "ASSET" : "assetAddr";

  const [
    balanceOfPoolResult,
    poolValue,
    balanceOfIdle,
    harvestOnDeposit,
    baseTokenShareBps,
    UniswapFeesCollected,
    assetAddr,
    modeRaw,
    lastRebalanceTime,
  ] = await Promise.all([
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "balanceOfPool",
    }),
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "poolValue",
    }),
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "balanceOfIdle",
    }),
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "harvestOnDeposit",
    }),
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "baseTokenShareBps",
    }),
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "UniswapFeesCollected",
    }),
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: assetViewFn,
    }),
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "mode",
    }),
    client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "lastRebalanceTime",
    }),
  ]);

  let baselineTick: number | null = null;
  if (!isV4) {
    try {
      baselineTick = Number(
        await client.readContract({
          address: strategyAddress,
          abi: strategyAbi,
          functionName: "baselineTick",
        })
      );
    } catch {
      // Older FloatStrategy deployments may omit baselineTick
    }
  }

  const lastHarvest = (await client.readContract({
    address: strategyAddress,
    abi: strategyAbi,
    functionName: "lastHarvest",
  })) as bigint;

  const [assetAmt, wethAmt] = balanceOfPoolResult as [bigint, bigint];
  const mode = MODE_LABELS[modeRaw as number] ?? `UNKNOWN(${modeRaw})`;

  let consecutiveOffensiveCount: bigint | undefined;
  try {
    consecutiveOffensiveCount = await client.readContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "consecutiveOffensiveCount",
    }) as bigint;
  } catch {
    // Not all strategy versions expose this
  }

  let targetAssetBps: bigint | undefined;
  let offensiveAssetBps: bigint | undefined;
  let rangeBelowBps: bigint | undefined;
  let rangeAboveBps: bigint | undefined;
  if (isV4) {
    try {
      [targetAssetBps, offensiveAssetBps, rangeBelowBps, rangeAboveBps] = await Promise.all([
        client.readContract({
          address: strategyAddress,
          abi: strategyAbi,
          functionName: "targetAssetBps",
        }) as Promise<bigint>,
        client.readContract({
          address: strategyAddress,
          abi: strategyAbi,
          functionName: "offensiveAssetBps",
        }) as Promise<bigint>,
        client.readContract({
          address: strategyAddress,
          abi: strategyAbi,
          functionName: "rangeBelowBps",
        }) as Promise<bigint>,
        client.readContract({
          address: strategyAddress,
          abi: strategyAbi,
          functionName: "rangeAboveBps",
        }) as Promise<bigint>,
      ]);
    } catch {
      // Optional V4 band reads — ignore if ABI/deploy mismatch
    }
  }

  return {
    strategyAddress: strategyAddress as string,
    balanceOfPool: {
      assetAmt: formatUnits(assetAmt, DECIMALS),
      wethAmt: formatUnits(wethAmt, DECIMALS),
    },
    poolValue: formatUnits(poolValue as bigint, DECIMALS),
    balanceOfIdle: formatUnits(balanceOfIdle as bigint, DECIMALS),
    baselineTick,
    harvestOnDeposit: harvestOnDeposit as boolean,
    lastHarvest,
    baseTokenShareBps: baseTokenShareBps as bigint,
    UniswapFeesCollected: formatUnits(UniswapFeesCollected as bigint, DECIMALS),
    assetAddr: assetAddr as string,
    mode,
    lastRebalanceTime: lastRebalanceTime as bigint,
    ...(consecutiveOffensiveCount !== undefined && { consecutiveOffensiveCount }),
    ...(targetAssetBps !== undefined && { targetAssetBps }),
    ...(offensiveAssetBps !== undefined && { offensiveAssetBps }),
    ...(rangeBelowBps !== undefined && { rangeBelowBps }),
    ...(rangeAboveBps !== undefined && { rangeAboveBps }),
  };
}

/**
 * Fetch strategy stats: pool balances, state variables, fees, mode, etc.
 * Uses getAddress(strategyKey) from the contract manager (FloatContractManager for FloatStrategy; LiquidContractManager for LiquidStrategy).
 * LiquidStrategy: only reads assetAddr, mode, baselineTick, vaultValue, consecutiveOffensiveCount (no poolValue/lastHarvest/etc.).
 */
export async function getStrategyStatsNamed(
  floatContractManagerAddress: Address,
  rpcUrl: string,
  strategyKey: StrategyRegistryKey
): Promise<{
  strategyAddress: string;
  balanceOfPool: { assetAmt: string; wethAmt: string };
  /** FloatStrategy: poolValue(). LiquidStrategy: not read; use vaultValue. */
  poolValue: string;
  /** LiquidStrategy: vaultValue(). Omitted for FloatStrategy. */
  vaultValue?: string;
  balanceOfIdle: string;
  baselineTick: number | null;
  harvestOnDeposit: boolean;
  lastHarvest: bigint;
  baseTokenShareBps: bigint;
  UniswapFeesCollected: string;
  assetAddr: string;
  mode: string;
  lastRebalanceTime: bigint;
  consecutiveOffensiveCount?: bigint;
  targetAssetBps?: bigint;
  offensiveAssetBps?: bigint;
  rangeBelowBps?: bigint;
  rangeAboveBps?: bigint;
}> {
  const client = createPublicClient({
    chain: getViemChain(),
    transport: http(rpcUrl),
  });

  if (strategyKey === "LiquidStrategy") {
    const strategyAddress = await client.readContract({
      address: floatContractManagerAddress,
      abi: FLOAT_MANAGER_ABI,
      functionName: "getAddress",
      args: [strategyKey],
    });
    const [assetAddr, modeRaw, baselineTick, vaultValueRaw] = await Promise.all([
      client.readContract({
        address: strategyAddress,
        abi: LIQUID_STRATEGY_VIEW_ABI,
        functionName: "assetAddr",
      }),
      client.readContract({
        address: strategyAddress,
        abi: LIQUID_STRATEGY_VIEW_ABI,
        functionName: "mode",
      }),
      client.readContract({
        address: strategyAddress,
        abi: LIQUID_STRATEGY_VIEW_ABI,
        functionName: "baselineTick",
      }),
      client.readContract({
        address: strategyAddress,
        abi: LIQUID_STRATEGY_VIEW_ABI,
        functionName: "vaultValue",
      }),
    ]);

    const mode = MODE_LABELS[modeRaw as number] ?? `UNKNOWN(${modeRaw})`;

    let consecutiveOffensiveCount: bigint | undefined;
    try {
      consecutiveOffensiveCount = await client.readContract({
        address: strategyAddress,
        abi: LIQUID_STRATEGY_VIEW_ABI,
        functionName: "consecutiveOffensiveCount",
      }) as bigint;
    } catch {
      // Not all strategy versions expose this
    }

    return {
      strategyAddress,
      balanceOfPool: { assetAmt: "0", wethAmt: "0" },
      poolValue: "0",
      vaultValue: formatUnits(vaultValueRaw as bigint, DECIMALS),
      balanceOfIdle: "0",
      baselineTick: Number(baselineTick),
      harvestOnDeposit: false,
      lastHarvest: 0n,
      baseTokenShareBps: 0n,
      UniswapFeesCollected: "0",
      assetAddr: assetAddr as string,
      mode,
      lastRebalanceTime: 0n,
      ...(consecutiveOffensiveCount !== undefined && { consecutiveOffensiveCount }),
    };
  }

  const strategyKeyForStats: FloatManagerStrategyKey =
    strategyKey === "FloatStrategyV4" ? "FloatStrategyV4" : "FloatStrategy";
  const strategyAddress = await resolveFloatManagerStrategyAddress(
    floatContractManagerAddress,
    rpcUrl,
    strategyKeyForStats
  );
  return getFloatStrategyStatsAtAddress(strategyAddress, rpcUrl, strategyKeyForStats);
}

/** FloatStrategy stats via manager getAddress("FloatStrategy"). */
export async function getStrategyStats(
  floatContractManagerAddress: Address,
  rpcUrl: string
): Promise<Awaited<ReturnType<typeof getStrategyStatsNamed>>> {
  return getStrategyStatsNamed(floatContractManagerAddress, rpcUrl, "FloatStrategy");
}

/** LiquidStrategy stats via LiquidContractManager getAddress("LiquidStrategy"). */
export async function getOffensiveStrategyStats(
  liquidContractManagerAddress: Address,
  rpcUrl: string
): Promise<Awaited<ReturnType<typeof getStrategyStatsNamed>>> {
  return getStrategyStatsNamed(liquidContractManagerAddress, rpcUrl, "LiquidStrategy");
}

/**
 * Call FloatContractManager.changeStrategyAsset(newAssetAddr) directly.
 * Use this from Demeter when in DEFENSIVE mode so we always call the contract with the chosen asset (no LLM in the loop).
 */
/**
 * Float V4 market-breadth stable: flatten LP, swap to WETH, set strategy mode STABLE; registry ASSET → WETH.
 */
export async function sendExitStrategyToStable(
  walletProvider: EvmWalletProvider,
  contractAddress: Address
): Promise<{ success: true; transactionHash: string } | { success: false; error: string }> {
  try {
    const data = encodeFunctionData({
      abi: FLOAT_MANAGER_ABI,
      functionName: "exitStrategyToStable",
    });
    const txHash = await sendEvmTxWithGasHeadroom(walletProvider, {
      to: contractAddress,
      data,
    });
    return { success: true, transactionHash: txHash };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error calling exitStrategyToStable",
    };
  }
}

export async function sendChangeStrategyAsset(
  walletProvider: EvmWalletProvider,
  contractAddress: Address,
  newAssetAddr: string
): Promise<{ success: true; transactionHash: string } | { success: false; error: string }> {
  try {
    const data = encodeFunctionData({
      abi: FLOAT_MANAGER_ABI,
      functionName: "changeStrategyAsset",
      args: [newAssetAddr as Address],
    });
    const txHash = await sendEvmTxWithGasHeadroom(walletProvider, {
      to: contractAddress,
      data,
    });
    return { success: true, transactionHash: txHash };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error calling changeStrategyAsset",
    };
  }
}

/**
 * FloatContractManager Action Provider
 * Provides changeStrategyAsset and float_getStrategyStats.
 */
export function floatActionProvider(
  contractAddress: Address,
  options?: { toolPrefix?: string; strategyRegistryKey?: FloatManagerStrategyKey }
) {
  const prefix = options?.toolPrefix ?? "float";
  const strategyRegistryKey = options?.strategyRegistryKey ?? "FloatStrategy";
  return customActionProvider([
    {
      name: `${prefix}_getStrategyStats`,
      description:
        strategyRegistryKey === "FloatStrategyV4"
          ? `Get FloatStrategyV4 stats: pool balances (asset/weth), poolValue, balanceOfIdle, harvestOnDeposit, lastHarvest, baseTokenShareBps, UniswapFeesCollected, ASSET, mode (NORMAL/DEFENSIVE/OFFENSIVE/NEUTRAL/STABLE), lastRebalanceTime, consecutiveOffensiveCount, targetAssetBps, offensiveAssetBps, rangeBelowBps, rangeAboveBps. V4 has no baselineTick (removed from contract). Reads from FloatContractManager V4 at ${contractAddress}.`
          : `Get FloatStrategy stats: pool balances (asset/weth), poolValue, balanceOfIdle, baselineTick, harvestOnDeposit, lastHarvest, baseTokenShareBps, UniswapFeesCollected, assetAddr, mode (NORMAL/DEFENSIVE/OFFENSIVE), lastRebalanceTime, consecutiveOffensiveCount. When mode is OFFENSIVE, consecutiveOffensiveCount is how many consecutive times upkeep returned OFFENSIVE. Use when users ask for "strategy stats", "pool stats", "strategy info", "pool value", or similar. Reads from FloatContractManager at ${contractAddress}.`,
      schema: z.object({}),
      invoke: async () => {
        try {
          const rpcUrl = getRpcUrlOptional();
          if (!rpcUrl) {
            return JSON.stringify({
              success: false,
              error: "RPC_URL is not set in environment",
            });
          }
          const stats = await getStrategyStatsNamed(
            contractAddress,
            rpcUrl,
            strategyRegistryKey
          );
          const data: Record<string, unknown> = {
            strategyAddress: stats.strategyAddress,
            balanceOfPool: stats.balanceOfPool,
            poolValue: stats.poolValue,
            balanceOfIdle: stats.balanceOfIdle,
            harvestOnDeposit: stats.harvestOnDeposit,
            lastHarvest: stats.lastHarvest.toString(),
            baseTokenShareBps: stats.baseTokenShareBps.toString(),
            UniswapFeesCollected: stats.UniswapFeesCollected,
            assetAddr: stats.assetAddr,
            mode: stats.mode,
            lastRebalanceTime: stats.lastRebalanceTime.toString(),
          };
          if (stats.baselineTick != null) {
            data.baselineTick = stats.baselineTick;
          }
          if (stats.consecutiveOffensiveCount !== undefined) {
            data.consecutiveOffensiveCount = stats.consecutiveOffensiveCount.toString();
          }
          if (stats.targetAssetBps !== undefined) {
            data.targetAssetBps = stats.targetAssetBps.toString();
          }
          if (stats.offensiveAssetBps !== undefined) {
            data.offensiveAssetBps = stats.offensiveAssetBps.toString();
          }
          if (stats.rangeBelowBps !== undefined) {
            data.rangeBelowBps = stats.rangeBelowBps.toString();
          }
          if (stats.rangeAboveBps !== undefined) {
            data.rangeAboveBps = stats.rangeAboveBps.toString();
          }
          return JSON.stringify({ success: true, data });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error fetching strategy stats",
          });
        }
      },
    },
    {
      name: `${prefix}_changeStrategyAsset`,
      description: `Update the strategy asset to a new token address. Call changeStrategyAsset on FloatContractManager at ${contractAddress}.`,
      schema: z.object({
        newAssetAddr: z.string().describe("The new token contract address to set as the strategy asset"),
      }),
      invoke: async (walletProvider: WalletProvider, args: { newAssetAddr: string }) => {
        try {
          if (!(walletProvider instanceof EvmWalletProvider)) {
            return JSON.stringify({
              success: false,
              error: "Wallet provider must be an EVM wallet provider",
            });
          }

          const data = encodeFunctionData({
            abi: FLOAT_MANAGER_ABI,
            functionName: "changeStrategyAsset",
            args: [args.newAssetAddr as Address],
          });

          const txHash = await sendEvmTxWithGasHeadroom(walletProvider, {
            to: contractAddress,
            data,
          });

          return JSON.stringify({
            success: true,
            data: {
              newAssetAddr: args.newAssetAddr,
              transactionHash: txHash,
              action: "changeStrategyAsset",
              timestamp: new Date().toISOString(),
            },
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error calling changeStrategyAsset",
          });
        }
      },
    },
  ]);
}
