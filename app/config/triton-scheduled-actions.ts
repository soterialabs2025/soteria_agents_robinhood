import { resolveTritonV4Token } from "./triton-v4-token-registry";
import {
  clearSoteriaRuntimeJsonFile,
  getSoteriaRuntimeFileCandidates,
  getSoteriaRuntimeFilePath,
  loadFirstExistingJsonFile,
  writeSoteriaRuntimeJsonFile,
} from "./soteria-runtime-paths";

const RUNTIME_FILENAME = "triton-scheduled-action.json";

/** One-shot timed action for the Triton loop (replaced when a new schedule is saved). */
export type TritonScheduledAction =
  | {
      kind: "exit_to_weth";
      executeAtUtc: string;
      createdAtUtc: string;
      notes?: string;
    }
  | {
      kind: "rotate_to_token";
      tokenName: string;
      tokenAddress: string;
      executeAtUtc: string;
      createdAtUtc: string;
      notes?: string;
    };

const MIN_DELAY_MS = 60_000;

function parseActionRaw(raw: unknown): TritonScheduledAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<TritonScheduledAction>;
  if (typeof r.executeAtUtc !== "string" || typeof r.createdAtUtc !== "string") return null;
  if (r.kind === "exit_to_weth") {
    return {
      kind: "exit_to_weth",
      executeAtUtc: r.executeAtUtc,
      createdAtUtc: r.createdAtUtc,
      notes: typeof r.notes === "string" ? r.notes : undefined,
    };
  }
  if (
    r.kind === "rotate_to_token" &&
    typeof r.tokenAddress === "string" &&
    r.tokenAddress.startsWith("0x")
  ) {
    return {
      kind: "rotate_to_token",
      tokenName: typeof r.tokenName === "string" ? r.tokenName : r.tokenAddress,
      tokenAddress: r.tokenAddress,
      executeAtUtc: r.executeAtUtc,
      createdAtUtc: r.createdAtUtc,
      notes: typeof r.notes === "string" ? r.notes : undefined,
    };
  }
  return null;
}

export function loadTritonScheduledAction(): TritonScheduledAction | null {
  const hit = loadFirstExistingJsonFile(
    getSoteriaRuntimeFileCandidates(RUNTIME_FILENAME, "TRITON_SCHEDULED_ACTION_PATH"),
    parseActionRaw
  );
  return hit?.value ?? null;
}

export function saveTritonScheduledAction(action: TritonScheduledAction): string {
  const p = writeSoteriaRuntimeJsonFile(RUNTIME_FILENAME, action);
  console.log(`[Triton] Saved scheduled action → ${p}`);
  return p;
}

export function clearTritonScheduledAction(): void {
  clearSoteriaRuntimeJsonFile(RUNTIME_FILENAME, "TRITON_SCHEDULED_ACTION_PATH");
}

export type TritonScheduleDelayInput = {
  delayMs?: number;
  delayMinutes?: number;
  delayHours?: number;
};

/** Resolve delay to milliseconds (minimum 1 minute). */
export function parseTritonScheduleDelayMs(input: TritonScheduleDelayInput): number {
  if (input.delayMs != null) {
    const n = Math.floor(input.delayMs);
    if (Number.isFinite(n) && n >= MIN_DELAY_MS) return n;
  }
  if (input.delayMinutes != null) {
    const n = Number(input.delayMinutes);
    if (Number.isFinite(n) && n > 0) return Math.max(MIN_DELAY_MS, Math.floor(n * 60_000));
  }
  if (input.delayHours != null) {
    const n = Number(input.delayHours);
    if (Number.isFinite(n) && n > 0) return Math.max(MIN_DELAY_MS, Math.floor(n * 3_600_000));
  }
  throw new Error(
    "Provide delayMinutes, delayHours, or delayMs (minimum 1 minute / 60000 ms)"
  );
}

function executeAtFromDelay(delayMs: number): string {
  return new Date(Date.now() + delayMs).toISOString();
}

export function scheduleTritonExitToWeth(
  delay: TritonScheduleDelayInput,
  notes?: string
): TritonScheduledAction {
  const action: TritonScheduledAction = {
    kind: "exit_to_weth",
    executeAtUtc: executeAtFromDelay(parseTritonScheduleDelayMs(delay)),
    createdAtUtc: new Date().toISOString(),
    ...(notes?.trim() && { notes: notes.trim() }),
  };
  saveTritonScheduledAction(action);
  return action;
}

export function scheduleTritonRotateToToken(
  token: string,
  delay: TritonScheduleDelayInput,
  notes?: string
): TritonScheduledAction {
  const resolved = resolveTritonV4Token(token);
  if (!resolved) {
    throw new Error(`Unknown Triton V4 token "${token}". Use liquidStratMinV4_listTokens.`);
  }
  const action: TritonScheduledAction = {
    kind: "rotate_to_token",
    tokenName: resolved.name,
    tokenAddress: resolved.address,
    executeAtUtc: executeAtFromDelay(parseTritonScheduleDelayMs(delay)),
    createdAtUtc: new Date().toISOString(),
    ...(notes?.trim() && { notes: notes.trim() }),
  };
  saveTritonScheduledAction(action);
  return action;
}

export function isTritonScheduledActionDue(
  action: TritonScheduledAction,
  nowMs: number = Date.now()
): boolean {
  const at = Date.parse(action.executeAtUtc);
  return Number.isFinite(at) && nowMs >= at;
}

export function msUntilTritonScheduledAction(
  action: TritonScheduledAction,
  nowMs: number = Date.now()
): number {
  const at = Date.parse(action.executeAtUtc);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - nowMs);
}

export function formatTritonScheduledActionSummary(action: TritonScheduledAction): string {
  const remainingMs = msUntilTritonScheduledAction(action);
  const remainingMin = Math.ceil(remainingMs / 60_000);
  if (action.kind === "exit_to_weth") {
    return `exit to WETH at ${action.executeAtUtc} (${remainingMin} min remaining)`;
  }
  return `rotate to ${action.tokenName} at ${action.executeAtUtc} (${remainingMin} min remaining)`;
}

export function getTritonScheduledActionPath(): string {
  return getSoteriaRuntimeFilePath(RUNTIME_FILENAME);
}
