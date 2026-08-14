import * as fs from "fs/promises";

import {
  getSoteriaRuntimeFileCandidates,
  getSoteriaRepoRoot,
} from "../config/soteria-runtime-paths";
import { getDemeterLogsPublishDelayMs } from "../lib/demeter-logs-auth";
import type {
  DemeterPublicLogEntry,
  DemeterPublicLogStream,
  DemeterPublicPoolLogEntry,
  DemeterPublicStrategyLogEntry,
} from "../types/demeter-logs";
import type { DemeterDefensiveOffensiveLogEntry } from "./demeter-defensive-offensive-log";
import type { DemeterPoolValueLogEntry } from "./demeter-pool-value-log";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function strategyLogCandidates(): string[] {
  return getSoteriaRuntimeFileCandidates(
    "demeter-defensive-offensive-strategy.jsonl",
    "DEMETER_DEFENSIVE_OFFENSIVE_LOG_PATH"
  );
}

function poolLogCandidates(): string[] {
  return getSoteriaRuntimeFileCandidates(
    "demeter-pool-value.jsonl",
    "DEMETER_POOL_VALUE_LOG_PATH"
  );
}

async function readFirstExistingFile(candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    try {
      await fs.access(p);
      return await fs.readFile(p, "utf8");
    } catch {
      /* try next */
    }
  }
  return null;
}

function parseJsonlLines<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

function entryTimestampUtc(entry: { timestampUtc?: string }): number {
  const ms = Date.parse(entry.timestampUtc ?? "");
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/** Only rows at least {@link getDemeterLogsPublishDelayMs} old (avoids real-time frontrunning). */
export function isLogEntryPublishable(timestampUtc: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(timestampUtc);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts >= getDemeterLogsPublishDelayMs();
}

function toPublicStrategyEntry(
  row: DemeterDefensiveOffensiveLogEntry
): DemeterPublicStrategyLogEntry {
  return {
    kind: "strategy",
    timestampUtc: row.timestampUtc,
    timestampPacific: row.timestampPacific,
    trigger: row.trigger,
    outcome: row.outcome,
    keeperPipeline: row.keeperPipeline,
    changeSummary: row.changeSummary ?? null,
    chosenSymbol: row.chosenToken?.symbol ?? null,
    oldSymbol: row.oldToken?.symbol ?? null,
    changeStrategyTransaction: row.changeStrategyTransaction ?? null,
  };
}

function toPublicPoolEntry(row: DemeterPoolValueLogEntry): DemeterPublicPoolLogEntry {
  return {
    kind: "pool_value",
    timestampUtc: row.timestampUtc,
    timestampPacific: row.timestampPacific,
    poolValue: row.poolValue,
  };
}

export type FetchDemeterPublicLogsOptions = {
  stream?: DemeterPublicLogStream;
  limit?: number;
  /** Only entries strictly after this UTC ISO timestamp. */
  afterUtc?: string | null;
};

export async function fetchDemeterPublicLogs(
  options: FetchDemeterPublicLogsOptions = {}
): Promise<{
  stream: DemeterPublicLogStream;
  publishDelayMs: number;
  entries: DemeterPublicLogEntry[];
  limit: number;
}> {
  const stream = options.stream === "pool" ? "pool" : "strategy";
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT))
  );
  const publishDelayMs = getDemeterLogsPublishDelayMs();
  const nowMs = Date.now();
  const afterMs = options.afterUtc ? Date.parse(options.afterUtc) : Number.NaN;

  const raw =
    stream === "pool"
      ? await readFirstExistingFile(poolLogCandidates())
      : await readFirstExistingFile(strategyLogCandidates());

  if (!raw) {
    return { stream, publishDelayMs, entries: [], limit };
  }

  let entries: DemeterPublicLogEntry[] = [];

  if (stream === "pool") {
    const rows = parseJsonlLines<DemeterPoolValueLogEntry>(raw);
    entries = rows
      .filter((r) => isLogEntryPublishable(r.timestampUtc, nowMs))
      .filter((r) => !Number.isFinite(afterMs) || entryTimestampUtc(r) > afterMs)
      .map(toPublicPoolEntry);
  } else {
    const rows = parseJsonlLines<DemeterDefensiveOffensiveLogEntry>(raw);
    entries = rows
      .filter((r) => isLogEntryPublishable(r.timestampUtc, nowMs))
      .filter((r) => !Number.isFinite(afterMs) || entryTimestampUtc(r) > afterMs)
      .map(toPublicStrategyEntry);
  }

  entries.sort((a, b) => entryTimestampUtc(a) - entryTimestampUtc(b));
  if (entries.length > limit) {
    entries = entries.slice(-limit);
  }

  return { stream, publishDelayMs, entries, limit };
}

/** For health/debug — no secrets. */
export function demeterPublicLogsStatus(): {
  repoRoot: string;
  publishDelayMs: number;
  apiKeyConfigured: boolean;
  strategyLogCandidates: string[];
  poolLogCandidates: string[];
} {
  return {
    repoRoot: getSoteriaRepoRoot(),
    publishDelayMs: getDemeterLogsPublishDelayMs(),
    apiKeyConfigured: Boolean(process.env["DEMETER_LOGS_API_KEY"]?.trim()),
    strategyLogCandidates: strategyLogCandidates(),
    poolLogCandidates: poolLogCandidates(),
  };
}
