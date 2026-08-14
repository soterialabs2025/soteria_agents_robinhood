/**
 * LLM-assisted metric calibration — Path A: "LLM proposes, deterministic guardrails dispose".
 *
 * Flow each cycle:
 *   1. Run the deterministic analyzer ({@link runMetricCalibrationTuning}, report-only) to get segment stats
 *      + a deterministic baseline proposal from the same JSONL data.
 *   2. Ask an OpenAI model (structured output, temperature 0) to adjust the proposal using judgment, given the
 *      current config, the evidence, and the product rules baked into the prompt.
 *   3. Clamp EVERY number the LLM returns to the same conservative rails the deterministic tuner uses
 *      (±{@link CALIBRATION_TUNING_MAX_SCALAR_DELTA_FRACTION}, ±{@link CALIBRATION_TUNING_MAX_WEIGHT_DELTA},
 *      product locks, weight renormalization). Raw LLM numbers never reach disk.
 *   4. Write only when {@link isCalibrationAutoApplyEnabled}; otherwise report-only. Always log rationale +
 *      proposed-vs-applied to tuning-runs.jsonl.
 *
 * The LLM call is retried with exponential backoff ({@link CALIBRATION_LLM_MAX_RETRIES}) to ride out transient
 * errors (e.g. intermittent 403 propagation, 429s, 5xx). If every attempt fails this throws WITHOUT marking the
 * cycle done (the deterministic analyzer is run with `writeState:false`), so the scheduled loop leaves the cycle
 * "due" and simply retries on the next poll — it never falls back to the deterministic tuner.
 */
import * as fs from "fs/promises";

import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import {
  getMergedConfig,
  saveOverrides,
  type ConfigOverrides,
} from "../../config/demeter-config";
import { saveTritonOverrides } from "../../config/triton-overrides";
import {
  CALIBRATION_LLM_MAX_RETRIES,  
  CALIBRATION_LLM_MODEL,
  CALIBRATION_TUNING_MAX_SCALAR_DELTA_FRACTION,
  CALIBRATION_TUNING_MAX_WEIGHT_DELTA,
  CALIBRATION_TUNING_MIN_SAMPLES,
  getCalibrationTuningRunsPath,
  getCalibrationTuningStatePath,
  isCalibrationAutoApplyEnabled,
} from "./calibration-config";
import {
  pruneCalibrationData,
  runMetricCalibrationTuning,
  type CalibrationTuningSegmentStats,
  type MetricCalibrationTuningReport,
} from "./calibration-tuner";
import { appendJsonlLine } from "./jsonl";

/** Offensive ranking metrics the LLM may reweight (same set the deterministic tuner touches). */
const OFFENSIVE_METRIC_KEYS = [
  "volume_h1",
  "volume_h6",
  "volume_h12",
  "volume_m5",
  "volume_m15",
  "volume_m30",
  "buy_sell_ratio_h6",
  "buy_sell_ratio_h24",
  "price_change_h1",
  "price_change_h6",
  "price_change_h12",
  "price_change_m5_pct",
  "price_change_m15_pct",
  "price_change_m30_pct",
  "price_stability_h24",
  "volatility_h6",
] as const;

type OffensiveMetricKey = (typeof OFFENSIVE_METRIC_KEYS)[number];

/** Scalar thresholds the LLM may adjust (clamped ±frac per cycle). */
const SCALAR_KEYS = [
  "offensiveMomentumMinM5Pct",
  "offensiveMomentumMaxM5Pct",
  "offensiveMomentumMinM15Pct",
  "offensiveMomentumMaxM15Pct",
  "offensiveMomentumMinM30Pct",
  "offensiveMomentumMaxM30Pct",
  "scheduledChangeMinWeightedScore",
  "minVolumeH12Usd",
  "minPoolLiquidityUsd",
] as const;

type ScalarKey = (typeof SCALAR_KEYS)[number];

/** Momentum MIN floors we never let the model RAISE (protects the intentional negative/loosened gates). */
const MOMENTUM_MIN_KEYS: ReadonlySet<ScalarKey> = new Set([
  "offensiveMomentumMinM5Pct",
  "offensiveMomentumMinM15Pct",
  "offensiveMomentumMinM30Pct",
]);

