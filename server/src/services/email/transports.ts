import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { EmailMessage, EmailSendResult, EmailTransport } from './transport.js';

/**
 * Writes the message to the server log instead of sending it.
 *
 * This is the default so that verification and password-reset flows are fully
 * usable in development and CI with no provider account — the action link is
 * printed in full, which makes the flow testable end to end. The body is logged
 * at `info` only when it is a link-bearing flow; see `sender.ts`, which routes
 * through here for every message.
 */
export class ConsoleEmailTransport implements EmailTransport {
  readonly name = 'console';

  async send(message: EmailMessage): Promise<EmailSendResult> {
    logger.info(
      { to: message.to, subject: message.subject, body: message.text },
      'email (console transport — not sent)',
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
