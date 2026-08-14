/**
 * Auth for POST /api/x402/token-score (Bankr thin proxy → Demeter).
 * Env: `X402_TOKEN_SCORE_API_KEY` (min 16 chars).
 */
import { timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";

import { getSoteriaRepoRoot } from "@/app/config/soteria-runtime-paths";

function normalizeSecret(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r/g, "").trim().replace(/^["']|["']$/g, "");
}

function parseDotEnvValue(content: string, name: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith(`${name}=`)) continue;
    let value = trimmed.slice(name.length + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf(" #");
      if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
    }
    value = normalizeSecret(value);
    return value || null;
  }
  return null;
}

function readEnvValue(name: string): string | null {
  const override = process.env["DEMETER_ENV_FILE"]?.trim();
  const cwd = process.cwd();
  const root = getSoteriaRepoRoot();
  const candidates = [
    ...(override ? [path.resolve(override)] : []),
    path.join(root, ".env"),
    ...(cwd !== root ? [path.join(cwd, ".env")] : []),
  ];
  for (const envPath of [...new Set(candidates)]) {
    try {
      const value = parseDotEnvValue(fs.readFileSync(envPath, "utf8"), name);
      if (value) return value;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function getX402TokenScoreApiKey(): string | null {
  const fromFile = readEnvValue("X402_TOKEN_SCORE_API_KEY");
  const fromProcess = process.env["X402_TOKEN_SCORE_API_KEY"];
  const key = normalizeSecret(fromFile ?? fromProcess ?? "");
  return key.length >= 16 ? key : null;
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const trimmed = normalizeSecret(authHeader);
  const match = /^bearer\s+(.+)$/i.exec(trimmed);
  if (match?.[1]) return normalizeSecret(match[1]);
  if (!/^bearer$/i.test(trimmed)) return trimmed;
  return null;
}

function extractProvidedApiKey(req: Request): string | null {
  const headerKey = req.headers.get("x-x402-token-score-key");
  if (headerKey) return normalizeSecret(headerKey);

  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return normalizeSecret(xApiKey);

  const bearer = extractBearerToken(req.headers.get("authorization"));
  if (bearer) return bearer;

  const url = new URL(req.url);
  const queryKey = url.searchParams.get("apiKey") ?? url.searchParams.get("key");
  if (queryKey) return normalizeSecret(queryKey);

  return null;
}

function safeEqualSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Validates API key from Bearer / X-X402-Token-Score-Key / X-Api-Key / ?apiKey=. */
export function isX402TokenScoreAuthorized(req: Request): boolean {
  const expected = getX402TokenScoreApiKey();
  if (!expected) return false;
  const provided = extractProvidedApiKey(req);
  if (!provided) return false;
  return safeEqualSecret(provided, expected);
}
