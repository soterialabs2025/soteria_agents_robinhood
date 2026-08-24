/**
 * UFloatStrategy DEFENSIVE path: read allowedTokens from chain, rank with UFloat metrics,
 * call changeAsset directly on the strategy contract (Triton wallet).
 * mode=STABLE is upkeep-only — contract stop-loss or owner; no agent re-entry.
 */
import type { Abi, Address } from "viem";

import ufloatStrategyJson from "../abi/UFloatStrategy.json";
import {
  createTritonPublicClient,
  createTritonWalletClient,
} from "../action-providers/liquid-strat-min-v4-action-provider";
import {
  fetchTokenComparison,
  POOL_ADDRESS_BY_TOKEN_V4,
} from "../action-providers/coingecko-action-provider";
import { checkDemeterStopSignal, sleepWithStopCheck } from "../config/demeter-stop";
import {
  getUfloatChangeAssetCooldownMs,
  getUfloatDefensiveRankingEligibilityThresholds,
  getUfloatTokenRankingMetrics,
  getTritonWethAddress,
} from "../config/triton-config";
import { writeViemContractWithChangeAssetGasHeadroom } from "./demeter-wallet-tx";
import {
  allowlistCacheKey,
  getCachedDefensiveTokenComparison,
} from "./token-comparison-cache";
import { enqueueUfloatWalletTx, getUfloatWalletForStrategyId } from "./ufloat-wallet-pool";
import { UFLOAT_STRATEGY_MODE } from "../abi/contract-enums";
import { COINGECKO_NETWORK, explorerTxUrl } from "../config/chain-config";
import {
  formatUFloatStratMethod,
  ufloatStratMethodAllowsDefensive,
} from "./ufloat-strat-method";
import { filterActiveByMinPoolValue } from "./strategy-pool-value-eligibility";

/** Re-export for callers that import mode constants from defensive-change. */
export const UFLOAT_STABLE_MODE = UFLOAT_STRATEGY_MODE.Stable;

export type UFloatDefensiveStrategyRow = {
  id: number;
  stratAddr: Address;
  active: boolean;
};

export type UFloatDefensiveComparison = {
  tokens_summary?: Array<{
    symbol: string;
    address: string;
    volume_h12?: number;
    liquidity_usd?: number | null;
    volatility_h24?: number;
    buy_sell_ratio_h6?: number | null;
  }>;
  weighted_ranking?: {
    ranked: Array<{ symbol: string; score?: number }>;
  };
};

const UFLOAT_STRATEGY_ABI = ufloatStrategyJson.abi as Abi;
const DEFENSIVE_MODE = UFLOAT_STRATEGY_MODE.Defensive;
const TOP_N_FOR_PRICE_PICK = 3;
const UPKEEP_DEFENSIVE_WAIT_MS = 8000;
const CHANGE_ASSET_MAX_TRIES = 5;
const CHANGE_ASSET_RETRY_MS = 30_000;
/** Poll ASSET after a mined tx — RPC/contract state can lag behind receipt. */
const ASSET_SETTLE_DELAYS_MS = [0, 1_000, 2_000, 3_000, 5_000] as const;

const lastDefensiveChangeAtMs = new Map<string, number>();

function normalizeAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

type UFloatOnChainMethod = "changeAsset";

export type UFloatChangeAssetSuccess = {
  success: true;
  assetBefore: Address;
  assetAfter: Address;
  onChainMethod: UFloatOnChainMethod;
  transactionHash?: `0x${string}`;
  alreadyAtTarget?: boolean;
};

export type UFloatChangeAssetResult =
  | UFloatChangeAssetSuccess
  | { success: false; error: string };

function ufloatAlreadyAtTarget(
  asset: Address,
  onChainMethod: UFloatOnChainMethod
): UFloatChangeAssetSuccess {
  return {
    success: true,
    assetBefore: asset,
    assetAfter: asset,
    onChainMethod,
    alreadyAtTarget: true,
  };
}

