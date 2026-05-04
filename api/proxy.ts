/**
 * Edge proxy for OptimEngine MCP server.
 *
 * Architecture: thin pass-through. Browser clients hit this proxy with CORS;
 * the proxy validates origin + rate limit + forwards server-to-server to
 * OptimEngine. The upstream service stays free of CORS coupling.
 *
 * See DESIGN.md in the repo root for the full architectural rationale.
 */

export const config = {
  runtime: 'edge',
  regions: ['fra1'],
};

// ─── Configuration ─────────────────────────────────────────────────────────
const UPSTREAM_BASE = 'https://optim-engine-production.up.railway.app';
const UPSTREAM_TIMEOUT_MS = 10_000;

const ALLOWED_ORIGINS = new Set<string>([
  'https://claude.ai',
  'https://michelecampi.github.io',
  'http://localhost:3000',
]);

// Pattern-based allowed origins (for *.anthropic.com)
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^https:\/\/[a-z0-9-]+\.anthropic\.com$/,
];

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, Accept, X-Engine-Key';
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

// ─── Origin validation ─────────────────────────────────────────────────────

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // server-to-server: no Origin header, pass through
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

function buildCorsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// ─── Rate limiting (in-memory, per IP, sliding window) ─────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateBucket>();

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const bucket = rateLimitStore.get(ip);

  if (!bucket || bucket.resetAt < now) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (bucket.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  bucket.count += 1;
  return { allowed: true };
}

function getClientIp(request: Request): string {
  // Vercel Edge sets x-real-ip and x-forwarded-for. Prefer x-real-ip.
  return (
    request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

// ─── Upstream forwarding ───────────────────────────────────────────────────

async function forwardRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // /mcp and /mcp/* paths are forwarded as-is to upstream
  const upstreamUrl = `${UPSTREAM_BASE}${url.pathname}${url.search}`;

  // Strip Origin/Referer to make this look server-to-server upstream
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete('origin');
  forwardHeaders.delete('referer');
  forwardHeaders.delete('host');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
      signal: controller.signal,
      // @ts-expect-error: duplex required for streaming bodies in fetch
      duplex: 'half',
    });
    return upstreamResponse;
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return new Response(
      JSON.stringify({
        error: isTimeout ? 'gateway_timeout' : 'upstream_error',
        message: isTimeout
          ? 'OptimEngine did not respond within 10s'
          : 'Failed to reach OptimEngine',
      }),
      {
        status: isTimeout ? 504 : 502,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Main handler ──────────────────────────────────────────────────────────

export default async function handler(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);

  // 1. CORS preflight
  if (request.method === 'OPTIONS') {
    if (!isOriginAllowed(origin)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 2. Origin check (browser only — server-to-server has no Origin and is allowed)
  if (origin && !isOriginAllowed(origin)) {
    return new Response(JSON.stringify({ error: 'origin_not_allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Rate limit (browser traffic only — server-to-server has its own upstream limit)
  if (origin) {
    const ip = getClientIp(request);
    const { allowed, retryAfter } = checkRateLimit(ip);
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter ?? 60),
          ...corsHeaders,
        },
      });
    }
  }

  // 4. Forward to upstream
  const upstreamResponse = await forwardRequest(request);

  // 5. Re-attach CORS headers on response
  const responseHeaders = new Headers(upstreamResponse.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    responseHeaders.set(key, value as string);
  }

  // Log (no PII, no body)
  const ip = getClientIp(request);
  const path = new URL(request.url).pathname;
  console.log(
    `[${new Date().toISOString()}] [${origin ?? 's2s'}] [${ip}] ${request.method} ${path} -> ${upstreamResponse.status}`,
  );

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
