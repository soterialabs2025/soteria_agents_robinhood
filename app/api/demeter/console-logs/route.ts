import { NextResponse } from "next/server";

import {
  demeterLogsCorsHeaders,
  getDemeterLogsApiKey,
  getDemeterLogsAuthDebug,
  isDemeterLogsAuthorized,
} from "@/app/lib/demeter-logs-auth";
import { fetchDemeterPm2Logs, formatConsoleEntryLine } from "@/app/services/demeter-pm2-logs";
import type {
  DemeterConsoleChannelFilter,
  DemeterConsoleLogsApiResponse,
} from "@/app/types/demeter-logs";

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

function parseChannel(value: string | null): DemeterConsoleChannelFilter | null {
  if (value === "out" || value === "err" || value === "all") return value;
  return null;
}

export async function OPTIONS(req: Request): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: demeterLogsCorsHeaders(req),
  });
}

/**
 * GET /api/demeter/console-logs?channel=out|err|all&limit=100&after=<iso-utc>
 *
 * Tails PM2 demeter stdout/stderr files (see ecosystem.config.cjs).
 * Auth: same as /api/demeter/logs (DEMETER_LOGS_API_KEY).
 * Rows withheld until DEMETER_LOGS_PUBLISH_DELAY_MS after timestampUtc (default 5s).
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
  const channelParam = parseChannel(url.searchParams.get("channel"));
  if (url.searchParams.has("channel") && !channelParam) {
    return jsonWithCors(req, { error: "Invalid channel — use out, err, or all" }, 400);
  }

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw != null ? Number(limitRaw) : undefined;
  if (limitRaw != null && (!Number.isFinite(limit) || limit! < 1)) {
    return jsonWithCors(req, { error: "Invalid limit" }, 400);
  }

  const afterUtc = url.searchParams.get("after");
  const includeDebug = url.searchParams.get("debug") === "1";

  try {
    const result = await fetchDemeterPm2Logs({
      channel: channelParam ?? "all",
      limit,
      afterUtc,
    });

    const newest =
      result.entries.length > 0
        ? result.entries[result.entries.length - 1]!.timestampUtc
        : null;

    const body: DemeterConsoleLogsApiResponse = {
      channel: result.channel,
      publishDelayMs: result.publishDelayMs,
      entries: result.entries,
      lines: result.entries.map((entry) => formatConsoleEntryLine(entry)),
      meta: {
        returned: result.entries.length,
        limit: result.limit,
        newestTimestampUtc: newest,
        ...(includeDebug && result.debug ? { debug: result.debug } : {}),
      },
    };

    return jsonWithCors(req, body);
  } catch (e) {
    console.error("[api/demeter/console-logs]", e);
    return jsonWithCors(req, { error: "Failed to read console logs" }, 500);
  }
}