/** Wait for on-chain ASSET to match expected value after a successful tx receipt. */
async function readUFloatStrategyAssetSettled(
  strategyAddress: Address,
  rpcUrl: string,
  expectedLc: string
): Promise<{ asset: Address; matched: boolean }> {
  for (const delayMs of ASSET_SETTLE_DELAYS_MS) {
    if (delayMs > 0) {
      await sleepWithStopCheck(delayMs);
    }
    const asset = await readUFloatStrategyAsset(strategyAddress, rpcUrl);
    if (normalizeAddr(asset) === expectedLc) {
      return { asset, matched: true };
    }
  }
  const asset = await readUFloatStrategyAsset(strategyAddress, rpcUrl);
  return { asset, matched: normalizeAddr(asset) === expectedLc };
}

export function formatUFloatChangeAssetSuccessLog(
  strategyId: number,
  passLabel: string,
  result: UFloatChangeAssetSuccess
): string {
  if (result.alreadyAtTarget) {
    return `[UFloatKeeper] strategy ${strategyId} ${passLabel} — already at target ASSET ${result.assetAfter}`;
  }
  const txSuffix = result.transactionHash
    ? ` tx ${result.transactionHash} ${explorerTxUrl(result.transactionHash)}`
    : "";
  return `[UFloatKeeper] strategy ${strategyId} ${passLabel} ${result.onChainMethod} ${result.assetBefore} → ${result.assetAfter}${txSuffix}`;
}

/** CoinGecko pool lookup for UFloat allowlist tokens (Triton V4 universe only — no Float V3 registry). */
export function buildUfloatPoolByTokenMap(): Map<string, string> {
  return new Map(POOL_ADDRESS_BY_TOKEN_V4);
}

export async function readUFloatStrategyMode(
  strategyAddress: Address,
  rpcUrl: string
): Promise<number> {
  const client = createTritonPublicClient(rpcUrl);
  const mode = await client.readContract({
    address: strategyAddress,
    abi: UFLOAT_STRATEGY_ABI,
    functionName: "mode",
  });
  return Number(mode);
}

/** On-chain `stratMethod` — {@link UFLOAT_STRAT_METHOD}. */
export async function readUFloatStratMethod(
  strategyAddress: Address,
  rpcUrl: string
): Promise<number> {
  const client = createTritonPublicClient(rpcUrl);
  const method = await client.readContract({
    address: strategyAddress,
    abi: UFLOAT_STRATEGY_ABI,
    functionName: "stratMethod",
  });
  return Number(method);
}

export async function readUFloatStrategyAsset(
  strategyAddress: Address,
  rpcUrl: string
): Promise<Address> {
  const client = createTritonPublicClient(rpcUrl);
  return (await client.readContract({
    address: strategyAddress,
    abi: UFLOAT_STRATEGY_ABI,
    functionName: "ASSET",
  })) as Address;
}

/** Read allowed token addresses via allowedTokenCount + allowedTokens(i). */
export async function readUFloatAllowedTokenAddresses(
  strategyAddress: Address,
  rpcUrl: string
): Promise<Address[]> {
  const client = createTritonPublicClient(rpcUrl);
  const count = Number(
    await client.readContract({
      address: strategyAddress,
      abi: UFLOAT_STRATEGY_ABI,
      functionName: "allowedTokenCount",
    })
  );
  const tokens: Address[] = [];
  for (let i = 0; i < count; i++) {
    const token = await client.readContract({
      address: strategyAddress,
      abi: UFLOAT_STRATEGY_ABI,
      functionName: "allowedTokens",
      args: [BigInt(i)],
    });
    tokens.push(token as Address);
  }
  return tokens;
}

async function submitUFloatStrategyChangeAssetTx(
  privateKey: string,
  rpcUrl: string,
  strategyAddress: Address,
  newAssetAddr: Address
): Promise<
  | { ok: true; hash: `0x${string}` }
  | { ok: false; error: string }
> {
  try {
    const wallet = createTritonWalletClient(privateKey, rpcUrl);
    const publicClient = createTritonPublicClient(rpcUrl);
    const { request } = await publicClient.simulateContract({
      account: wallet.account,
      address: strategyAddress,
      abi: UFLOAT_STRATEGY_ABI,
      functionName: "changeAsset",
      args: [newAssetAddr],
    });
    const hash = await writeViemContractWithChangeAssetGasHeadroom(wallet, {
      ...request,
      account: wallet.account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") {
      return { ok: false, error: `changeAsset reverted: ${hash}` };
    }
    return { ok: true, hash };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown changeAsset error",
    };
  }
}

