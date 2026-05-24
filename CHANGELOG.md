# Changelog

All notable changes to optim-engine-proxy are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). This is a small repository (one TypeScript file, three commits at time of writing) so the changelog is correspondingly short.

## [Unreleased]

No changes since 2026-05-04. The proxy has been stable in production at `optim-engine-proxy.vercel.app` since deploy.

## [0.1.0] — 2026-05-04

### Added

- **Thin edge proxy for OptimEngine MCP server.** Single-file TypeScript implementation deployed as a Vercel Edge Function (`api/proxy.ts`). Terminates browser requests on behalf of `claude.ai` artifact iframes and `michelecampi.github.io/demo` pages, applies CORS headers against an origin whitelist, rate-limits at 60 req/min per IP for browser clients, and forwards bodies/query/headers (minus `Origin`/`Referer`/`Host`) to the upstream Railway service. Streaming SSE responses pass through with `duplex: 'half'`. Upstream timeouts >10 s return `504`; network errors return `502`. CORS headers attach to error responses so the browser can read the JSON body. Architectural rationale lives in [DESIGN.md](./DESIGN.md), written before any code. (commit `46beb15`)
- **Origin whitelist**: `claude.ai`, `*.anthropic.com`, `michelecampi.github.io`, and `localhost:3000` for development.
- **Integration test suite** under `tests/`: CORS preflight, origin validation (fast, no network), rate limit, and upstream pass-through (live Railway).
- **Vercel deployment config** (`vercel.json`), TypeScript with `strict` and `noUncheckedIndexedAccess`, no external runtime dependencies.

### Fixed

- **Vercel build configuration** simplified to let Vercel auto-detect the edge runtime from the `config` export in `api/proxy.ts` rather than declaring it in `vercel.json`. (commit `ffb4c4c`)
- **Vercel project** configured for functions-only deploy. Removed the static output build step that produced an empty `dist/` directory and caused deploy warnings. (commit `ba975e4`)

## Notes

This changelog was introduced on 2026-05-24, after the proxy had been deployed and stable for three weeks. The three entries above are reconstructed from the commit history. Going forward, version bumps will be cut by creating a git tag and updating this file in the same commit.
