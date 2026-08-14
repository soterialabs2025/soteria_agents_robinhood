import { formatTritonDefensiveExitRulesSummary } from "./triton-defensive-exit";
import { getTritonDefensiveExitRules } from "./triton-config";
import {
  getSoteriaRuntimeFileCandidates,
  getSoteriaRuntimeFilePath,
  loadFirstExistingJsonFile,
  writeSoteriaRuntimeJsonFile,
} from "./soteria-runtime-paths";

const RUNTIME_FILENAME = "triton-defensive-exit-control.json";

/** Runtime toggle for HIGH/MEDIUM/LOW tiered exits (separate from custom position rules). */
export type TritonDefensiveExitControl = {
  /** When false, Triton loop only enforces custom rules from `triton-position-rules.json`. */
  tieredExitsEnabled: boolean;
  updatedAtUtc: string;
  source?: "chat" | "env" | "default";
  notes?: string;
};

function parseControlRaw(raw: unknown): TritonDefensiveExitControl | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<TritonDefensiveExitControl>;
  if (typeof r.tieredExitsEnabled !== "boolean") return null;
  return {
    tieredExitsEnabled: r.tieredExitsEnabled,
    updatedAtUtc:
      typeof r.updatedAtUtc === "string" ? r.updatedAtUtc : new Date().toISOString(),
    source: r.source === "chat" || r.source === "env" ? r.source : "chat",
    notes: typeof r.notes === "string" ? r.notes : undefined,
  };
}

function parseEnvBool(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

/** Default when no file: env `TRITON_TIERED_DEFENSIVE_EXITS_ENABLED`, else true. */
function defaultTieredEnabled(): boolean {
  return parseEnvBool(process.env.TRITON_TIERED_DEFENSIVE_EXITS_ENABLED) ?? true;
}

export function loadTritonDefensiveExitControl(): TritonDefensiveExitControl | null {
  const hit = loadFirstExistingJsonFile(
    getSoteriaRuntimeFileCandidates(RUNTIME_FILENAME, "TRITON_DEFENSIVE_EXIT_CONTROL_PATH"),
    parseControlRaw
  );
  return hit?.value ?? null;
}

export function saveTritonDefensiveExitControl(control: TritonDefensiveExitControl): string {
  const p = writeSoteriaRuntimeJsonFile(RUNTIME_FILENAME, control);
  console.log(`[Triton] Saved defensive exit control → ${p}`);
  return p;
}

/** Whether tiered defensive exits (HIGH/MEDIUM/LOW) run in the Triton loop. */
export function isTritonTieredDefensiveExitEnabled(): boolean {
  const file = loadTritonDefensiveExitControl();
  if (file) return file.tieredExitsEnabled;
  return defaultTieredEnabled();
}

export function setTritonTieredDefensiveExitsEnabled(
  enabled: boolean,
  notes?: string
): TritonDefensiveExitControl {
  const control: TritonDefensiveExitControl = {
    tieredExitsEnabled: enabled,
    updatedAtUtc: new Date().toISOString(),
    source: "chat",
    ...(notes && { notes }),
  };
  saveTritonDefensiveExitControl(control);
  return control;
}

export function getTritonDefensiveExitStatus(): {
  tieredExitsEnabled: boolean;
  tieredRulesSummary: string;
  tieredRules: ReturnType<typeof getTritonDefensiveExitRules>;
  controlFile: string;
  persistedControl: TritonDefensiveExitControl | null;
} {
  const tieredExitsEnabled = isTritonTieredDefensiveExitEnabled();
  return {
    tieredExitsEnabled,
    tieredRulesSummary: formatTritonDefensiveExitRulesSummary(),
    tieredRules: getTritonDefensiveExitRules(),
    controlFile: getSoteriaRuntimeFilePath(RUNTIME_FILENAME),
    persistedControl: loadTritonDefensiveExitControl(),
  };
}
