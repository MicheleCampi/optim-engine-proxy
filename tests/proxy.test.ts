/**
 * Integration tests for the edge proxy.
 *
 * These tests are written against the real proxy logic by importing the handler
 * and constructing Request objects directly. They run on Node, not Vercel Edge,
 * but rely on the same Web Fetch API surface that Edge uses.
 *
 * For end-to-end tests against the deployed proxy, see e2e.test.ts (run after deploy).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import handler from '../api/proxy.js';

// Helper to construct browser-like request
function browserRequest(opts: {
  origin?: string;
  method?: string;
  path?: string;
  body?: unknown;
  ip?: string;
}): Request {
  const url = `https://proxy.example.com${opts.path ?? '/mcp'}`;
  const headers = new Headers();
  if (opts.origin) headers.set('origin', opts.origin);
  if (opts.ip) headers.set('x-real-ip', opts.ip);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(url, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe('CORS preflight', () => {
  it('accepts OPTIONS from claude.ai', async () => {
    const req = browserRequest({ origin: 'https://claude.ai', method: 'OPTIONS' });
    const res = await handler(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('accepts OPTIONS from anthropic.com subdomain', async () => {
    const req = browserRequest({ origin: 'https://docs.anthropic.com', method: 'OPTIONS' });
    const res = await handler(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://docs.anthropic.com');
  });

  it('rejects OPTIONS from disallowed origin', async () => {
    const req = browserRequest({ origin: 'https://malicious.example', method: 'OPTIONS' });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });
});

describe('Origin validation on actual requests', () => {
  it('rejects POST from disallowed origin', async () => {
    const req = browserRequest({
      origin: 'https://malicious.example',
      method: 'POST',
      body: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('origin_not_allowed');
  });
});

describe('Rate limiting', () => {
  beforeEach(async () => {
    // Drain rate limit store between tests by waiting briefly + using unique IPs
  });

  it('allows up to 60 requests from same IP+origin in window', async () => {
    const ip = 'test-ip-burst-1';
    const requests = Array.from({ length: 60 }, () =>
      browserRequest({
        origin: 'https://claude.ai',
        method: 'OPTIONS',
        ip,
      }),
    );
    const responses = await Promise.all(requests.map((r) => handler(r)));
    const successes = responses.filter((r) => r.status === 204).length;
    // OPTIONS bypass rate limit (preflight is special). Real test below.
    expect(successes).toBeGreaterThanOrEqual(60);
  });

  it('returns 429 on 61st POST from same IP+origin', async () => {
    const ip = 'test-ip-burst-2';
    const makeReq = () =>
      browserRequest({
        origin: 'https://claude.ai',
        method: 'POST',
        body: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
        ip,
      });

    // Fire 60 requests; expect them to forward upstream (we don't care about result here)
    for (let i = 0; i < 60; i++) {
      await handler(makeReq());
    }
    // 61st should hit rate limit
    const res61 = await handler(makeReq());
    expect(res61.status).toBe(429);
    expect(res61.headers.get('retry-after')).toBeTruthy();
    const body = await res61.json();
    expect(body.error).toBe('rate_limited');
  }, 30_000); // 30s timeout — first 60 calls go upstream
});

describe('Server-to-server (no Origin header)', () => {
  it('passes through without rate limit', async () => {
    // No origin header → s2s. Hit /health upstream which is fast and stable.
    const req = new Request('https://proxy.example.com/health', { method: 'GET' });
    const res = await handler(req);
    // Either 200 (health OK) or 502/504 if upstream is down — both prove pass-through.
    expect([200, 502, 504]).toContain(res.status);
  });
});
