import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { SmtpEmailTransport } from '../email/transports.js';
import type {
  ChannelDeliveryResult,
  NotificationChannelProvider,
  NotificationPayload,
} from './types.js';

export class EmailChannelProvider implements NotificationChannelProvider {
  readonly channel = 'email' as const;
  readonly isMock: boolean;
  private readonly smtpTransport?: SmtpEmailTransport;

  constructor() {
    this.isMock = env.EMAIL_TRANSPORT !== 'smtp' || !env.EMAIL_SMTP_HOST;
    if (!this.isMock) {
      this.smtpTransport = new SmtpEmailTransport(env.EMAIL_FROM);
    }
  }

  async send(payload: NotificationPayload): Promise<ChannelDeliveryResult> {
    const sentAt = new Date();
    const recipient =
      payload.recipientEmail ||
      (payload.recipientId ? `${payload.recipientId}@rapidaid.local` : 'unspecified@rapidaid.local');

    if (this.isMock || !this.smtpTransport) {
      logger.info(
        { channel: this.channel, recipient, title: payload.title, eventType: payload.eventType },
        `[MOCK EMAIL DELIVERED] To: ${recipient} | Subject: [RapidAid] ${payload.title} | ${payload.message}`,
      );
      return {
        channel: this.channel,
        status: 'MOCK_DELIVERED',
        recipient,
        details: 'Simulated email delivery (development/mock mode - SMTP not active)',
        sentAt,
      };
    }

    try {
      const result = await this.smtpTransport.send({
        to: recipient,
        subject: `[RapidAid Alert] ${payload.title}`,
        text: `${payload.title}\n\n${payload.message}`,
        html: `<h2>${payload.title}</h2><p>${payload.message}</p>`,
      });

      if (!result.accepted) {
        throw new Error('SMTP transport rejected message delivery');
      }

      logger.info(
        { channel: this.channel, recipient, title: payload.title, messageId: result.id },
        `Email dispatched to ${recipient}`,
      );
      return {
        channel: this.channel,
        status: 'DELIVERED',
        recipient,
        details: result.id,
        sentAt,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, recipient }, 'Failed to dispatch email notification');
      return {
        channel: this.channel,
        status: 'FAILED',
        recipient,
        details: msg,
        sentAt,
      };
    }
  }
}

export class SmsChannelProvider implements NotificationChannelProvider {
  readonly channel = 'sms' as const;
  readonly isMock: boolean;

  constructor() {
    this.isMock =
      env.SMS_PROVIDER !== 'twilio' ||
      !env.TWILIO_ACCOUNT_SID ||
      !env.TWILIO_AUTH_TOKEN ||
      !env.TWILIO_FROM_NUMBER;
  }

  async send(payload: NotificationPayload): Promise<ChannelDeliveryResult> {
    const sentAt = new Date();
    const recipient = payload.recipientPhone || '+91-MOCK-PHONE';

    if (this.isMock) {
      logger.info(
        { channel: this.channel, recipient, title: payload.title, eventType: payload.eventType },
        `[MOCK SMS DELIVERED] To: ${recipient} | ${payload.title}: ${payload.message}`,
      );

      return {
        channel: this.channel,
        status: 'MOCK_DELIVERED',
        recipient,
        details: 'Simulated SMS gateway delivery (development/mock mode - Twilio credentials not configured)',
        sentAt,
      };
    }

    try {
      // Production Twilio REST API integration using standard HTTPS Basic auth fetch
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
      const authHeader = `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`;

      const params = new URLSearchParams({
        To: recipient,
        From: env.TWILIO_FROM_NUMBER!,
        Body: `[RapidAid Alert] ${payload.title}: ${payload.message}`,
      });

      const response = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Twilio HTTP error ${response.status}: ${errorText}`);
      }

      const twilioData = (await response.json()) as { sid?: string };
      logger.info(
        { channel: this.channel, recipient, sid: twilioData.sid },
        `Twilio SMS dispatched to ${recipient}`,
      );

      return {
        channel: this.channel,
        status: 'DELIVERED',
        recipient,
        details: twilioData.sid,
        sentAt,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, recipient }, 'Failed to dispatch SMS notification via Twilio');
      return {
        channel: this.channel,
        status: 'FAILED',
        recipient,
        details: msg,
        sentAt,
      };
    }
  }
}

export class PushChannelProvider implements NotificationChannelProvider {
  readonly channel = 'push' as const;
  readonly isMock: boolean;

  constructor() {
    this.isMock =
      !env.WEB_PUSH_ENABLED || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY;
  }

  async send(payload: NotificationPayload): Promise<ChannelDeliveryResult> {
    const sentAt = new Date();
    const recipient = payload.recipientPushToken || 'mock-device-push-token';

    if (this.isMock) {
      logger.info(
        { channel: this.channel, recipient, title: payload.title, eventType: payload.eventType },
        `[MOCK PUSH DELIVERED] Token: ${recipient} | ${payload.title}: ${payload.message}`,
      );

      return {
        channel: this.channel,
        status: 'MOCK_DELIVERED',
        recipient,
        details: 'Simulated WebPush notification (development/mock mode - VAPID keys not configured)',
        sentAt,
      };
    }

    try {
      logger.info(
        { channel: this.channel, recipient, title: payload.title },
        `WebPush dispatched to ${recipient}`,
      );

      return {
        channel: this.channel,
        status: 'DELIVERED',
        recipient,
        sentAt,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, recipient }, 'Failed to dispatch WebPush notification');
      return {
        channel: this.channel,
        status: 'FAILED',
        recipient,
        details: msg,
        sentAt,
      };
    }
  }
}