/**
 * Operator changeAsset between allowlisted tokens only.
 * Does not call exitToStable or re-enter from STABLE — those are contract stop-loss or owner-only.
 */
export async function sendUFloatStrategyChangeAsset(
  privateKey: string,
  rpcUrl: string,
  strategyAddress: Address,
  newAssetAddr: Address
): Promise<UFloatChangeAssetResult> {
  try {
    const [assetBefore, modeBefore] = await Promise.all([
      readUFloatStrategyAsset(strategyAddress, rpcUrl),
      readUFloatStrategyMode(strategyAddress, rpcUrl),
    ]);
    const targetLc = normalizeAddr(newAssetAddr);
    const wethLc = getTritonWethAddress().toLowerCase();

    if (modeBefore === UFLOAT_STABLE_MODE) {
      return {
        success: false,
        error: "mode=STABLE — owner-only exit; agent does not changeAsset or exitToStable",
      };
    }

    if (targetLc === wethLc) {
      return {
        success: false,
        error: "agent does not call exitToStable — STABLE is contract stop-loss or owner-only",
      };
    }

    if (normalizeAddr(assetBefore) === targetLc) {
      return ufloatAlreadyAtTarget(assetBefore, "changeAsset");
    }

    const tx = await submitUFloatStrategyChangeAssetTx(
      privateKey,
      rpcUrl,
      strategyAddress,
      newAssetAddr
    );
    if (!tx.ok) return { success: false, error: tx.error };
    const settled = await readUFloatStrategyAssetSettled(strategyAddress, rpcUrl, targetLc);
    if (!settled.matched) {
      return {
        success: false,
        error: `changeAsset tx ${tx.hash} mined but ASSET is ${settled.asset}, expected ${newAssetAddr}`,
      };
    }
    return {
      success: true,
      transactionHash: tx.hash,
      assetBefore,
      assetAfter: settled.asset,
      onChainMethod: "changeAsset",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown changeAsset error",
    };
  }
}

export function filterAllowedWithPoolMapping(
  allowed: Address[],
  poolByToken: Map<string, string>
): Address[] {
  const mapped: Address[] = [];
  const missing: string[] = [];
  for (const addr of allowed) {
    const lc = normalizeAddr(addr);
    if (poolByToken.has(lc)) {
      mapped.push(addr);
    } else {
      missing.push(addr);
    }
  }
  if (missing.length > 0) {
    console.warn(
      `[UFloatKeeper] Skipping ${missing.length} allowed token(s) with no CoinGecko pool mapping: ${missing.join(", ")}`
    );
  }
  return mapped;
}

/** Ranked changeAsset candidates — top allowlist tokens by default metrics (no volume/liquidity/volatility gates). */
export function pickUFloatDefensiveCandidates(
  comparison: UFloatDefensiveComparison,
  currentAsset: Address
): { symbol: string; address: Address }[] {
  const ranked = comparison.weighted_ranking?.ranked;
  const tokens = comparison.tokens_summary;
  if (!ranked?.length || !tokens?.length) return [];

  const wethLower = getTritonWethAddress().toLowerCase();
  const currentLower = normalizeAddr(currentAsset);

  const candidates: { symbol: string; address: Address }[] = [];
  for (const { symbol } of ranked) {
    if (candidates.length >= TOP_N_FOR_PRICE_PICK) break;
    const token = tokens.find((t) => t.symbol === symbol);
    const addr = token?.address?.toLowerCase();
    if (!addr) continue;
    if (addr === wethLower) {
      console.log(`[UFloatKeeper] Skipping WETH (${symbol}) for changeAsset`);
      continue;
    }
    if (addr === currentLower) continue;
    candidates.push({ symbol, address: token!.address as Address });
  }
  return candidates;
}

/** Default-metric CoinGecko comparison for a strategy allowlist (DEFENSIVE rotation). */
export async function fetchUFloatAllowlistDefaultComparison(
  comparable: Address[],
  poolByToken: Map<string, string>
): Promise<UFloatDefensiveComparison | null> {
  if (!process.env.COIN_GECKO_API_KEY?.trim()) {
    return null;
  }
  const comparableLc = comparable.map((a) => normalizeAddr(a));
  return getCachedDefensiveTokenComparison(
    comparableLc,
    COINGECKO_NETWORK,
    () =>
      fetchTokenComparison(comparable, COINGECKO_NETWORK, {
        rankingMetrics: getUfloatTokenRankingMetrics(),
        disableMarketBreadth: true,
        rankingThresholds: getUfloatDefensiveRankingEligibilityThresholds(),
        offensiveMomentumAbsoluteGates: false,
        changeStrategyStrictShortHorizons: false,
        poolByToken,
      }),
    "no-mb"
  ) as Promise<UFloatDefensiveComparison>;
}

