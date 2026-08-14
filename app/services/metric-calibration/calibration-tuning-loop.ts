import {
  CALIBRATION_LLM_MODEL,
  getCalibrationTuningPollMs,
  getCalibrationTuningWindowMs,
  isCalibrationAutoApplyEnabled,
  isCalibrationLlmEnabled,
} from "./calibration-config";
import { isCalibrationTuningDue, runMetricCalibrationTuning } from "./calibration-tuner";
import { runLlmCalibrationTuning } from "./llm-calibration";
import { checkDemeterStopSignal, sleepWithStopCheck } from "../../config/demeter-stop";

/**
 * Run one due cycle. When the LLM pass (Path A) is enabled it OWNS the cycle: it retries internally and, if it
 * still fails, throws WITHOUT marking the cycle done so this loop leaves it "due" and retries next poll — it never
 * falls back to the deterministic tuner. The deterministic tuner runs only when the LLM pass is disabled.
 */
async function runOneCalibrationCycle(autoApply: boolean): Promise<void> {
  if (isCalibrationLlmEnabled()) {
    const r = await runLlmCalibrationTuning({ apply: autoApply });
    console.log(
      `[MetricCalibration] LLM tuning run complete — model=${r.model}, samples=${r.totalSamples}, applied=${r.applied}` +
        (r.applySkippedReason ? ` (${r.applySkippedReason})` : "") +
        (r.rationale ? ` — ${r.rationale}` : "")
    );
    return;
  }
  const report = await runMetricCalibrationTuning({ apply: autoApply, pruneAfter: true });
  console.log(
    `[MetricCalibration] Tuning run complete — samples=${report.totalSamples}, applied=${report.applied}` +
      (report.applySkippedReason ? ` (${report.applySkippedReason})` : "") +
      (report.prune
        ? `, pruned events=${report.prune.events} outcomes=${report.prune.outcomes} optimal=${report.prune.optimal}`
        : "")
  );
}

/**
 * Background loop: every {@link getCalibrationTuningPollMs} check whether a tuning cycle is due.
 * Writes overrides only when {@link isCalibrationAutoApplyEnabled} and the run is due. When
 * {@link isCalibrationLlmEnabled}, the cycle is driven by the LLM pass, which retries on failure and never
 * falls back to the deterministic tuner (a failed cycle stays "due" and is retried on the next poll).
 */
export async function metricCalibrationTuningLoop(): Promise<void> {
  const autoApply = isCalibrationAutoApplyEnabled();
  const llm = isCalibrationLlmEnabled();
  const pollMs = getCalibrationTuningPollMs();
  const windowMs = getCalibrationTuningWindowMs();
  console.log(
    `[MetricCalibration] Tuning loop started — check every ${Math.round(pollMs / 60_000)} min, ` +
      `cycle every ${Math.round(windowMs / (24 * 60 * 60 * 1000))} days (CALIBRATION_TUNING_*_MS), autoApply=${autoApply}, ` +
      `mode=${llm ? `llm(${CALIBRATION_LLM_MODEL})` : "deterministic"}`
  );

  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[MetricCalibration] Stop signal received, exiting tuning loop");
      return;
    }
    try {
      if (await isCalibrationTuningDue()) {
        await runOneCalibrationCycle(autoApply);
      }
    } catch (e) {
      console.error("[MetricCalibration] Tuning loop error:", e);
    }
    await sleepWithStopCheck(pollMs);
  }
}
