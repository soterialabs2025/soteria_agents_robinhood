import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

let cachedRepoRoot: string | null = null;

function isRepoRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "ecosystem.config.cjs")) &&
    fs.existsSync(path.join(dir, "app", "services", "demeter-agent.ts"))
  );
}

/**
 * Stable repo root for runtime JSON (Triton rules, schedules, overrides).
 * PM2 sets cwd correctly, but Next.js / bundled API routes may not — walk up from cwd and this module.
 */
export function getSoteriaRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;

  const envRoot = process.env.SOTERIA_REPO_ROOT?.trim();
  if (envRoot && isRepoRoot(path.resolve(envRoot))) {
    cachedRepoRoot = path.resolve(envRoot);
    return cachedRepoRoot;
  }

  const startDirs = new Set<string>([process.cwd()]);
  try {
    startDirs.add(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  } catch {
    // ignore (non-ESM)
  }

  for (const start of startDirs) {
    let dir = start;
    for (let i = 0; i < 10; i++) {
      if (isRepoRoot(dir)) {
        cachedRepoRoot = dir;
        return cachedRepoRoot;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  cachedRepoRoot = process.cwd();
  return cachedRepoRoot;
}

/** Primary writable runtime file under `logs/` (shared by demeter + soteria-web console). */
export function getSoteriaRuntimeFilePath(filename: string): string {
  return path.join(getSoteriaRepoRoot(), "logs", filename);
}

/** All locations to read a runtime JSON file (newest valid wins on load). */
export function getSoteriaRuntimeFileCandidates(
  filename: string,
  envOverrideVar?: string
): string[] {
  const root = getSoteriaRepoRoot();
  const cwd = process.cwd();
  const out: string[] = [];

  const envPath = envOverrideVar ? process.env[envOverrideVar]?.trim() : undefined;
  if (envPath) out.push(path.resolve(envPath));

  const add = (base: string) => {
    out.push(path.join(base, "logs", filename));
    out.push(path.join(base, "app", "config", filename));
  };

  add(root);
  if (cwd !== root) add(cwd);

  return [...new Set(out.map((p) => path.resolve(p)))];
}

export function loadFirstExistingJsonFile<T>(
  candidates: string[],
  parse: (raw: unknown) => T | null
): { value: T; path: string } | null {
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const value = parse(raw);
      if (value != null) return { value, path: p };
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function writeSoteriaRuntimeJsonFile(filename: string, data: unknown): string {
  const p = getSoteriaRuntimeFilePath(filename);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  return p;
}

export function clearSoteriaRuntimeJsonFile(filename: string, envOverrideVar?: string): void {
  for (const p of getSoteriaRuntimeFileCandidates(filename, envOverrideVar)) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
}
