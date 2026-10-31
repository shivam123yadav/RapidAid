import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer } from './helpers.js';
import { EmailToken } from '../src/models/index.js';
import { logger } from '../src/config/logger.js';
import {
  BrevoApiEmailTransport,
  parseEmailAddress,
  parseRetryAfter,
} from '../src/services/email/transports.js';
import {
  NonRetryableDeliveryError,
  RateLimitDeliveryError,
} from '../src/services/email/transport.js';

import {
  sendEmail,
  setTransport,
  resetTransport,
} from '../src/services/email/sender.js';
import { sanitizeString } from '../src/config/logger.js';

const app = createApp();
useTestDatabase(runSeed);

const TEST_API_KEY = 'xkeysib-testfakeapikey1234567890abcdef-secure';
const SENDER_ADDRESS = 'RapidAid Alerts <alerts@rapidaid.com>';

let capturedLogs: string[] = [];

beforeEach(() => {
  resetTransport();
  capturedLogs = [];
  const logSpy = (...args: unknown[]) => {
    capturedLogs.push(JSON.stringify(args));
  };
  vi.spyOn(logger, 'info').mockImplementation(logSpy);
  vi.spyOn(logger, 'warn').mockImplementation(logSpy);
  vi.spyOn(logger, 'error').mockImplementation(logSpy);
  vi.spyOn(logger, 'debug').mockImplementation(logSpy);
});

afterEach(() => {
  vi.useRealTimers();
  resetTransport();
  vi.restoreAllMocks();
});

describe('parseEmailAddress helper', () => {
  it('parses formatted RFC 5322 address with display name', () => {
    const parsed = parseEmailAddress('RapidAid Alerts <alerts@rapidaid.com>');
    expect(parsed).toEqual({ name: 'RapidAid Alerts', email: 'alerts@rapidaid.com' });
  });

  it('parses quoted display name', () => {
    const parsed = parseEmailAddress('"RapidAid Dispatch" <dispatch@rapidaid.com>');
    expect(parsed).toEqual({ name: 'RapidAid Dispatch', email: 'dispatch@rapidaid.com' });
  });

  it('parses bare email address', () => {
    const parsed = parseEmailAddress('citizen@example.com');
    expect(parsed).toEqual({ email: 'citizen@example.com' });
  });
});

describe('parseRetryAfter helper', () => {
  it('parses seconds format as milliseconds', () => {
    expect(parseRetryAfter('1')).toBe(1000);
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('  120  ')).toBe(120000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses HTTP date format as milliseconds from now', () => {
    const futureDate = new Date(Date.now() + 15000).toUTCString();
    const parsed = parseRetryAfter(futureDate);
    expect(parsed).toBeDefined();
    expect(parsed).toBeGreaterThan(10000);
    expect(parsed).toBeLessThanOrEqual(16000);
  });

  it('returns undefined for invalid, empty, or missing header values', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('invalid-format')).toBeUndefined();
  });
});


