import express, { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { P } from '../authz/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pingDB } from '../db/connection.js';
import { isEmergencyIdempotencyIndexReady } from '../models/Emergency.js';
import { isAppShuttingDown } from '../config/lifecycle.js';
import { metricsRegistry } from '../metrics/registry.js';
import { cspReportLimiter } from '../middleware/rateLimit.js';
import { logger } from '../config/logger.js';

export const systemRouter = Router();

interface HealthService {
  service: string;
  status: 'OPERATIONAL' | 'DEGRADED' | 'OFFLINE';
  latency?: number;
  lastChecked: string;
  details?: string;
}

/** Safe, unauthenticated liveness probe for orchestrators and load balancers. */
export const livenessProbe = (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
};

/**
 * Safe, unauthenticated readiness probe.
 * Returns HTTP 503 if:
 *  1. Application shutdown has started.
 *  2. Mongoose is not in connected state.
 *  3. Database ping fails or throws.
 * Returns HTTP 200 only when all conditions are satisfied.
 */
export const readinessProbe = asyncHandler(async (_req, res) => {
  const timestamp = new Date().toISOString();

  // 1. Condition 1: Application shutdown has started -> 503
  if (isAppShuttingDown()) {
    return res.status(503).json({
      status: 'not_ready',
      timestamp,
      reason: 'shutting_down',
    });
  }

  // 2. Condition 2: Mongoose is not in connected state -> 503
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      status: 'not_ready',
      timestamp,
      reason: 'database_unavailable',
    });
  }

  // 3. Condition 3: Database readiness ping fails or throws an error -> 503
  let db: { ok: boolean; latencyMs: number };
  try {
    db = await pingDB();
  } catch {
    db = { ok: false, latencyMs: 0 };
  }

  if (!db.ok) {
    return res.status(503).json({
      status: 'not_ready',
      timestamp,
      reason: 'database_unavailable',
    });
  }

  const idempotencyReady = isEmergencyIdempotencyIndexReady();
  return res.status(200).json({
    status: 'ready',
    timestamp,
    capabilities: {
      emergencyDeduplication: idempotencyReady ? 'ready' : 'degraded',
    },
  });
});

// Unauthenticated orchestrator probes
systemRouter.get('/healthz', livenessProbe);
systemRouter.get('/readyz', readinessProbe);

/**
 * Safely sanitizes a URI string reported by CSP, stripping query parameters,
 * credentials, and URL hash fragments without throwing errors on malformed
 * or non-URL values (e.g. 'eval', 'inline', 'wasm-eval', relative paths).
 */
export function sanitizeReportUri(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const trimmed = raw.trim();
  if (!trimmed) return 'unknown';

  try {
    const parsed = new URL(trimmed, 'http://localhost');
    return parsed.pathname;
  } catch {
    return trimmed.split('?')[0].split('#')[0].slice(0, 100);
  }
}

/** Specific body parser for CSP reports: accepts application/csp-report and limits size to 10 KB. */
export const cspReportParser = express.json({
  type: ['application/json', 'application/csp-report'],
  limit: '10kb',
});

/**
 * Unauthenticated CSP violation report ingestion handler.
 * Defensively extracts directive names and sanitized paths, safely logs structured warnings,
 * and terminates with 204 No Content without leaking internal state.
 */
export function cspReportHandler(req: Request, res: Response): void {
  const body = req.body as Record<string, unknown> | undefined;
  const report = (body?.['csp-report'] ?? body) as Record<string, unknown> | undefined;

  const violatedDirective = typeof report?.['violated-directive'] === 'string'
    ? report['violated-directive'].slice(0, 50)
    : typeof report?.['effective-directive'] === 'string'
      ? report['effective-directive'].slice(0, 50)
      : 'unknown';

  const blockedUri = sanitizeReportUri(report?.['blocked-uri'] ?? report?.['blockedURL']);
  const documentUri = sanitizeReportUri(report?.['document-uri'] ?? report?.['documentURL']);

  logger.warn(
    {
      csp: {
        violatedDirective,
        blockedUri,
        documentUri,
      },
    },
    'CSP violation reported',
  );

  res.status(204).end();
}

// Unauthenticated CSP violation report endpoint
systemRouter.post('/csp-report', cspReportLimiter, cspReportParser, cspReportHandler);

/**
 * GET /api/system/health — authenticated operations overview:
 *  - Database: live ping with measured round-trip latency
 *  - API Server: process uptime + memory pressure
 * Requires SYSTEM_READ permission.
 */
systemRouter.get(
  '/health',
  authenticate,
  requirePermission(P.SYSTEM_READ),
  asyncHandler(async (_req, res) => {
    const now = new Date().toISOString();
    let db: { ok: boolean; latencyMs: number };
    try {
      db = await pingDB();
    } catch {
      db = { ok: false, latencyMs: 0 };
    }

    const services: HealthService[] = [
      {
        service: 'API Gateway',
        status: 'OPERATIONAL',
        latency: Math.max(1, Math.round(process.uptime() * 1000)),
        lastChecked: now,
        details: `uptime ${Math.floor(process.uptime())}s, rss ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB`,
      },
      {
        service: 'Database',
        status: db.ok ? 'OPERATIONAL' : 'OFFLINE',
        latency: db.latencyMs,
        lastChecked: now,
        details: db.ok
          ? (isEmergencyIdempotencyIndexReady()
              ? 'MongoDB connection healthy (idempotency index verified)'
              : 'MongoDB connection healthy (idempotency index degraded)')
          : 'MongoDB ping failed',
      },
      {
        service: 'Real-time (WebSocket)',
        status: 'OFFLINE',
        lastChecked: now,
        details: 'No dedicated WebSocket daemon; client falling back to HTTP polling',
      },
      {
        service: 'AI Vision Service',
        status: 'DEGRADED',
        lastChecked: now,
        details: 'RapidVision detection queue active; no real-time GPU inference attached',
      },
      {
        service: 'Voice AI',
        status: db.ok ? 'OPERATIONAL' : 'OFFLINE',
        lastChecked: now,
        details: 'transcript extraction pipeline',
      },
      {
        service: 'Maps Service',
        status: 'OPERATIONAL',
        lastChecked: now,
        details: 'OpenStreetMap tiles (client-side)',
      },
      {
        service: 'Notification Service',
        status: db.ok ? 'OPERATIONAL' : 'OFFLINE',
        lastChecked: now,
        details: 'in-process notification writer',
      },
    ];

    // Core operational status reflects readiness of primary backend and deduplication capability
    const idempotencyReady = isEmergencyIdempotencyIndexReady();
    const overall = db.ok ? (idempotencyReady ? 'OPERATIONAL' : 'DEGRADED') : 'DEGRADED';

    res.json({
      status: overall,
      timestamp: now,
      idempotencyReady,
      capabilities: {
        idempotentEmergencyCreation: idempotencyReady ? 'OPERATIONAL' : 'DEGRADED',
      },
      services,
    });
  }),
);

/**
 * GET /api/system/metrics — authenticated Prometheus metrics exposition.
 * Requires valid authentication and SYSTEM_READ permission.
 */
systemRouter.get(
  '/metrics',
  authenticate,
  requirePermission(P.SYSTEM_READ),
  asyncHandler(async (_req, res) => {
    res.setHeader('Content-Type', metricsRegistry.contentType);
    res.send(await metricsRegistry.metrics());
  }),
);

