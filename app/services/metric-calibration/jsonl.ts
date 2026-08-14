import * as fs from "fs/promises";

export async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const out: T[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function appendJsonlLine(filePath: string, row: unknown): Promise<void> {
  await fs.appendFile(filePath, JSON.stringify(row) + "\n", "utf8");
}

/** Rewrite JSONL keeping rows whose timestamp (ISO field) is >= cutoffMs. */
export async function pruneJsonlByIsoField(
  filePath: string,
  isoField: string,
  cutoffMs: number
): Promise<{ kept: number; removed: number }> {
  const rows = await readJsonlFile<Record<string, unknown>>(filePath);
  if (rows.length === 0) return { kept: 0, removed: 0 };
  const keptRows: Record<string, unknown>[] = [];
  let removed = 0;
  for (const row of rows) {
    const raw = row[isoField];
    const ms =
      typeof raw === "string" && raw.length > 0 ? Date.parse(raw) : Number.NaN;
    if (Number.isFinite(ms) && ms >= cutoffMs) {
      keptRows.push(row);
    } else {
      removed++;
    }
  }
  const body = keptRows.map((r) => JSON.stringify(r)).join("\n");
  await fs.writeFile(filePath, body.length > 0 ? body + "\n" : "", "utf8");
  return { kept: keptRows.length, removed };
}
