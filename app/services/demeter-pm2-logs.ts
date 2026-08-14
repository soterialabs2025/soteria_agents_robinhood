import * as fs from "fs/promises";
import os from "os";
import path from "path";

import { getSoteriaRepoRoot } from "../config/soteria-runtime-paths";
import { getDemeterLogsPublishDelayMs } from "../lib/demeter-logs-auth";
import type { DemeterConsoleChannelFilter, DemeterPublicConsoleLogEntry } from "../types/demeter-logs";
import { isLogEntryPublishable } from "./demeter-public-logs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Max bytes read from each PM2 log file per request (tail). */
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

/** PM2 log lines — several formats seen in the wild. */
const PM2_LOG_LINE_PATTERNS = [
  // 2026-05-27 12:00:00 +00:00: message
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}): (.*)$/,
  // 0|demeter  | 2026-05-27 12:00:00 +00:00: message
  /^\d+\|[^|]+\|\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}): (.*)$/,
  // 2026-05-27T12:00:00: message (no tz)
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}): (.*)$/,
  // 2026-05-27 12:00:00: message (no tz)
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}): (.*)$/,
];

function matchPm2LogLine(trimmed: string): { timestamp: string; message: string } | null {
  for (const pattern of PM2_LOG_LINE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) {
      return { timestamp: match[1], message: match[2] ?? "" };
    }
  }
  return null;
}

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function demeterOutLogCandidates(): string[] {
  const override = process.env.DEMETER_PM2_OUT_LOG_PATH?.trim();
  const root = getSoteriaRepoRoot();
  const cwd = process.cwd();
  const out: string[] = [];
  if (override) out.push(path.resolve(override));
  out.push(path.join(root, "logs", "demeter-out.log"));
  if (cwd !== root) out.push(path.join(cwd, "logs", "demeter-out.log"));
  out.push(path.join(os.homedir(), ".pm2", "logs", "demeter-out.log"));
  return [...new Set(out.map((p) => path.resolve(p)))];
}

function demeterErrLogCandidates(): string[] {
  const override = process.env.DEMETER_PM2_ERROR_LOG_PATH?.trim();
  const root = getSoteriaRepoRoot();
  const cwd = process.cwd();
  const out: string[] = [];
  if (override) out.push(path.resolve(override));
  out.push(path.join(root, "logs", "demeter-error.log"));
  if (cwd !== root) out.push(path.join(cwd, "logs", "demeter-error.log"));
  out.push(path.join(os.homedir(), ".pm2", "logs", "demeter-error.log"));
  return [...new Set(out.map((p) => path.resolve(p)))];
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

function pm2TimestampToUtcIso(pm2Ts: string): string | null {
  const ms = Date.parse(pm2Ts);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

async function readBestLogTail(
  candidates: string[]
): Promise<{ raw: string | null; path: string | null }> {
  let best: { raw: string; path: string } | null = null;
  for (const candidate of candidates) {
    const raw = await readLogTail(candidate);
    if (raw == null) continue;
    if (!best || raw.length > best.raw.length) {
      best = { raw, path: candidate };
    }
  }
  return best ?? { raw: null, path: null };
}

async function readLogTail(filePath: string): Promise<string | null> {
  try {
    const fh = await fs.open(filePath, "r");
    try {
      const stat = await fh.stat();
      if (stat.size === 0) return "";
      const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** Format like `pm2 logs demeter` for UI display. */
export function formatConsoleEntryLine(entry: DemeterPublicConsoleLogEntry): string {
  const ts = entry.timestampDisplay ?? entry.timestampUtc;
  return `0|demeter  | ${ts}: ${entry.message}`;
}

function parsePm2LogLines(
  raw: string,
  channel: DemeterPublicConsoleLogEntry["channel"]
): DemeterPublicConsoleLogEntry[] {
  const entries: DemeterPublicConsoleLogEntry[] = [];
  let pending: DemeterPublicConsoleLogEntry | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;

    const matched = matchPm2LogLine(trimmed);
    if (matched) {
      const timestampUtc = pm2TimestampToUtcIso(matched.timestamp);
      if (!timestampUtc) continue;
      pending = {
        kind: "console",
        channel,
        timestampUtc,
        timestampDisplay: matched.timestamp,
        message: stripAnsi(matched.message),
      };
      entries.push(pending);
      continue;
    }

    if (pending) {
      pending.message += `\n${stripAnsi(trimmed)}`;
    }
  }

  return entries;
}

export type FetchDemeterPm2LogsOptions = {
  channel?: DemeterConsoleChannelFilter;
  limit?: number;
  afterUtc?: string | null;
};

export async function fetchDemeterPm2Logs(
  options: FetchDemeterPm2LogsOptions = {}
): Promise<{
  channel: DemeterConsoleChannelFilter;
  publishDelayMs: number;
  entries: DemeterPublicConsoleLogEntry[];
  limit: number;
  debug?: {
    sources: Array<{
      channel: DemeterPublicConsoleLogEntry["channel"];
      path: string;
      readable: boolean;
      bytesRead: number;
      parsedLines: number;
    }>;
    withheldByPublishDelay: number;
  };
}> {
  const channel = options.channel ?? "all";
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT))
  );
  const publishDelayMs = getDemeterLogsPublishDelayMs();
  const nowMs = Date.now();
  const afterMs = options.afterUtc ? Date.parse(options.afterUtc) : Number.NaN;

  const sourceSpecs: Array<{
    channel: DemeterPublicConsoleLogEntry["channel"];
    candidates: string[];
  }> = [];
  if (channel === "out" || channel === "all") {
    sourceSpecs.push({ channel: "out", candidates: demeterOutLogCandidates() });
  }
  if (channel === "err" || channel === "all") {
    sourceSpecs.push({ channel: "err", candidates: demeterErrLogCandidates() });
  }

  let entries: DemeterPublicConsoleLogEntry[] = [];
  const debugSources: NonNullable<
    Awaited<ReturnType<typeof fetchDemeterPm2Logs>>["debug"]
  >["sources"] = [];

  for (const src of sourceSpecs) {
    const { raw, path: usedPath } = await readBestLogTail(src.candidates);
    const readable = raw != null;
    const bytesRead = raw?.length ?? 0;
    const parsed = raw == null ? [] : parsePm2LogLines(raw, src.channel);
    debugSources.push({
      channel: src.channel,
      path: usedPath ?? src.candidates[0] ?? "",
      readable,
      bytesRead,
      parsedLines: parsed.length,
    });
    if (raw == null) continue;
    entries.push(...parsed);
  }

  const parsedCount = entries.length;
  const publishable = entries.filter((e) => isLogEntryPublishable(e.timestampUtc, nowMs));
  entries = publishable
    .filter((e) => !Number.isFinite(afterMs) || Date.parse(e.timestampUtc) > afterMs)
    .sort((a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc));

  const withheldByPublishDelay = parsedCount - publishable.length;

  if (entries.length > limit) {
    entries = entries.slice(-limit);
  }

  return {
    channel,
    publishDelayMs,
    entries,
    limit,
    debug: {
      sources: debugSources,
      withheldByPublishDelay,
    },
  };
}

/** For health/debug — no secrets. */
export function demeterPm2LogsStatus(): {
  repoRoot: string;
  outLogCandidates: string[];
  errLogCandidates: string[];
  publishDelayMs: number;
} {
  return {
    repoRoot: getSoteriaRepoRoot(),
    outLogCandidates: demeterOutLogCandidates(),
    errLogCandidates: demeterErrLogCandidates(),
    publishDelayMs: getDemeterLogsPublishDelayMs(),
  };
}
