/**
 * Analyze optimal.jsonl and propose (or apply) bounded config overrides.
 *
 * Report only (default):
 *   npm run calibration:tune
 *
 * Apply when CALIBRATION_AUTO_APPLY=1:
 *   CALIBRATION_AUTO_APPLY=1 npm run calibration:tune -- --apply
 */
import "dotenv/config";

import { ensureMetricCalibrationLogDir } from "../app/services/metric-calibration/calibration-log";
import {
  isCalibrationAutoApplyEnabled,
  CALIBRATION_TUNING_MIN_SAMPLES,
} from "../app/services/metric-calibration/calibration-config";
import { runMetricCalibrationTuning } from "../app/services/metric-calibration/calibration-tuner";

async function main(): Promise<void> {
  await ensureMetricCalibrationLogDir();
  const apply = process.argv.includes("--apply");
  const report = await runMetricCalibrationTuning({ apply, pruneAfter: true });

  console.log(JSON.stringify(report, null, 2));

  if (apply && !report.applied) {
    console.error(
      `[calibration:tune] Apply requested but not written: ${report.applySkippedReason ?? "unknown"}`
    );
    if (!isCalibrationAutoApplyEnabled()) {
      console.error("Set CALIBRATION_AUTO_APPLY=1 to allow writing config.overrides.json / triton.overrides.json");
    }
    if (report.totalSamples < CALIBRATION_TUNING_MIN_SAMPLES) {
      console.error(
        `Need at least ${CALIBRATION_TUNING_MIN_SAMPLES} optimal rows in the ${report.windowMs / (24 * 60 * 60 * 1000)}-day window`
      );
    }
    process.exitCode = 1;
  } else if (report.applied) {
    console.log("[calibration:tune] Applied overrides — Demeter picks up thresholds on next read (intervals need restart).");
  } else {
    console.log("[calibration:tune] Report only — pass --apply with CALIBRATION_AUTO_APPLY=1 to write overrides.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
