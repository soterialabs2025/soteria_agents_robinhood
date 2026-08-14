import { NextResponse } from "next/server";

import {
  getX402TokenScoreApiKey,
  isX402TokenScoreAuthorized,
} from "@/app/lib/x402-token-score-auth";
import { scoreTokensForX402 } from "@/app/services/x402/token-score";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/x402/token-score
 *
 * Body: `{ "tokens": ["0x...", "0x..."] }` (2–10 Base addresses).
 * Auth: `Authorization: Bearer <X402_TOKEN_SCORE_API_KEY>` or `X-X402-Token-Score-Key`.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!getX402TokenScoreApiKey()) {
    return NextResponse.json(
      { error: "X402_TOKEN_SCORE_API_KEY is not configured on the server" },
      { status: 503 }
    );
  }

  if (!isX402TokenScoreAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const tokens =
    body && typeof body === "object" && body !== null && "tokens" in body
      ? (body as { tokens: unknown }).tokens
      : undefined;

  try {
    const result = await scoreTokensForX402(tokens);
    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status =
      typeof e === "object" && e !== null && "status" in e && typeof (e as { status: unknown }).status === "number"
        ? (e as { status: number }).status
        : /must|invalid|fewer than|need at least|at most/i.test(msg)
          ? 400
          : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-X402-Token-Score-Key, X-Api-Key",
    },
  });
}
