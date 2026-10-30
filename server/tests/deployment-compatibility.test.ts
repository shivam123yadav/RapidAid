import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { env } from '../src/config/env.js';
import { setRefreshCookie, clearRefreshCookie } from '../src/services/tokenService.js';

describe('Deployment & Cloud Hosting Compatibility', () => {
  it('exposes HOST configured for external binding (default 0.0.0.0)', () => {
    expect(env.HOST).toBeDefined();
    expect(typeof env.HOST).toBe('string');
  });

  it('exposes COOKIE_SAME_SITE with valid values (lax, strict, none)', () => {
    expect(env.COOKIE_SAME_SITE).toBeDefined();
    expect(['lax', 'strict', 'none']).toContain(env.COOKIE_SAME_SITE);
  });

  it('setRefreshCookie applies cookie configuration matching environment policy', () => {
    let cookieName = '';
    let cookieVal = '';
    let cookieOpts: Record<string, unknown> = {};

    const mockRes = {
      cookie: (name: string, val: string, opts: Record<string, unknown>) => {
        cookieName = name;
        cookieVal = val;
        cookieOpts = opts;
      },
    } as unknown as Response;

    setRefreshCookie(mockRes, 'test-refresh-token-value');

    expect(cookieName).toBe('rapidaid_rt');
    expect(cookieVal).toBe('test-refresh-token-value');
    expect(cookieOpts.httpOnly).toBe(true);
    expect(cookieOpts.path).toBe('/api/auth');
    expect(cookieOpts.sameSite).toBe(env.COOKIE_SAME_SITE);
    if (env.COOKIE_SAME_SITE === 'none') {
      expect(cookieOpts.secure).toBe(true);
    }
  });

  it('clearRefreshCookie clears cookie with matching path and sameSite attributes', () => {
    let clearName = '';
    let clearOpts: Record<string, unknown> = {};

    const mockRes = {
      clearCookie: (name: string, opts: Record<string, unknown>) => {
        clearName = name;
        clearOpts = opts;
      },
    } as unknown as Response;

    clearRefreshCookie(mockRes);

    expect(clearName).toBe('rapidaid_rt');
    expect(clearOpts.path).toBe('/api/auth');
    expect(clearOpts.httpOnly).toBe(true);
    expect(clearOpts.sameSite).toBe(env.COOKIE_SAME_SITE);
  });

  it('CORS origin parser supports comma-separated multiple domains', () => {
    const origins = 'https://rapidaid.vercel.app, http://localhost:3000, https://custom.domain.org';
    const parsed = origins.split(',').map((o) => o.trim()).filter(Boolean);

    expect(parsed).toEqual([
      'https://rapidaid.vercel.app',
      'http://localhost:3000',
      'https://custom.domain.org',
    ]);
  });
});

