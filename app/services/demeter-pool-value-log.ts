/**
 * Hourly (or configured interval) append-only JSONL for FloatStrategy.poolValue().
 * Default path: <cwd>/logs/demeter-pool-value.jsonl
 * Override: DEMETER_POOL_VALUE_LOG_PATH
 */

import * as fs from "fs/promises";
import * as path from "path";

export type DemeterPoolValueLogEntry = {
  kind: "pool_value";
  /** ISO-8601 UTC */
  timestampUtc: string;
  /** Formatted in America/Los_Angeles (PST/PDT), same style as defensive/offensive log */
  timestampPacific: string;
  floatContractManagerAddress: string;
  strategyAddress: string;
  /** Human-readable pool value (WETH-denominated, 18 decimals) */
  poolValue: string;
};

function defaultLogFilePath(): string {
  const override = process.env.DEMETER_POOL_VALUE_LOG_PATH?.trim();
  if (override) return override;
  return path.join(process.cwd(), "logs", "demeter-pool-value.jsonl");
}

export async function appendDemeterPoolValueLog(entry: DemeterPoolValueLogEntry): Promise<void> {
  const filePath = defaultLogFilePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(filePath, line, "utf8");
}
