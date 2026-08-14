import * as fs from "fs/promises";
import * as path from "path";

import {
  fetchTokenData,
  getPoolByTokenMapForStrategyRegistry,
} from "../../action-providers/coingecko-action-provider";
import type { DemeterChosenTokenMetrics } from "../demeter-defensive-offensive-log";
import {
  getCalibrationEventsPath,
  getCalibrationOptimalPath,
  getCalibrationOutcomesPath,
} from "./calibration-config";
import type { MetricCalibrationEventEntry } from "./calibration-log";
import type { MetricCalibrationTokenSnapshot } from "./calibration-snapshots";
import { appendJsonlLine, readJsonlFile } from "./jsonl";
import {
  filterCalibrationTopThree,
  isStableCalibrationTokenAddress,
  isStableOnlyCalibrationEvent,
} from "./calibration-candidates";

export type MetricCalibrationOutcomeRow = {
  eventId: string;
  collectedAtUtc: string;
  trigger: MetricCalibrationEventEntry["trigger"];
  keeperPipeline?: MetricCalibrationEventEntry["keeperPipeline"];
  chosenSymbol?: string | null;
  chosenAddress?: string | null;
  winnerSymbol?: string;
  winnerAddress?: string;
  winnerForwardReturnPct?: number;
  horizonHours?: 6;
  candidateReturns?: Array<{
    symbol: string;
    address: string;
    entryPriceUsd: number;
    exitPriceUsd: number;
    forwardReturnPct: number;
  }>;
  /** Set when the event is not usable for tuning (e.g. stable-only rotation). */
  skippedReason?: string;
};

export type MetricCalibrationOptimalRow = {
  eventId: string;
  collectedAtUtc: string;
  trigger: MetricCalibrationEventEntry["trigger"];
  keeperPipeline?: MetricCalibrationEventEntry["keeperPipeline"];
  winnerSymbol: string;
  winnerAddress: string;
  winnerForwardReturnPct: number;
  /** Entry-time metrics for the 6h winner among top-3. */
  winnerMetrics: DemeterChosenTokenMetrics;
  chosenSymbol: string | null;
  chosenMatchedWinner: boolean;
};

function strategyRegistryForPipeline(
  keeperPipeline: MetricCalibrationEventEntry["keeperPipeline"]
): "FloatStrategy" | "FloatStrategyV4" {
  return keeperPipeline === "float_v4" ? "FloatStrategyV4" : "FloatStrategy";
}

