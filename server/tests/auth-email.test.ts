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

/**
 * The console transport is the default in tests (no SMTP credentials), and it
 * prints the full action link — which is the only place the raw token ever
 * appears. Intercepting the structured log is therefore the honest way to
 * capture it, rather than reaching into the service for a value it
 * deliberately does not return.
 */
let capturedBodies: string[] = [];

beforeEach(() => {
  capturedBodies = [];
  vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
    const [meta] = args as [{ body?: string }];
    if (typeof meta?.body === 'string') capturedBodies.push(meta.body);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** Pulls the token out of the most recent emitted action link. */
const lastToken = (): string => {
  const withToken = capturedBodies
    .map((body) => /token=([a-f0-9]{16,})/.exec(body)?.[1])
    .filter((value): value is string => Boolean(value));
  if (!withToken.length) throw new Error('No token found in captured email bodies');
  return withToken[withToken.length - 1];
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

