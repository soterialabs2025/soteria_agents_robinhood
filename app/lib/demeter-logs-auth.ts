import { timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";

import { getSoteriaRepoRoot } from "@/app/config/soteria-runtime-paths";

/** Minimum age before a log row is returned (anti–front-run). Default 5s. */
export function getDemeterLogsPublishDelayMs(): number {
  const raw = readEnvValue("DEMETER_LOGS_PUBLISH_DELAY_MS");
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 5_000;
}

function normalizeSecret(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r/g, "").trim().replace(/^["']|["']$/g, "");
}

function parseDotEnvValue(content: string, name: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith(`${name}=`)) continue;
    let value = trimmed.slice(name.length + 1).trim();
    // Match common dotenv: strip trailing ` # comment` on unquoted values
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf(" #");
      if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
    }
    value = normalizeSecret(value);
    return value || null;
  }
  return null;
}

function dotEnvCandidates(): string[] {
  const override = process.env["DEMETER_ENV_FILE"]?.trim();
  const cwd = process.cwd();
  const root = getSoteriaRepoRoot();
  const out: string[] = [];
  if (override) out.push(path.resolve(override));
  out.push(path.join(root, ".env"));
  if (cwd !== root) out.push(path.join(cwd, ".env"));
  return [...new Set(out)];
}

/** Read one env var from `.env` on disk (EC2 source of truth — not stale process.env). */
function readEnvValue(name: string): string | null {
  for (const envPath of dotEnvCandidates()) {
    try {
      const value = parseDotEnvValue(fs.readFileSync(envPath, "utf8"), name);
      if (value) return value;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function getDemeterLogsApiKey(): string | null {
  const fromFile = readEnvValue("DEMETER_LOGS_API_KEY");
  const fromProcess = process.env["DEMETER_LOGS_API_KEY"];
  const key = normalizeSecret(fromFile ?? fromProcess ?? "");
  return key.length >= 16 ? key : null;
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const trimmed = normalizeSecret(authHeader);
  const match = /^bearer\s+(.+)$/i.exec(trimmed);
  if (match?.[1]) return normalizeSecret(match[1]);
  // Raw token in Authorization (no "Bearer " prefix)
  if (!/^bearer$/i.test(trimmed)) return trimmed;
  return null;
}

function extractProvidedApiKey(req: Request): string | null {
  const headerKey = req.headers.get("x-demeter-logs-key");
  if (headerKey) return normalizeSecret(headerKey);

  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return normalizeSecret(xApiKey);

  const auth = req.headers.get("authorization");
  const bearer = extractBearerToken(auth);
  if (bearer) return bearer;

  const url = new URL(req.url);
  const queryKey = url.searchParams.get("apiKey") ?? url.searchParams.get("key");
  if (queryKey) return normalizeSecret(queryKey);

  return null;
}

/** For auth-check diagnostics only — lengths, never secret values. */
export function getDemeterLogsAuthDebug(req: Request): {
  configuredKeyLength: number | null;
  providedBearerLength: number | null;
  providedHeaderKeyLength: number | null;
  providedQueryKeyLength: number | null;
  providedKeyLength: number | null;
  authorizationHeaderPresent: boolean;
  hint: string | null;
} {
  const configured = getDemeterLogsApiKey();
  const auth = req.headers.get("authorization");
  const bearer = extractBearerToken(auth);
  const headerKey = req.headers.get("x-demeter-logs-key");
  const queryKey = new URL(req.url).searchParams.get("apiKey") ?? new URL(req.url).searchParams.get("key");
  const provided = extractProvidedApiKey(req);
  const configuredLen = configured?.length ?? null;
  const bearerLen = bearer?.length ?? null;
  const headerKeyLen = headerKey ? normalizeSecret(headerKey).length : null;
  const queryKeyLen = queryKey ? normalizeSecret(queryKey).length : null;
  const providedLen = provided?.length ?? null;

  let hint: string | null = null;
  if (!provided) {
    hint =
      "No credentials received. Send X-Demeter-Logs-Key, Authorization: Bearer <key>, or ?apiKey=<key> on auth-check.";
  } else if (configuredLen !== null && providedLen !== null && providedLen !== configuredLen) {
    hint = "Provided key length differs from configured key.";
  } else if (configuredLen !== null && providedLen === configuredLen) {
    hint = "Length matches but value differs, or Authorization header did not reach the app (check nginx).";
  } else if (auth?.trim() && bearerLen === null) {
    hint = "Authorization header present but not Bearer format (use: Authorization: Bearer <key>).";
  }

  return {
    configuredKeyLength: configuredLen,
    providedBearerLength: bearerLen,
    providedHeaderKeyLength: headerKeyLen,
    providedQueryKeyLength: queryKeyLen,
    providedKeyLength: providedLen,
    authorizationHeaderPresent: Boolean(auth?.trim()),
    hint,
  };
}

function safeEqualSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Validates API key from header (Bearer / X-Demeter-Logs-Key / X-Api-Key) or ?apiKey= query. */
export function isDemeterLogsAuthorized(req: Request): boolean {
  const expected = getDemeterLogsApiKey();
  if (!expected) return false;

  const provided = extractProvidedApiKey(req);
  if (!provided) return false;

  return safeEqualSecret(provided, expected);
}

export function demeterLogsCorsHeaders(req: Request): HeadersInit {
  const allowed = (readEnvValue("DEMETER_LOGS_CORS_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.get("origin");
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, X-Demeter-Logs-Key",
    Vary: "Origin",
  };
}
