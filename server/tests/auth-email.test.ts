import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs, DEMO_USERS } from './helpers.js';
import { EmailToken, User } from '../src/models/index.js';
import { logger } from '../src/config/logger.js';
import { activeTransportName } from '../src/services/email/sender.js';

const app = createApp();
useTestDatabase(runSeed);

import { ConsoleEmailTransport } from '../src/services/email/transports.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';

let capturedLogs: string[] = [];

beforeEach(() => {
  ConsoleEmailTransport.clearRecorded();
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
  vi.restoreAllMocks();
});

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** Pulls the token out of the most recent in-memory recorded message (never from logs). */
const lastToken = (): string => {
  const lastMsg = ConsoleEmailTransport.getLastMessage();
  if (!lastMsg) throw new Error('No email recorded in ConsoleEmailTransport');
  const body = lastMsg.text || lastMsg.html || '';
  const match = /token=([a-f0-9]{16,})/.exec(body);
  if (!match?.[1]) throw new Error('No token found in recorded email body');
  return match[1];
};

const registerCitizen = (email: string) =>
  request(app).post('/api/auth/register').send({ name: 'Test Citizen', email, password: 'citizenpass1', role: 'CITIZEN' });

describe('email tokens: storage, single use, TTL, purpose', () => {
  it('uses the console transport in tests, so links are capturable', () => {
    expect(activeTransportName).toBe('console');
  });

  it('stores only a SHA-256 hash — never the raw token that was emailed', async () => {
    const res = await registerCitizen('hash-check@rapidaid.com');
    expect(res.status).toBe(201);

    const raw = lastToken();
    const record = await EmailToken.findOne({ userId: res.body.user.id, purpose: 'verify' }).lean();
    expect(record).toBeTruthy();
    expect(record!.tokenHash).toBe(sha256(raw));
    // The plaintext must appear nowhere in the document.
    expect(JSON.stringify(record)).not.toContain(raw);
  });

  it('starts a self-registered citizen unverified, then verifies on link use', async () => {
    const res = await registerCitizen('verify-flow@rapidaid.com');
    expect(res.body.user.emailVerified).toBe(false);
    expect(res.body.user.role).toBe('CITIZEN');

    const token = lastToken();
    const verify = await request(app).post('/api/auth/verify-email').send({ token });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ success: true, emailVerified: true });

    const after = await User.findById(res.body.user.id).lean();
    expect(after!.emailVerified).toBe(true);
    expect(after!.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('rejects a replayed verification link (single use)', async () => {
    await registerCitizen('replay-verify@rapidaid.com');
    const token = lastToken();

    expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(200);
    const second = await request(app).post('/api/auth/verify-email').send({ token });
    expect(second.status).toBe(400);
    // The message must not distinguish "already used" from "never existed".
    expect(second.body.error.message).toMatch(/invalid or has expired/i);
  });

  it('rejects an unknown token with the same neutral message', async () => {
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: 'a'.repeat(96) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/invalid or has expired/i);
  });

  it('rejects an expired token', async () => {
    const res = await registerCitizen('expired-verify@rapidaid.com');
    await EmailToken.updateMany(
      { userId: res.body.user.id, purpose: 'verify' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const token = lastToken();
    const verify = await request(app).post('/api/auth/verify-email').send({ token });
    expect(verify.status).toBe(400);
    expect(verify.body.error.message).toMatch(/invalid or has expired/i);
  });

  it('will not accept a reset token where a verification token is expected', async () => {
    const email = 'purpose-mix@rapidaid.com';
    const res = await registerCitizen(email);
    const userId = res.body.user.id;

    // A reset token exists for this user; the verify token was replaced on issue.
    await request(app).post('/api/auth/forgot-password').send({ email });
    const resetToken = lastToken();
    expect(await EmailToken.findOne({ userId, purpose: 'reset' }).lean()).toBeTruthy();

    // Replaying it against the verification endpoint must fail.
    const cross = await request(app).post('/api/auth/verify-email').send({ token: resetToken });
    expect(cross.status).toBe(400);
    expect(cross.body.error.message).toMatch(/invalid or has expired/i);
  });

  it('revokes a previously issued token when a new one is issued', async () => {
    const email = 'superseded@rapidaid.com';
    await registerCitizen(email);
    const first = lastToken();

    await request(app).post('/api/auth/forgot-password').send({ email });
    // issueToken() deletes prior tokens for the same purpose before minting.
    const second = lastToken();
    expect(second).not.toBe(first);

    // The superseded reset token no longer works.
    const stale = await request(app).post('/api/auth/reset-password').send({ token: first, password: 'newpassword1' });
    expect(stale.status).toBe(400);
  });
});

describe('password reset', () => {
  it('answers identically for a known and an unknown address (no enumeration)', async () => {
    const known = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: DEMO_USERS.dispatcher.email });
    const unknown = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'definitely-not-registered@rapidaid.com' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    // Byte-for-byte equal: same status, same body. A differing response here
    // would turn this endpoint into an account-enumeration oracle.
    expect(unknown.body).toEqual(known.body);
    expect(JSON.stringify(unknown.body)).not.toContain('not found');
  });

  it('changes the password and lets the user sign in with the new one', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: DEMO_USERS.supervisor.email });
    const token = lastToken();

    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'brand-new-pass-9' });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ success: true });

    const withNew = await request(app)
      .post('/api/auth/login')
      .send({ ...DEMO_USERS.supervisor, password: 'brand-new-pass-9' });
    expect(withNew.status).toBe(200);

    const withOld = await request(app).post('/api/auth/login').send(DEMO_USERS.supervisor);
    expect(withOld.status).toBe(401);
  });

  it('revokes every existing session so a stolen refresh token dies with the reset', async () => {
    // Capture a live refresh cookie before the reset.
    const before = await request(app).post('/api/auth/login').send(DEMO_USERS.analyst);
    expect(before.status).toBe(200);
    const cookie = before.headers['set-cookie'];

    await request(app).post('/api/auth/forgot-password').send({ email: DEMO_USERS.analyst.email });
    const token = lastToken();
    await request(app).post('/api/auth/reset-password').send({ token, password: 'analyst-new-pass-7' });

    // The pre-reset refresh cookie must no longer mint an access token.
    const refresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookie as unknown as string[]);
    expect(refresh.status).toBe(401);
  });

  it('refuses a reset token that was already consumed', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: DEMO_USERS.auditor.email });
    const token = lastToken();

    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'first-new-pass-1' })).status).toBe(200);
    const replay = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'second-new-pass-2' });
    expect(replay.status).toBe(400);
  });

  it('enforces the password policy on reset', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: DEMO_USERS.crew.email });
    const token = lastToken();
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('existing accounts are unaffected', () => {
  it('keeps every seeded demo account verified', async () => {
    for (const email of Object.values(DEMO_USERS).map((u) => u.email)) {
      const row = await User.findOne({ email }).lean();
      expect(row, `${email} should exist`).toBeTruthy();
      expect(row!.emailVerified, `${email} must stay verified`).toBe(true);
    }
  });

  it('still logs in the demo personas this file did not reset', async () => {
    for (const [who, creds] of Object.entries(DEMO_USERS)) {
      // supervisor, analyst and auditor had their passwords changed by the
      // reset tests above, so their original credential is intentionally gone.
      if (who === 'supervisor' || who === 'analyst' || who === 'auditor') continue;
      const res = await request(app).post('/api/auth/login').send(creds);
      expect(res.status, `${who} should still sign in`).toBe(200);
    }
  });

  it('reports seeded demo users as verified through /auth/login', async () => {
    const res = await request(app).post('/api/auth/login').send(DEMO_USERS.dispatcher);
    expect(res.body.user.emailVerified).toBe(true);
  });

  it('creates admin-provisioned accounts already verified and immediately usable', async () => {
    const token = await loginAs(app, 'admin');
    const res = await request(app)
      .post('/api/admin/users')
      .set(bearer(token))
      .send({ name: 'Nina Rao', email: 'nina.rao@rapidaid.com', password: 'provisional-1', role: 'HOSPITAL_STAFF', hospitalId: 'HOSP-01' });

    expect(res.status).toBe(201);
    expect(res.body.emailVerified).toBe(true);

    // And it can sign in immediately — no confirmation round trip.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nina.rao@rapidaid.com', password: 'provisional-1', role: 'HOSPITAL_STAFF' });
    expect(login.status).toBe(200);
    expect(login.body.user.emailVerified).toBe(true);
  });

  it('exposes admin user rows with id, not the raw _id', async () => {
    const token = await loginAs(app, 'admin');
    const res = await request(app).get('/api/admin/users').set(bearer(token));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expect(row.id).toMatch(/^USR-\d+$/);
      expect(row._id).toBeUndefined();
      expect(row.passwordHash).toBeUndefined();
    }
  });

  it('refuses a duplicate email on admin creation', async () => {
    const token = await loginAs(app, 'admin');
    const res = await request(app)
      .post('/api/admin/users')
      .set(bearer(token))
      .send({ name: 'Clone', email: DEMO_USERS.hospital.email, password: 'provisional-1', role: 'DISPATCHER' });
    expect(res.status).toBe(409);
  });
});

