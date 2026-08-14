import { NextResponse } from "next/server";

import {
  demeterLogsCorsHeaders,
  getDemeterLogsApiKey,
  getDemeterLogsAuthDebug,
  isDemeterLogsAuthorized,
} from "@/app/lib/demeter-logs-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/demeter/auth-check — verify API key wiring (no log payload).
 * Auth: same Bearer / X-Demeter-Logs-Key as other demeter log routes.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const key = getDemeterLogsApiKey();
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "DEMETER_LOGS_API_KEY not found in .env (min 16 chars)" },
      { status: 503, headers: demeterLogsCorsHeaders(req) }
    );
  }

  if (!isDemeterLogsAuthorized(req)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Unauthorized",
        ...getDemeterLogsAuthDebug(req),
      },
      { status: 401, headers: demeterLogsCorsHeaders(req) }
    );
  }

  return NextResponse.json(
    { ok: true, configuredKeyLength: key.length },
    { headers: demeterLogsCorsHeaders(req) }
  );
}
