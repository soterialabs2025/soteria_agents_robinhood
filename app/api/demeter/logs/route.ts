import { NextResponse } from "next/server";

import {
  demeterLogsCorsHeaders,
  getDemeterLogsApiKey,
  getDemeterLogsAuthDebug,
  isDemeterLogsAuthorized,
} from "@/app/lib/demeter-logs-auth";
import { fetchDemeterPublicLogs } from "@/app/services/demeter-public-logs";
import type { DemeterLogsApiResponse, DemeterPublicLogStream } from "@/app/types/demeter-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonWithCors(req: Request, body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      ...demeterLogsCorsHeaders(req),
      "Cache-Control": "private, no-store",
    },
  });
}

function unauthorized(req: Request): NextResponse {
  return jsonWithCors(
    req,
    {
      error: "Unauthorized",
      ...getDemeterLogsAuthDebug(req),
    },
    401
  );
}

function parseStream(value: string | null): DemeterPublicLogStream | null {
  if (value === "strategy" || value === "pool") return value;
  return null;
}

export async function OPTIONS(req: Request): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: demeterLogsCorsHeaders(req),
  });
}

/**
 * GET /api/demeter/logs?stream=strategy|pool&limit=50&after=<iso-utc>
 *
 * Auth: X-Demeter-Logs-Key, Authorization: Bearer <key>, or ?apiKey=<key> (server-to-server).
 * Rows are withheld until {@link DEMETER_LOGS_PUBLISH_DELAY_MS} after timestampUtc (default 5s).
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!getDemeterLogsApiKey()) {
    return jsonWithCors(
      req,
      { error: "DEMETER_LOGS_API_KEY is not configured on the server" },
      503
    );
  }

  if (!isDemeterLogsAuthorized(req)) {
    return unauthorized(req);
  }

  const url = new URL(req.url);
  const streamParam = parseStream(url.searchParams.get("stream"));
  if (url.searchParams.has("stream") && !streamParam) {
    return jsonWithCors(req, { error: "Invalid stream — use strategy or pool" }, 400);
  }

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw != null ? Number(limitRaw) : undefined;
  if (limitRaw != null && (!Number.isFinite(limit) || limit! < 1)) {
    return jsonWithCors(req, { error: "Invalid limit" }, 400);
  }

  const afterUtc = url.searchParams.get("after");

  try {
    const result = await fetchDemeterPublicLogs({
      stream: streamParam ?? "strategy",
      limit,
      afterUtc,
    });

    const newest =
      result.entries.length > 0
        ? result.entries[result.entries.length - 1]!.timestampUtc
        : null;

    const body: DemeterLogsApiResponse = {
      stream: result.stream,
      publishDelayMs: result.publishDelayMs,
      entries: result.entries,
      meta: {
        returned: result.entries.length,
        limit: result.limit,
        newestTimestampUtc: newest,
      },
    };

    return jsonWithCors(req, body);
  } catch (e) {
    console.error("[api/demeter/logs]", e);
    return jsonWithCors(req, { error: "Failed to read logs" }, 500);
  }
}
