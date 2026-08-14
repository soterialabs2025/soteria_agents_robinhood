/**
 * Tiered Triton defensive exit evaluation (defaults in `triton-config.ts`).
 */

import {
  getTritonDefensiveExitRules,
  type TritonDefensiveExitRules,
} from "./triton-config";

export type { TritonDefensiveExitRules } from "./triton-config";
export { getTritonDefensiveExitRules } from "./triton-config";

export type TritonDefensiveExitEvaluation = {
  exit: boolean;
  reason: string;
  tier: "high" | "mid" | "low" | "below_low" | "hold";
  exitThresholdPct: number;
};

export function pctFromEntryPrice(entryPriceUsd: number, currentPriceUsd: number): number {
  return ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
}

function evaluateTrailTier(
  tier: "high" | "mid" | "low",
  peak: number,
  cur: number,
  peakTierPct: number,
  trailDrawdownPct: number
): TritonDefensiveExitEvaluation {
  const exitThresholdPct = peak - trailDrawdownPct;
  if (cur <= exitThresholdPct) {
    return {
      exit: true,
      tier,
      exitThresholdPct,
      reason:
        `peak +${peak.toFixed(2)}% (≥ +${peakTierPct}% ${tier.toUpperCase()}) → exit at +${exitThresholdPct.toFixed(2)}% ` +
        `(trail −${trailDrawdownPct}% from peak)`,
    };
  }
  return {
    exit: false,
    tier,
    exitThresholdPct,
    reason: `holding (${tier.toUpperCase()} tier: peak +${peak.toFixed(2)}%, exit if ≤ +${exitThresholdPct.toFixed(2)}%)`,
  };
}

export function evaluateTritonDefensiveExit(
  currentPctFromEntry: number,
  peakPctFromEntry: number,
  rules: TritonDefensiveExitRules = getTritonDefensiveExitRules()
): TritonDefensiveExitEvaluation {
  const peak = peakPctFromEntry;
  const cur = currentPctFromEntry;

  if (peak >= rules.peakTierHighPct) {
    return evaluateTrailTier(
      "high",
      peak,
      cur,
      rules.peakTierHighPct,
      rules.peakTierHighTrailDrawdownPct
    );
  }

  if (peak >= rules.peakTierMidPct) {
    return evaluateTrailTier(
      "mid",
      peak,
      cur,
      rules.peakTierMidPct,
      rules.peakTierMidTrailDrawdownPct
    );
  }

  if (peak >= rules.peakTierLowPct) {
    return evaluateTrailTier(
      "low",
      peak,
      cur,
      rules.peakTierLowPct,
      rules.peakTierLowTrailDrawdownPct
    );
  }

  const exitThresholdPct = rules.belowLowTierExitPct;
  if (cur <= exitThresholdPct) {
    return {
      exit: true,
      tier: "below_low",
      exitThresholdPct,
      reason:
        `peak only +${peak.toFixed(2)}% (never +${rules.peakTierLowPct}%) → exit at ${exitThresholdPct}% from entry`,
    };
  }
  return {
    exit: false,
    tier: "below_low",
    exitThresholdPct,
    reason: `holding (peak +${peak.toFixed(2)}%, exit if ≤ ${exitThresholdPct}% — never reached +${rules.peakTierLowPct}%)`,
  };
}

export function formatTritonDefensiveExitRulesSummary(
  rules: TritonDefensiveExitRules = getTritonDefensiveExitRules()
): string {
  return (
    `HIGH peak≥+${rules.peakTierHighPct}% → exit ≤ peak−${rules.peakTierHighTrailDrawdownPct}%; ` +
    `MEDIUM peak≥+${rules.peakTierMidPct}% → exit ≤ peak−${rules.peakTierMidTrailDrawdownPct}%; ` +
    `LOW peak≥+${rules.peakTierLowPct}% → exit ≤ peak−${rules.peakTierLowTrailDrawdownPct}%; ` +
    `else exit ≤ ${rules.belowLowTierExitPct}% from entry`
  );
}