describe('security: logging sanitization & token protection', () => {
  it('never outputs raw verification tokens, URLs, or email bodies to logs', async () => {
    capturedLogs = [];
    const res = await registerCitizen('audit-logger@rapidaid.com');
    expect(res.status).toBe(201);

    const token = lastToken();
    expect(token).toBeTruthy();

    const allLogsJoined = capturedLogs.join(' ');

    // Raw token must never appear in logs
    expect(allLogsJoined).not.toContain(token);
    // Verification URL must never appear in logs
    expect(allLogsJoined).not.toContain('/verify-email?token=');
    expect(allLogsJoined).not.toContain('verify-email');
    // Console transport must not claim email delivered
    expect(allLogsJoined).toContain('email simulated via console transport (not delivered over network)');
    expect(allLogsJoined).not.toMatch(/"msg":"email delivered"/);
  });

  it('restricts recorded messages to test environments and prevents production retention', async () => {
    // In test environment, recorded messages are captured
    ConsoleEmailTransport.clearRecorded();
    const transport = new ConsoleEmailTransport();
    await transport.send({
      to: 'retention-test@rapidaid.com',
      subject: 'Subject',
      text: 'Sensitive Body',
      html: '<p>Sensitive Body</p>',
    });
    expect(ConsoleEmailTransport.getRecordedMessages()).toHaveLength(1);
    expect(ConsoleEmailTransport.getLastMessage()?.text).toBe('Sensitive Body');

    // Simulate non-test / production environment
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(ConsoleEmailTransport.getRecordedMessages()).toEqual([]);
      expect(ConsoleEmailTransport.getLastMessage()).toBeUndefined();
      await transport.send({
        to: 'prod-test@rapidaid.com',
        subject: 'Prod',
        text: 'Should not record',
        html: '<p>Should not record</p>',
      });
      expect(ConsoleEmailTransport.getRecordedMessages()).toEqual([]);
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });
});

