/**
 * Bankr x402 paid handler — thin proxy to Demeter POST /api/x402/token-score.
 *
 * Env (bankr x402 env set):
 *   X402_TOKEN_SCORE_BACKEND_URL  e.g. https://agent.soterialabs.io/api/x402/token-score
 *   X402_TOKEN_SCORE_API_KEY      same secret as EC2 X402_TOKEN_SCORE_API_KEY
 */

const MIN_TOKENS = 2;
const MAX_TOKENS = 10;

function isHexAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

function validateTokens(tokens: unknown): string[] | string {
  if (!Array.isArray(tokens)) return "tokens must be an array of Base contract addresses";
  if (tokens.length < MIN_TOKENS || tokens.length > MAX_TOKENS) {
    return `tokens must contain between ${MIN_TOKENS} and ${MAX_TOKENS} addresses`;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    if (typeof raw !== "string" || !isHexAddress(raw)) {
      return `invalid token address: ${String(raw)}`;
    }
    const lc = raw.trim().toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(lc);
  }
  if (out.length < MIN_TOKENS) {
    return `need at least ${MIN_TOKENS} unique valid addresses (got ${out.length})`;
  }
  return out;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405 });
  }

  const backendUrl = process.env.X402_TOKEN_SCORE_BACKEND_URL?.trim();
  const apiKey = process.env.X402_TOKEN_SCORE_API_KEY?.trim();
  if (!backendUrl || !apiKey) {
    console.error("Missing X402_TOKEN_SCORE_BACKEND_URL or X402_TOKEN_SCORE_API_KEY");
    return Response.json({ error: "Service misconfigured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const tokensRaw =
    body && typeof body === "object" && body !== null && "tokens" in body
      ? (body as { tokens: unknown }).tokens
      : undefined;

  const validated = validateTokens(tokensRaw);
  if (typeof validated === "string") {
    return Response.json({ error: validated }, { status: 400 });
  }

  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ tokens: validated }),
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      console.error("Backend non-JSON:", res.status, text.slice(0, 200));
      return Response.json({ error: "Backend returned invalid JSON" }, { status: 502 });
    }

    if (!res.ok) {
      const errMsg =
        data && typeof data === "object" && data !== null && "error" in data
          ? String((data as { error: unknown }).error)
          : `Backend error ${res.status}`;
      return Response.json({ error: errMsg }, { status: res.status >= 500 ? 502 : res.status });
    }

    return Response.json(data);
  } catch (e) {
    console.error("Backend fetch failed:", e instanceof Error ? e.message : e);
    return Response.json({ error: "Failed to reach ranking backend" }, { status: 502 });
  }
}
