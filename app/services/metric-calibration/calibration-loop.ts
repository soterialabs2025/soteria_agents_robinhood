import { getCalibrationCollectorPollMs } from "./calibration-config";
import { ensureMetricCalibrationOutcomeFiles } from "./outcome-collector";
import { collectMetricCalibrationOutcomes } from "./outcome-collector";
import { checkDemeterStopSignal, sleepWithStopCheck } from "../../config/demeter-stop";

/**
 * Background loop: every {@link CALIBRATION_COLLECTOR_POLL_MS} process events past the 6h horizon.
 */
export async function metricCalibrationLoop(): Promise<void> {
  await ensureMetricCalibrationOutcomeFiles();
  const pollMs = getCalibrationCollectorPollMs();
  console.log(
    `[MetricCalibration] Outcome collector started — poll every ${Math.round(pollMs / 60_000)} min (override CALIBRATION_COLLECTOR_POLL_MS)`
  );

  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[MetricCalibration] Stop signal received, exiting outcome collector");
      return;
    }
    try {
      const result = await collectMetricCalibrationOutcomes();
      if (result.written > 0) {
        console.log(
          `[MetricCalibration] Wrote ${result.written} outcome(s) (scanned=${result.scanned}, due=${result.due}, incomplete=${result.skippedIncomplete})`
        );
      }
    } catch (e) {
      console.error("[MetricCalibration] Collector error:", e);
    }
    await sleepWithStopCheck(pollMs);
  }
}