describe('BrevoApiEmailTransport Unit Tests', () => {
  it('throws on instantiation if API key is missing', () => {
    expect(() => new BrevoApiEmailTransport('', SENDER_ADDRESS)).toThrow(
      'BrevoApiEmailTransport requires an API key',
    );
  });

  it('successfully delivers when Brevo API responds with 201 Created', async () => {
    let capturedUrl = '';
    let capturedOptions: RequestInit | undefined;

    const mockFetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return new Response(
        JSON.stringify({ messageId: '<20261031.12345@smtp-relay.brevo.com>' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });

    const result = await transport.send({
      to: 'recipient@example.com',
      subject: 'Verify your account',
      html: '<p>Please click here</p>',
      text: 'Please click here',
    });

    expect(result.accepted).toBe(true);
    expect(result.id).toBe('<20261031.12345@smtp-relay.brevo.com>');

    expect(capturedUrl).toBe('https://api.brevo.com/v3/smtp/email');
    expect(capturedOptions?.method).toBe('POST');

    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers['api-key']).toBe(TEST_API_KEY);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept']).toBe('application/json');

    const body = JSON.parse(capturedOptions?.body as string);
    expect(body).toEqual({
      sender: { name: 'RapidAid Alerts', email: 'alerts@rapidaid.com' },
      to: [{ email: 'recipient@example.com' }],
      subject: 'Verify your account',
      htmlContent: '<p>Please click here</p>',
      textContent: 'Please click here',
    });
  });

  it('classifies invalid API credentials (HTTP 401) as NonRetryableDeliveryError', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 'unauthorized', message: 'Key not found' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });

    await expect(
      transport.send({
        to: 'recipient@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
        text: 'Test',
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof NonRetryableDeliveryError &&
        err.statusCode === 401 &&
        err.retryable === false &&
        err.message.includes('Key not found')
      );
    });
  });

  it('classifies client validation errors (HTTP 400) as NonRetryableDeliveryError', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 'invalid_parameter', message: 'Invalid recipient format' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });

    await expect(
      transport.send({
        to: 'bad-email',
        subject: 'Test',
        html: '<p>Test</p>',
        text: 'Test',
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof NonRetryableDeliveryError &&
        err.statusCode === 400 &&
        err.retryable === false &&
        err.message.includes('Invalid recipient format')
      );
    });
  });

  it('classifies server errors (HTTP 500) as retryable errors', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 'server_error', message: 'Internal service error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });

    await expect(
      transport.send({
        to: 'recipient@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
        text: 'Test',
      }),
    ).rejects.toSatisfy((err: unknown) => {
      // Must NOT be NonRetryableDeliveryError
      return !(err instanceof NonRetryableDeliveryError) && err instanceof Error;
    });
  });

  it('classifies rate limiting (HTTP 429) and parses Retry-After seconds as RateLimitDeliveryError', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 'too_many_requests', message: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '5',
          },
        },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });

    await expect(
      transport.send({
        to: 'recipient@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
        text: 'Test',
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof RateLimitDeliveryError &&
        err.retryable === true &&
        err.retryAfterMs === 5000 &&
        err.message.includes('rate limit exceeded')
      );
    });
  });

  it('classifies rate limiting (HTTP 429) and parses Retry-After HTTP date', async () => {
    const futureDateStr = new Date(Date.now() + 10000).toUTCString();
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 'too_many_requests', message: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': futureDateStr,
          },
        },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });

    await expect(
      transport.send({
        to: 'recipient@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
        text: 'Test',
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof RateLimitDeliveryError &&
        err.retryable === true &&
        typeof err.retryAfterMs === 'number' &&
        err.retryAfterMs > 0
      );
    });
  });


  it('aborts on network timeout and throws NonRetryableDeliveryError to prevent duplicate sends', async () => {
    const mockFetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
      // Simulate timeout by listening to signal
      return new Promise<Response>((_, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      timeoutMs: 50, // fast timeout for test
      fetchFn: mockFetch,
    });

    await expect(
      transport.send({
        to: 'recipient@example.com',
        subject: 'Timeout Test',
        html: '<p>Test</p>',
        text: 'Test',
      }),

    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof NonRetryableDeliveryError &&
        err.retryable === false &&
        err.message.includes('timed out') &&
        err.message.includes('delivery status uncertain')
      );
    });
  });
});

