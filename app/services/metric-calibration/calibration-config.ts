import * as path from "path";

/** Forward return horizon after each changeStrategy success (6 hours). */
export const DEFAULT_CALIBRATION_OUTCOME_HORIZON_MS = 6 * 60 * 60 * 1000;

/** How often Demeter wakes the outcome collector (default 15 min). */
export const DEFAULT_CALIBRATION_COLLECTOR_POLL_MS = 15 * 60 * 1000;

/** Minimum time between tuning runs (default 5 days — conservative rollout). */
export const DEFAULT_CALIBRATION_TUNING_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

/** Keep raw calibration JSONL rows for this long, then prune (default 15 days = 3 cycles). */
export const DEFAULT_CALIBRATION_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

/** How often the tuning loop checks whether a tuning cycle is due (default 1 hour). */
export const DEFAULT_CALIBRATION_TUNING_POLL_MS = 60 * 60 * 1000;

/** @deprecated Use {@link DEFAULT_CALIBRATION_OUTCOME_HORIZON_MS} or {@link getCalibrationOutcomeHorizonMs}. */
export const CALIBRATION_OUTCOME_HORIZON_MS = DEFAULT_CALIBRATION_OUTCOME_HORIZON_MS;
/** @deprecated Use {@link DEFAULT_CALIBRATION_COLLECTOR_POLL_MS} or {@link getCalibrationCollectorPollMs}. */
export const CALIBRATION_COLLECTOR_POLL_MS = DEFAULT_CALIBRATION_COLLECTOR_POLL_MS;
/** @deprecated Use {@link DEFAULT_CALIBRATION_TUNING_WINDOW_MS} or {@link getCalibrationTuningWindowMs}. */
export const CALIBRATION_TUNING_WINDOW_MS = DEFAULT_CALIBRATION_TUNING_WINDOW_MS;
/** @deprecated Use {@link DEFAULT_CALIBRATION_RETENTION_MS} or {@link getCalibrationRetentionMs}. */
export const CALIBRATION_RETENTION_MS = DEFAULT_CALIBRATION_RETENTION_MS;
/** @deprecated Use {@link DEFAULT_CALIBRATION_TUNING_POLL_MS} or {@link getCalibrationTuningPollMs}. */
export const CALIBRATION_TUNING_POLL_MS = DEFAULT_CALIBRATION_TUNING_POLL_MS;

/** Minimum optimal rows in the analysis window before proposing/applying changes. */
export const CALIBRATION_TUNING_MIN_SAMPLES = 12;

/** Max relative change per tuning cycle for scalar thresholds (e.g. 0.05 = ±5%). Conservative rollout. */
export const CALIBRATION_TUNING_MAX_SCALAR_DELTA_FRACTION = 0.05;

/** Max absolute weight nudge per metric per cycle (before renormalize). Conservative rollout. */
export const CALIBRATION_TUNING_MAX_WEIGHT_DELTA = 0.005;

function parseEnvMs(name: string, fallback: number, minMs = 60_000): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < minMs) return fallback;
  return Math.floor(n);
}

/** Env: `CALIBRATION_OUTCOME_HORIZON_MS` (default 6h). */
export function getCalibrationOutcomeHorizonMs(): number {
  return parseEnvMs(
    "CALIBRATION_OUTCOME_HORIZON_MS",
    DEFAULT_CALIBRATION_OUTCOME_HORIZON_MS,
    60_000
  );
}

/** Env: `CALIBRATION_COLLECTOR_POLL_MS` (default 15 min). Set very high on UFloat-only EC2 to idle the collector. */
export function getCalibrationCollectorPollMs(): number {
  return parseEnvMs(
    "CALIBRATION_COLLECTOR_POLL_MS",
    DEFAULT_CALIBRATION_COLLECTOR_POLL_MS,
    60_000
  );
}

/** Env: `CALIBRATION_TUNING_WINDOW_MS` (default 3 days). Min interval between tuning runs. */
export function getCalibrationTuningWindowMs(): number {
  return parseEnvMs(
    "CALIBRATION_TUNING_WINDOW_MS",
    DEFAULT_CALIBRATION_TUNING_WINDOW_MS,
    60_000
  );
}

/** Env: `CALIBRATION_RETENTION_MS` (default 15 days). */
export function getCalibrationRetentionMs(): number {
  return parseEnvMs("CALIBRATION_RETENTION_MS", DEFAULT_CALIBRATION_RETENTION_MS, 60_000);
}

/** Env: `CALIBRATION_TUNING_POLL_MS` (default 1 hour). How often to check if tuning is due. */
export function getCalibrationTuningPollMs(): number {
  return parseEnvMs("CALIBRATION_TUNING_POLL_MS", DEFAULT_CALIBRATION_TUNING_POLL_MS, 60_000);
}

/** When true, tuning loop writes config.overrides.json / triton.overrides.json. */
export function isCalibrationAutoApplyEnabled(): boolean {
  const raw = process.env.CALIBRATION_AUTO_APPLY?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** When true, the tuning loop drives the cycle via the LLM-assisted pass (Path A) instead of the deterministic tuner. */
export function isCalibrationLlmEnabled(): boolean {
  const raw = process.env.CALIBRATION_LLM_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** OpenAI model for the LLM calibration pass (runs at most once per cycle). Override via CALIBRATION_LLM_MODEL. */
export const CALIBRATION_LLM_MODEL = process.env.CALIBRATION_LLM_MODEL?.trim() || "gpt-5.4-mini";

/**
 * Attempts for the LLM calibration call within a single cycle (exponential backoff between tries). On exhaustion
 * the cycle is left "due" so the hourly poll keeps retrying — it never falls back to the deterministic tuner.
 * Override via CALIBRATION_LLM_MAX_RETRIES.
 */
export const CALIBRATION_LLM_MAX_RETRIES = (() => {
  const n = Number(process.env.CALIBRATION_LLM_MAX_RETRIES?.trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
})();

const CALIBRATION_DIR = () => {
  const override = process.env.METRIC_CALIBRATION_LOG_DIR?.trim();
  return override || path.join(process.cwd(), "logs", "metric-calibration");
};

export function getCalibrationEventsPath(): string {
  const override = process.env.METRIC_CALIBRATION_EVENTS_PATH?.trim();
  return override || path.join(CALIBRATION_DIR(), "events.jsonl");
}

export function getCalibrationOutcomesPath(): string {
  const override = process.env.METRIC_CALIBRATION_OUTCOMES_PATH?.trim();
  return override || path.join(CALIBRATION_DIR(), "outcomes.jsonl");
}

export function getCalibrationOptimalPath(): string {
  const override = process.env.METRIC_CALIBRATION_OPTIMAL_PATH?.trim();
  return override || path.join(CALIBRATION_DIR(), "optimal.jsonl");
}

export function getCalibrationTuningRunsPath(): string {
  return path.join(CALIBRATION_DIR(), "tuning-runs.jsonl");
}

export function getCalibrationTuningStatePath(): string {
  return path.join(CALIBRATION_DIR(), "tuning-state.json");
}
