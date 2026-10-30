import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'http';
import { env, isTest } from './config/env.js';
import { logger, defaultSerializers } from './config/logger.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { apiRouter } from './routes/index.js';
import { livenessProbe, readinessProbe } from './routes/system.routes.js';
import { DEFAULT_JSON_BODY_LIMIT, EMERGENCY_UPLOAD_BODY_LIMIT } from './validation/constants.js';
import { asyncHandler } from './utils/asyncHandler.js';
import { metricsRegistry } from './metrics/registry.js';
import { createScraperAuthMiddleware } from './middleware/metricsAuth.js';

export interface CreateAppOptions {
  logger?: typeof logger;
  autoLogging?: boolean;
  metricsScrapeEnabled?: boolean;
  metricsScrapeToken?: string;
}

/**
 * Builds the Express application as a pure factory (no listen, no DB
 * connect) so tests can mount it with supertest against the test database.
 */
export function createApp(options?: CreateAppOptions): express.Express {
  const app = express();
  const appLogger = options?.logger ?? logger;
  const autoLogging = options?.autoLogging ?? !isTest;

  // `req.ip` feeds the rate limiters, so the proxy trust depth is an explicit
  // deployment decision rather than a hardcoded assumption. Trusting a hop the
  // app does not actually sit behind lets any client mint a fresh rate-limit
  // bucket per request by forging `X-Forwarded-For`; behind the Vite dev proxy
  // or a load balancer, set TRUST_PROXY_HOPS to the real hop count.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  // Security headers. CSP is relaxed for the API-only surface (JSON
  // responses); the SPA is served separately by Vite in development.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // CORS: explicit origin allowlist with credentials support (cookies).
  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(
    cors({
      origin(origin, callback) {
        // Non-browser clients (curl, server-to-server) send no Origin header.
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(null, false); // respond 204 without CORS headers → browser blocks
        }
      },
      credentials: true,
      exposedHeaders: ['x-request-id'],
    }),
  );

  app.use(compression());
  // Default JSON bodies are small — no route outside emergency reporting accepts
  // more than a few KB. Emergency creation is the single exception because
  // photos arrive as base64 data URLs. Allow 16 MB on *every* endpoint instead
  // let an unauthenticated caller make the server buffer 16 MB per request
  // before the rate limiter or the validator could reject it.
  //
  // Order matters: body-parser marks the request as parsed and skips if it
  // already ran, so the roomier parser for the emergency path must be
  // registered first or the default would reject the payload it is meant to let
  // through.
  app.use('/api/emergencies', express.json({ limit: EMERGENCY_UPLOAD_BODY_LIMIT }));
  app.use(express.json({ limit: DEFAULT_JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  // Correlation id first so every later log line + error carries it.
  app.use(requestId);
  app.use(
    pinoHttp({
      logger: appLogger,
      autoLogging,
      serializers: defaultSerializers,
      genReqId: (req: IncomingMessage) =>
        (req as unknown as { requestId?: string }).requestId ?? 'unknown',
      customLogLevel: (
        _req: IncomingMessage,
        res: ServerResponse,
        err?: Error,
      ): 'error' | 'warn' | 'info' =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );

  // Defensive headers on every response (must be registered before routes and probes).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Unauthenticated orchestrator health & readiness probes (bypass rate limiter)
  app.get('/healthz', livenessProbe);
  app.get('/readyz', readinessProbe);

  // Optional scraper endpoint (protected by bearer token, disabled by default in all environments)
  const scrapeEnabled = options?.metricsScrapeEnabled ?? env.METRICS_SCRAPE_ENABLED;
  const scrapeToken = options?.metricsScrapeToken ?? env.METRICS_SCRAPE_TOKEN;
  if (scrapeEnabled) {
    app.get(
      '/metrics',
      createScraperAuthMiddleware(scrapeToken),
      asyncHandler(async (_req, res) => {
        res.setHeader('Content-Type', metricsRegistry.contentType);
        res.send(await metricsRegistry.metrics());
      }),
    );
  }

  // Rate limiting (skipped in tests / when RATE_LIMIT_DISABLED=true).
  app.use('/api', apiLimiter);

  // Routes.
  app.use('/api', apiRouter);

  // Central error handler (must be registered last).
  app.use(errorHandler);

  return app;
}
