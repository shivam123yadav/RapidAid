import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ConsoleEmailTransport, SmtpEmailTransport, BrevoApiEmailTransport } from './transports.js';
import type { EmailMessage, EmailTransport } from './transport.js';

export function createTransportFromEnv(): EmailTransport {
  if (env.EMAIL_TRANSPORT === 'brevo_api') {
    return new BrevoApiEmailTransport(env.BREVO_API_KEY ?? '', env.EMAIL_FROM);
  }
  if (env.EMAIL_TRANSPORT === 'smtp') {
    return new SmtpEmailTransport(env.EMAIL_FROM);
  }
  return new ConsoleEmailTransport();
}

/** Selected at boot from EMAIL_TRANSPORT, mutable for testing. */
let transport: EmailTransport = createTransportFromEnv();

/** Exposed for tests to override the active transport. */
export function setTransport(newTransport: EmailTransport): void {
  transport = newTransport;
}

/** Exposed for tests to reset the active transport to the environment default. */
export function resetTransport(): void {
  transport = createTransportFromEnv();
}

/** Exposed for callers that need the active transport instance. */
export function getActiveTransport(): EmailTransport {
  return transport;
}

/** Exposed for tests and for callers that need to describe the active delivery path. */
export const activeTransportName = transport.name;

/** Attempts per message before the delivery is recorded as failed. */
export const MAX_ATTEMPTS = 3;
export const BASE_DELAY_MS = 250;
export const MAX_RETRY_DELAY_MS = 2_000;

export interface SendResult {
  delivered: boolean;
  attempts: number;
  error?: string;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a message with exponential backoff (250ms, 500ms).
 *
 * Never throws. A failed delivery is logged and returned, so that email — an
 * auxiliary channel — can never fail the request that triggered it, such as
 * registration. A user who never receives a verification mail can still ask for
 * a resend; that is strictly better than the signup itself erroring out.
 *
 * Bounded retries: Non-retryable errors (4xx client rejections, invalid credentials,
 * network timeouts where payload may have been received by the remote server) break
 * the retry loop immediately to prevent duplicate email sends.
 *
 * Rate limiting: If transport conveys a Retry-After delay (HTTP 429), it is respected
 * within MAX_RETRY_DELAY_MS. If Retry-After exceeds MAX_RETRY_DELAY_MS, delivery is aborted
 * immediately without retrying earlier than requested, preventing uncontrolled duplicates
 * or hanging requests indefinitely.
 */
export async function sendEmail(
  message: EmailMessage,
  context: { purpose: string; userId?: string },
): Promise<SendResult> {
  let lastError = 'unknown error';
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attemptsMade = attempt;
    try {
      const result = await transport.send(message);
      if (!result.accepted) throw new Error('transport reported rejection');

      if (transport.name === 'console') {
        logger.info(
          { to: message.to, purpose: context.purpose, transport: transport.name, attempt },
          'email simulated via console transport (not delivered over network)',
        );
      } else if (transport.name === 'brevo_api') {
        logger.info(
          { to: message.to, purpose: context.purpose, transport: transport.name, attempt },
          'email accepted by Brevo transactional API',
        );
      } else {
        logger.info(
          { to: message.to, purpose: context.purpose, transport: transport.name, attempt },
          'email delivered',
        );
      }
      return { delivered: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const isRetryable = (err as { retryable?: boolean })?.retryable !== false;
      const suggestedRetryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;

      logger.warn(
        {
          to: message.to,
          purpose: context.purpose,
          transport: transport.name,
          attempt,
          err: lastError,
          retryable: isRetryable,
          retryAfterMs: suggestedRetryAfterMs,
        },
        'email delivery attempt failed',
      );

      // Stop immediately on non-retryable failures to prevent duplicate dispatches
      if (!isRetryable) {
        break;
      }

      // If remote rate limit requested a Retry-After exceeding our permitted window,
      // do NOT retry earlier than Brevo requested. Stop the current delivery attempt
      // sequence and return a controlled delivery failure.
      if (
        typeof suggestedRetryAfterMs === 'number' &&
        !Number.isNaN(suggestedRetryAfterMs) &&
        suggestedRetryAfterMs > MAX_RETRY_DELAY_MS
      ) {
        logger.warn(
          {
            to: message.to,
            purpose: context.purpose,
            transport: transport.name,
            attempt,
            retryAfterMs: suggestedRetryAfterMs,
            maxRetryDelayMs: MAX_RETRY_DELAY_MS,
          },
          'email delivery aborted: requested Retry-After exceeds maximum permitted retry window',
        );
        break;
      }

      if (attempt < MAX_ATTEMPTS) {
        let sleepMs = BASE_DELAY_MS * 2 ** (attempt - 1);
        if (typeof suggestedRetryAfterMs === 'number' && !Number.isNaN(suggestedRetryAfterMs)) {
          // Retry-After is within permitted window (<= MAX_RETRY_DELAY_MS); wait for requested duration
          sleepMs = Math.max(0, suggestedRetryAfterMs);
        } else {
          // Absent or invalid Retry-After; use bounded exponential backoff
          sleepMs = Math.min(sleepMs, MAX_RETRY_DELAY_MS);
        }
        await delay(sleepMs);
      }
    }
  }


  logger.error(
    {
      to: message.to,
      purpose: context.purpose,
      userId: context.userId,
      transport: transport.name,
      attempts: attemptsMade,
      err: lastError,
    },
    'email delivery failed after all attempts',
  );
  return { delivered: false, attempts: attemptsMade, error: lastError };
}

