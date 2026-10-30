/**
 * Transport contract for outgoing mail.
 *
 * Every caller depends on this interface rather than on nodemailer directly, so
 * swapping the delivery provider (SMTP -> SendGrid -> SES -> a queue) is a
 * configuration change, never a rewrite of the flows that send mail.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text alternative. Never omitted — several clients score poorly without it. */
  text: string;
  html: string;
}

export interface EmailSendResult {
  accepted: boolean;
  /** Provider-assigned identifier, useful for correlating delivery logs. */
  id?: string;
}

export interface EmailTransport {
  /** Identifies the active transport in structured logs. */
  readonly name: string;
  /**
   * Delivers a message. May throw — the sender treats a rejection as retryable
   * and records a delivery failure after exhausting its attempts.
   */
  send(message: EmailMessage): Promise<EmailSendResult>;
}