describe('sendEmail retry behavior & duplicate prevention', () => {
  it('does NOT retry when transport throws NonRetryableDeliveryError (aborts after 1 attempt)', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({ code: 'unauthorized', message: 'Invalid API key' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const result = await sendEmail(
      { to: 'citizen@example.com', subject: 'Verify', html: '<p>Link</p>', text: 'Link' },
      { purpose: 'verification' },
    );

    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(1); // Crucial: stopped immediately after 1 attempt!
    expect(callCount).toBe(1);
  });

  it('does NOT retry when transport times out (aborts after 1 attempt to prevent duplicate dispatch)', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
      callCount += 1;
      return new Promise<Response>((_, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const abortErr = new Error('aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      timeoutMs: 30,
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const result = await sendEmail(
      { to: 'citizen@example.com', subject: 'Verify', html: '<p>Link</p>', text: 'Link' },
      { purpose: 'verification' },
    );

    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(1);
    expect(callCount).toBe(1);
  });

  it('retries transient 5xx errors up to MAX_ATTEMPTS (3 attempts)', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({ code: 'server_error', message: 'Temporary failure' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const result = await sendEmail(
      { to: 'citizen@example.com', subject: 'Verify', html: '<p>Link</p>', text: 'Link' },
      { purpose: 'verification' },
    );

    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(3);
    expect(callCount).toBe(3);
  });

  it('waits requested duration and retries when Retry-After is 1 second (within permitted window)', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ code: 'too_many_requests', message: 'Rate limit exceeded' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '1', // 1s (1000ms) <= MAX_RETRY_DELAY_MS (2000ms)
            },
          },
        );
      }
      return new Response(
        JSON.stringify({ messageId: '<msg-retry-ok-1s@brevo.com>' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const emailPromise = sendEmail(
      { to: 'citizen@example.com', subject: 'Verify', html: '<p>Link</p>', text: 'Link' },
      { purpose: 'verification' },
    );

    // Initial attempt has run
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // After 500ms (< 1000ms), second attempt has NOT yet run
    await vi.advanceTimersByTimeAsync(500);
    expect(callCount).toBe(1);

    // After another 500ms (total 1000ms), second attempt executes and succeeds
    await vi.advanceTimersByTimeAsync(500);
    expect(callCount).toBe(2);

    const result = await emailPromise;
    expect(result.delivered).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('does NOT retry after 2 seconds and stops sequence when Retry-After is 5 seconds (exceeds MAX_RETRY_DELAY_MS)', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({ code: 'too_many_requests', message: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '5', // 5s (5000ms) > MAX_RETRY_DELAY_MS (2000ms)
          },
        },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const emailPromise = sendEmail(
      { to: 'citizen@example.com', subject: 'Verify', html: '<p>Link</p>', text: 'Link' },
      { purpose: 'verification' },
    );

    // Delivery attempt aborts immediately without scheduling a retry
    const result = await emailPromise;
    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(1);
    expect(callCount).toBe(1);

    // Crucial check: verify that after 2 seconds (the old MAX_RETRY_DELAY_MS clamp), NO retry was executed
    await vi.advanceTimersByTimeAsync(2000);
    expect(callCount).toBe(1);

    // Verify even after 5 seconds, no additional attempt was made
    await vi.advanceTimersByTimeAsync(3000);
    expect(callCount).toBe(1);
  });

  it('does NOT retry after 2 seconds and stops sequence when Retry-After is 120 seconds (exceeds MAX_RETRY_DELAY_MS)', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({ code: 'too_many_requests', message: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '120', // 120s (120000ms) > MAX_RETRY_DELAY_MS (2000ms)
          },
        },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const emailPromise = sendEmail(
      { to: 'citizen@example.com', subject: 'Verify', html: '<p>Link</p>', text: 'Link' },
      { purpose: 'verification' },
    );

    const result = await emailPromise;
    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(1);
    expect(callCount).toBe(1);

    // Crucial check: verify that after 2 seconds, NO retry was executed
    await vi.advanceTimersByTimeAsync(2000);
    expect(callCount).toBe(1);

    // Verify after 120 seconds, no additional attempt was made
    await vi.advanceTimersByTimeAsync(118000);
    expect(callCount).toBe(1);
  });

  it('does NOT retry after 2 seconds when HTTP-date Retry-After exceeds MAX_RETRY_DELAY_MS', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const futureDateStr = new Date(Date.now() + 10000).toUTCString(); // 10s > 2s
    const mockFetch = vi.fn(async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({ code: 'too_many_requests', message: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': futureDateStr,
          },
        },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const emailPromise = sendEmail(
      { to: 'citizen@example.com', subject: 'Verify', html: '<p>Link</p>', text: 'Link' },
      { purpose: 'verification' },
    );

    const result = await emailPromise;
    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(1);
    expect(callCount).toBe(1);

    // Verify not retried after 2 seconds
    await vi.advanceTimersByTimeAsync(2000);
    expect(callCount).toBe(1);
  });

  it('uses bounded exponential backoff when Retry-After is absent on HTTP 429', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({ code: 'too_many_requests', message: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            // No Retry-After header
          },
        },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const result = await sendEmail(
      { to: 'citizen@example.com', subject: 'Verify', html: '<p>Link</p>', text: 'Link' },
      { purpose: 'verification' },
    );

    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(3); // Retried up to MAX_ATTEMPTS
    expect(callCount).toBe(3);
  });

  it('uses bounded exponential backoff when Retry-After is invalid on HTTP 429', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({ code: 'too_many_requests', message: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': 'invalid-garbage',
          },
        },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const result = await sendEmail(
      { to: 'citizen@example.com', subject: 'Verify', html: '<p>Link</p>', text: 'Link' },
      { purpose: 'verification' },
    );

    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(3); // Retried up to MAX_ATTEMPTS
    expect(callCount).toBe(3);
  });
});


describe('Secret and credential redaction', () => {
  it('redacts Brevo API key and secrets from string serialization', () => {
    const raw = `Connecting with api-key: ${TEST_API_KEY} and token 12345`;
    const sanitized = sanitizeString(raw);
    expect(sanitized).not.toContain(TEST_API_KEY);
    expect(sanitized).toContain('[REDACTED]');
  });

  it('never logs the Brevo API key during error conditions', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 'unauthorized', message: 'Rejected' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    await sendEmail(
      { to: 'citizen@example.com', subject: 'Verify', html: '<p>Secret Token: 999999</p>', text: 'Secret Token: 999999' },
      { purpose: 'verification' },
    );

    for (const logLine of capturedLogs) {
      expect(logLine).not.toContain(TEST_API_KEY);
      expect(logLine).not.toContain('999999'); // Email body content should not leak
    }
  });
});

