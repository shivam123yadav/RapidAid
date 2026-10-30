import 'dotenv/config';
import { z } from 'zod';
import { isStrongScraperToken } from '../middleware/metricsAuth.js';

/**
 * Fail-fast environment validation. process.exit(1) on any missing/invalid
 * value so the server never boots with a broken configuration.
 * dotenv does NOT override variables already set in process.env (tests rely on this).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  HOST: z.string().default('0.0.0.0'),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/rapidaid'),
  // 32 characters minimum: HS256 keys below that are brute-forceable, and a
  // weak signing key defeats every other access control in the system.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  /**
   * Number of proxy hops to trust when deriving `req.ip` (0 = trust nothing).
   *
   * Rate limiting keys on `req.ip`, so this value decides whether a client can
   * rotate its bucket by forging `X-Forwarded-For`. Set it ONLY when the API is
   * genuinely behind that many trusted reverse proxies. With 0 (the default) a
   * directly-exposed deployment cannot be rate-limit-evaded.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /**
   * How long a role's effective permission set is cached in-process (ms).
   *
   * 0 (the default) disables the cache and reads `RolePolicy` on every
   * request, so a permission revoked through the admin API takes effect on
   * *every* instance immediately. A positive value trades revocation latency
   * for fewer database reads, and is only safe on a single-instance deploy.
   */
  PERMISSION_CACHE_TTL_MS: z.coerce.number().int().min(0).default(0),
  ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  SEED_IF_EMPTY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.string().default('info'),
  TELEMETRY_FRESHNESS_THRESHOLD_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
  AUTOMATED_DISPATCH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  RATE_LIMIT_DISABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ROUTING_PROVIDER_TYPE: z.enum(['osrm', 'mock', 'offline']).default('osrm'),
  ROUTING_PROVIDER_URL: z.string().url().default('https://router.project-osrm.org'),
  ROUTING_CACHE_TTL_MS: z.coerce.number().int().min(1000).max(86400000).default(60000),
  ROUTING_RECALCULATION_DISTANCE_THRESHOLD_METERS: z.coerce.number().int().min(10).max(5000).default(60),
  ROUTING_DEVIATION_THRESHOLD_METERS: z.coerce.number().int().min(20).max(5000).default(100),
  ROUTING_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(4000),

  // ── Metrics & Observability ──────────────────────────────────────────────
  /**
   * Enables the dedicated Prometheus scraper endpoint (GET /metrics).
   * Disabled by default across all environments.
   */
  METRICS_SCRAPE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Secret token for GET /metrics scraping (`Authorization: Bearer <token>`).
   * Must be at least 16 characters and not a weak placeholder.
   */
  METRICS_SCRAPE_TOKEN: z.string().optional(),

  // ── Email ───────────────────────────────────────────────────────────────
  /**
   * Delivery strategy. `console` (the default) writes every message to the
   * server log instead of sending it, so verification and password-reset flows
   * are fully exercisable with no provider account or API key. `smtp` uses the
   * EMAIL_SMTP_* values below.
   */
  EMAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  EMAIL_FROM: z.string().min(1).default('RapidAid <no-reply@rapidaid.com>'),
  /** Base URL of the frontend, used to build links inside outgoing emails. */
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  /** Lifetime of verification and password-reset links. */
  EMAIL_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASS: z.string().optional(),
  /** `secure: true` (implicit TLS). Defaults to true, as required by most providers. */
  EMAIL_SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // ── External Services ───────────────────────────────────────────────────
  SMS_PROVIDER: z.enum(['mock', 'twilio']).default('mock'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  WEB_PUSH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  MAP_TILE_PROVIDER_URL: z.string().default('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'),
  MAP_TILE_ATTRIBUTION: z.string().default('&copy; OpenStreetMap contributors'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  console.error('   See server/.env.example for required variables.');
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

// ── Production Safety & Integrity Validations ──────────────────────────────
if (isProd) {
  // 1. Never point production configuration to an isolated test database
  const lowerMongoUri = env.MONGODB_URI.toLowerCase();
  if (
    lowerMongoUri.includes('rapidaid_phase1_test') ||
    lowerMongoUri.includes('rapidaid_test') ||
    lowerMongoUri.endsWith('/test') ||
    lowerMongoUri.includes('/test?') ||
    lowerMongoUri.includes('_test')
  ) {
    console.error('❌ Strict Safety Block: Production MONGODB_URI cannot point to a test database.');
    console.error(`   Detected test database pattern in URI: ${env.MONGODB_URI.replace(/:([^:@]+)@/, ':***@')}`);
    console.error('   Ensure MONGODB_URI points to your production MongoDB Atlas cluster or production replica set.');
    process.exit(1);
  }

  // 2. Reject weak or default development secrets in production
  const WEAK_PATTERNS = ['change_me', 'replace_me', 'secret_change', 'dev_access', 'dev_refresh', 'test-access', 'test-refresh'];
  const hasWeakAccessSecret = WEAK_PATTERNS.some((p) => env.JWT_ACCESS_SECRET.toLowerCase().includes(p));
  const hasWeakRefreshSecret = WEAK_PATTERNS.some((p) => env.JWT_REFRESH_SECRET.toLowerCase().includes(p));

  if (hasWeakAccessSecret || hasWeakRefreshSecret) {
    console.error('❌ Insecure secrets detected in production:');
    if (hasWeakAccessSecret) console.error('   - JWT_ACCESS_SECRET contains default or placeholder pattern.');
    if (hasWeakRefreshSecret) console.error('   - JWT_REFRESH_SECRET contains default or placeholder pattern.');
    console.error('   Generate cryptographically secure 256-bit secrets (e.g. `openssl rand -hex 32`) for production.');
    process.exit(1);
  }

  // 3. Reject wildcard CORS in production
  if (env.CORS_ORIGINS === '*' || env.CORS_ORIGINS.includes('*')) {
    console.error('❌ Wildcard CORS_ORIGINS ("*") is strictly forbidden in production with credential support.');
    console.error('   Specify exact trusted production domains (e.g. "https://rapidaid.example.com").');
    process.exit(1);
  }

  // 4. Safety requirement: Automated dispatch must remain false
  if (env.AUTOMATED_DISPATCH_ENABLED) {
    console.error('❌ Safety Requirement Violation: AUTOMATED_DISPATCH_ENABLED must remain false.');
    console.error('   All ambulance dispatch decisions require explicit human dispatcher authorization.');
    process.exit(1);
  }
}

// The seeder writes demo accounts whose passwords are a known literal, including
// an ADMIN with the full permission set. A production deployment that boots with
// SEED_IF_EMPTY=true against an empty database would therefore come up with a
// fully-privileged, publicly-known account. Refuse to start rather than let a
// default silently create one.
if (isProd && env.SEED_IF_EMPTY) {
  console.error('❌ SEED_IF_EMPTY=true is not allowed when NODE_ENV=production.');
  console.error('   The demo seeder creates accounts with a hardcoded password, including an Administrator.');
  console.error('   Set SEED_IF_EMPTY=false, or use NODE_ENV=development for local work.');
  process.exit(1);
}

// Selecting SMTP without a host would surface much later as an opaque nodemailer
// connection error on the first send. Fail fast at boot instead, naming the
// variables that are missing so the fix is obvious.
if (env.EMAIL_TRANSPORT === 'smtp' && !env.EMAIL_SMTP_HOST) {
  console.error('❌ EMAIL_TRANSPORT=smtp requires EMAIL_SMTP_HOST.');
  console.error('   Set EMAIL_SMTP_HOST/PORT/USER/PASS, or use EMAIL_TRANSPORT=console for local development.');
  process.exit(1);
}

// Enabling the metrics scraper endpoint requires a strong bearer token (at least
// 16 characters, not a placeholder or weak password) to prevent unauthorized exposition.
if (env.METRICS_SCRAPE_ENABLED && !isStrongScraperToken(env.METRICS_SCRAPE_TOKEN)) {
  console.error('❌ METRICS_SCRAPE_ENABLED=true requires a strong METRICS_SCRAPE_TOKEN (at least 16 characters, not a placeholder).');
  console.error('   Generate a strong secret (e.g. `openssl rand -hex 32`) and set METRICS_SCRAPE_TOKEN.');
  process.exit(1);
}