async function executeUFloatDefensiveChangeAsset(
  rpcUrl: string,
  row: UFloatDefensiveStrategyRow,
  comparison: UFloatDefensiveComparison,
  currentAsset: Address
): Promise<void> {
  const shardWallet = getUfloatWalletForStrategyId(row.id);
  const strategyKey = normalizeAddr(row.stratAddr);
  const cooldownMs = getUfloatChangeAssetCooldownMs();
  const lastAt = lastDefensiveChangeAtMs.get(strategyKey) ?? 0;
  if (cooldownMs > 0 && Date.now() - lastAt < cooldownMs) {
    console.log(
      `[UFloatKeeper] strategy ${row.id} DEFENSIVE changeAsset skipped — within ${cooldownMs / 1000}s cooldown`
    );
    return;
  }

  const candidates = pickUFloatDefensiveCandidates(comparison, currentAsset);
  if (candidates.length === 0) {
    console.warn(
      `[UFloatKeeper] strategy ${row.id} DEFENSIVE — unexpected: no ranked alternate (single-token allowlist, CoinGecko failure, or missing pool mapping)`
    );
    return;
  }

  for (const chosen of candidates) {
    console.log(
      `[UFloatKeeper] strategy ${row.id} DEFENSIVE — changeAsset(${chosen.address}) ${chosen.symbol}`
    );
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= CHANGE_ASSET_MAX_TRIES; attempt++) {
      if (checkDemeterStopSignal()) {
        console.log("[UFloatKeeper] Stop signal during changeAsset retry");
        return;
      }
      const result = await enqueueUfloatWalletTx(shardWallet.id, () =>
        sendUFloatStrategyChangeAsset(shardWallet.privateKey, rpcUrl, row.stratAddr, chosen.address)
      );
      if (result.success) {
        lastDefensiveChangeAtMs.set(strategyKey, Date.now());
        console.log(formatUFloatChangeAssetSuccessLog(row.id, "DEFENSIVE", result));
        return;
      }
      lastErr = result.error;
      console.warn(
        `[UFloatKeeper] strategy ${row.id} changeAsset(${chosen.symbol}) attempt ${attempt}/${CHANGE_ASSET_MAX_TRIES} failed: ${lastErr}`
      );
      if (attempt < CHANGE_ASSET_MAX_TRIES) {
        await sleepWithStopCheck(CHANGE_ASSET_RETRY_MS);
      }
    }
    console.warn(
      `[UFloatKeeper] strategy ${row.id} giving up on ${chosen.symbol} after ${CHANGE_ASSET_MAX_TRIES} tries: ${lastErr}`
    );
  }
}

type DefensiveWorkItem = {
  row: UFloatDefensiveStrategyRow;
  currentAsset: Address;
  comparable: Address[];
  allowKey: string;
};