describe('End-to-End Auth Flows with Brevo Transport', () => {
  it('delivers verification email successfully via Brevo HTTP API on signup', async () => {
    let receivedPayload: { subject?: string; to?: Array<{ email: string }> } | null = null;
    const mockFetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
      receivedPayload = JSON.parse(options?.body as string);
      return new Response(
        JSON.stringify({ messageId: '<msg-123456@brevo.com>' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Brevo User',
        email: 'brevo.user@example.com',
        password: 'password123!',
        role: 'CITIZEN',
      });

    expect(res.status).toBe(201);
    expect(receivedPayload).not.toBeNull();
    expect((receivedPayload as any)?.subject).toBe('Verify your RapidAid account');
    expect((receivedPayload as any)?.to).toEqual([{ email: 'brevo.user@example.com' }]);

    // Honest logging check: Brevo acceptance message logged
    const acceptedLog = capturedLogs.find((l) =>
      l.includes('email accepted by Brevo transactional API'),
    );
    expect(acceptedLog).toBeDefined();
  });

  it('delivers password reset email successfully via Brevo HTTP API', async () => {
    let receivedPayload: Record<string, unknown> | null = null;
    const mockFetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
      receivedPayload = JSON.parse(options?.body as string);
      return new Response(
        JSON.stringify({ messageId: '<msg-pw-reset@brevo.com>' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    // Seeded citizen: citizen@rapidaid.com
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'citizen@rapidaid.com' });

    expect(res.status).toBe(200);
    expect(receivedPayload).not.toBeNull();
    expect((receivedPayload as any)?.subject).toBe('Reset your RapidAid password');
    expect((receivedPayload as any)?.to).toEqual([{ email: 'citizen@rapidaid.com' }]);
  });



  it('returns 503 and purges token when Brevo delivery fails', async () => {
    // Start with successful transport for signup so registration completes
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ messageId: '<msg-signup@brevo.com>' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    let transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const email = 'delivery.fail@example.com';
    const regRes = await request(app).post('/api/auth/register').send({
      name: 'Fail User',
      email,
      password: 'password123!',
      role: 'CITIZEN',
    });
    expect(regRes.status).toBe(201);
    const accessToken = regRes.body.accessToken;

    // Reset cooldown of the registration verification token
    await EmailToken.updateMany(
      { userId: regRes.body.user.id, purpose: 'verify' },
      { $set: { createdAt: new Date(Date.now() - 65_000) } },
    );

    // Now switch transport to simulate Brevo permanent failure (401 client rejection)
    const failingFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 'unauthorized', message: 'Account suspended' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: failingFetch,
    });
    setTransport(transport);

    const res = await request(app)
      .post('/api/auth/resend-verification')
      .set(bearer(accessToken));

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('EMAIL_DELIVERY_FAILED');
    expect(res.body.error.details?.retryAfter).toBe(5);

    // Verify token was purged so no invalid orphaned token remains
    const activeTokens = await EmailToken.find({ userId: regRes.body.user.id, purpose: 'verify' });
    expect(activeTokens.length).toBe(0);

    // Restore working transport and verify that immediate retry succeeds without waiting 60s
    // (failed delivery did NOT consume the 60-second cooldown because the failed token was purged)
    setTransport(new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    }));

    const retryRes = await request(app)
      .post('/api/auth/resend-verification')
      .set(bearer(accessToken));

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.delivered).toBe(true);
  });

  it('protects against concurrent resend requests', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount += 1;
      await new Promise((r) => setTimeout(r, 100)); // Delay to simulate latency
      return new Response(
        JSON.stringify({ messageId: '<msg-concurrent@brevo.com>' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const transport = new BrevoApiEmailTransport(TEST_API_KEY, SENDER_ADDRESS, {
      fetchFn: mockFetch,
    });
    setTransport(transport);

    const email = 'concurrent.test@example.com';
    const regRes = await request(app).post('/api/auth/register').send({
      name: 'Concurrent User',
      email,
      password: 'password123!',
      role: 'CITIZEN',
    });
    expect(regRes.status).toBe(201);
    const accessToken = regRes.body.accessToken;

    // Reset cooldown of the registration verification token
    await EmailToken.updateMany(
      { userId: regRes.body.user.id, purpose: 'verify' },
      { $set: { createdAt: new Date(Date.now() - 65_000) } },
    );

    // Reset callCount to 0 before testing resend dispatch concurrency
    callCount = 0;

    // Fire two requests concurrently
    const [req1, req2] = await Promise.all([
      request(app).post('/api/auth/resend-verification').set(bearer(accessToken)),
      request(app).post('/api/auth/resend-verification').set(bearer(accessToken)),
    ]);

    const statuses = [req1.status, req2.status].sort();
    // One must succeed (200), the concurrent one must be rejected (429)
    expect(statuses).toEqual([200, 429]);
    expect(callCount).toBe(1);
  });
});

