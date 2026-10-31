import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { EmailMessage, EmailSendResult, EmailTransport } from './transport.js';

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
