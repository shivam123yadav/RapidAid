import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { IdempotencyKey } from '../models/IdempotencyKey.js';
import { Emergency, isEmergencyIdempotencyIndexReady } from '../models/Emergency.js';
import { VoiceReport } from '../models/VoiceReport.js';
import { toClientEmergency, type AuthContext } from '../authz/access.js';
import { ApiError } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';

declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
      scopedIdempotencyKey?: string;
    }
  }
}

export interface IdempotentOptions {
  endpoint: string;
}

/** Formats a scoped idempotency key binding caller identity, endpoint and client key. */
export function formatScopedIdempotencyKey(scope: string, endpoint: string, key: string): string {
  return `${scope}::${endpoint}::${key.trim()}`;
}

/** Computes the canonical deterministic SHA-256 fingerprint of the request body and optional multipart audio bytes. */
export function computeRequestHash(body: unknown, audioBuffer?: Buffer | null): string {
  let canonicalPayload = JSON.stringify(body ?? {});
  if (audioBuffer && Buffer.isBuffer(audioBuffer)) {
    const audioHash = createHash('sha256').update(audioBuffer).digest('hex');
    canonicalPayload += `::audioChecksum=${audioHash}`;
  }
  return createHash('sha256').update(canonicalPayload).digest('hex');
}

/**
 * Robust, persistent idempotency middleware.
 *
 * Scopes each key to the authenticated caller (or IP) and endpoint.
 * Detects:
 *  - Concurrent identical requests (409 Conflict: in progress)
 *  - Mismatched request fingerprints (409 Conflict: payload mismatch)
 *  - Completed requests (replays saved response with Idempotent-Replayed: true header)
 *  - Server failure after creation: recovers created emergency safely without duplicates
 */
