/**
 * x402 token-score — rank 2–10 Robinhood Chain token addresses for LP positioning.
 * Resolves CoinGecko top pools (no hard-coded pool map), then weighted rank via {@link getX402TokenRankingMetrics}.
 */
import { fetchTokenComparison } from "../../action-providers/coingecko-action-provider";
import {
  getX402TokenRankingMetrics,
  getX402TokenRankingWeightSum,
} from "../../config/demeter-config";
import { getUfloatDefensiveRankingEligibilityThresholds } from "../../config/triton-config";
import { COINGECKO_NETWORK, getWethAddress } from "../../config/chain-config";

const NETWORK = COINGECKO_NETWORK;
const COINGECKO_API_BASE = "https://pro-api.coingecko.com/api/v3";
const MIN_TOKENS = 2;
const MAX_TOKENS = 10;

export type X402TokenScoreError = {
  address: string;
  reason: string;
};

export type X402RankedToken = {
  rank: number;
  symbol: string;
  address: string;
  score: number;
  score_normalized: number;
  pool_address: string;
  metric_scores?: Record<string, number>;
};

export type X402TokenScoreResult = {
  network: typeof NETWORK;
  best: X402RankedToken | null;
  ranked: X402RankedToken[];
  errors: X402TokenScoreError[];
  metrics: Record<string, number>;
  weight_sum: number;
};

function normalizeHexAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

function isHexAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

function coinGeckoApiKey(): string {
  const key = process.env.COIN_GECKO_API_KEY?.trim();
  if (!key) throw new Error("COIN_GECKO_API_KEY is required");
  return key;
}

function coinGeckoHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "x-cg-pro-api-key": coinGeckoApiKey(),
  };
}

