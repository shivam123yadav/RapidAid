import { describe, it, expect } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { requestId } from '../src/middleware/requestId.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('Request-ID Propagation & Security Hardening', () => {
  function createTestApp() {
    const app = express();
    app.use(requestId);

    app.get('/echo-id', (req: Request, res: Response) => {
      res.status(200).json({
        requestId: req.requestId,
        echoHeader: res.getHeader('x-request-id'),
      });
    });

    app.get('/error-test', (_req: Request, _res: Response) => {
      const err = new Error('Test unexpected failure');
      (err as { status?: number }).status = 500;
      throw err;
    });

    app.use(errorHandler);
    return app;
  }

  describe('Missing or Absent Request-ID', () => {
    it('generates a cryptographically random UUIDv4 when client sends no x-request-id', async () => {
      const app = createTestApp();
      const res = await request(app).get('/echo-id');

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBeDefined();
      expect(UUID_V4_RE.test(res.headers['x-request-id'])).toBe(true);
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('generates unique IDs across distinct requests', async () => {
      const app = createTestApp();
      const res1 = await request(app).get('/echo-id');
      const res2 = await request(app).get('/echo-id');

      expect(res1.body.requestId).not.toBe(res2.body.requestId);
    });
  });

  describe('Valid Client-Supplied Identifiers', () => {
    it('accepts and preserves standard alphanumeric trace IDs with dots, dashes, underscores up to 64 chars', async () => {
      const app = createTestApp();
      const validIds = [
        'trace-12345',
        'frontend.req_001-abc',
        'a'.repeat(64),
        '1234567890',
        'gateway-trace.node_1-clusterA',
      ];

      for (const traceId of validIds) {
        const res = await request(app).get('/echo-id').set('x-request-id', traceId);
        expect(res.status).toBe(200);
        expect(res.headers['x-request-id']).toBe(traceId);
        expect(res.body.requestId).toBe(traceId);
      }
    });
  });

  describe('Malformed and Injection Attempts', () => {
    it('discards IDs containing whitespace and falls back to a safe UUIDv4', async () => {
      const app = createTestApp();
      const res = await request(app).get('/echo-id').set('x-request-id', 'trace id with spaces');

      expect(res.status).toBe(200);
      expect(res.body.requestId).not.toBe('trace id with spaces');
      expect(UUID_V4_RE.test(res.body.requestId)).toBe(true);
    });

    it('discards IDs containing punctuation/characters outside [A-Za-z0-9._-]', async () => {
      const app = createTestApp();
      const badIds = [
        'trace;semicolon',
        'trace:colon',
        'trace/slash',
        'trace=equals',
        'trace?query',
        'trace#hash',
        'trace$dollar',
      ];

      for (const badId of badIds) {
        const res = await request(app).get('/echo-id').set('x-request-id', badId);
        expect(res.status).toBe(200);
        expect(res.body.requestId).not.toBe(badId);
        expect(UUID_V4_RE.test(res.body.requestId)).toBe(true);
      }
    });

    it('unit test: middleware discards raw CRLF/header injection and unicode characters', () => {
      const rawInjections = [
        'evil\r\nX-Injected: true',
        'trace\nnewline',
        '🔥-unicode-trace',
        '<script>alert(1)</script>',
        'a'.repeat(65),
      ];

      for (const raw of rawInjections) {
        let setHeaderKey = '';
        let setHeaderVal = '';
        const mockReq = {
          header: (name: string) => (name.toLowerCase() === 'x-request-id' ? raw : undefined),
          requestId: '',
        } as unknown as Request;

        const mockRes = {
          setHeader: (k: string, v: string) => {
            setHeaderKey = k;
            setHeaderVal = v;
          },
        } as unknown as Response;

        let nextCalled = false;
        requestId(mockReq, mockRes, () => {
          nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(setHeaderKey).toBe('x-request-id');
        expect(mockReq.requestId).not.toBe(raw);
        expect(UUID_V4_RE.test(mockReq.requestId)).toBe(true);
        expect(setHeaderVal).toBe(mockReq.requestId);
      }
    });

    it('discards IDs exceeding 64 characters and generates a safe UUIDv4', async () => {
      const app = createTestApp();
      const longId = 'a'.repeat(65);
      const res = await request(app).get('/echo-id').set('x-request-id', longId);

      expect(res.status).toBe(200);
      expect(res.body.requestId).not.toBe(longId);
      expect(UUID_V4_RE.test(res.body.requestId)).toBe(true);
    });

    it('handles empty string request-id safely', async () => {
      const app = createTestApp();
      const res = await request(app).get('/echo-id').set('x-request-id', '');

      expect(res.status).toBe(200);
      expect(UUID_V4_RE.test(res.body.requestId)).toBe(true);
    });
  });

  describe('Traceability in Error Responses', () => {
    it('propagates the correlation requestId into 500 error responses', async () => {
      const app = createTestApp();
      const traceId = 'test-trace-err-999';
      const res = await request(app).get('/error-test').set('x-request-id', traceId);

      expect(res.status).toBe(500);
      expect(res.headers['x-request-id']).toBe(traceId);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.requestId).toBe(traceId);
    });
  });
});

