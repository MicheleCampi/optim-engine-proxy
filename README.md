# optim-engine-proxy

Thin edge proxy for [OptimEngine](https://github.com/MicheleCampi/optim-engine) — a production OR-Tools optimization service exposing 9 solvers via REST and MCP.

This proxy lives in front of the MCP transport (`/mcp` SSE and `/mcp/v2` Streamable HTTP) and lets browser-based clients call the solver without compromising the upstream service's server-to-server architecture.

**Live**: `https://optim-engine-proxy.vercel.app`
**Upstream**: `https://optim-engine-production.up.railway.app`

## Why this exists

OptimEngine is intentionally server-to-server only. Legitimate clients are MCP runtimes (Claude Desktop, Cursor), Anthropic's MCP-via-API integration, x402 payment gateways, and other server-side agents. CORS was deliberately removed from the upstream on April 19, 2026.

A new use case emerged: browser-based demos rendered inside `claude.ai` artifact iframes and on `michelecampi.github.io/demo`. The naive solution is to add CORS to OptimEngine with a whitelist. That works but couples a portfolio concern to the production service and breaks the original invariant.

The thin edge proxy is the alternative. It absorbs the browser concern, leaves OptimEngine untouched, and is small enough that the entire codebase fits in one TypeScript file.

The full architectural rationale lives in [DESIGN.md](./DESIGN.md). Read it first.

## What the proxy does

1. **CORS termination** — preflight OPTIONS requests are answered locally with appropriate headers. POST/GET requests are validated against an origin whitelist.
2. **Rate limiting** — 60 req/min per IP for browser clients, mirroring upstream policy. Server-to-server traffic (no `Origin` header) is not double-limited.
3. **Pass-through forwarding** — bodies, query strings, and headers (minus `Origin`/`Referer`/`Host`) are forwarded as-is to OptimEngine. Streaming SSE responses are passed through with `duplex: 'half'`.
4. **Failure containment** — upstream timeouts (>10s) return `504`; network errors return `502`. CORS headers attach to error responses too, so the browser can read the JSON body.

## What the proxy does NOT do

By design:

- **No payload caching.** MCP `tools/call` is stateful; caching makes no sense.
- **No request transformation.** The proxy is dumb on purpose.
- **No multi-region failover.** OptimEngine is single-region (Railway EU); the proxy mirrors that with `fra1`.
- **No auth on the proxy itself.** It's a transport layer. The OAuth-protected `/mcp/v2` continues to require Bearer tokens — the proxy forwards them as-is.
- **No retry logic.** Failed upstream → fail fast. The MCP client retries at its discretion.

## Allowed origins

| Origin | Purpose |
|---|---|
| `https://claude.ai` | Anthropic's primary domain, used by artifact iframes |
| `https://*.anthropic.com` | Subdomain pattern for future Anthropic platform features |
| `https://michelecampi.github.io` | Personal blog / demo embeds |
| `http://localhost:3000` | Local development |

All other browser origins receive `403 Forbidden`.

## Run locally

```bash
npm install
npm run build      # TypeScript type check
npm test           # Run integration tests (no network)
npm run dev        # Vercel local emulator
```

## Run tests

```bash
# Fast tests (no network), runs in ~50ms:
npx vitest run -t "CORS preflight|Origin validation"

# Full suite including rate limit + upstream pass-through (hits live Railway):
npm test
```

## Deploy

This repository is configured for Vercel. On push to `main`, Vercel builds and deploys automatically.

```bash
vercel --prod
```

## Stack

- Vercel Edge Runtime (Web Fetch API, ~200 LOC)
- TypeScript with `strict` and `noUncheckedIndexedAccess`
- Vitest for tests
- No external runtime dependencies

## Related

- [OptimEngine](https://github.com/MicheleCampi/optim-engine) — the upstream solver service
- [optim-engine-showcase](https://github.com/MicheleCampi/optim-engine-showcase) — public documentation, architecture deep-dive, 11-tool reference
- [Public observability dashboard](https://optimengine.grafana.net/public-dashboards/21137ba340fc4b6e917a4b108db3e109) — live metrics on the upstream service

## Security

The security model of this proxy is **intentionally minimal** because the proxy itself stores no state and holds no secrets. The substantive security architecture — threat model, authentication, CORS strategy, rate limiting at the engine level, dependency hygiene — lives in the upstream service's [`SECURITY.md`](https://github.com/MicheleCampi/optim-engine/blob/main/SECURITY.md), which is authoritative.

What this proxy contributes to the overall security posture:

- **CORS enforcement at the edge.** Browser requests from origins outside the whitelist receive `403 Forbidden`. The upstream OptimEngine service does not handle CORS at all; the proxy is the only path through which browser-origin traffic can reach the solver.
- **Origin whitelist as a hardcoded list** in `api/proxy.ts`, not a database. Adding or removing an origin requires a commit and a Vercel deploy — there is no runtime configuration surface to abuse.
- **Rate limiting on browser traffic only.** 60 req/min per IP for browser clients; server-to-server traffic (no `Origin` header) is not double-limited, since it is already rate-limited at the upstream MCP layer.
- **No secrets in the proxy.** No API keys, no OAuth tokens, no signing material. The Bearer token required for `/mcp/v2` is forwarded from the browser as-is and validated upstream by OptimEngine.
- **No persistence.** Rate-limit counters live in edge memory and reset with each deploy. There is no database, no cache, no log of payloads.

To report a security issue affecting this proxy specifically (for example, a CORS bypass or rate-limit evasion), open a private advisory at [github.com/MicheleCampi/optim-engine-proxy/security/advisories/new](https://github.com/MicheleCampi/optim-engine-proxy/security/advisories/new), or email `michele.campi@outlook.com` with the subject prefix `[OPTIMENGINE-PROXY-SEC]`. Issues affecting the upstream solver belong upstream — please report them at the optim-engine repository.

## License

MIT