const LlmProposalSchema = z.object({
  rationale: z
    .string()
    .describe(
      "2-4 sentences: the evidence (metricAdvantage, winner momentum/return, match rate) and why these changes follow. Non-authoritative."
    ),
  offensiveWeights: z
    .array(
      z.object({
        metric: z.string().describe("Offensive metric key, e.g. volume_h1, buy_sell_ratio_h6"),
        weight: z.number().describe("Proposed weight (pre-normalization, >= 0). Only include metrics you want to change."),
      })
    )
    .optional()
    .describe("Proposed offensive ranking weight changes. Omit to leave weights unchanged."),
  scalars: z
    .array(
      z.object({
        key: z.string().describe("Threshold key, e.g. scheduledChangeMinWeightedScore, offensiveMomentumMaxM5Pct"),
        value: z.number().describe("Proposed value. Will be clamped to a small band around the current value."),
      })
    )
    .optional()
    .describe("Proposed scalar threshold changes. Omit to leave thresholds unchanged."),
});

type LlmProposal = z.infer<typeof LlmProposalSchema>;

export type LlmCalibrationRunReport = {
  runAtUtc: string;
  mode: "llm";
  model: string;
  totalSamples: number;
  autoApplyEnabled: boolean;
  applied: boolean;
  applySkippedReason?: string;
  rationale?: string;
  llmProposal?: LlmProposal;
  appliedDemeterOverrides: ConfigOverrides;
  appliedTritonOverridesApplied: boolean;
  deterministicBaseline: {
    proposedDemeterOverrides: ConfigOverrides;
    floatV3: CalibrationTuningSegmentStats;
    floatV4: CalibrationTuningSegmentStats;
  };
};

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Clamp `target` to within ±(|current|·maxFraction) of `current`. */
function clampScalarDelta(current: number, target: number, maxFraction: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return current;
  const maxDelta = Math.abs(current) * maxFraction + 1e-9;
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return round4(target);
  return round4(current + Math.sign(delta) * maxDelta);
}

function summarizeSegment(seg: CalibrationTuningSegmentStats) {
  return {
    sampleCount: seg.sampleCount,
    chosenMatchedWinnerCount: seg.chosenMatchedWinnerCount,
    avgWinnerForwardReturnPct: seg.avgWinnerForwardReturnPct,
    metricAdvantage: seg.metricAdvantage,
    winnerMomentumP10: seg.winnerMomentumP10,
    winnerMomentumP90: seg.winnerMomentumP90,
    winnerCompositeP25: seg.winnerCompositeP25,
    winnerVolumeH12P5: seg.winnerVolumeH12P5,
    winnerLiquidityP5: seg.winnerLiquidityP5,
  };
}

function currentConfigSnapshot(): {
  offensiveWeights: Record<string, number>;
  scalars: Record<string, number>;
} {
  const cfg = getMergedConfig();
  const offensiveWeights: Record<string, number> = {};
  for (const key of OFFENSIVE_METRIC_KEYS) {
    const w = cfg.offensiveTokenRankingMetrics[key]?.weight ?? 0;
    if (w > 0) offensiveWeights[key] = round4(w);
  }
  const scalars: Record<string, number> = {};
  for (const key of SCALAR_KEYS) scalars[key] = cfg[key];
  return { offensiveWeights, scalars };
}

const SYSTEM_RULES = `You tune a crypto strategy's offensive token-ranking model from 6h forward-return calibration evidence.

Hard product rules (never violate):
- price_change_* metrics stay "higher is better" (no buy-the-dip inversion). You only set weights, never directions.
- buy_sell_ratio_h24 stays "higher is better". Net-selling tokens must never be rewarded.
- Do NOT raise the momentum MIN floors (offensiveMomentumMin*). They are intentionally loose/negative to let more tokens qualify; you may lower them or leave them.
- Favor buy pressure (buy_sell_ratio_h6/h24) and volume_h1 when the evidence supports it; volume_h1 is historically the strongest single separator.

Method:
- Use metricAdvantage (winner minus loser weighted score per metric): positive => that metric helped pick winners => consider more weight; negative => less.
- Weight the two segments (floatV3, floatV4) by their sampleCount.
- Every number you return will be CLAMPED to a small band around the current value, so propose direction + modest magnitude; do not try to make large jumps.
- Only include metrics/scalars you actually want to change. Prefer few, well-justified changes.
- If the evidence is weak or noisy, return empty arrays and say so in the rationale.`;

function buildUserPrompt(report: MetricCalibrationTuningReport): string {
  const snap = currentConfigSnapshot();
  const payload = {
    windowDays: Math.round(report.windowMs / (24 * 60 * 60 * 1000)),
    totalSamples: report.totalSamples,
    currentOffensiveWeights: snap.offensiveWeights,
    currentScalars: snap.scalars,
    evidence: {
      floatV3: summarizeSegment(report.floatV3),
      floatV4: summarizeSegment(report.floatV4),
    },
    deterministicBaselineProposal: report.proposedDemeterOverrides,
  };
  return (
    "Calibration evidence and current config (JSON):\n" +
    JSON.stringify(payload, null, 2) +
    "\n\nReturn your proposed offensive weight changes and scalar threshold changes."
  );
}