function parseReserveUsd(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

type IncludedPool = {
  id: string;
  address: string;
  reserveUsd: number;
  baseTokenAddr: string | null;
  quoteTokenAddr: string | null;
};

/**
 * Validate and dedupe Robinhood Chain token addresses (2–10).
 * Throws Error with message suitable for HTTP 400.
 */
export function validateX402TokenAddresses(tokens: unknown): string[] {
  if (!Array.isArray(tokens)) {
    throw new Error("tokens must be an array of Robinhood Chain contract addresses");
  }
  if (tokens.length < MIN_TOKENS || tokens.length > MAX_TOKENS) {
    throw new Error(`tokens must contain between ${MIN_TOKENS} and ${MAX_TOKENS} addresses`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    if (typeof raw !== "string" || !isHexAddress(raw)) {
      throw new Error(`invalid token address: ${String(raw)}`);
    }
    const lc = normalizeHexAddress(raw);
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(lc);
  }
  if (out.length < MIN_TOKENS) {
    throw new Error(`need at least ${MIN_TOKENS} unique valid addresses (got ${out.length})`);
  }
  if (out.length > MAX_TOKENS) {
    throw new Error(`at most ${MAX_TOKENS} unique addresses allowed`);
  }
  return out;
}

/**
 * Resolve best CoinGecko pool per token via tokens/multi?include=top_pools.
 * Prefers WETH pairs; else highest reserve_in_usd.
 */
export async function resolveTopPoolsForTokens(
  tokenAddresses: string[],
  network: string = NETWORK
): Promise<{
  poolByToken: Map<string, string>;
  errors: X402TokenScoreError[];
}> {
  const headers = coinGeckoHeaders();
  const csv = tokenAddresses.join(",");
  const q = new URLSearchParams({
    include: "top_pools",
    include_composition: "true",
  });
  const url = `${COINGECKO_API_BASE}/onchain/networks/${encodeURIComponent(network)}/tokens/multi/${encodeURIComponent(csv)}?${q}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CoinGecko tokens/multi failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  const raw = (await res.json()) as {
    data?: Array<{
      attributes?: { address?: string };
      relationships?: { top_pools?: { data?: Array<{ id?: string; type?: string }> } };
    }>;
    included?: Array<{
      id?: string;
      type?: string;
      attributes?: { address?: string; reserve_in_usd?: string | number };
      relationships?: {
        base_token?: { data?: { id?: string } };
        quote_token?: { data?: { id?: string } };
      };
    }>;
  };

  const includedPools = new Map<string, IncludedPool>();
  for (const inc of raw.included ?? []) {
    if (inc.type !== "pool" || !inc.id) continue;
    const addr = typeof inc.attributes?.address === "string" ? normalizeHexAddress(inc.attributes.address) : "";
    if (!addr) continue;
    const baseId = inc.relationships?.base_token?.data?.id ?? "";
    const quoteId = inc.relationships?.quote_token?.data?.id ?? "";
    // CoinGecko token ids look like "base_0x...."
    const extractAddr = (id: string): string | null => {
      const m = /_(0x[a-fA-F0-9]{40})$/i.exec(id);
      return m?.[1] ? normalizeHexAddress(m[1]) : null;
    };
    includedPools.set(inc.id, {
      id: inc.id,
      address: addr,
      reserveUsd: parseReserveUsd(inc.attributes?.reserve_in_usd),
      baseTokenAddr: extractAddr(baseId),
      quoteTokenAddr: extractAddr(quoteId),
    });
  }

  const poolByToken = new Map<string, string>();
  const errors: X402TokenScoreError[] = [];
  const wethLc = getWethAddress().toLowerCase();

  type TokenRow = NonNullable<typeof raw.data>[number];
  const tokenDataByAddr = new Map<string, TokenRow>();
  for (const t of raw.data ?? []) {
    const a = t.attributes?.address;
    if (typeof a === "string") tokenDataByAddr.set(normalizeHexAddress(a), t);
  }

  for (const tokenAddr of tokenAddresses) {
    const row = tokenDataByAddr.get(tokenAddr);
    if (!row) {
      errors.push({ address: tokenAddr, reason: "token not found on CoinGecko Robinhood" });
      continue;
    }
    const topRefs = row.relationships?.top_pools?.data ?? [];
    const candidates: IncludedPool[] = [];
    for (const ref of topRefs) {
      if (!ref.id) continue;
      const pool = includedPools.get(ref.id);
      if (pool) candidates.push(pool);
    }
    if (candidates.length === 0) {
      errors.push({ address: tokenAddr, reason: "no top_pools available" });
      continue;
    }

    const withWeth = candidates.filter(
      (p) => p.baseTokenAddr === wethLc || p.quoteTokenAddr === wethLc
    );
    const poolSet = withWeth.length > 0 ? withWeth : candidates;
    poolSet.sort((a, b) => b.reserveUsd - a.reserveUsd);
    const best = poolSet[0]!;
    poolByToken.set(tokenAddr, best.address);
  }

  return { poolByToken, errors };
}

type ComparisonShape = {
  tokens_summary?: Array<{ symbol: string; address: string }>;
  weighted_ranking?: {
    ranked: Array<{ symbol: string; score: number; metric_scores?: Record<string, number> }>;
  };
};

/**
 * Rank 2–10 Robinhood Chain token addresses for LP positioning (x402 paid product).
 */
export async function scoreTokensForX402(tokensInput: unknown): Promise<X402TokenScoreResult> {
  const addresses = validateX402TokenAddresses(tokensInput);
  const { poolByToken, errors } = await resolveTopPoolsForTokens(addresses, NETWORK);

  const scorable = addresses.filter((a) => poolByToken.has(a));
  if (scorable.length < MIN_TOKENS) {
    const err = new Error(
      `fewer than ${MIN_TOKENS} tokens could be scored (${scorable.length} ok). ${errors.map((e) => `${e.address}: ${e.reason}`).join("; ")}`
    );
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const rankingMetrics = getX402TokenRankingMetrics();
  const weightSum = getX402TokenRankingWeightSum();
  const comparison = (await fetchTokenComparison(scorable, NETWORK, {
    rankingMetrics,
    poolByToken,
    disableMarketBreadth: true,
    rankingThresholds: getUfloatDefensiveRankingEligibilityThresholds(),
  })) as ComparisonShape;

  const tokens = comparison.tokens_summary ?? [];
  const rankedRaw = comparison.weighted_ranking?.ranked ?? [];
  const ranked: X402RankedToken[] = [];

  for (let i = 0; i < rankedRaw.length; i++) {
    const r = rankedRaw[i]!;
    const token = tokens.find((t) => t.symbol === r.symbol);
    if (!token?.address) continue;
    const addrLc = normalizeHexAddress(token.address);
    const pool = poolByToken.get(addrLc) ?? "";
    const score = Number.isFinite(r.score) ? r.score : 0;
    ranked.push({
      rank: ranked.length + 1,
      symbol: r.symbol,
      address: addrLc,
      score: Math.round(score * 1000) / 1000,
      score_normalized: Math.round((score / weightSum) * 1000) / 1000,
      pool_address: pool,
      metric_scores: r.metric_scores,
    });
  }

  // Tokens that had pools but were somehow missing from ranking
  for (const addr of scorable) {
    if (!ranked.some((r) => r.address === addr)) {
      errors.push({ address: addr, reason: "missing from weighted ranking response" });
    }
  }

  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(rankingMetrics)) {
    metrics[k] = v.weight;
  }

  return {
    network: NETWORK,
    best: ranked[0] ?? null,
    ranked,
    errors,
    metrics,
    weight_sum: Math.round(weightSum * 1000) / 1000,
  };
}
