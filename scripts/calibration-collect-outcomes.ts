/**
 * One-shot: process calibration events past the 6h horizon → outcomes.jsonl + optimal.jsonl.
 */
import "dotenv/config";

import { ensureMetricCalibrationLogDir } from "../app/services/metric-calibration/calibration-log";
import {
  collectMetricCalibrationOutcomes,
  ensureMetricCalibrationOutcomeFiles,
} from "../app/services/metric-calibration/outcome-collector";

async function main() {
  await ensureMetricCalibrationLogDir();
  await ensureMetricCalibrationOutcomeFiles();
  const result = await collectMetricCalibrationOutcomes();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