export function idempotent(options: IdempotentOptions) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawKey = req.header('idempotency-key') || req.header('x-idempotency-key');
    if (!rawKey) {
      return next();
    }

    const key = rawKey.trim();
    if (key.length === 0 || key.length > 200) {
      throw ApiError.badRequest('Idempotency-Key must be a non-empty string of at most 200 characters');
    }

    // Fail closed: Keyed emergency creation requires confirmed database-level uniqueness.
    // Requests without an idempotency key bypass this guard (rawKey check above).
    const isEmergencyEndpoint =
      options.endpoint === 'POST /api/emergencies' ||
      options.endpoint === 'POST /api/voice/reports/recording';
    if (isEmergencyEndpoint && !isEmergencyIdempotencyIndexReady()) {
      res.setHeader('Retry-After', '30');
      throw ApiError.serviceUnavailable(
        'Idempotent emergency creation is temporarily unavailable: database uniqueness index is unverified. Please retry shortly.',
      );
    }

    const scope = (req as unknown as { auth?: { userId?: string } }).auth?.userId ?? req.ip ?? 'anonymous';
    const scopedKey = formatScopedIdempotencyKey(scope, options.endpoint, key);
    req.idempotencyKey = key;
    req.scopedIdempotencyKey = scopedKey;

    const uploadedAudio = (req as unknown as { files?: { [field: string]: { buffer?: Buffer; data?: Buffer } } }).files?.audio;
    const audioBuffer = uploadedAudio?.buffer ?? uploadedAudio?.data;
    const requestHash = computeRequestHash(req.body, audioBuffer);

    try {
      await IdempotencyKey.create({
        key,
        scope,
        endpoint: options.endpoint,
        requestHash,
        status: 'IN_PROGRESS',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (err: unknown) {
      if ((err as { code?: number }).code === 11000) {
        const existing = await IdempotencyKey.findOne({ key, scope, endpoint: options.endpoint });
        if (!existing) {
          throw err;
        }

        // Verify request payload fingerprint
        if (existing.requestHash !== requestHash) {
          throw ApiError.conflict(
            'Idempotency key reuse: A request with this key already exists with a different payload',
          );
        }

        if (existing.status === 'IN_PROGRESS') {
          // Check if an emergency was already created for this key (recovering from server failure after creation but before response caching)
          // Scoped strictly to the caller and endpoint so recovery can never return another user's emergency.
          const existingEmergency = await Emergency.findOne({ idempotencyKey: scopedKey });
          if (existingEmergency) {
            const authContext = (req as unknown as { auth?: AuthContext }).auth;
            const clientEmergency = authContext
              ? toClientEmergency(authContext, existingEmergency)
              : existingEmergency.toJSON();

            let responsePayload: unknown = clientEmergency;
            if (options.endpoint === 'POST /api/voice/reports/recording') {
              const existingReport = await VoiceReport.findOne({ emergencyId: existingEmergency._id }).lean();
              if (existingReport) {
                responsePayload = {
                  report: existingReport,
                  transcript: existingReport.transcript ?? '',
                  extractedInformation: existingReport.extractedInformation ?? {},
                  location: existingReport.location ?? {},
                  hospital: existingReport.hospitalRouting
                    ? {
                        hospitalId: existingReport.hospitalRouting.hospitalId,
                        name: existingReport.hospitalRouting.hospitalName,
                        distanceMeters: existingReport.hospitalRouting.distance,
                        etaSeconds: existingReport.hospitalRouting.etaSeconds,
                      }
                    : null,
                  distance: existingReport.hospitalRouting?.distance ?? null,
                  emergency: clientEmergency,
                  dispatchStatus: existingReport.dispatchStatus ?? 'DISPATCH_PENDING',
                  hospitalNotificationSent: Boolean(existingReport.hospitalRouting?.hospitalId),
                  warning: null,
                };
              }
            }

            await IdempotencyKey.updateOne(
              { _id: existing._id },
              {
                $set: {
                  status: 'COMPLETED',
                  statusCode: 201,
                  responseBody: responsePayload,
                  updatedAt: new Date(),
                },
              },
            );

            res.setHeader('Idempotent-Replayed', 'true');
            res.status(201).json(responsePayload);
            return;
          }

          const STALE_THRESHOLD_MS = 30_000;
          const isStale = Date.now() - new Date(existing.updatedAt ?? existing.createdAt).getTime() > STALE_THRESHOLD_MS;
          if (isStale) {
            const reclaimed = await IdempotencyKey.findOneAndUpdate(
              { _id: existing._id, status: 'IN_PROGRESS', updatedAt: existing.updatedAt },
              { $set: { updatedAt: new Date() } },
              { new: true },
            );
            if (!reclaimed) {
              throw ApiError.conflict(
                'A request with this idempotency key is already in progress. Please wait for completion.',
              );
            }
            // Stale lock successfully reclaimed; proceed to create emergency
          } else {
            throw ApiError.conflict(
              'A request with this idempotency key is already in progress. Please wait for completion.',
            );
          }
        } else if (existing.status === 'COMPLETED') {
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(existing.statusCode ?? 200).json(existing.responseBody);
          return;
        } else {
          // Previous attempt marked FAILED; atomically reclaim for retry
          const reclaimed = await IdempotencyKey.findOneAndUpdate(
            { _id: existing._id, status: 'FAILED' },
            { $set: { status: 'IN_PROGRESS', updatedAt: new Date() } },
          );
          if (!reclaimed) {
            throw ApiError.conflict('Concurrent request in progress for this idempotency key');
          }
        }
      } else {
        throw err;
      }
    }

    // Intercept response completion to record the outcome
    const originalJson = res.json.bind(res);
    res.json = (body: unknown): Response => {
      const statusCode = res.statusCode;
      if (statusCode >= 200 && statusCode < 300) {
        IdempotencyKey.updateOne(
          { key, scope, endpoint: options.endpoint },
          {
            $set: {
              status: 'COMPLETED',
              statusCode,
              responseBody: body,
              updatedAt: new Date(),
            },
          },
        )
          .exec()
          .catch((saveErr) => {
            logger.error({ err: saveErr }, 'Failed to persist completed idempotency record');
          });
      } else {
        IdempotencyKey.deleteOne({ key, scope, endpoint: options.endpoint })
          .exec()
          .catch((delErr) => {
            logger.error({ err: delErr }, 'Failed to cleanup failed idempotency record');
          });
      }
      return originalJson(body);
    };

    next();
  });
}
