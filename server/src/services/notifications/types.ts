export type ChannelType = 'inApp' | 'email' | 'sms' | 'push';

export type DeliveryStatus = 'DELIVERED' | 'MOCK_DELIVERED' | 'FAILED' | 'SKIPPED';

export type NotificationCategory = 'CRITICAL' | 'WARNING' | 'INFO' | 'SUCCESS';

export type NotificationEventType =
  // Citizen events
  | 'EMERGENCY_REPORTED'
  | 'EMERGENCY_CONFIRMED'
  | 'EMERGENCY_REJECTED'
  | 'AMBULANCE_ASSIGNED'
  | 'AMBULANCE_EN_ROUTE'
  | 'AMBULANCE_AT_SCENE'
  | 'PATIENT_ONBOARD'
  | 'HOSPITAL_RESERVED'
  | 'HOSPITAL_REROUTED'
  | 'AMBULANCE_AT_HOSPITAL'
  | 'EMERGENCY_COMPLETED'
  // Dispatcher events
  | 'VOICE_CONFIRMATION_REQUIRED'
  | 'NO_AMBULANCE_AVAILABLE'
  | 'TELEMETRY_STALE'
  | 'HOSPITAL_RESERVATION_FAILED'
  | 'SUPERVISOR_ATTENTION_REQUIRED'
  // Crew events
  | 'CREW_ASSIGNED'
  | 'LOCATION_UPDATED'
  | 'ASSIGNMENT_CANCELLED'
  | 'GENERAL';

export interface ChannelDeliveryResult {
  channel: ChannelType;
  status: DeliveryStatus;
  recipient?: string;
  details?: string;
  sentAt: Date;
}

export interface NotificationPayload {
  id: string;
  eventType: NotificationEventType;
  category: NotificationCategory;
  title: string;
  message: string;
  recipientId?: string;
  recipientRole?: string;
  recipientEmail?: string;
  recipientPhone?: string;
  recipientPushToken?: string;
  linkedEmergency?: string;
  linkedResource?: string;
  audienceRoles?: string[];
  hospitalId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface NotificationChannelProvider {
  readonly channel: ChannelType;
  readonly isMock: boolean;
  send(payload: NotificationPayload): Promise<ChannelDeliveryResult>;
}

export interface DomainNotificationInput {
  eventType: NotificationEventType;
  category?: NotificationCategory;
  title: string;
  message: string;
  recipientId?: string;
  recipientRole?: string;
  audienceRoles?: string[];
  hospitalId?: string;
  linkedEmergency?: string;
  linkedResource?: string;
  idempotencyKey?: string;
  channels?: ChannelType[];
  metadata?: Record<string, unknown>;
}
