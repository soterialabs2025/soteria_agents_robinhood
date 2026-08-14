/**
 * File-based stop signal for Demeter loops.
 * When demeter_stopLoops is called from chat, it creates this file.
 * The demeter-agent checks for it each loop iteration and exits if present.
 */

import * as fs from "fs";
import * as path from "path";

const STOP_FLAG_FILENAME = ".demeter-stop";

function getStopFlagPath(): string {
  return path.join(process.cwd(), STOP_FLAG_FILENAME);
}

/**
 * Returns true if the stop signal file exists (user requested stop from chat).
 */
export function checkDemeterStopSignal(): boolean {
  try {
    return fs.existsSync(getStopFlagPath());
  } catch {
    return false;
  }
}

/**
 * Creates the stop flag file. Called by demeter_stopLoops action.
 */
export function setDemeterStopSignal(): void {
  fs.writeFileSync(getStopFlagPath(), new Date().toISOString(), "utf8");
}

/**
 * Removes the stop flag file. Called when Demeter starts (clear stale signal).
 */
export function clearDemeterStopSignal(): void {
  try {
    const p = getStopFlagPath();
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch {
    // ignore
  }
}

const STOP_CHECK_INTERVAL_MS = 2000;

/**
 * Sleep for up to `ms` milliseconds, but return early if stop signal is set.
 * Allows responsive shutdown (within ~2 seconds) instead of waiting for full sleep.
 */
export async function sleepWithStopCheck(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (checkDemeterStopSignal()) return;
    const remaining = Math.min(STOP_CHECK_INTERVAL_MS, deadline - Date.now());
    if (remaining <= 0) return;
    await new Promise((r) => setTimeout(r, remaining));
  }
}
