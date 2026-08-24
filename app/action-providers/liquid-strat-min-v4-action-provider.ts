import type { Abi, Address } from "viem";
import { createPublicClient, createWalletClient, formatUnits, http, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";

import liquidStratMinV4Json from "../abi/LiquidStratMinV4.json";
import { writeViemContractWithChangeAssetGasHeadroom } from "../services/demeter-wallet-tx";
import { fetchTokenComparisonV4, fetchTokenComparisonV4Default } from "./coingecko-action-provider";
import {
  getTritonDefensiveExitStatus,
  setTritonTieredDefensiveExitsEnabled,
} from "../config/triton-defensive-exit-control";
import {
  clearTritonPositionRules,
  getTritonPositionRulesLoadPaths,
  getTritonPositionRulesPath,
  loadTritonPositionRules,
  setTritonPositionRulesFromChat,
} from "../config/triton-position-rules";
import {
  clearTritonScheduledAction,
  formatTritonScheduledActionSummary,
  loadTritonScheduledAction,
  scheduleTritonExitToWeth,
  scheduleTritonRotateToToken,
} from "../config/triton-scheduled-actions";
import {
  listTritonV4Tokens,
  resolveTritonV4Token,
  tokenNameForAddress,
} from "../config/triton-v4-token-registry";
import {
  LIQUID_STRAT_MIN_V4_ADDRESS,
  TRITON_WALLET_ADDRESS,
  getTritonWethAddress,
} from "../config/triton-config";
import {
  explorerAddressUrl,
  explorerTokenUrl,
  getRpcUrlOptional,
  getViemChain,
  COINGECKO_NETWORK,
} from "../config/chain-config";

const LIQUID_STRAT_MIN_V4_ABI = (liquidStratMinV4Json as { abi: Abi }).abi;

const LIQUID_MODE_LABELS: Record<number, string> = {
  0: "NORMAL",
  1: "DEFENSIVE",
  2: "OFFENSIVE",
  3: "NEUTRAL",
};

export function isTritonWethAddress(addr: string): boolean {
  return addr.trim().toLowerCase() === getTritonWethAddress().toLowerCase();
}

export type LiquidStratAccess = {
  owner: Address;
  tritonAddr: Address;
  mode: number;
  canChangeAsset: (wallet: Address) => boolean;
};

function normalizePk(pk: string): `0x${string}` {
  const t = pk.trim();
  return (t.startsWith("0x") ? t : `0x${t}`) as `0x${string}`;
}

export function getTritonWalletAddress(privateKey: string): Address {
  return privateKeyToAccount(normalizePk(privateKey)).address;
}

export function getLiquidStratMinV4Address(): Address {
  return LIQUID_STRAT_MIN_V4_ADDRESS as Address;
}

function chainFromEnv() {
  return getViemChain();
}

export function createTritonPublicClient(rpcUrl: string) {
  return createPublicClient({
    chain: chainFromEnv(),
    transport: http(rpcUrl),
  });
}

export function createTritonWalletClient(privateKey: string, rpcUrl: string) {
  const account = privateKeyToAccount(normalizePk(privateKey));
  return createWalletClient({
    account,
    chain: chainFromEnv(),
    transport: http(rpcUrl),
  });
}

/** On-chain roles that may call `changeAsset` (owner or tritonAddr). */
export async function readLiquidStratAccess(rpcUrl: string): Promise<LiquidStratAccess> {
  const client = createTritonPublicClient(rpcUrl);
  const contract = getLiquidStratMinV4Address();
  const [owner, tritonAddr, mode] = await Promise.all([
    client.readContract({
      address: contract,
      abi: LIQUID_STRAT_MIN_V4_ABI,
      functionName: "owner",
    }),
    client.readContract({
      address: contract,
      abi: LIQUID_STRAT_MIN_V4_ABI,
      functionName: "tritonAddr",
    }),
    client.readContract({
      address: contract,
      abi: LIQUID_STRAT_MIN_V4_ABI,
      functionName: "mode",
    }),
  ]);
  const ownerAddr = owner as Address;
  const triton = tritonAddr as Address;
  return {
    owner: ownerAddr,
    tritonAddr: triton,
    mode: Number(mode),
    canChangeAsset(wallet: Address) {
      const w = wallet.toLowerCase();
      if (w === ownerAddr.toLowerCase()) return true;
      if (triton !== zeroAddress && w === triton.toLowerCase()) return true;
      return false;
    },
  };
}

export async function readLiquidStratAssetAddr(rpcUrl: string): Promise<Address> {
  const client = createTritonPublicClient(rpcUrl);
  const addr = await client.readContract({
    address: getLiquidStratMinV4Address(),
    abi: LIQUID_STRAT_MIN_V4_ABI,
    functionName: "assetAddr",
  });
  return addr as Address;
}

export type LiquidStratMinV4Status = {
  contractAddress: Address;
  /** Token the strategy currently holds (`ASSET()`). WETH means offensive parking. */
  heldAssetAddress: Address;
  /** Short name for chat (e.g. grantr, nook). */
  heldAssetName: string;
  heldAssetLabel: string;
  isWethParked: boolean;
  /** Configured target from `assetAddr` (may differ from held while rotating). */
  assetAddr: Address;
  loopBranch: "offensive_parking_weth" | "defensive_holding_token";
  mode: number;
  modeLabel: string;
  owner: Address;
  tritonAddr: Address;
  v4PoolConfigForHeldAsset: boolean;
  consecutiveOffensiveCount: number;
  vaultValue: string;
  defensiveEnteredAt: number;
  explorerContractUrl: string;
  explorerHeldTokenUrl: string;
};

/** Read-only LiquidStratMinV4 snapshot for chat / diagnostics. */
export async function readLiquidStratMinV4Status(rpcUrl: string): Promise<LiquidStratMinV4Status> {
  const client = createTritonPublicClient(rpcUrl);
  const contract = getLiquidStratMinV4Address();
  const [access, assetAddr, heldAsset, consecutiveOffensiveCount, vaultValue, defensiveEnteredAt] =
    await Promise.all([
      readLiquidStratAccess(rpcUrl),
      readLiquidStratAssetAddr(rpcUrl),
      readLiquidStratHeldAsset(rpcUrl),
      client.readContract({
        address: contract,
        abi: LIQUID_STRAT_MIN_V4_ABI,
        functionName: "consecutiveOffensiveCount",
      }),
      client.readContract({
        address: contract,
        abi: LIQUID_STRAT_MIN_V4_ABI,
        functionName: "vaultValue",
      }),
      client.readContract({
        address: contract,
        abi: LIQUID_STRAT_MIN_V4_ABI,
        functionName: "defensiveEnteredAt",
      }),
    ]);

  const isWethParked = isTritonWethAddress(heldAsset);
  const heldName = tokenNameForAddress(heldAsset) ?? heldAsset;
  const mode = access.mode;
  return {
    contractAddress: contract,
    heldAssetAddress: heldAsset,
    heldAssetName: isWethParked ? "weth" : heldName,
    heldAssetLabel: isWethParked ? "WETH (offensive parking)" : `${heldName} (${heldAsset})`,
    isWethParked,
    assetAddr: assetAddr as Address,
    loopBranch: isWethParked ? "offensive_parking_weth" : "defensive_holding_token",
    mode,
    modeLabel: LIQUID_MODE_LABELS[mode] ?? `UNKNOWN(${mode})`,
    owner: access.owner,
    tritonAddr: access.tritonAddr,
    v4PoolConfigForHeldAsset: await hasV4PoolConfigForAsset(rpcUrl, heldAsset),
    consecutiveOffensiveCount: Number(consecutiveOffensiveCount),
    vaultValue: formatUnits(vaultValue as bigint, 18),
    defensiveEnteredAt: Number(defensiveEnteredAt),
    explorerContractUrl: explorerAddressUrl(contract),
    explorerHeldTokenUrl: explorerTokenUrl(heldAsset),
  };
}

/** AgentKit tools for LiquidStratMinV4 / Triton (chat console). */
export function liquidStratMinV4ActionProvider() {
  const contract = LIQUID_STRAT_MIN_V4_ADDRESS;
  return customActionProvider([
    {
      name: "liquidStratMinV4_getStatus",
      description:
        `Read LiquidStratMinV4 (Triton "Liquid" strategy) on-chain status at ${contract}. ` +
        `Use for "what token is Liquid holding", "what is Triton holding", LiquidStratMinV4 position, mode, WETH parking, etc. ` +
        `Returns heldAssetAddress from ASSET() (actual token held), assetAddr (configured target), mode, vaultValue, loop branch.`,
      schema: z.object({}),
      invoke: async () => {
        try {
          const rpcUrl = getRpcUrlOptional();
          if (!rpcUrl) {
            return JSON.stringify({ success: false, error: "RPC_URL is not set" });
          }
          const status = await readLiquidStratMinV4Status(rpcUrl);
          return JSON.stringify({ success: true, data: status });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: "liquidStratMinV4_listTokens",
      description:
        "List all Triton V4 tokens by short name (e.g. grantr, nook, moltbook) with contract addresses. " +
        "Use when the user asks what tokens are available or needs a name for changeAsset / getTokenPrice.",
      schema: z.object({}),
      invoke: async () => {
        const tokens = listTritonV4Tokens();
        return JSON.stringify({ success: true, data: tokens });
      },
    },
    {
      name: "liquidStratMinV4_getTokenPrice",
      description:
        "Get USD price for a Triton V4 token by short name (e.g. grantr) or 0x address. " +
        'Use for "what is the price of grantr?"',
      schema: z.object({
        token: z.string().describe("Token short name (grantr) or contract address"),
      }),
      invoke: async ({ token }: { token: string }) => {
        try {
          const resolved = resolveTritonV4Token(token);
          if (!resolved) {
            return JSON.stringify({
              success: false,
              error: `Unknown token "${token}". Call liquidStratMinV4_listTokens for names.`,
            });
          }
          const priceUsd = await fetchTokenPriceUsd(resolved.address);
          return JSON.stringify({
            success: true,
            data: {
              name: resolved.name,
              address: resolved.address,
              priceUsd,
            },
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: "liquidStratMinV4_compareTokens",
      description:
        "Rank the Triton V4 token universe. " +
        'rankingMode "offensive" = momentum/offensive metrics (best for "best offensive V4 token"). ' +
        'rankingMode "default" = default/defensive metrics (best for "best default token").',
      schema: z.object({
        rankingMode: z
          .enum(["offensive", "default"])
          .optional()
          .describe('Default "offensive". Use "default" for defensive/default ranking.'),
        currentHeldToken: z
          .string()
          .optional()
          .describe("Optional held token name or address for ranking context"),
      }),
      invoke: async ({
        rankingMode,
        currentHeldToken,
      }: {
        rankingMode?: "offensive" | "default";
        currentHeldToken?: string;
      }) => {
        try {
          let currentAddress: string | null = null;
          if (currentHeldToken?.trim()) {
            const resolved = resolveTritonV4Token(currentHeldToken);
            currentAddress = resolved?.address ?? currentHeldToken.trim();
          }
          const mode = rankingMode ?? "offensive";
          const comparison =
            mode === "default"
              ? await fetchTokenComparisonV4Default(undefined, {
                  currentStrategyTokenAddress: currentAddress,
                })
              : await fetchTokenComparisonV4(undefined, {
                  currentStrategyTokenAddress: currentAddress,
                });
          return JSON.stringify({ success: true, rankingMode: mode, data: comparison });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: "liquidStratMinV4_getDefensiveExitRules",
      description:
        "Show tiered defensive exit config: enabled/disabled + HIGH/MEDIUM/LOW rule thresholds. " +
        "When tiered exits are OFF, only liquidStratMinV4_setPositionRules custom exits apply.",
      schema: z.object({}),
      invoke: async () => {
        const status = getTritonDefensiveExitStatus();
        const custom = loadTritonPositionRules();
        return JSON.stringify({
          success: true,
          tieredExitsEnabled: status.tieredExitsEnabled,
          tieredRulesSummary: status.tieredRulesSummary,
          tieredRules: status.tieredRules,
          customPositionRules: custom,
        });
      },
    },
    {
      name: "liquidStratMinV4_setTieredDefensiveExits",
      description:
        "Start or stop tiered defensive exit rules (HIGH/MEDIUM/LOW trails) in the Triton loop. " +
        'Set enabled:false before using only custom exit rules (setPositionRules). ' +
        'Set enabled:true to resume default tiered exits.',
      schema: z.object({
        enabled: z.boolean().describe("true = run tiered exits; false = custom rules only"),
        notes: z.string().optional(),
      }),
      invoke: async ({ enabled, notes }: { enabled: boolean; notes?: string }) => {
        const control = setTritonTieredDefensiveExitsEnabled(enabled, notes);
        return JSON.stringify({
          success: true,
          message: enabled
            ? "Tiered defensive exits enabled for Triton loop."
            : "Tiered defensive exits disabled — only custom position rules will trigger exits.",
          data: control,
        });
      },
    },
    {
      name: "liquidStratMinV4_getPositionRules",
      description:
        "Show custom exit rules set from chat (take profit / stop loss) for the current Triton position.",
      schema: z.object({}),
      invoke: async () => {
        const rules = loadTritonPositionRules();
        return JSON.stringify({
          success: true,
          data: rules,
          rulesPath: getTritonPositionRulesPath(),
          searchedPaths: getTritonPositionRulesLoadPaths(),
        });
      },
    },
    {
      name: "liquidStratMinV4_setPositionRules",
      description:
        "Set custom exit rules for whatever token Triton currently holds (not tied to one symbol). " +
        'Examples: exit at +10% (takeProfitPctFromEntry: 10), sell at -3% (stopLossPctFromEntry: 3). ' +
        "Rules persist across asset rotations until cleared or updated.",
      schema: z.object({
        token: z
          .string()
          .optional()
          .describe("Optional — ignored; rules apply to any held asset"),
        takeProfitPctFromEntry: z
          .number()
          .optional()
          .describe("Exit to WETH when gain from entry >= this % (e.g. 10)"),
        stopLossPctFromEntry: z
          .number()
          .optional()
          .describe("Exit to WETH when gain from entry <= -this % (e.g. 3)"),
        peakTrailDrawdownPct: z
          .number()
          .optional()
          .describe("Optional peak trail override (% drawdown from peak)"),
        clear: z.boolean().optional().describe("If true, clear all custom rules"),
      }),
      invoke: async ({
        token,
        takeProfitPctFromEntry,
        stopLossPctFromEntry,
        peakTrailDrawdownPct,
        clear,
      }: {
        token?: string;
        takeProfitPctFromEntry?: number;
        stopLossPctFromEntry?: number;
        peakTrailDrawdownPct?: number;
        clear?: boolean;
      }) => {
        try {
          if (clear) {
            clearTritonPositionRules();
            return JSON.stringify({ success: true, cleared: true });
          }
          const rules = setTritonPositionRulesFromChat({
            token,
            takeProfitPctFromEntry,
            stopLossPctFromEntry,
            peakTrailDrawdownPct,
          });
          return JSON.stringify({
            success: true,
            data: rules,
            message: `Rules saved to ${rules.savedPath} — Demeter Triton loop reads this file on the next price tick.`,
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: "liquidStratMinV4_getScheduledAction",
      description: "Show the pending time-based Triton action (exit to WETH or rotate to a token).",
      schema: z.object({}),
      invoke: async () => {
        const action = loadTritonScheduledAction();
        return JSON.stringify({
          success: true,
          data: action,
          summary: action ? formatTritonScheduledActionSummary(action) : null,
        });
      },
    },
    {
      name: "liquidStratMinV4_scheduleExit",
      description:
        "Schedule selling the current token to WETH after a delay (e.g. sell in 1 hour). Runs on next Triton price tick after the time elapses.",
      schema: z.object({
        delayMinutes: z.number().optional().describe("Minutes until exit (e.g. 60 for 1 hour)"),
        delayHours: z.number().optional().describe("Hours until exit"),
        notes: z.string().optional(),
      }),
      invoke: async ({
        delayMinutes,
        delayHours,
        notes,
      }: {
        delayMinutes?: number;
        delayHours?: number;
        notes?: string;
      }) => {
        try {
          const action = scheduleTritonExitToWeth({ delayMinutes, delayHours }, notes);
          return JSON.stringify({
            success: true,
            data: action,
            summary: formatTritonScheduledActionSummary(action),
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: "liquidStratMinV4_scheduleRotate",
      description:
        "Schedule rotating to a token after a delay (e.g. rotate to nook in 10 minutes). Works from WETH or another token.",
      schema: z.object({
        token: z.string().describe("Token name (e.g. nook) or address"),
        delayMinutes: z.number().optional().describe("Minutes until rotate (e.g. 10)"),
        delayHours: z.number().optional().describe("Hours until rotate"),
        notes: z.string().optional(),
      }),
      invoke: async ({
        token,
        delayMinutes,
        delayHours,
        notes,
      }: {
        token: string;
        delayMinutes?: number;
        delayHours?: number;
        notes?: string;
      }) => {
        try {
          const action = scheduleTritonRotateToToken(token, { delayMinutes, delayHours }, notes);
          return JSON.stringify({
            success: true,
            data: action,
            summary: formatTritonScheduledActionSummary(action),
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: "liquidStratMinV4_clearScheduledAction",
      description: "Cancel the pending time-based exit or rotate.",
      schema: z.object({}),
      invoke: async () => {
        clearTritonScheduledAction();
        return JSON.stringify({ success: true, cleared: true });
      },
    },
    {
      name: "liquidStratMinV4_changeAsset",
      description:
        `Submit changeAsset on LiquidStratMinV4 (${contract}). Requires TRITON_PRIVATE_KEY in env (Triton wallet must match on-chain tritonAddr). ` +
        "Use token short name (grantr, nook) or 0x address. Use weth for defensive parking.",
      schema: z.object({
        token: z
          .string()
          .optional()
          .describe("Token short name (grantr) or address — preferred"),
        newAssetAddress: z
          .string()
          .optional()
          .describe("Legacy: raw address (use token field with name instead)"),
      }),
      invoke: async ({
        token,
        newAssetAddress,
      }: {
        token?: string;
        newAssetAddress?: string;
      }) => {
        try {
          const rpcUrl = getRpcUrlOptional();
          const pk = process.env.TRITON_PRIVATE_KEY?.trim();
          if (!rpcUrl) {
            return JSON.stringify({ success: false, error: "RPC_URL is not set" });
          }
          if (!pk) {
            return JSON.stringify({
              success: false,
              error: "TRITON_PRIVATE_KEY is not set — cannot submit changeAsset from chat",
            });
          }
          const raw = token?.trim() || newAssetAddress?.trim();
          if (!raw) {
            return JSON.stringify({
              success: false,
              error: "Provide token (name or address), e.g. grantr",
            });
          }
          const resolved = resolveTritonV4Token(raw);
          const target = (resolved?.address ?? raw.trim()) as Address;
          const result = await sendLiquidStratChangeAsset(pk, rpcUrl, target);
          return JSON.stringify({
            ...result,
            ...(resolved && { tokenName: resolved.name, tokenAddress: resolved.address }),
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  ]);
}

/** IERC20 the strategy currently holds (`ASSET()`), not `assetAddr` (configured target / pool key). */
export async function readLiquidStratHeldAsset(rpcUrl: string): Promise<Address> {
  const client = createTritonPublicClient(rpcUrl);
  const asset = await client.readContract({
    address: getLiquidStratMinV4Address(),
    abi: LIQUID_STRAT_MIN_V4_ABI,
    functionName: "ASSET",
  });
  return asset as Address;
}

/** True when `getV4PoolConfig(asset)` has non-zero currencies + hooks (required for swaps). */
export async function hasV4PoolConfigForAsset(rpcUrl: string, asset: Address): Promise<boolean> {
  const client = createTritonPublicClient(rpcUrl);
  try {
    const result = await client.readContract({
      address: getLiquidStratMinV4Address(),
      abi: LIQUID_STRAT_MIN_V4_ABI,
      functionName: "getV4PoolConfig",
      args: [asset],
    });
    const [key] = result as [
      { currency0: Address; currency1: Address; hooks: Address },
      `0x${string}`,
    ];
    return (
      key.currency0 !== zeroAddress &&
      key.currency1 !== zeroAddress &&
      key.hooks !== zeroAddress
    );
  } catch {
    return false;
  }
}

export async function sendLiquidStratChangeAsset(
  privateKey: string,
  rpcUrl: string,
  newAssetAddr: Address
): Promise<
  | {
      success: true;
      transactionHash: `0x${string}`;
      assetBefore: Address;
      assetAfter: Address;
    }
  | { success: false; error: string }
> {
  try {
    const wallet = createTritonWalletClient(privateKey, rpcUrl);
    const contract = getLiquidStratMinV4Address();
    const access = await readLiquidStratAccess(rpcUrl);
    if (!access.canChangeAsset(wallet.account.address)) {
      return {
        success: false,
        error: `Wallet ${wallet.account.address} is not owner (${access.owner}) or tritonAddr (${access.tritonAddr}) — changeAsset will revert`,
      };
    }

    const publicClient = createTritonPublicClient(rpcUrl);
    const [assetAddrBefore, heldBefore] = await Promise.all([
      readLiquidStratAssetAddr(rpcUrl),
      readLiquidStratHeldAsset(rpcUrl),
    ]);
    const targetLc = newAssetAddr.toLowerCase();
    const targetIsWeth = isTritonWethAddress(newAssetAddr);
    const heldLc = heldBefore.toLowerCase();

    if (targetIsWeth && isTritonWethAddress(heldBefore)) {
      return {
        success: false,
        error:
          `changeAsset(WETH) skipped: ASSET is already WETH (assetAddr=${assetAddrBefore}). ` +
          `Prior agent txs may have no-op'd when assetAddr was stale.`,
      };
    }
    if (!targetIsWeth && heldLc === targetLc) {
      return {
        success: false,
        error: `changeAsset skipped: ASSET already ${heldBefore} (same as target ${newAssetAddr})`,
      };
    }

    const poolReady = await hasV4PoolConfigForAsset(rpcUrl, newAssetAddr);
    if (!poolReady) {
      return {
        success: false,
        error: `changeAsset blocked: no V4 pool config on ${contract} for ${newAssetAddr} — owner must call setV4PoolConfig first`,
      };
    }

    const { request } = await publicClient.simulateContract({
      account: wallet.account,
      address: contract,
      abi: LIQUID_STRAT_MIN_V4_ABI,
      functionName: "changeAsset",
      args: [newAssetAddr],
    });

    const hash = await writeViemContractWithChangeAssetGasHeadroom(wallet, {
      ...request,
      account: wallet.account,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") {
      return { success: false, error: `changeAsset tx reverted: ${hash}` };
    }

    const [assetAddrAfter, heldAfter] = await Promise.all([
      readLiquidStratAssetAddr(rpcUrl),
      readLiquidStratHeldAsset(rpcUrl),
    ]);
    const heldAfterLc = heldAfter.toLowerCase();
    const verified = targetIsWeth ? isTritonWethAddress(heldAfter) : heldAfterLc === targetLc;
    if (!verified) {
      return {
        success: false,
        error:
          `changeAsset tx mined (${hash}) but ASSET is ${heldAfter} (assetAddr ${assetAddrAfter}), expected ${newAssetAddr}. ` +
          `Compare gas: successful entry ~200k+, no-op ~19k.`,
      };
    }

    const swapLogs = receipt.logs?.length ?? 0;
    console.log(
      `[Triton] changeAsset verified: ASSET ${heldBefore} → ${heldAfter}, assetAddr ${assetAddrBefore} → ${assetAddrAfter} (${swapLogs} logs, gas ${receipt.gasUsed})`
    );

    return {
      success: true,
      transactionHash: hash,
      assetBefore: heldBefore,
      assetAfter: heldAfter,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error calling changeAsset",
    };
  }
}

/**
 * Verify `TRITON_PRIVATE_KEY` wallet matches on-chain `tritonAddr` (and {@link TRITON_WALLET_ADDRESS}).
 */
export function assertTritonWalletMatches(
  wallet: Address,
  access: LiquidStratAccess
): void {
  if (wallet.toLowerCase() !== TRITON_WALLET_ADDRESS.toLowerCase()) {
    throw new Error(
      `TRITON_PRIVATE_KEY derives ${wallet} but configured Triton address is ${TRITON_WALLET_ADDRESS}`
    );
  }
  if (
    access.tritonAddr !== zeroAddress &&
    access.tritonAddr.toLowerCase() !== wallet.toLowerCase()
  ) {
    throw new Error(
      `Contract tritonAddr is ${access.tritonAddr} but Triton wallet is ${wallet}. ` +
        `Owner must set tritonAddr to ${TRITON_WALLET_ADDRESS} on LiquidStratMinV4 before changeAsset will succeed.`
    );
  }
  if (!access.canChangeAsset(wallet)) {
    throw new Error(
      `Triton wallet ${wallet} cannot call changeAsset (owner=${access.owner}, tritonAddr=${access.tritonAddr})`
    );
  }
}

/** CoinGecko simple token price on Robinhood Chain (USD). */
export async function fetchTokenPriceUsd(
  tokenAddress: string,
  network = COINGECKO_NETWORK
): Promise<number | null> {
  const key = process.env.COIN_GECKO_API_KEY;
  if (!key) throw new Error("COIN_GECKO_API_KEY is required");
  const addr = tokenAddress.trim().toLowerCase();
  const url = `https://pro-api.coingecko.com/api/v3/simple/token_price/${network}?contract_addresses=${encodeURIComponent(addr)}&vs_currencies=usd`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-cg-pro-api-key": key },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as Record<string, { usd?: number }>;
  const row = json[addr];
  const p = row?.usd;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
}
