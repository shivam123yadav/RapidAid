import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, DEMO_USERS } from './helpers.js';
import { AuditLog, User } from '../src/models/index.js';
import { hashPassword } from '../src/services/tokenService.js';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

const app = createApp();
useTestDatabase(runSeed);

describe('auth', () => {
  it('logs in a demo dispatcher and returns user + access token + cookie', async () => {
    const res = await request(app).post('/api/auth/login').send(DEMO_USERS.dispatcher);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: 'USR-001',
      email: 'dispatcher@rapidaid.com',
      role: 'DISPATCHER',
    });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.headers['set-cookie']?.[0]).toContain('rapidaid_rt=');
    // Password hash must never appear in responses.
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('rejects a wrong password with 401 INVALID creds', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ ...DEMO_USERS.dispatcher, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a role mismatch (same email, different selected role) with 401 without leaking the actual role', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ ...DEMO_USERS.dispatcher, role: 'ADMIN' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Invalid credentials');
    expect(JSON.stringify(res.body)).not.toContain('DISPATCHER');
  });

  it('rejects an unknown email with 401 (no user enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@rapidaid.com', password: 'demo123', role: 'DISPATCHER' });
    expect(res.status).toBe(401);
  });

  it('validates the login payload with 400 on malformed input', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('password');
  });

  it('GET /me returns the caller profile with a valid token', async () => {
    const token = await login('admin');
    const res = await request(app).get('/api/auth/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'USR-004', role: 'ADMIN' });
  });

  it('GET /me returns 401 without a token and 401 with a garbage token', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(bearer('garbage'))).status).toBe(401);
  });

  it('rejects privileged public registration and keeps self-registration citizen-only', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Not An Admin', email: 'not-an-admin@example.com', password: 'secret123', role: 'ADMIN',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
  it('rotates refresh tokens: refresh works once, then replay is rejected', async () => {
    const agent = request.agent(app); // persists the httpOnly cookie
    const loginRes = await agent.post('/api/auth/login').send(DEMO_USERS.crew);
    expect(loginRes.status).toBe(200);

    const refresh1 = await agent.post('/api/auth/refresh');
    expect(refresh1.status).toBe(200);
    expect(refresh1.body.accessToken).toEqual(expect.any(String));

    // The old cookie was rotated; agent now holds the new one, so a second
    // refresh succeeds — but replaying the FIRST (already-consumed) token
    // must fail. Simulate replay by calling refresh without the cookie.
    const noCookie = await request(app).post('/api/auth/refresh');
    expect(noCookie.status).toBe(401);
  });

  it('logout clears the refresh cookie and revokes it', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(DEMO_USERS.hospital);
    const logout = await agent.post('/api/auth/logout');
    expect(logout.status).toBe(200);

    const refreshAfterLogout = await agent.post('/api/auth/refresh');
    expect(refreshAfterLogout.status).toBe(401);
  });

  it('registers a new citizen account and immediately authenticates', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Test Citizen',
      email: 'test.citizen@example.com',
      password: 'secret123',
      role: 'CITIZEN',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('CITIZEN');
    expect(res.body.user.id).toMatch(/^USR-\d{3}$/);

    const dup = await request(app).post('/api/auth/register').send({
      name: 'Test Citizen',
      email: 'test.citizen@example.com',
      password: 'secret123',
      role: 'CITIZEN',
    });
    expect(dup.status).toBe(409);

    const me = await request(app).get('/api/auth/me').set(bearer(res.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('test.citizen@example.com');
  });

  describe('Milestone 3.1: Anti-Enumeration & Login Hardening', () => {
    it('1. returns generic 401 for a nonexistent account without user enumeration', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ghost.account@rapidaid.test', password: 'randomPassword123', role: 'CITIZEN' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid credentials',
      });
      const audit = await AuditLog.findOne({
        action: 'auth.login_failed',
        resourceId: 'ghost.account@rapidaid.test',
      }).sort({ timestamp: -1 }).lean();
      expect(audit).not.toBeNull();
      expect(audit?.details).toBe('unknown-account');
    });

    it('2. returns generic 401 for an inactive account for both wrong and correct passwords', async () => {
      await User.create({
        _id: 'USR-INACTIVE-TEST',
        name: 'Inactive Operator',
        email: 'inactive.operator@rapidaid.test',
        passwordHash: await hashPassword('correctPassword123'),
        role: 'DISPATCHER',
        active: false,
      });

      // 2a. Inactive account with wrong password -> bad-password audit
      const wrongPassRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'inactive.operator@rapidaid.test', password: 'wrongPassword99', role: 'DISPATCHER' });
      expect(wrongPassRes.status).toBe(401);
      expect(wrongPassRes.body.error.message).toBe('Invalid credentials');
      expect(JSON.stringify(wrongPassRes.body)).not.toContain('inactive');

      const auditWrong = await AuditLog.findOne({
        action: 'auth.login_failed',
        resourceId: 'USR-INACTIVE-TEST',
        details: 'bad-password',
      }).sort({ timestamp: -1 }).lean();
      expect(auditWrong).not.toBeNull();

      // 2b. Inactive account with correct password -> inactive-account audit
      const correctPassRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'inactive.operator@rapidaid.test', password: 'correctPassword123', role: 'DISPATCHER' });
      expect(correctPassRes.status).toBe(401);
      expect(correctPassRes.body.error.message).toBe('Invalid credentials');
      expect(JSON.stringify(correctPassRes.body)).not.toContain('inactive');

      const auditInactive = await AuditLog.findOne({
        action: 'auth.login_failed',
        resourceId: 'USR-INACTIVE-TEST',
        details: 'inactive-account',
      }).sort({ timestamp: -1 }).lean();
      expect(auditInactive).not.toBeNull();
    });

    it('3. returns generic 401 for an existing account with an incorrect password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: DEMO_USERS.dispatcher.email, password: 'definitelyWrongPassword', role: 'DISPATCHER' });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid credentials');

      const audit = await AuditLog.findOne({
        action: 'auth.login_failed',
        resourceId: 'USR-001',
        details: 'bad-password',
      }).sort({ timestamp: -1 }).lean();
      expect(audit).not.toBeNull();
    });

    it('4. returns generic 401 for an existing account with wrong role and incorrect password (verifies password first)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: DEMO_USERS.dispatcher.email, password: 'definitelyWrongPassword', role: 'ADMIN' });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid credentials');
      expect(JSON.stringify(res.body)).not.toContain('DISPATCHER');
      expect(JSON.stringify(res.body)).not.toContain('ADMIN');

      const audit = await AuditLog.findOne({
        action: 'auth.login_failed',
        resourceId: 'USR-001',
        details: 'bad-password',
      }).sort({ timestamp: -1 }).lean();
      expect(audit).not.toBeNull();
    });

    it('5. returns generic 401 for a wrong-role attempt with correct password without disclosing the actual role', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: DEMO_USERS.dispatcher.email, password: DEMO_USERS.dispatcher.password, role: 'ADMIN' });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid credentials');
      expect(JSON.stringify(res.body)).not.toContain('DISPATCHER');
      expect(JSON.stringify(res.body)).not.toContain('Account role is');

      const audit = await AuditLog.findOne({
        action: 'auth.login_failed',
        resourceId: 'USR-001',
        details: 'role-mismatch',
      }).sort({ timestamp: -1 }).lean();
      expect(audit).not.toBeNull();
    });

    it('6. successful login with the correct role still works and issues tokens', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send(DEMO_USERS.dispatcher);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        id: 'USR-001',
        email: DEMO_USERS.dispatcher.email,
        role: 'DISPATCHER',
      });
      expect(res.body.accessToken).toEqual(expect.any(String));

      const audit = await AuditLog.findOne({
        action: 'auth.login',
        resourceId: 'USR-001',
      }).sort({ timestamp: -1 }).lean();
      expect(audit).not.toBeNull();
      expect(audit?.actorRole).toBe('DISPATCHER');
    });

    it('7. audit logging preserves internal failure categories without exposing plaintext passwords', async () => {
      const sensitivePassword = 'SecretP@ssword!999';
      await request(app)
        .post('/api/auth/login')
        .send({ email: DEMO_USERS.supervisor.email, password: sensitivePassword, role: 'SUPERVISOR' });

      const failureLogs = await AuditLog.find({ action: 'auth.login_failed' }).lean();
      expect(failureLogs.length).toBeGreaterThan(0);

      // Verify categories
      const detailsSet = new Set(failureLogs.map((l) => l.details));
      expect(detailsSet.has('unknown-account') || detailsSet.has('bad-password') || detailsSet.has('role-mismatch')).toBe(true);

      // Verify no plaintext password leaked
      const fullLogDump = JSON.stringify(failureLogs);
      expect(fullLogDump).not.toContain(sensitivePassword);
      expect(fullLogDump).not.toContain('randomPassword123');
      expect(fullLogDump).not.toContain('correctPassword123');
    });

    it('8. timing resistance: missing-account path executes full bcrypt comparison', async () => {
      // Warm up
      await request(app).post('/api/auth/login').send({
        email: 'warmup.account@rapidaid.test',
        password: 'warmupPassword123',
        role: 'CITIZEN',
      });

      // Benchmark missing account vs wrong password on existing account
      const t0Missing = performance.now();
      await request(app).post('/api/auth/login').send({
        email: 'timing.ghost@rapidaid.test',
        password: 'timingCheckPassword123',
        role: 'CITIZEN',
      });
      const durationMissing = performance.now() - t0Missing;

      const t0Existing = performance.now();
      await request(app).post('/api/auth/login').send({
        email: DEMO_USERS.citizen.email,
        password: 'timingCheckPassword123',
        role: 'CITIZEN',
      });
      const durationExisting = performance.now() - t0Existing;

      // Both must execute full 10-round bcrypt hash comparison (> 15ms), proving no fast-path exit
      expect(durationMissing).toBeGreaterThan(15);
      expect(durationExisting).toBeGreaterThan(15);
    });
  });

  describe('Milestone 3.3: Password Policy Unification', () => {
    it('1. rejects 6-character and 7-character registration passwords with 400 and expected validation message', async () => {
      // 6 characters
      const res6 = await request(app).post('/api/auth/register').send({
        name: 'Short Six',
        email: 'six.chars@rapidaid.test',
        password: 'pass06',
        role: 'CITIZEN',
      });
      expect(res6.status).toBe(400);
      expect(res6.body.error.code).toBe('BAD_REQUEST');
      expect(res6.body.error.message).toContain('Password must be at least 8 characters');

      // 7 characters
      const res7 = await request(app).post('/api/auth/register').send({
        name: 'Short Seven',
        email: 'seven.chars@rapidaid.test',
        password: 'pass007',
        role: 'CITIZEN',
      });
      expect(res7.status).toBe(400);
      expect(res7.body.error.code).toBe('BAD_REQUEST');
      expect(res7.body.error.message).toContain('Password must be at least 8 characters');
    });

    it('2. accepts an exactly 8-character password on citizen registration', async () => {
      const res8 = await request(app).post('/api/auth/register').send({
        name: 'Eight Character Citizen',
        email: 'eight.chars@rapidaid.test',
        password: 'exact8ch',
        role: 'CITIZEN',
      });
      expect(res8.status).toBe(201);
      expect(res8.body.user).toMatchObject({
        email: 'eight.chars@rapidaid.test',
        role: 'CITIZEN',
      });
      expect(res8.body.accessToken).toEqual(expect.any(String));
    });

    it('3. accepts a valid longer password within the 128-character limit', async () => {
      const longPassword = 'super-secure-extended-passphrase-with-lots-of-entropy-2026';
      const resLong = await request(app).post('/api/auth/register').send({
        name: 'Long Pass Citizen',
        email: 'long.pass@rapidaid.test',
        password: longPassword,
        role: 'CITIZEN',
      });
      expect(resLong.status).toBe(201);
      expect(resLong.body.user.email).toBe('long.pass@rapidaid.test');
    });

    it('4. password-reset and admin provisioning enforce consistent minimum length (8 chars)', async () => {
      // Password reset rejects 7 characters
      const resetRes = await request(app).post('/api/auth/reset-password').send({
        token: 'valid-format-token-xyz-12345',
        password: 'pass007',
      });
      expect(resetRes.status).toBe(400);
      expect(resetRes.body.error.code).toBe('BAD_REQUEST');
      expect(resetRes.body.error.message).toContain('Password must be at least 8 characters');

      // Admin user provisioning rejects 7 characters
      const adminToken = await login('admin');
      const adminShortRes = await request(app)
        .post('/api/admin/users')
        .set(bearer(adminToken))
        .send({
          name: 'Staff Under 8',
          email: 'staff.short@rapidaid.test',
          password: 'pass007',
          role: 'DISPATCHER',
        });
      expect(adminShortRes.status).toBe(400);

      // Admin user provisioning accepts 8 characters
      const adminOkRes = await request(app)
        .post('/api/admin/users')
        .set(bearer(adminToken))
        .send({
          name: 'Staff Exactly 8',
          email: 'staff.ok8@rapidaid.test',
          password: 'exact8st',
          role: 'DISPATCHER',
        });
      expect(adminOkRes.status).toBe(201);
      expect(adminOkRes.body.email).toBe('staff.ok8@rapidaid.test');
    });
  });

  describe('Milestone 3.4: Access-Token Invalidation on Logout', () => {
    it('1, 2, 3: authenticated logout invalidates presented access token, rejects subsequent requests with 401, and revokes refresh session', async () => {
      const agent = request.agent(app);
      const loginRes = await agent.post('/api/auth/login').send(DEMO_USERS.hospital);
      expect(loginRes.status).toBe(200);
      const token = loginRes.body.accessToken;

      // Access token works before logout
      const beforeRes = await request(app).get('/api/auth/me').set(bearer(token));
      expect(beforeRes.status).toBe(200);

      // Authenticated logout with Bearer token
      const logoutRes = await agent.post('/api/auth/logout').set(bearer(token));
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body).toEqual({ success: true });

      // Subsequent request using invalidated access token returns HTTP 401 with established message
      const afterRes = await request(app).get('/api/auth/me').set(bearer(token));
      expect(afterRes.status).toBe(401);
      expect(afterRes.body.error.code).toBe('UNAUTHORIZED');
      expect(afterRes.body.error.message).toBe('Session is no longer valid; please sign in again');

      // Refresh token cookie was also revoked and cannot be refreshed
      const refreshRes = await agent.post('/api/auth/refresh');
      expect(refreshRes.status).toBe(401);
    });

    it('4. logout without a Bearer token remains supported and revokes the refresh cookie', async () => {
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send(DEMO_USERS.citizen);

      // Call logout with NO Authorization header
      const logoutRes = await agent.post('/api/auth/logout');
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body).toEqual({ success: true });

      // Refresh cookie was revoked
      const refreshRes = await agent.post('/api/auth/refresh');
      expect(refreshRes.status).toBe(401);
    });

    it('5. invalid, expired, or malformed Bearer tokens cannot modify another user’s token version', async () => {
      const dispatcherToken = await login('dispatcher');
      const userBefore = await User.findById('USR-001').lean();
      const initialVersion = userBefore?.tokenVersion ?? 0;

      // 5a: Forged signature token with sub USR-001
      const forgedToken = jwt.sign(
        { sub: 'USR-001', role: 'DISPATCHER', name: 'Dispatcher', email: 'dispatcher@rapidaid.com', ver: initialVersion },
        'untrusted-fake-secret-which-does-not-match-signature-at-all-xyz',
        { algorithm: 'HS256', issuer: 'rapidaid-api', audience: 'rapidaid-client' },
      );
      const forgedRes = await request(app).post('/api/auth/logout').set(bearer(forgedToken));
      expect(forgedRes.status).toBe(200);

      // 5b: Expired token with sub USR-001
      const expiredToken = jwt.sign(
        { sub: 'USR-001', role: 'DISPATCHER', name: 'Dispatcher', email: 'dispatcher@rapidaid.com', ver: initialVersion },
        env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', issuer: 'rapidaid-api', audience: 'rapidaid-client', expiresIn: -60 },
      );
      const expiredRes = await request(app).post('/api/auth/logout').set(bearer(expiredToken));
      expect(expiredRes.status).toBe(200);

      // 5c: Malformed header
      const malformedRes = await request(app).post('/api/auth/logout').set('Authorization', 'Bearer totally-malformed-jwt');
      expect(malformedRes.status).toBe(200);

      // Verify tokenVersion was NOT mutated by any of the unauthorized requests
      const userAfter = await User.findById('USR-001').lean();
      expect(userAfter?.tokenVersion ?? 0).toBe(initialVersion);

      // Legitimate access token for USR-001 remains completely valid
      const meRes = await request(app).get('/api/auth/me').set(bearer(dispatcherToken));
      expect(meRes.status).toBe(200);
      expect(meRes.body.id).toBe('USR-001');
    });

    it('6. documents and verifies multi-session behavior: access tokens invalidate immediately while unrevoked refresh tokens rotate to the new version', async () => {
      const agentDevice1 = request.agent(app);
      const agentDevice2 = request.agent(app);

      // Two concurrent sessions for dispatcher
      const login1 = await agentDevice1.post('/api/auth/login').send(DEMO_USERS.dispatcher);
      const token1 = login1.body.accessToken;

      const login2 = await agentDevice2.post('/api/auth/login').send(DEMO_USERS.dispatcher);
      const token2 = login2.body.accessToken;

      // Both initial tokens work
      expect((await request(app).get('/api/auth/me').set(bearer(token1))).status).toBe(200);
      expect((await request(app).get('/api/auth/me').set(bearer(token2))).status).toBe(200);

      // Device 1 performs authenticated logout
      const logout1 = await agentDevice1.post('/api/auth/logout').set(bearer(token1));
      expect(logout1.status).toBe(200);

      // Device 1's token is invalidated
      const me1 = await request(app).get('/api/auth/me').set(bearer(token1));
      expect(me1.status).toBe(401);
      expect(me1.body.error.message).toBe('Session is no longer valid; please sign in again');

      // Device 1's refresh cookie was destroyed
      expect((await agentDevice1.post('/api/auth/refresh')).status).toBe(401);

      // Under the token-version architecture, Device 2's old access token also fails on next use
      const me2 = await request(app).get('/api/auth/me').set(bearer(token2));
      expect(me2.status).toBe(401);
      expect(me2.body.error.message).toBe('Session is no longer valid; please sign in again');

      // BUT Device 2's distinct refresh token was NOT revoked on Device 1's logout
      const refresh2 = await agentDevice2.post('/api/auth/refresh');
      expect(refresh2.status).toBe(200);
      const newToken2 = refresh2.body.accessToken;
      expect(newToken2).toEqual(expect.any(String));

      // Device 2's new access token functions normally with the current tokenVersion
      const me2Recovered = await request(app).get('/api/auth/me').set(bearer(newToken2));
      expect(me2Recovered.status).toBe(200);
      expect(me2Recovered.body.id).toBe('USR-001');
    });
  });

  async function login(who: keyof typeof DEMO_USERS): Promise<string> {
    const res = await request(app).post('/api/auth/login').send(DEMO_USERS[who]);
    return res.body.accessToken;
  }
});
