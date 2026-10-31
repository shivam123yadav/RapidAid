import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
  NonRetryableDeliveryError,
  RateLimitDeliveryError,
} from './transport.js';



/**
 * Simulates email delivery for development and testing.
 *
 * Sensitive email payloads, verification tokens, and action links are never
 * written to log streams or persisted to disk. Messages are retained in-memory
 * strictly during test execution (isTest === true) for assertions; production
 * instances never retain message payloads in memory.
 */
export class ConsoleEmailTransport implements EmailTransport {
  readonly name = 'console';

  /** In-memory storage for test assertions; only populated when isTest is true */
  private static recordedMessages: EmailMessage[] = [];

  static getRecordedMessages(): readonly EmailMessage[] {
    if (process.env.NODE_ENV !== 'test') return [];
    return this.recordedMessages;
  }

  static getLastMessage(): EmailMessage | undefined {
    if (process.env.NODE_ENV !== 'test') return undefined;
    return this.recordedMessages[this.recordedMessages.length - 1];
  }

  private static simulatedFailure: Error | null = null;
  private static simulatedRejection = false;

  static setSimulatedFailure(err: Error | null): void {
    if (process.env.NODE_ENV !== 'test') return;
    this.simulatedFailure = err;
  }

  static setSimulatedRejection(rejected: boolean): void {
    if (process.env.NODE_ENV !== 'test') return;
    this.simulatedRejection = rejected;
  }

  static clearRecorded(): void {
    this.recordedMessages = [];
    this.simulatedFailure = null;
    this.simulatedRejection = false;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (process.env.NODE_ENV === 'test') {
      if (ConsoleEmailTransport.simulatedFailure) {
        throw ConsoleEmailTransport.simulatedFailure;
      }
      if (ConsoleEmailTransport.simulatedRejection) {
        return { accepted: false, id: `console-rejected-${Date.now()}` };
      }
      ConsoleEmailTransport.recordedMessages.push(message);
    }
    logger.info(
      { to: message.to, subject: message.subject },
      'email captured by console transport (network dispatch disabled)',
    );
    return { accepted: true, id: `console-${Date.now()}` };
  }
}

/** Delivers over SMTP using the EMAIL_SMTP_* environment values. */
export class SmtpEmailTransport implements EmailTransport {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(private readonly from: string) {
    this.transporter = nodemailer.createTransport({
      host: env.EMAIL_SMTP_HOST,
      port: env.EMAIL_SMTP_PORT ?? 587,
      secure: env.EMAIL_SMTP_SECURE,
      ...(env.EMAIL_SMTP_USER && env.EMAIL_SMTP_PASS
        ? { auth: { user: env.EMAIL_SMTP_USER, pass: env.EMAIL_SMTP_PASS } }
        : {}),
      // Bounded timeouts to prevent socket hangs and indefinite pending requests
      connectionTimeout: 10000, // 10 seconds to establish TCP connection
      greetingTimeout: 10000,   // 10 seconds for initial server greeting
      socketTimeout: 15000,     // 15 seconds max inactivity on socket
    });
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    // nodemailer reports a rejection without throwing for some failure modes.
    // Both arrays are optional on SentMessageInfo, hence the defaults.
    const rejected = info.rejected ?? [];
    const accepted = info.accepted ?? [];
    return { accepted: rejected.length === 0 && accepted.length > 0, id: info.messageId };
  }
}

export interface BrevoApiTransportOptions {
  /** Override API endpoint (default: https://api.brevo.com/v3/smtp/email) */
  apiUrl?: string;
  /** Request timeout in ms (default: 10000ms) */
  timeoutMs?: number;
  /** Custom fetch implementation for testing or mocking */
  fetchFn?: typeof fetch;
}

/** Parses an RFC 2822 / 5322 style address e.g. "RapidAid <no-reply@rapidaid.com>" or "no-reply@rapidaid.com". */
export function parseEmailAddress(raw: string): { name?: string; email: string } {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(?:(?:"?([^"]*)"?\s)?<([^>]+)>|([^<>\s]+))$/);
  if (match) {
    const name = (match[1] || '').trim();
    const email = (match[2] || match[3] || '').trim();
    return name ? { name, email } : { email };
  }
  return { email: trimmed };
}