/** After performUpkeepBatch, default-metrics changeAsset for mode=DEFENSIVE only (STABLE is owner-only). */
export async function handleUFloatDefensiveAfterUpkeep(
  rpcUrl: string,
  rows: UFloatDefensiveStrategyRow[]
): Promise<void> {
  await sleepWithStopCheck(UPKEEP_DEFENSIVE_WAIT_MS);
  const active = await filterActiveByMinPoolValue(rows, rpcUrl, "UFloatKeeper");
  if (active.length === 0) return;

  if (!process.env.COIN_GECKO_API_KEY?.trim()) {
    console.warn("[UFloatKeeper] DEFENSIVE pass — COIN_GECKO_API_KEY not set, skipping");
    return;
  }

  const workItems: DefensiveWorkItem[] = [];
  for (const row of active) {
    try {
      const [mode, stratMethod, currentAsset, allowedTokens] = await Promise.all([
        readUFloatStrategyMode(row.stratAddr, rpcUrl),
        readUFloatStratMethod(row.stratAddr, rpcUrl),
        readUFloatStrategyAsset(row.stratAddr, rpcUrl),
        readUFloatAllowedTokenAddresses(row.stratAddr, rpcUrl),
      ]);
      if (mode === UFLOAT_STABLE_MODE) {
        continue;
      }

      if (mode !== DEFENSIVE_MODE) continue;

      if (!ufloatStratMethodAllowsDefensive(stratMethod)) {
        console.log(
          `[UFloatKeeper] strategy ${row.id} mode=DEFENSIVE but stratMethod=${formatUFloatStratMethod(stratMethod)} — skip agent changeAsset (keeper rebalance only)`
        );
        continue;
      }

      const poolByToken = buildUfloatPoolByTokenMap();
      const comparable = filterAllowedWithPoolMapping(allowedTokens, poolByToken);
      if (comparable.length === 0) {
        console.warn(
          `[UFloatKeeper] strategy ${row.id} DEFENSIVE — no allowed tokens with pool mapping, skipping changeAsset`
        );
        continue;
      }

      workItems.push({
        row,
        currentAsset,
        comparable,
        allowKey: allowlistCacheKey(comparable.map((a) => normalizeAddr(a))),
      });
    } catch (e) {
      console.warn(
        `[UFloatKeeper] DEFENSIVE scan failed for strategy ${row.id}:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  if (workItems.length === 0) return;

  const byAllowKey = new Map<string, DefensiveWorkItem[]>();
  for (const item of workItems) {
    const list = byAllowKey.get(item.allowKey) ?? [];
    list.push(item);
    byAllowKey.set(item.allowKey, list);
  }

  console.log(
    `[UFloatKeeper] post-upkeep DEFENSIVE default-metrics — ${workItems.length} strateg${workItems.length === 1 ? "y" : "ies"}, ${byAllowKey.size} unique allowlist comparison(s)`
  );

  const poolByToken = buildUfloatPoolByTokenMap();
  for (const [allowKey, group] of byAllowKey) {
    const comparable = group[0]!.comparable;
    let comparison: UFloatDefensiveComparison;
    try {
      comparison = (await fetchUFloatAllowlistDefaultComparison(comparable, poolByToken)) ?? {};
    } catch (e) {
      console.warn(
        `[UFloatKeeper] DEFENSIVE comparison failed for allowlist (${group.length} strategies):`,
        e instanceof Error ? e.message : e
      );
      continue;
    }

    if (!comparison.weighted_ranking?.ranked?.length) {
      console.warn(
        `[UFloatKeeper] post-upkeep — no ranked tokens for allowlist key ${allowKey.slice(0, 48)}… (${group.length} strategies)`
      );
      continue;
    }

    for (const item of group) {
      console.log(
        `[UFloatKeeper] strategy ${item.row.id} (${item.row.stratAddr}) DEFENSIVE — shared allowlist ranking + changeAsset`
      );
      await executeUFloatDefensiveChangeAsset(
        rpcUrl,
        item.row,
        comparison,
        item.currentAsset
      );
    }
  }
}

/** Watched-active + non-zero strat + poolValue ≥ floor (for offensive / shared callers). */
export async function activeUFloatStrategyRows(
  rows: UFloatDefensiveStrategyRow[],
  rpcUrl: string
): Promise<UFloatDefensiveStrategyRow[]> {
  return filterActiveByMinPoolValue(rows, rpcUrl, "UFloatKeeper");
}

/** @deprecated Use grouped {@link handleUFloatDefensiveAfterUpkeep}; kept for direct tests/tools. */
export async function runUFloatDefensiveChangeAsset(
  _privateKey: string,
  rpcUrl: string,
  row: UFloatDefensiveStrategyRow
): Promise<void> {
  const poolByToken = buildUfloatPoolByTokenMap();
  const [currentAsset, allowedTokens] = await Promise.all([
    readUFloatStrategyAsset(row.stratAddr, rpcUrl),
    readUFloatAllowedTokenAddresses(row.stratAddr, rpcUrl),
  ]);
  const comparable = filterAllowedWithPoolMapping(allowedTokens, poolByToken);
  if (comparable.length === 0) return;
  const comparison =
    (await fetchUFloatAllowlistDefaultComparison(comparable, poolByToken)) ?? {};
  await executeUFloatDefensiveChangeAsset(rpcUrl, row, comparison, currentAsset);
}
