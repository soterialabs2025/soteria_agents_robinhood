import * as fs from "fs/promises";
import * as path from "path";

import type { DemeterDefensiveOffensiveLogEntry } from "../demeter-defensive-offensive-log";
import type { MetricCalibrationTokenSnapshot } from "./calibration-snapshots";
import { getCalibrationEventsPath } from "./calibration-config";

export type MetricCalibrationEventEntry = DemeterDefensiveOffensiveLogEntry & {
  eventId: string;
  outcomeDueAtUtc: string;
  topThreeTokenSnapshots: MetricCalibrationTokenSnapshot[];
};

export async function ensureMetricCalibrationLogDir(): Promise<void> {
  const dir = path.dirname(getCalibrationEventsPath());
  await fs.mkdir(dir, { recursive: true });
  for (const file of [
    getCalibrationEventsPath(),
  ]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, "", "utf8");
    }
  }
}

export async function appendMetricCalibrationEvent(
  entry: MetricCalibrationEventEntry
): Promise<void> {
  if (entry.outcome !== "success") return;
  if (!entry.eventId || !entry.topThreeTokenSnapshots?.length) return;

  const filePath = getCalibrationEventsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
}
