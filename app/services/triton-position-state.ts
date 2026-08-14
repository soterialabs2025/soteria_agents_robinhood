import fs from "fs";
import path from "path";

export type TritonPositionState = {
  assetAddress: string;
  entryPriceUsd: number;
  /** Best % gain from entry seen while holding (high-water mark). */
  peakGainPctFromEntry: number;
  enteredAtUtc: string;
};

const DEFAULT_PATH = path.join(process.cwd(), "logs", "triton-position-state.json");

function statePath(): string {
  return process.env.TRITON_POSITION_STATE_PATH?.trim() || DEFAULT_PATH;
}

function normalizePeakGainPct(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return 0;
}

export function loadTritonPositionState(): TritonPositionState | null {
  const p = statePath();
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<TritonPositionState>;
    if (
      typeof raw.assetAddress === "string" &&
      typeof raw.entryPriceUsd === "number" &&
      Number.isFinite(raw.entryPriceUsd) &&
      raw.entryPriceUsd > 0
    ) {
      return {
        assetAddress: raw.assetAddress,
        entryPriceUsd: raw.entryPriceUsd,
        peakGainPctFromEntry: normalizePeakGainPct(raw.peakGainPctFromEntry),
        enteredAtUtc: typeof raw.enteredAtUtc === "string" ? raw.enteredAtUtc : new Date().toISOString(),
      };
    }
  } catch {
    // ignore
  }
  return null;
}

export function saveTritonPositionState(state: TritonPositionState): void {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
}

export function clearTritonPositionState(): void {
  const p = statePath();
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // ignore
  }
}