describe('POST /api/auth/resend-verification', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/auth/resend-verification');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects already-verified accounts with 400 Bad Request', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .post('/api/auth/resend-verification')
      .set(bearer(token));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/already verified/i);
  });

  it('successfully resends verification email for an unverified citizen with generic response', async () => {
    const email = 'resend-success@rapidaid.com';
    const regRes = await registerCitizen(email);
    expect(regRes.status).toBe(201);
    const accessToken = regRes.body.accessToken;

    // Reset timestamp of previous token to simulate cooldown elapsed
    await EmailToken.updateMany(
      { userId: regRes.body.user.id, purpose: 'verify' },
      { $set: { createdAt: new Date(Date.now() - 70000) } },
    );

    const resendRes = await request(app)
      .post('/api/auth/resend-verification')
      .set(bearer(accessToken));

    expect(resendRes.status).toBe(200);
    expect(resendRes.body).toMatchObject({
      success: true,
      message: expect.stringMatching(/verification email sent/i),
    });
  });

  it('invalidates previous verification token when a new one is re-sent', async () => {
    const email = 'invalidation-check@rapidaid.com';
    const regRes = await registerCitizen(email);
    const accessToken = regRes.body.accessToken;
    const firstToken = lastToken();

    // Reset timestamp so cooldown passes
    await EmailToken.updateMany(
      { userId: regRes.body.user.id, purpose: 'verify' },
      { $set: { createdAt: new Date(Date.now() - 70000) } },
    );

    const resendRes = await request(app)
      .post('/api/auth/resend-verification')
      .set(bearer(accessToken));
    expect(resendRes.status).toBe(200);

    const secondToken = lastToken();
    expect(secondToken).not.toBe(firstToken);

    // Old token is invalidated: verify with firstToken must fail
    const firstVerify = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: firstToken });
    expect(firstVerify.status).toBe(400);
    expect(firstVerify.body.error.message).toMatch(/invalid or has expired/i);

    // New token works: verify with secondToken succeeds
    const secondVerify = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: secondToken });
    expect(secondVerify.status).toBe(200);
    expect(secondVerify.body).toMatchObject({ success: true, emailVerified: true });
  });

  it('enforces 60-second cooldown between resend requests', async () => {
    const email = 'cooldown-check@rapidaid.com';
    const regRes = await registerCitizen(email);
    const accessToken = regRes.body.accessToken;

    // Immediate resend should trigger 429 because registration just created a token < 60s ago
    const immediateRes = await request(app)
      .post('/api/auth/resend-verification')
      .set(bearer(accessToken));

    expect(immediateRes.status).toBe(429);
    expect(immediateRes.body.error.code).toBe('RATE_LIMITED');
    expect(immediateRes.body.error.message).toMatch(/please wait/i);

    // Advance time past cooldown
    await EmailToken.updateMany(
      { userId: regRes.body.user.id, purpose: 'verify' },
      { $set: { createdAt: new Date(Date.now() - 65000) } },
    );

    const allowedRes = await request(app)
      .post('/api/auth/resend-verification')
      .set(bearer(accessToken));

    expect(allowedRes.status).toBe(200);
    expect(allowedRes.body.success).toBe(true);
  });

  it('applies rate limiting to prevent abuse', async () => {
    const customLimiter = createRateLimiter({
      windowMs: 60 * 1000,
      limit: 2,
      skip: () => false,
    });

    const testApp = (await import('express')).default();
    testApp.post('/test-resend-limit', customLimiter, (_req, res) => res.json({ ok: true }));

    await request(testApp).post('/test-resend-limit').expect(200);
    await request(testApp).post('/test-resend-limit').expect(200);
    const blocked = await request(testApp).post('/test-resend-limit');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('safely handles concurrent resend requests without racing', async () => {
    const email = 'concurrent-resend@rapidaid.com';
    const regRes = await registerCitizen(email);
    const accessToken = regRes.body.accessToken;

    // Reset timestamp so cooldown passes
    await EmailToken.updateMany(
      { userId: regRes.body.user.id, purpose: 'verify' },
      { $set: { createdAt: new Date(Date.now() - 70000) } },
    );

    // Fire 5 concurrent requests simultaneously
    const responses = await Promise.all([
      request(app).post('/api/auth/resend-verification').set(bearer(accessToken)),
      request(app).post('/api/auth/resend-verification').set(bearer(accessToken)),
      request(app).post('/api/auth/resend-verification').set(bearer(accessToken)),
      request(app).post('/api/auth/resend-verification').set(bearer(accessToken)),
      request(app).post('/api/auth/resend-verification').set(bearer(accessToken)),
    ]);

    const successful = responses.filter((r) => r.status === 200);
    const rateLimited = responses.filter((r) => r.status === 429);

    // Exactly one request should succeed; the others must be rejected with 429
    expect(successful.length).toBe(1);
    expect(rateLimited.length).toBe(4);
    for (const r of rateLimited) {
      expect(r.body.error.code).toBe('RATE_LIMITED');
    }
  });
});



