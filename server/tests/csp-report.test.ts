import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createApp } from '../src/app.js';
import { sanitizeReportUri, cspReportParser, cspReportHandler } from '../src/routes/system.routes.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';

describe('Milestone 5 Stage 2: CSP Report Ingestion Endpoint', () => {
  const app = createApp();

  describe('URL Sanitization Unit Tests', () => {
    it('strips query parameters and URL fragments from absolute URLs', () => {
      expect(sanitizeReportUri('http://localhost:3000/emergencies?token=secret123#tab1')).toBe('/emergencies');
      expect(sanitizeReportUri('https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap')).toBe('/css2');
    });

    it('handles relative URLs and paths safely', () => {
      expect(sanitizeReportUri('/assets/index-B7yCtZOe.css?v=1#sec')).toBe('/assets/index-B7yCtZOe.css');
    });

    it('handles non-URL strings like eval, inline, and wasm-eval without throwing', () => {
      expect(sanitizeReportUri('eval')).toBe('/eval');
      expect(sanitizeReportUri('wasm-unsafe-eval')).toBe('/wasm-unsafe-eval');
      expect(sanitizeReportUri('inline?foo=bar')).toBe('/inline');
    });

    it('handles null, undefined, empty, or non-string values safely', () => {
      expect(sanitizeReportUri(null)).toBe('unknown');
      expect(sanitizeReportUri(undefined)).toBe('unknown');
      expect(sanitizeReportUri('')).toBe('unknown');
      expect(sanitizeReportUri('   ')).toBe('unknown');
      expect(sanitizeReportUri(12345)).toBe('unknown');
      expect(sanitizeReportUri({})).toBe('unknown');
    });
  });

  describe('POST /api/csp-report Content-Type & Ingestion', () => {
    it('accepts application/csp-report with 204 No Content', async () => {
      const res = await request(app)
        .post('/api/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(
          JSON.stringify({
            'csp-report': {
              'document-uri': 'http://localhost:3000/emergencies?token=sensitive-query-param',
              referrer: '',
              'violated-directive': 'script-src',
              'effective-directive': 'script-src',
              'original-policy': "default-src 'self'",
              disposition: 'report',
              'blocked-uri': 'eval',
              'status-code': 200,
            },
          }),
        );

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    });

    it('accepts standard application/json report with 204 No Content', async () => {
      const res = await request(app)
        .post('/api/csp-report')
        .set('Content-Type', 'application/json')
        .send({
          'csp-report': {
            'document-uri': 'http://localhost:3000/command-center',
            'violated-directive': 'img-src',
            'blocked-uri': 'https://evil.com/tracker.png?session=12345',
          },
        });

      expect(res.status).toBe(204);
    });

    it('accepts reports at /api/system/csp-report alias', async () => {
      const res = await request(app)
        .post('/api/system/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(
          JSON.stringify({
            'csp-report': {
              'document-uri': 'http://localhost:3000/dispatch',
              'violated-directive': 'style-src',
              'blocked-uri': 'inline',
            },
          }),
        );

      expect(res.status).toBe(204);
    });

    it('accepts Reporting-API array payload format with 204 No Content', async () => {
      const res = await request(app)
        .post('/api/csp-report')
        .set('Content-Type', 'application/json')
        .send([
          {
            type: 'csp-violation',
            body: {
              blockedURL: 'http://localhost:3000/inline-script',
              effectiveDirective: 'script-src-elem',
            },
          },
        ]);

      expect(res.status).toBe(204);
    });

    it('handles empty or malformed objects gracefully without crashing', async () => {
      const res = await request(app).post('/api/csp-report').set('Content-Type', 'application/json').send({});

      expect(res.status).toBe(204);
    });

    it('rejects malformed raw JSON with HTTP 400', async () => {
      const res = await request(app)
        .post('/api/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send('{"invalid-json: unterminated');

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('rejects oversized payloads (> 10 KB) with HTTP 413 Payload Too Large', async () => {
      // 12 KB payload
      const largePayload = {
        'csp-report': {
          'document-uri': 'http://localhost:3000/',
          'violated-directive': 'script-src',
          'blocked-uri': 'x'.repeat(12 * 1024),
        },
      };

      const res = await request(app)
        .post('/api/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(JSON.stringify(largePayload));

      expect(res.status).toBe(413);
    });
  });

  describe('CSP Reporting Rate Limiting', () => {
    it('throttles excessive report submissions beyond configured threshold', async () => {
      const testApp = express();
      const testLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 3,
        skip: () => false,
      });

      testApp.post('/api/csp-report', testLimiter, cspReportParser, cspReportHandler);

      // Requests 1-3: accepted
      for (let i = 0; i < 3; i++) {
        const res = await request(testApp)
          .post('/api/csp-report')
          .set('Content-Type', 'application/csp-report')
          .send(JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }));
        expect(res.status).toBe(204);
      }

      // Request 4: rate limited
      const resBlocked = await request(testApp)
        .post('/api/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }));
      expect(resBlocked.status).toBe(429);
      expect(resBlocked.body.error.code).toBe('RATE_LIMITED');
    });
  });
});

