/** Default TTL for cached CoinGecko token comparisons (offensive V4 + defensive allowlists). */
export const DEFAULT_TOKEN_COMPARISON_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

/** Max projected send gas per performUpkeepBatch chunk (RPC estimates under-report; default 2). */
export const DEFAULT_UFLOAT_UPKEEP_BATCH_MAX_GAS = 2_000_000n;

/** Max projected send gas per performHarvestBatch chunk (~30M Base block limit). */
export const DEFAULT_UFLOAT_HARVEST_BATCH_MAX_GAS = 25_000_000n;

export function getTokenComparisonCacheTtlMs(): number {
  const raw = process.env.TOKEN_COMPARISON_CACHE_TTL_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 30_000) return Math.floor(n);
  }
  return DEFAULT_TOKEN_COMPARISON_CACHE_TTL_MS;
}

function parseGasEnv(name: string): bigint | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  try {
    const n = BigInt(raw);
    if (n > 0n) return n;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Chunk sizing cap for performUpkeepBatch (env: `UFLOAT_UPKEEP_BATCH_MAX_GAS`). */
export function getUfloatUpkeepBatchMaxGas(): bigint {
  return (
    parseGasEnv("UFLOAT_UPKEEP_BATCH_MAX_GAS") ??
    parseGasEnv("UFLOAT_KEEPER_BATCH_MAX_GAS") ??
    DEFAULT_UFLOAT_UPKEEP_BATCH_MAX_GAS
  );
}

/** Chunk sizing cap for performHarvestBatch (env: `UFLOAT_HARVEST_BATCH_MAX_GAS`). */
export function getUfloatHarvestBatchMaxGas(): bigint {
  return (
    parseGasEnv("UFLOAT_HARVEST_BATCH_MAX_GAS") ??
    parseGasEnv("UFLOAT_KEEPER_BATCH_MAX_GAS") ??
    DEFAULT_UFLOAT_HARVEST_BATCH_MAX_GAS
  );
}

export function getUfloatKeeperBatchMaxGas(
  functionName: "performUpkeepBatch" | "performHarvestBatch"
): bigint {
  return functionName === "performUpkeepBatch"
    ? getUfloatUpkeepBatchMaxGas()
    : getUfloatHarvestBatchMaxGas();
}

/** `REDIS_URL` — optional shared cache across processes (e.g. redis://127.0.0.1:6379). */
export function getRedisUrl(): string | undefined {
  const url = process.env.REDIS_URL?.trim();
  return url || undefined;
}
