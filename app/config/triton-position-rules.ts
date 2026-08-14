import fs from "fs";

import {
  clearSoteriaRuntimeJsonFile,
  getSoteriaRuntimeFileCandidates,
  getSoteriaRuntimeFilePath,
  loadFirstExistingJsonFile,
  writeSoteriaRuntimeJsonFile,
} from "./soteria-runtime-paths";

const RUNTIME_FILENAME = "triton-position-rules.json";

/**
 * Custom TP/SL for Triton — applies to **whatever token is currently held** (not tied to one symbol).
 * Legacy files may still include tokenName/tokenAddress; thresholds are used for any held asset.
 */
export type TritonPositionRules = {
  scope?: "held_asset";
  /** @deprecated Legacy — ignored for matching; kept when reading old files. */
  tokenName?: string;
  /** @deprecated Legacy — ignored for matching; kept when reading old files. */
  tokenAddress?: string;
  /** Exit to WETH when gain from entry ≥ this % (e.g. 10 = take profit at +10%). */
  takeProfitPctFromEntry?: number;
  /** Exit to WETH when gain from entry ≤ −this % (e.g. 3 = stop at −3%). */
  stopLossPctFromEntry?: number;
  /** Optional: exit when drawdown from peak ≥ this % (overrides tier trail for this token). */
  peakTrailDrawdownPct?: number;
  notes?: string;
  updatedAtUtc: string;
};

function hasRuleThresholds(r: Partial<TritonPositionRules>): boolean {
  return (
    typeof r.takeProfitPctFromEntry === "number" ||
    typeof r.stopLossPctFromEntry === "number" ||
    typeof r.peakTrailDrawdownPct === "number"
  );
}

function parseRulesRaw(raw: unknown): TritonPositionRules | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<TritonPositionRules>;
  if (!hasRuleThresholds(r)) return null;
  return {
    scope: "held_asset",
    ...(typeof r.tokenName === "string" && { tokenName: r.tokenName }),
    ...(typeof r.tokenAddress === "string" &&
      r.tokenAddress.startsWith("0x") && { tokenAddress: r.tokenAddress }),
    takeProfitPctFromEntry:
      typeof r.takeProfitPctFromEntry === "number" ? r.takeProfitPctFromEntry : undefined,
    stopLossPctFromEntry:
      typeof r.stopLossPctFromEntry === "number" ? r.stopLossPctFromEntry : undefined,
    peakTrailDrawdownPct:
      typeof r.peakTrailDrawdownPct === "number" ? r.peakTrailDrawdownPct : undefined,
    notes: typeof r.notes === "string" ? r.notes : undefined,
    updatedAtUtc: typeof r.updatedAtUtc === "string" ? r.updatedAtUtc : new Date().toISOString(),
  };
}

let lastLoadedRulesPath: string | null = null;

export function formatTritonPositionRulesSummary(rules: TritonPositionRules): string {
  return `held asset TP +${rules.takeProfitPctFromEntry ?? "—"}% / SL −${rules.stopLossPctFromEntry ?? "—"}%`;
}

export function getTritonPositionRulesPath(): string {
  return getSoteriaRuntimeFilePath(RUNTIME_FILENAME);
}

export function getTritonPositionRulesLoadPaths(): string[] {
  return getSoteriaRuntimeFileCandidates(RUNTIME_FILENAME, "TRITON_POSITION_RULES_PATH");
}

export function loadTritonPositionRules(): TritonPositionRules | null {
  const hit = loadFirstExistingJsonFile(getTritonPositionRulesLoadPaths(), parseRulesRaw);
  lastLoadedRulesPath = hit?.path ?? null;
  return hit?.value ?? null;
}

export function saveTritonPositionRules(rules: TritonPositionRules): string {
  const toSave: TritonPositionRules = {
    scope: "held_asset",
    takeProfitPctFromEntry: rules.takeProfitPctFromEntry,
    stopLossPctFromEntry: rules.stopLossPctFromEntry,
    peakTrailDrawdownPct: rules.peakTrailDrawdownPct,
    notes: rules.notes,
    updatedAtUtc: rules.updatedAtUtc,
  };
  const p = writeSoteriaRuntimeJsonFile(RUNTIME_FILENAME, toSave);
  lastLoadedRulesPath = p;
  console.log(`[Triton] Saved position rules (any held asset) → ${p}`);
  return p;
}