/**
 * Parses HTTP Retry-After header per RFC 7231 / RFC 9110 into milliseconds.
 * Supports both delay-seconds (e.g. "120") and HTTP-date formats (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
 */
export function parseRetryAfter(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  // 1. delay-seconds (one or more digits)
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  // 2. HTTP-date format
  const parsedTimestamp = Date.parse(trimmed);
  if (!Number.isNaN(parsedTimestamp)) {
    const delayMs = parsedTimestamp - Date.now();
    return Math.max(0, delayMs);
  }

  return undefined;
}


/**
 * Delivers transactional emails via Brevo's official HTTP REST API (v3/smtp/email).
 *
 * Designed to bypass restrictive outbound SMTP port blocks and TLS connection
 * timeouts common on cloud hosts such as Render. Authenticates over HTTPS via the
 * `api-key` header.
 *
 * Failure classification:
 * - 4xx client errors (e.g. 401 Unauthorized, 400 Bad Request) are marked NonRetryableDeliveryError.
 * - Timeouts abort after bounded duration and are marked NonRetryableDeliveryError to prevent duplicate sends when delivery status is uncertain.
 * - 5xx server errors and 429 rate limits throw retryable Errors handled with exponential backoff.
 */
export class BrevoApiEmailTransport implements EmailTransport {
  readonly name = 'brevo_api';
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    options?: BrevoApiTransportOptions,
  ) {
    if (!apiKey) {
      throw new Error('BrevoApiEmailTransport requires an API key');
    }
    this.apiUrl = options?.apiUrl ?? 'https://api.brevo.com/v3/smtp/email';
    this.timeoutMs = options?.timeoutMs ?? 10_000;
    this.fetchFn = options?.fetchFn ?? fetch;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const sender = parseEmailAddress(this.from);
    const recipient = parseEmailAddress(message.to);

    const payload = {
      sender,
      to: [recipient],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.apiUrl, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Brevo returns 201 Created on acceptance (or 200/202)
      if (response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          messageId?: string;
          messageIds?: string[];
        };
        const id = data.messageId || data.messageIds?.[0] || `brevo-${Date.now()}`;
        return { accepted: true, id };
      }

      // Parse error details safely without leaking credentials
      let errorDetail = `HTTP ${response.status}`;
      try {
        const errorJson = (await response.json()) as { code?: string; message?: string };
        if (errorJson.message) {
          errorDetail = `${response.status} (${errorJson.code || 'error'}): ${errorJson.message}`;
        }
      } catch {
        // Non-JSON response body
      }

      // 4xx errors (except 429 rate limits) are permanent client configuration failures (e.g. 401 invalid key, 400 invalid email)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new NonRetryableDeliveryError(`Brevo API client error: ${errorDetail}`, response.status);
      }

      // 429 Rate Limiting: extract and parse Retry-After header
      if (response.status === 429) {
        const retryAfterHeader = response.headers?.get
          ? response.headers.get('retry-after') ?? response.headers.get('Retry-After')
          : null;
        const retryAfterMs = parseRetryAfter(retryAfterHeader);
        throw new RateLimitDeliveryError(`Brevo API rate limit exceeded: ${errorDetail}`, retryAfterMs);
      }

      // 5xx are transient server errors: retryable by sender
      throw new Error(`Brevo API server error: ${errorDetail}`);

    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof NonRetryableDeliveryError) {
        throw err;
      }
      if (
        (err instanceof Error && err.name === 'AbortError') ||
        controller.signal.aborted
      ) {
        throw new NonRetryableDeliveryError(
          `Brevo API request timed out after ${this.timeoutMs}ms; delivery status uncertain, skipping retry to prevent duplicates`,
        );
      }
      throw err;
    }
  }
}
