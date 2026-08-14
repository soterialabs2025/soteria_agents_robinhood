/**
 * Demeter + Triton wallet tx gas — headroom after `estimateGas`, then floor at {@link DEFAULT_TX_MIN_GAS_LIMIT}.
 * Default 1.30× headroom matches legacy keeper-service harvest buffer.
 */

/** Minimum gas limit for all Demeter/Triton on-chain calls (especially performHarvest). */
export const DEFAULT_TX_MIN_GAS_LIMIT = 1_300_000n;

/** Default gas limit multiplier: 1300 bps = 1.30×. Override: `DEMETER_TX_GAS_HEADROOM_BPS`. */
export const DEFAULT_DEMETER_TX_GAS_HEADROOM_BPS = 1300;

const MIN_HEADROOM_BPS = 1000;
const MAX_HEADROOM_BPS = 2000;

/** Gas limit multiplier in basis points (1000 = 1.0×, 1300 = 1.30×). */
export function getDemeterTxGasHeadroomBps(): number {
  const raw = process.env.DEMETER_TX_GAS_HEADROOM_BPS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= MIN_HEADROOM_BPS && n <= MAX_HEADROOM_BPS) {
      return Math.floor(n);
    }
  }
  return DEFAULT_DEMETER_TX_GAS_HEADROOM_BPS;
}

export function applyDemeterTxGasHeadroom(estimate: bigint, headroomBps?: number): bigint {
  const bps = headroomBps ?? getDemeterTxGasHeadroomBps();
  return (estimate * BigInt(bps)) / 1000n;
}

/** Override: `DEMETER_TX_MIN_GAS_LIMIT` (decimal string). */
export function getTxMinGasLimit(): bigint {
  const raw = process.env.DEMETER_TX_MIN_GAS_LIMIT?.trim();
  if (raw) {
    try {
      const n = BigInt(raw);
      if (n > 0n) return n;
    } catch {
      /* ignore invalid */
    }
  }
  return DEFAULT_TX_MIN_GAS_LIMIT;
}

/** Headroom on estimate, then `max(..., minGasLimit)`. Used by Demeter AgentKit and Triton viem sends. */
export function resolveTxGasLimit(estimate: bigint, headroomBps?: number): bigint {
  const withHeadroom = applyDemeterTxGasHeadroom(estimate, headroomBps);
  const min = getTxMinGasLimit();
  return withHeadroom < min ? min : withHeadroom;
}

/** Extra headroom for multi-strategy keeper batches (RPC estimates often under-report). Default 1600 = 1.60×. */
export const DEFAULT_BATCH_TX_GAS_HEADROOM_BPS = 1600;

export function getBatchTxGasHeadroomBps(): number {
  const raw = process.env.DEMETER_BATCH_TX_GAS_HEADROOM_BPS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= MIN_HEADROOM_BPS && n <= 2500) {
      return Math.floor(n);
    }
  }
  return DEFAULT_BATCH_TX_GAS_HEADROOM_BPS;
}

/** Minimum gas sent for multi-id keeper batches (RPC estimate often under-reports). */
export const DEFAULT_BATCH_TX_MIN_GAS_LIMIT = 2_500_000n;

export function getBatchTxMinGasLimit(): bigint {
  const raw = process.env.DEMETER_BATCH_TX_MIN_GAS_LIMIT?.trim();
  if (raw) {
    try {
      const n = BigInt(raw);
      if (n > 0n) return n;
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_BATCH_TX_MIN_GAS_LIMIT;
}

/**
 * Gas limit for keeper batch txs (performUpkeepBatch / performHarvestBatch).
 * Uses higher headroom than single txs, 2.5× raw estimate, and a batch floor (default 2.5M).
 */
export function resolveBatchTxGasLimit(rawEstimate: bigint): bigint {
  const batchHeadroom = applyDemeterTxGasHeadroom(rawEstimate, getBatchTxGasHeadroomBps());
  const scaled = (rawEstimate * 25n) / 10n;
  let gas = batchHeadroom > scaled ? batchHeadroom : scaled;
  const batchMin = getBatchTxMinGasLimit();
  if (gas < batchMin) {
    gas = batchMin;
  }
  const blockCap = 25_000_000n;
  return gas > blockCap ? blockCap : gas;
}

/**
 * Gas limit for `changeAsset` (UFloat / LiquidStratMinV4) — same headroom + floor as keeper batches;
 * RPC estimates often under-report heavy swap + liquidity paths.
 */
export function resolveChangeAssetTxGasLimit(rawEstimate: bigint): bigint {
  return resolveBatchTxGasLimit(rawEstimate);
}

/** Flatten viem/BaseError chains — OOG often appears in `.details`, not top-level `.message`. */
export function flattenTxErrorText(error: unknown): string {
  const bits: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = error;
  while (cur != null && !seen.has(cur) && bits.length < 24) {
    seen.add(cur);
    if (typeof cur === "object") {
      const o = cur as Record<string, unknown>;
      for (const key of ["shortMessage", "message", "details"]) {
        const v = o[key];
        if (typeof v === "string" && v.trim()) {
          bits.push(v);
        }
      }
      if (Array.isArray(o.metaMessages)) {
        bits.push(o.metaMessages.filter((m): m is string => typeof m === "string").join(" "));
      }
      cur = o.cause;
    } else {
      bits.push(String(cur));
      break;
    }
  }
  return bits.join(" ");
}

export function isTxOutOfGasError(error: unknown): boolean {
  return /out of gas|gas required exceeds|intrinsic gas too low|exceeds block gas limit/i.test(
    flattenTxErrorText(error)
  );
}
