/**
 * Cached CoinGecko comparisons — in-process L1 + optional Redis L2 ({@link getRedisUrl}).
 * Dedupes in-flight fetches for the same key.
 */
import { fetchTokenComparisonV4 } from "../action-providers/coingecko-action-provider";
import {
  getRedisUrl,
  getTokenComparisonCacheTtlMs,
} from "../config/token-comparison-cache-config";
import { COINGECKO_NETWORK } from "../config/chain-config";

type CacheEntry = {
  expiresAt: number;
  value: string;
};

const memoryCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

let redisClient: import("ioredis").default | null | undefined;

async function getRedisClient(): Promise<import("ioredis").default | null> {
  if (redisClient !== undefined) return redisClient;
  const url = getRedisUrl();
  if (!url) {
    redisClient = null;
    return null;
  }
  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
    await client.connect();
    redisClient = client;
    console.log("[TokenComparisonCache] Redis L2 connected");
    return client;
  } catch (e) {
    console.warn(
      "[TokenComparisonCache] Redis unavailable — in-memory cache only:",
      e instanceof Error ? e.message : e
    );
    redisClient = null;
    return null;
  }
}

function readMemory(key: string): unknown | undefined {
  const row = memoryCache.get(key);
  if (!row) return undefined;
  if (Date.now() >= row.expiresAt) {
    memoryCache.delete(key);
    return undefined;
  }
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    memoryCache.delete(key);
    return undefined;
  }
}

function writeMemory(key: string, value: unknown, ttlMs: number): void {
  memoryCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value: JSON.stringify(value),
  });
}

async function readRedis(key: string): Promise<unknown | undefined> {
  const client = await getRedisClient();
  if (!client) return undefined;
  try {
    const raw = await client.get(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

async function writeRedis(key: string, value: unknown, ttlMs: number): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;
  try {
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    await client.set(key, JSON.stringify(value), "EX", ttlSec);
  } catch {
    /* ignore Redis write failures */
  }
}

/** Stable cache key for a sorted allowlist of token addresses. */
export function allowlistCacheKey(tokens: readonly string[]): string {
  return [...tokens]
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

async function getOrFetchCached<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlMs: number = getTokenComparisonCacheTtlMs()
): Promise<T> {
  const mem = readMemory(key);
  if (mem !== undefined) return mem as T;

  const redisHit = await readRedis(key);
  if (redisHit !== undefined) {
    writeMemory(key, redisHit, ttlMs);
    return redisHit as T;
  }

  const pending = inflight.get(key);
  if (pending) return (await pending) as T;

  const work = (async () => {
    const fresh = await fetchFn();
    writeMemory(key, fresh, ttlMs);
    await writeRedis(key, fresh, ttlMs);
    return fresh;
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

/** Cached full V4 offensive universe comparison ({@link fetchTokenComparisonV4}). */
export async function getCachedTokenComparisonV4(
  network: string = COINGECKO_NETWORK
): Promise<unknown> {
  const key = `token-comparison:v4:${network}:offensive`;
  const ttl = getTokenComparisonCacheTtlMs();
  return getOrFetchCached(key, () => fetchTokenComparisonV4(network, { disableMarketBreadth: true }), ttl);
}

/** Cached defensive comparison for a fixed allowlist (same metrics/options for all strategies in group). */
export async function getCachedDefensiveTokenComparison<T>(
  comparableTokenAddresses: readonly string[],
  network: string,
  fetchFn: () => Promise<T>,
  optionsKey?: string
): Promise<T> {
  const allowKey = allowlistCacheKey(comparableTokenAddresses);
  const key = `token-comparison:ufloat:defensive:${network}:${allowKey}${optionsKey ? `:${optionsKey}` : ""}`;
  return getOrFetchCached(key, fetchFn, getTokenComparisonCacheTtlMs());
}

/** Test helper — clear in-process cache. */
export function clearTokenComparisonMemoryCache(): void {
  memoryCache.clear();
  inflight.clear();
}