function entryPriceUsd(metrics: DemeterChosenTokenMetrics): number | null {
  const raw = metrics.chosen_token_tokens_summary?.price_usd;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function parseTokenPriceUsd(data: unknown, address: string): number | null {
  if (!data || typeof data !== "object") return null;
  const tokens = (data as { tokens?: unknown[] }).tokens;
  if (!Array.isArray(tokens)) return null;
  const lc = address.toLowerCase();
  const row = tokens.find(
    (t) =>
      t &&
      typeof t === "object" &&
      typeof (t as { address?: string }).address === "string" &&
      (t as { address: string }).address.toLowerCase() === lc
  ) as { price_usd?: string | number } | undefined;
  if (!row) return null;
  const p = row.price_usd;
  if (typeof p === "number" && Number.isFinite(p) && p > 0) return p;
  if (typeof p === "string") {
    const n = parseFloat(p);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function loadCompletedEventIds(): Promise<Set<string>> {
  const rows = await readJsonlFile<{ eventId: string }>(getCalibrationOutcomesPath());
  return new Set(rows.map((r) => r.eventId).filter(Boolean));
}

type CandidateReturn = NonNullable<MetricCalibrationOutcomeRow["candidateReturns"]>[number];

function pickWinner(returns: CandidateReturn[]): CandidateReturn | null {
  if (returns.length === 0) return null;
  return returns.reduce((best, cur) => (cur.forwardReturnPct > best.forwardReturnPct ? cur : best));
}

async function priceMapForAddresses(
  addresses: string[],
  keeperPipeline: MetricCalibrationEventEntry["keeperPipeline"]
): Promise<Map<string, number>> {
  const rankable = addresses.filter((a) => !isStableCalibrationTokenAddress(a));
  if (rankable.length === 0) return new Map();

  const registry = strategyRegistryForPipeline(keeperPipeline);
  const poolByToken = getPoolByTokenMapForStrategyRegistry(registry);
  const data = await fetchTokenData(rankable, undefined, {
    poolByToken,
    strategyRegistryKey: registry,
  });
  const map = new Map<string, number>();
  for (const addr of rankable) {
    const p = parseTokenPriceUsd(data, addr);
    if (p != null) map.set(addr.toLowerCase(), p);
  }
  return map;
}

async function markCalibrationEventSkipped(
  event: MetricCalibrationEventEntry,
  reason: string,
  now: Date
): Promise<void> {
  await appendJsonlLine(getCalibrationOutcomesPath(), {
    eventId: event.eventId,
    collectedAtUtc: now.toISOString(),
    trigger: event.trigger,
    keeperPipeline: event.keeperPipeline,
    skippedReason: reason,
  } satisfies MetricCalibrationOutcomeRow);
}

async function collectOutcomeForEvent(
  event: MetricCalibrationEventEntry,
  now = new Date()
): Promise<{ outcome: MetricCalibrationOutcomeRow; optimal: MetricCalibrationOptimalRow } | null> {
  const due = Date.parse(event.outcomeDueAtUtc);
  if (!Number.isFinite(due) || now.getTime() < due) return null;

  const snapshots = filterCalibrationTopThree(event.topThreeTokenSnapshots ?? []);
  if (snapshots.length === 0) return null;
  if (snapshots.length < 2) return null;

  const addresses = [...new Set(snapshots.map((s) => s.address))];
  const exitPrices = await priceMapForAddresses(addresses, event.keeperPipeline);

  const candidateReturns: CandidateReturn[] = [];
  for (const snap of snapshots) {
    const entry = entryPriceUsd(snap.metrics);
    const exit = exitPrices.get(snap.address.toLowerCase()) ?? null;
    if (entry == null || exit == null) continue;
    const forwardReturnPct = ((exit - entry) / entry) * 100;
    candidateReturns.push({
      symbol: snap.symbol,
      address: snap.address,
      entryPriceUsd: entry,
      exitPriceUsd: exit,
      forwardReturnPct,
    });
  }

  if (candidateReturns.length === 0) return null;
  if (candidateReturns.length < 2) return null;

  const winner = pickWinner(candidateReturns)!;
  const winnerSnap: MetricCalibrationTokenSnapshot | undefined = snapshots.find(
    (s) => s.address.toLowerCase() === winner.address.toLowerCase()
  );
  if (!winnerSnap) return null;

  const collectedAtUtc = now.toISOString();
  const chosenSymbol = event.chosenToken?.symbol ?? null;
  const chosenAddress = event.chosenToken?.address ?? null;

  return {
    outcome: {
      eventId: event.eventId,
      collectedAtUtc,
      trigger: event.trigger,
      keeperPipeline: event.keeperPipeline,
      chosenSymbol,
      chosenAddress,
      winnerSymbol: winner.symbol,
      winnerAddress: winner.address,
      winnerForwardReturnPct: winner.forwardReturnPct,
      horizonHours: 6,
      candidateReturns,
    },
    optimal: {
      eventId: event.eventId,
      collectedAtUtc,
      trigger: event.trigger,
      keeperPipeline: event.keeperPipeline,
      winnerSymbol: winner.symbol,
      winnerAddress: winner.address,
      winnerForwardReturnPct: winner.forwardReturnPct,
      winnerMetrics: winnerSnap.metrics,
      chosenSymbol,
      chosenMatchedWinner:
        chosenAddress != null &&
        chosenAddress.toLowerCase() === winner.address.toLowerCase(),
    },
  };
}

export type CollectOutcomesResult = {
  scanned: number;
  due: number;
  written: number;
  skippedIncomplete: number;
};

/**
 * Process calibration events whose 6h horizon has elapsed; append outcomes + optimal rows.
 */
export async function collectMetricCalibrationOutcomes(
  now = new Date()
): Promise<CollectOutcomesResult> {
  const events = await readJsonlFile<MetricCalibrationEventEntry>(getCalibrationEventsPath());
  const completed = await loadCompletedEventIds();

  let due = 0;
  let written = 0;
  let skippedIncomplete = 0;

  for (const event of events) {
    if (!event.eventId || completed.has(event.eventId)) continue;
    const dueMs = Date.parse(event.outcomeDueAtUtc);
    if (!Number.isFinite(dueMs) || now.getTime() < dueMs) continue;
    due++;

    try {
      if (isStableOnlyCalibrationEvent(event.topThreeTokenSnapshots)) {
        await markCalibrationEventSkipped(event, "stable_only_candidates", now);
        completed.add(event.eventId);
        console.log(
          `[MetricCalibration] skipped eventId=${event.eventId} (stable-only — not used for metric tuning)`
        );
        continue;
      }

      const pair = await collectOutcomeForEvent(event, now);
      if (!pair) {
        skippedIncomplete++;
        continue;
      }
      await appendJsonlLine(getCalibrationOutcomesPath(), pair.outcome);
      await appendJsonlLine(getCalibrationOptimalPath(), pair.optimal);
      completed.add(event.eventId);
      written++;
      console.log(
        `[MetricCalibration] outcome eventId=${event.eventId} winner=${pair.outcome.winnerSymbol} ${pair.outcome.winnerForwardReturnPct!.toFixed(2)}% (chosen matched: ${pair.optimal.chosenMatchedWinner})`
      );
    } catch (e) {
      console.warn(
        `[MetricCalibration] outcome failed eventId=${event.eventId}:`,
        e instanceof Error ? e.message : e
      );
      skippedIncomplete++;
    }
  }

  return { scanned: events.length, due, written, skippedIncomplete };
}

/** Ensure outcomes/optimal files exist. */
export async function ensureMetricCalibrationOutcomeFiles(): Promise<void> {
  const dir = path.dirname(getCalibrationOutcomesPath());
  await fs.mkdir(dir, { recursive: true });
  for (const p of [getCalibrationOutcomesPath(), getCalibrationOptimalPath()]) {
    try {
      await fs.access(p);
    } catch {
      await fs.writeFile(p, "", "utf8");
    }
  }
}
