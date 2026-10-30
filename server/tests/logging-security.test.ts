import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createLogger, REDACTED_VALUE } from '../src/config/logger.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { DEMO_USERS, bearer, loginAs } from './helpers.js';

useTestDatabase(runSeed);

interface LogEntry {
  level: number;
  time: number;
  msg?: string;
  requestId?: string;
  path?: string;
  method?: string;
  responseTime?: number;
  req?: {
    id?: string;
    method?: string;
    url?: string;
    headers?: Record<string, unknown>;
    remoteAddress?: string;
    body?: unknown;
  };
  res?: {
    statusCode?: number;
    headers?: Record<string, unknown>;
  };
  headers?: Record<string, unknown>;
  err?: {
    type?: string;
    message?: string;
    stack?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

describe('Phase 4.2: Logging Security & Sensitive Data Redaction', () => {
  let capturedLogs: LogEntry[] = [];
  let testLogger: ReturnType<typeof createLogger>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    capturedLogs = [];
    testLogger = createLogger(
      { level: 'info' },
      {
        write(str: string) {
          try {
            capturedLogs.push(JSON.parse(str));
          } catch {
            // Ignore non-json chunk if any
          }
        },
      },
    );
    app = createApp({ logger: testLogger, autoLogging: true });
  });

  const getCombinedLogText = (): string => JSON.stringify(capturedLogs);

  // ── 1. Authorization headers are redacted ──────────────────────────────
  it('1. redacts Authorization and proxy authorization headers in HTTP request logs', async () => {
    const canaryAuth = 'CANARY_AUTH_SECRET_JWT_7719283';
    const canaryProxy = 'CANARY_PROXY_AUTH_PASS_992817';

    const res = await request(app)
      .get('/healthz')
      .set('Authorization', `Bearer ${canaryAuth}`)
      .set('Proxy-Authorization', `Basic ${canaryProxy}`);

    expect(res.status).toBe(200);

    const logText = getCombinedLogText();
    expect(logText).not.toContain(canaryAuth);
    expect(logText).not.toContain(canaryProxy);

    const httpLog = capturedLogs.find((l) => l.req?.url?.includes('/healthz'));
    expect(httpLog).toBeDefined();
    expect(httpLog?.req?.headers?.authorization).toBe(REDACTED_VALUE);
    expect(httpLog?.req?.headers?.['proxy-authorization']).toBe(REDACTED_VALUE);
  });

  // ── 2. Cookie and Set-Cookie values are not exposed ────────────────────
  it('2. redacts Cookie request headers and Set-Cookie response headers', async () => {
    const canaryCookie = 'CANARY_SESSION_COOKIE_VALUE_338192';

    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('Cookie', `refreshToken=${canaryCookie}`)
      .send(DEMO_USERS.dispatcher);

    expect(loginRes.status).toBe(200);
    // Login sets refreshToken in Set-Cookie
    expect(loginRes.headers['set-cookie']).toBeDefined();

    const logText = getCombinedLogText();
    expect(logText).not.toContain(canaryCookie);

    // Verify Set-Cookie is redacted in logs
    const loginHttpLog = capturedLogs.find((l) => l.res?.headers?.['set-cookie']);
    expect(loginHttpLog).toBeDefined();
    expect(loginHttpLog?.res?.headers?.['set-cookie']).toBe(REDACTED_VALUE);
    expect(loginHttpLog?.req?.headers?.cookie).toBe(REDACTED_VALUE);
  });

  // ── 3. Passwords and password-reset or verification tokens are redacted ─
  it('3. redacts passwords, password-reset tokens, and verification tokens', async () => {
    const canaryPassword = 'CANARY_SECRET_PASSWORD_987654';
    const canaryToken = 'CANARY_RESET_TOKEN_ALPHA_BETA_123';
    const canaryQueryToken = 'CANARY_QUERY_PARAM_TOKEN_998877';

    // Application level logger
    testLogger.info(
      {
        password: canaryPassword,
        token: canaryToken,
        resetToken: 'CANARY_RESET_TOKEN_STANDALONE',
        verificationToken: 'CANARY_VERIFICATION_TOKEN_STANDALONE',
      },
      'credential log test',
    );

    // HTTP level request with credential in query
    await request(app).get(`/healthz?token=${canaryQueryToken}&safeParam=safeValue`);

    const logText = getCombinedLogText();
    expect(logText).not.toContain(canaryPassword);
    expect(logText).not.toContain(canaryToken);
    expect(logText).not.toContain('CANARY_RESET_TOKEN_STANDALONE');
    expect(logText).not.toContain('CANARY_VERIFICATION_TOKEN_STANDALONE');
    expect(logText).not.toContain(canaryQueryToken);

    const queryLog = capturedLogs.find((l) => l.req?.url?.includes('/healthz'));
    expect(queryLog?.req?.url).toContain('token=[REDACTED]');
    expect(queryLog?.req?.url).toContain('safeParam=safeValue');
  });

  // ── 4. Sensitive request-body fields are not logged ────────────────────
  it('4. ensures sensitive request-body fields are not logged', async () => {
    const canaryBodyPassword = 'CANARY_RAW_BODY_PASSWORD_554433';
    const canaryBodyEmail = 'canary_sensitive_user@rapidaid.test';

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: canaryBodyEmail, password: canaryBodyBodyPassword(canaryBodyPassword), role: 'CITIZEN' });

    expect(res.status).toBe(401);

    const logText = getCombinedLogText();
    expect(logText).not.toContain(canaryBodyPassword);

    // Verify req in HTTP log does not contain un-redacted body
    const httpLog = capturedLogs.find((l) => l.req?.url?.includes('/api/auth/login'));
    expect(httpLog).toBeDefined();
    expect(httpLog?.req?.body).toBeUndefined();
  });

  function canaryBodyBodyPassword(val: string): string {
    return val;
  }

  // ── 5. Patient contact information and emergency descriptions are not exposed ──
  it('5. does not expose patient names, phone numbers, email addresses, or emergency descriptions', async () => {
    const canaryPatientName = 'CANARY_PATIENT_JANE_DOE_71829';
    const canaryPhone = 'CANARY_PHONE_NUMBER_555_0199';
    const canaryEmergencyDesc = 'CANARY_EMERGENCY_DESCRIPTION_SEVERE_TRAUMA';
    const canaryMedicalNotes = 'CANARY_MEDICAL_NOTES_PATIENT_ALLERGIES';

    testLogger.info(
      {
        patientName: canaryPatientName,
        phone: canaryPhone,
        phoneNumber: canaryPhone,
        callerPhone: canaryPhone,
        patientPhone: canaryPhone,
        description: canaryEmergencyDesc,
        medicalNotes: canaryMedicalNotes,
        email: 'canary_patient_direct_email@rapidaid.test',
      },
      'patient and clinical information',
    );

    const logText = getCombinedLogText();
    expect(logText).not.toContain(canaryPatientName);
    expect(logText).not.toContain(canaryPhone);
    expect(logText).not.toContain(canaryEmergencyDesc);
    expect(logText).not.toContain(canaryMedicalNotes);
    expect(logText).not.toContain('canary_patient_direct_email@rapidaid.test');
  });

  // ── 6. Voice-report payloads and transcription text are not exposed ───
  it('6. does not expose voice-report payloads, audio data URLs, and transcription text', async () => {
    const canaryTranscript = 'CANARY_VOICE_TRANSCRIPTION_SPOKEN_CALLER_WORDS';
    const canaryDataUrl = 'data:audio/webm;base64,CANARY_AUDIO_BINARY_BYTES_ENCODED';
    const canarySpokenLocation = 'CANARY_SPOKEN_LOCATION_NEAR_LANDMARK';

    testLogger.info(
      {
        transcript: canaryTranscript,
        clientTranscript: canaryTranscript,
        rawTranscript: canaryTranscript,
        dataUrl: canaryDataUrl,
        spokenLocation: canarySpokenLocation,
      },
      'voice event payload',
    );

    const logText = getCombinedLogText();
    expect(logText).not.toContain(canaryTranscript);
    expect(logText).not.toContain(canaryDataUrl);
    expect(logText).not.toContain(canarySpokenLocation);
  });

  // ── 7. Nested sensitive fields are handled correctly ──────────────────
  it('7. redacts nested sensitive fields inside arbitrary object hierarchies', async () => {
    const canaryNestedSecret = 'CANARY_NESTED_SECRET_AT_DEPTH_4';
    const canaryNestedPhone = 'CANARY_NESTED_PHONE_AT_DEPTH_3';

    testLogger.info(
      {
        level1: {
          level2: {
            level3: {
              password: canaryNestedSecret,
              phone: canaryNestedPhone,
              safeOperationalId: 'AMB-101',
            },
          },
        },
      },
      'nested object test',
    );

    const logText = getCombinedLogText();
    expect(logText).not.toContain(canaryNestedSecret);
    expect(logText).not.toContain(canaryNestedPhone);
    expect(logText).toContain('AMB-101');
  });

  // ── 8. Sensitive values embedded in error metadata or messages ────────
  it('8. sanitizes database connection strings and embedded secrets in error messages and metadata', async () => {
    const canaryDbPassword = 'CANARY_DB_SECRET_PASSWORD_12345';
    const canaryErrToken = 'CANARY_ERR_METADATA_TOKEN_67890';

    const errorWithSecret = new Error(
      `MongoDB connection to mongodb://rapidaid_admin:${canaryDbPassword}@cluster0.mongodb.net:27017/rapidaid failed`,
    );
    (errorWithSecret as unknown as { token?: string; keyValue?: Record<string, unknown> }).token = canaryErrToken;
    (errorWithSecret as unknown as { keyValue?: Record<string, unknown> }).keyValue = { email: 'leak@rapidaid.test' };

    testLogger.error({ err: errorWithSecret }, 'database connection failure');

    const logText = getCombinedLogText();
    expect(logText).not.toContain(canaryDbPassword);
    expect(logText).not.toContain(canaryErrToken);
    expect(logText).not.toContain('leak@rapidaid.test');

    const errorLog = capturedLogs.find((l) => l.err?.message?.includes('mongodb://rapidaid_admin:[REDACTED]@'));
    expect(errorLog).toBeDefined();
    expect(errorLog?.err?.message).toContain('mongodb://rapidaid_admin:[REDACTED]@');
  });

  // ── 9. Successful and failed HTTP requests retain useful operational metadata ──
  it('9. retains useful operational diagnostics on success and failure without sensitive values', async () => {
    const successRes = await request(app).get('/healthz');
    expect(successRes.status).toBe(200);

    const failRes = await request(app).get('/api/not-a-real-endpoint');
    expect(failRes.status).toBe(404);

    const successLog = capturedLogs.find((l) => l.req?.url === '/healthz');
    expect(successLog).toBeDefined();
    expect(successLog?.req?.method).toBe('GET');
    expect(successLog?.res?.statusCode).toBe(200);
    expect(typeof successLog?.responseTime).toBe('number');

    const failLog = capturedLogs.find((l) => l.req?.url === '/api/not-a-real-endpoint');
    expect(failLog).toBeDefined();
    expect(failLog?.req?.method).toBe('GET');
    expect(failLog?.res?.statusCode).toBe(404);
    expect(typeof failLog?.responseTime).toBe('number');
  });

  // ── 10. Existing safe request correlation and error diagnostics remain available ─
  it('10. preserves correlation requestId and safe error classifications', async () => {
    const canaryRequestId = 'CANARY_CORR_REQ_ID_998877';

    const res = await request(app)
      .get('/api/not-a-real-endpoint')
      .set('X-Request-Id', canaryRequestId);

    expect(res.status).toBe(404);
    expect(res.body.error.requestId).toBe(canaryRequestId);
    expect(res.body.error.code).toBe('NOT_FOUND');

    const log = capturedLogs.find((l) => l.req?.id === canaryRequestId);
    expect(log).toBeDefined();
    expect(log?.req?.id).toBe(canaryRequestId);
  });

  // ── 11. Application-level logger calls and HTTP middleware use compatible redaction ──
  it('11. enforces compatible redaction behavior across application logger and HTTP middleware', async () => {
    const canaryAuth = 'CANARY_COMPAT_AUTH_TOKEN_112233';

    // Application-level log
    testLogger.info({ headers: { authorization: `Bearer ${canaryAuth}` } }, 'app level log');

    // HTTP middleware log
    await request(app).get('/healthz').set('Authorization', `Bearer ${canaryAuth}`);

    const logText = getCombinedLogText();
    expect(logText).not.toContain(canaryAuth);

    const appLog = capturedLogs.find((l) => l.msg === 'app level log');
    expect(appLog?.headers?.authorization).toBe(REDACTED_VALUE);

    const httpLog = capturedLogs.find((l) => l.req?.url === '/healthz');
    expect(httpLog?.req?.headers?.authorization).toBe(REDACTED_VALUE);
  });

  // ── 12. Redaction does not alter application request data or break processing ──
  it('12. ensures redaction does not mutate request bodies or break authentication and emergency workflows', async () => {
    // Authenticate with valid dispatcher credentials
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: DEMO_USERS.dispatcher.email,
        password: DEMO_USERS.dispatcher.password,
        role: 'DISPATCHER',
      });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.email).toBe(DEMO_USERS.dispatcher.email);
    expect(loginRes.body.accessToken).toBeDefined();

    // Verify token can be used for protected dispatch query
    const token = await loginAs(app, 'dispatcher');
    const ambulancesRes = await request(app)
      .get('/api/ambulances')
      .set(bearer(token));

    expect(ambulancesRes.status).toBe(200);
    expect(Array.isArray(ambulancesRes.body)).toBe(true);

    // Verify logs were emitted and did NOT leak the actual password
    const logText = getCombinedLogText();
    expect(logText).not.toContain(DEMO_USERS.dispatcher.password);
  });
});
