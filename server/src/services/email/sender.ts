import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ConsoleEmailTransport, SmtpEmailTransport } from './transports.js';
import type { EmailMessage, EmailTransport } from './transport.js';

/** Selected once at boot from EMAIL_TRANSPORT. */
const transport: EmailTransport =
  env.EMAIL_TRANSPORT === 'smtp'
    ? new SmtpEmailTransport(env.EMAIL_FROM)
    : new ConsoleEmailTransport();

/** Exposed for tests and for callers that need to describe the active delivery path. */
export const activeTransportName = transport.name;

/** Attempts per message before the delivery is recorded as failed. */
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;

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
 */
export async function sendEmail(
  message: EmailMessage,
  context: { purpose: string; userId?: string },
): Promise<SendResult> {
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await transport.send(message);
      if (!result.accepted) throw new Error('transport reported rejection');

      logger.info(
        { to: message.to, purpose: context.purpose, transport: transport.name, attempt },
        'email delivered',
      );
      return { delivered: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          to: message.to,
          purpose: context.purpose,
          transport: transport.name,
          attempt,
          err: lastError,
        },
        'email delivery attempt failed',
      );
      if (attempt < MAX_ATTEMPTS) await delay(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  logger.error(
    { to: message.to, purpose: context.purpose, userId: context.userId, transport: transport.name, err: lastError },
    'email delivery failed after all attempts',
  );
  return { delivered: false, attempts: MAX_ATTEMPTS, error: lastError };
}
