# Edge Proxy for OptimEngine — Design Decisions

*Written before implementation. May 4, 2026.*

This document captures the architectural decisions made before any code was written. Read it first; the implementation follows from it.

## Problem statement

OptimEngine is a Python/FastAPI service running on Railway, exposing an MCP server at `/mcp` (SSE transport, open with rate limiting) and `/mcp/v2` (Streamable HTTP, OAuth-protected). The architecture is intentionally **server-to-server only**: legitimate clients are MCP runtimes (Claude Desktop, Cursor), Anthropic's MCP-via-API integration, x402 payment gateways, and other server-side agents. CORS was deliberately removed on April 19, 2026 (see commit history) to enforce this boundary by default.

A new use case has emerged: **browser-based demos** that call the MCP server directly. Specifically:

- `claude.ai` artifact iframes that render live MCP integration demos for portfolio purposes
- A future `michelecampi.github.io/demo` page allowing visitors to invoke `optimize_schedule` interactively
- Any future browser-side preview tool that needs to call the solver

The naive solution is to add `CORSMiddleware` to OptimEngine with a whitelist. This works but has two costs:

1. It breaks the "server-to-server only" invariant we deliberately set
2. It couples a portfolio/demo concern (browser access) to the production solver service
3. Browser-side error patterns (preflight failures, mixed content) become OptimEngine's problem

## Decision: thin edge proxy on Vercel

Instead of opening CORS on OptimEngine, we deploy a thin proxy on Vercel Edge Runtime that:

- Sits in front of `/mcp` and `/mcp/v2`
- Terminates browser requests, applies CORS headers, forwards server-to-server to OptimEngine
- OptimEngine remains untouched: still server-to-server only, still no CORS

This preserves the original invariant. The proxy absorbs the browser-side concern.

## Why Vercel Edge

Three options considered:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Vercel Edge Functions** | Already in stack (optim-arc-v3), zero cost on hobby tier, fast cold-start | Lock-in to Vercel | ✓ Selected |
| Cloudflare Workers | More mature edge platform, faster cold-start | New stack to learn, separate billing | Rejected: no incremental benefit for the use case |
| AWS Lambda@Edge | Deepest configurability, mature | Heavy setup, slower cold-start, paid | Rejected: overkill |

Vercel Edge wins on coherence: it's already in the deployed stack (the x402 gateway runs on it), the project is single-developer, and the use case is a thin proxy.

## What this proxy does NOT do

Explicitly out of scope, to keep the proxy minimal:

- **No request payload caching.** MCP `tools/call` requests are stateful (each call returns a fresh solver result); caching makes no sense. We may add `tools/list` caching in v2 if response time becomes a problem.
- **No request transformation.** The proxy passes JSON-RPC payloads through unchanged. If the client sends a malformed request, the backend returns the error; the proxy does not validate or rewrite.
- **No multi-region failover.** OptimEngine is single-region (Railway EU). The proxy mirrors that. If Railway goes down, the proxy fails fast with `503`.
- **No auth on the proxy itself.** The proxy is a transport layer, not a gatekeeper. Rate limiting and origin whitelisting are the only filters. The OAuth-protected `/mcp/v2` continues to require Bearer tokens; the proxy forwards them as-is.
- **No load balancing or retry logic.** A single failed upstream request returns immediately. The MCP client (Claude Desktop, etc.) can retry at its own discretion.

This minimalism is deliberate. The proxy is "boring infrastructure" — short, predictable, easily replaceable.

## Allowed origins (whitelist)

Browser requests are allowed from:

- `https://claude.ai` (Anthropic's primary domain for artifact iframes)
- `https://*.anthropic.com` (Anthropic subdomains for future API/playground use)
- `https://michelecampi.github.io` (the personal blog/landing for demo embeds)
- `http://localhost:3000` (local development)

All other browser origins receive a CORS rejection. Server-to-server traffic with no `Origin` header passes through unchanged.

## Rate limiting strategy

The proxy applies an in-memory rate limit of **60 requests per minute per IP**, matching the upstream OptimEngine policy. Rationale:

- Matching upstream prevents the proxy from accepting requests that the backend will reject anyway
- 60/min is generous for legitimate demo browser usage (a Claude artifact making a few `tools/call` per session)
- In-memory limiting is acceptable for a single-instance proxy on hobby tier; if traffic grows, migrate to Redis or KV-backed limiter

Server-to-server traffic without browser origin headers is **not rate-limited at the proxy** — the upstream backend handles it. This avoids double-limiting legitimate MCP clients.

## Failure modes

| Failure | Proxy behavior |
|---|---|
| Upstream Railway 5xx | Pass-through with `Cache-Control: no-store` |
| Upstream timeout (>10s) | Return `504 Gateway Timeout` |
| Disallowed origin | Return `403 Forbidden` with empty body |
| Rate limit exceeded | Return `429 Too Many Requests` with `Retry-After: 60` |
| Malformed Origin header | Treat as no origin (server-to-server, pass through) |
| OPTIONS preflight | Echo back allowed methods/headers/origin |

## Observability

- Vercel Analytics (built-in) for request counts and latency
- Console logs for every request: `[timestamp] [origin] [path] [status] [latency]`
- No PII logged, no payloads logged

## Migration path

If the proxy becomes unreliable or if we want to deprecate it, the migration is trivial: tighten allowed origins to none, OptimEngine's CORS configuration is unchanged (still none), browser demos break gracefully. The upstream service remains intact.

## What "done" looks like for v1

- Single TypeScript file deployed on Vercel Edge
- README explaining the architecture decision (this DESIGN.md becomes its core)
- Integration test suite that hits the live proxy from a browser-like context
- Public repo on GitHub, linked from the OptimEngine showcase README and the personal blog
- Blog article (~1,500 words) published the weekend after deploy, walking through the architectural decision