/** Clamp LLM weight proposal to ±MAX_WEIGHT_DELTA per metric, renormalize active weights to sum 1, emit only changed. */
function validateWeights(
  proposed: LlmProposal["offensiveWeights"]
): ConfigOverrides["offensiveTokenRankingMetrics"] | undefined {
  if (!proposed || proposed.length === 0) return undefined;
  const cfg = getMergedConfig();
  const current: Record<string, number> = {};
  for (const key of OFFENSIVE_METRIC_KEYS) current[key] = cfg.offensiveTokenRankingMetrics[key]?.weight ?? 0;

  const proposedByKey = new Map<string, number>();
  for (const { metric, weight } of proposed) {
    if ((OFFENSIVE_METRIC_KEYS as readonly string[]).includes(metric)) proposedByKey.set(metric, weight);
  }

  const maxDelta = CALIBRATION_TUNING_MAX_WEIGHT_DELTA;
  const next: Record<string, number> = { ...current };
  for (const key of OFFENSIVE_METRIC_KEYS) {
    // Only reweight currently-active metrics; never resurrect a zero-weight (e.g. dip-inverted) metric.
    if (current[key]! <= 0) continue;
    const want = proposedByKey.get(key);
    if (want == null || !Number.isFinite(want)) continue;
    const delta = Math.max(0, want) - current[key]!;
    const capped =
      Math.abs(delta) <= maxDelta ? Math.max(0, want) : current[key]! + Math.sign(delta) * maxDelta;
    next[key] = Math.max(0, round4(capped));
  }

  let activeSum = 0;
  for (const key of OFFENSIVE_METRIC_KEYS) if (next[key]! > 0) activeSum += next[key]!;
  if (activeSum <= 0) return undefined;

  const out: NonNullable<ConfigOverrides["offensiveTokenRankingMetrics"]> = {};
  for (const key of OFFENSIVE_METRIC_KEYS) {
    if (next[key]! <= 0) continue;
    const normalized = round4(next[key]! / activeSum);
    const prev = round4(current[key]!);
    if (Math.abs(normalized - prev) >= 0.001) out[key as OffensiveMetricKey] = { weight: normalized };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Clamp LLM scalar proposals to ±frac of current; never raise momentum MIN floors. */
function validateScalars(proposed: LlmProposal["scalars"]): Partial<Record<ScalarKey, number>> {
  const out: Partial<Record<ScalarKey, number>> = {};
  if (!proposed || proposed.length === 0) return out;
  const cfg = getMergedConfig();
  const frac = CALIBRATION_TUNING_MAX_SCALAR_DELTA_FRACTION;
  for (const { key, value } of proposed) {
    if (!(SCALAR_KEYS as readonly string[]).includes(key)) continue;
    const k = key as ScalarKey;
    const current = cfg[k];
    if (!Number.isFinite(value)) continue;
    let next = clampScalarDelta(current, value, frac);
    // Protect intentional loosening: momentum mins may go down or stay, never up.
    if (MOMENTUM_MIN_KEYS.has(k) && next > current) next = current;
    if (next !== current) out[k] = next;
  }
  return out;
}

function hasKeys(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length > 0;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Invoke the structured LLM with exponential backoff. Retries transient failures ({@link CALIBRATION_LLM_MAX_RETRIES}
 * attempts, 1s→2s→4s→8s… capped at 30s). Throws the last error only after every attempt is exhausted.
 */
async function invokeWithRetry(
  invoke: () => Promise<LlmProposal>,
  maxAttempts: number
): Promise<LlmProposal> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await invoke();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= maxAttempts) {
        console.error(
          `[MetricCalibration] LLM attempt ${attempt}/${maxAttempts} failed (giving up this cycle): ${message}`
        );
        break;
      }
      const waitMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      console.warn(
        `[MetricCalibration] LLM attempt ${attempt}/${maxAttempts} failed: ${message} — retrying in ${waitMs}ms`
      );
      await sleep(waitMs);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM calibration call failed after ${maxAttempts} attempts`);
}

async function writeRunRecord(record: LlmCalibrationRunReport): Promise<void> {
  await appendJsonlLine(getCalibrationTuningRunsPath(), record);
  await fs.writeFile(
    getCalibrationTuningStatePath(),
    JSON.stringify({ lastRunAtUtc: record.runAtUtc, lastReport: record }, null, 2),
    "utf8"
  );
}

export type RunLlmCalibrationOptions = {
  /** When false, never write overrides even if auto-apply is enabled (dry run). Default true. */
  apply?: boolean;
  /** Override the analysis window (ms). Default = CALIBRATION_TUNING_WINDOW_MS (5 days). Widen for dry runs on old logs. */
  windowMs?: number;
  /** Prune old JSONL after the cycle. Default true (scheduled loop); pass false for dry runs on pulled logs. */
  pruneAfter?: boolean;
};

/**
 * Run one LLM-assisted calibration cycle. Retries the OpenAI call ({@link CALIBRATION_LLM_MAX_RETRIES}) and, if it
 * still fails, throws without persisting state so the scheduled loop retries next poll (no deterministic fallback).
 * Writes overrides only when apply !== false AND {@link isCalibrationAutoApplyEnabled}.
 */
export async function runLlmCalibrationTuning(
  options: RunLlmCalibrationOptions = {}
): Promise<LlmCalibrationRunReport> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY not set — cannot run LLM calibration pass");
  }
  const runAtUtc = new Date().toISOString();

  // 1. Deterministic analysis (report-only, no prune) → evidence + baseline proposal from the same data.
  //    writeState:false so a failed LLM cycle does NOT mark the cycle done (it stays "due" and retries next poll).
  const report = await runMetricCalibrationTuning({
    apply: false,
    pruneAfter: false,
    writeState: false,
    windowMs: options.windowMs,
  });

  const autoApplyEnabled = isCalibrationAutoApplyEnabled();
  const wantApply = options.apply !== false && autoApplyEnabled;

  const base: LlmCalibrationRunReport = {
    runAtUtc,
    mode: "llm",
    model: CALIBRATION_LLM_MODEL,
    totalSamples: report.totalSamples,
    autoApplyEnabled,
    applied: false,
    rationale: undefined,
    llmProposal: undefined,
    appliedDemeterOverrides: {},
    appliedTritonOverridesApplied: false,
    deterministicBaseline: {
      proposedDemeterOverrides: report.proposedDemeterOverrides,
      floatV3: report.floatV3,
      floatV4: report.floatV4,
    },
  };

  if (report.totalSamples < CALIBRATION_TUNING_MIN_SAMPLES) {
    const rec = {
      ...base,
      applySkippedReason: `Insufficient samples (${report.totalSamples} < ${CALIBRATION_TUNING_MIN_SAMPLES})`,
    };
    await writeRunRecord(rec);
    return rec;
  }

  // 2. LLM structured proposal. gpt-5* only accept the default temperature, so only force temp=0 on older models.
  const supportsTemperature = !/^gpt-5/i.test(CALIBRATION_LLM_MODEL);
  const llm = new ChatOpenAI({
    model: CALIBRATION_LLM_MODEL,
    ...(supportsTemperature ? { temperature: 0 } : {}),
  });
  const structured = llm.withStructuredOutput(LlmProposalSchema, { name: "calibration_proposal" });
  const userPrompt = buildUserPrompt(report);
  // Retry transient failures (intermittent 403 propagation / 429 / 5xx); throws only after all attempts fail.
  const proposal = await invokeWithRetry(
    () =>
      structured.invoke([
        { role: "system", content: SYSTEM_RULES },
        { role: "user", content: userPrompt },
      ]) as Promise<LlmProposal>,
    CALIBRATION_LLM_MAX_RETRIES
  );

  // 3. Clamp/validate to the same rails as the deterministic tuner.
  const weights = validateWeights(proposal.offensiveWeights);
  const scalars = validateScalars(proposal.scalars);
  const demeterOverrides: ConfigOverrides = {
    ...scalars,
    ...(weights ? { offensiveTokenRankingMetrics: weights } : {}),
  };

  base.rationale = proposal.rationale;
  base.llmProposal = proposal;
  base.appliedDemeterOverrides = demeterOverrides;

  const materialDemeter = hasKeys(demeterOverrides as Record<string, unknown>);
  const materialTriton = hasKeys(report.proposedTritonOverrides as Record<string, unknown>);

  // 4. Apply (gated). Triton/V4 uses the deterministic proposal (already clamped by its own logic).
  if (!wantApply) {
    base.applySkippedReason = autoApplyEnabled
      ? "Dry run (apply=false)"
      : "CALIBRATION_AUTO_APPLY not enabled (report-only)";
  } else if (!materialDemeter && !materialTriton) {
    base.applySkippedReason = "No material changes after clamping";
  } else {
    if (materialDemeter) saveOverrides(demeterOverrides);
    if (materialTriton) {
      saveTritonOverrides(report.proposedTritonOverrides);
      base.appliedTritonOverridesApplied = true;
    }
    base.applied = true;
  }

  // Prune old JSONL after a completed cycle (matches deterministic tuner). Skipped for dry runs so pulled/historical logs are preserved.
  if (options.pruneAfter !== false) await pruneCalibrationData();

  await writeRunRecord(base);
  return base;
}