export function clearTritonPositionRules(): void {
  clearSoteriaRuntimeJsonFile(RUNTIME_FILENAME, "TRITON_POSITION_RULES_PATH");
  lastLoadedRulesPath = null;
}

export type SetTritonPositionRulesInput = {
  /** Ignored for scoping (rules apply to whatever Triton holds). Optional for chat context. */
  token?: string;
  takeProfitPctFromEntry?: number;
  stopLossPctFromEntry?: number;
  peakTrailDrawdownPct?: number;
  notes?: string;
};

export function setTritonPositionRulesFromChat(
  input: SetTritonPositionRulesInput
): TritonPositionRules & { savedPath: string } {
  if (
    input.takeProfitPctFromEntry === undefined &&
    input.stopLossPctFromEntry === undefined &&
    input.peakTrailDrawdownPct === undefined
  ) {
    throw new Error("Provide at least one of takeProfitPctFromEntry, stopLossPctFromEntry, or peakTrailDrawdownPct");
  }
  const existing = loadTritonPositionRules();
  const rules: TritonPositionRules = {
    scope: "held_asset",
    ...(existing ?? {}),
    ...(input.takeProfitPctFromEntry !== undefined && {
      takeProfitPctFromEntry: input.takeProfitPctFromEntry,
    }),
    ...(input.stopLossPctFromEntry !== undefined && {
      stopLossPctFromEntry: input.stopLossPctFromEntry,
    }),
    ...(input.peakTrailDrawdownPct !== undefined && {
      peakTrailDrawdownPct: input.peakTrailDrawdownPct,
    }),
    ...(input.notes !== undefined && input.notes !== "" && { notes: input.notes }),
    updatedAtUtc: new Date().toISOString(),
  };
  const savedPath = saveTritonPositionRules(rules);
  return { ...rules, savedPath };
}

/** Why custom rules are not evaluating (for Triton loop logs). */
export function describeTritonCustomRulesGap(
  _currentAssetAddress: string,
  rules: TritonPositionRules | null
): string | null {
  if (!rules) {
    const primary = getTritonPositionRulesPath();
    const searched = getTritonPositionRulesLoadPaths();
    const existing = searched.filter((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (existing.length === 0) {
      return `no custom rules file found (save via liquidStratMinV4_setPositionRules → ${primary}; searched: ${searched.join(", ")})`;
    }
    return `custom rules file(s) present but invalid or empty (${existing.join(", ")})`;
  }
  return null;
}

export function getLastLoadedTritonPositionRulesPath(): string | null {
  return lastLoadedRulesPath;
}

/** Custom TP/SL for the currently held asset (token label used in log messages only). */
export function evaluateTritonCustomPositionRules(
  _currentAssetAddress: string,
  currentPctFromEntry: number,
  peakPctFromEntry: number,
  rules: TritonPositionRules | null,
  tokenLabel = "held asset"
): { exit: boolean; reason: string } | null {
  if (!rules) return null;

  if (
    rules.takeProfitPctFromEntry != null &&
    currentPctFromEntry >= rules.takeProfitPctFromEntry
  ) {
    return {
      exit: true,
      reason: `${tokenLabel}: take profit +${rules.takeProfitPctFromEntry}% (now ${currentPctFromEntry >= 0 ? "+" : ""}${currentPctFromEntry.toFixed(2)}%)`,
    };
  }
  if (
    rules.stopLossPctFromEntry != null &&
    currentPctFromEntry <= -Math.abs(rules.stopLossPctFromEntry)
  ) {
    return {
      exit: true,
      reason: `${tokenLabel}: stop loss −${Math.abs(rules.stopLossPctFromEntry)}% (now ${currentPctFromEntry >= 0 ? "+" : ""}${currentPctFromEntry.toFixed(2)}%)`,
    };
  }
  if (rules.peakTrailDrawdownPct != null && peakPctFromEntry > 0) {
    const floor = peakPctFromEntry - Math.abs(rules.peakTrailDrawdownPct);
    if (currentPctFromEntry <= floor) {
      return {
        exit: true,
        reason: `${tokenLabel}: peak trail −${rules.peakTrailDrawdownPct}% from peak +${peakPctFromEntry.toFixed(2)}% (now ${currentPctFromEntry >= 0 ? "+" : ""}${currentPctFromEntry.toFixed(2)}%)`,
      };
    }
  }
  return {
    exit: false,
    reason: `${tokenLabel}: custom rules active (${formatTritonPositionRulesSummary(rules)})`,
  };
}
