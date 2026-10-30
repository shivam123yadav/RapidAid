import { logger } from '../config/logger.js';
import { Notification, type NotificationDoc } from '../models/Notification.js';
import { nextId } from '../models/Counter.js';
import {
  EmailChannelProvider,
  PushChannelProvider,
  SmsChannelProvider,
} from './notifications/channels.js';
import type {
  ChannelType,
  DeliveryStatus,
  DomainNotificationInput,
  NotificationCategory,
  NotificationPayload,
} from './notifications/types.js';

export * from './notifications/types.js';
export * from './notifications/channels.js';

const emailProvider = new EmailChannelProvider();
const smsProvider = new SmsChannelProvider();
const pushProvider = new PushChannelProvider();

/**
 * Dispatches an event-driven domain notification to in-app storage and external channels.
 *
 * Guarantees:
 * 1. Idempotency: Duplicate events with the same idempotencyKey are safely de-duplicated.
 * 2. Fault Tolerance: Notification delivery failures NEVER throw or roll back calling operations.
 * 3. Channel Honesty: Mock deliveries are explicitly tagged MOCK_DELIVERED, never claimed as real telecom delivery.
 */
export async function dispatchNotification(
  input: DomainNotificationInput,
): Promise<NotificationDoc | null> {
  try {
    const category: NotificationCategory = input.category ?? 'INFO';
    const channels: ChannelType[] = input.channels ?? ['inApp', 'email', 'sms', 'push'];

    // Generate deterministic idempotency key if not supplied
    const idempotencyKey =
      input.idempotencyKey ||
      `evt:${input.eventType}:${input.linkedEmergency || 'none'}:${input.recipientId || (input.audienceRoles?.join(',') ?? 'broadcast')}`;

    // 1. Check if duplicate event exists
    const existing = await Notification.findOne({ idempotencyKey });
    if (existing) {
      logger.info(
        { idempotencyKey, existingId: existing._id, eventType: input.eventType },
        'Duplicate notification event suppressed by idempotency guard',
      );
      return existing;
    }

    const _id = await nextId('notification', 'N', 3);
    const now = new Date();

    const payload: NotificationPayload = {
      id: _id,
      eventType: input.eventType,
      category,
      title: input.title,
      message: input.message,
      recipientId: input.recipientId,
      recipientRole: input.recipientRole,
      audienceRoles: input.audienceRoles,
      hospitalId: input.hospitalId,
      linkedEmergency: input.linkedEmergency,
      linkedResource: input.linkedResource,
      idempotencyKey,
      metadata: input.metadata,
      timestamp: now,
    };

    // 2. Dispatch to external delivery channels in parallel (fire-and-settle)
    const deliveryStatus: {
      inApp: 'DELIVERED' | 'FAILED';
      email: DeliveryStatus;
      sms: DeliveryStatus;
      push: DeliveryStatus;
    } = {
      inApp: 'DELIVERED',
      email: 'SKIPPED',
      sms: 'SKIPPED',
      push: 'SKIPPED',
    };

    const externalDispatches: Promise<void>[] = [];

    if (channels.includes('email')) {
      externalDispatches.push(
        emailProvider.send(payload).then((res) => {
          deliveryStatus.email = res.status;
        }).catch((err) => {
          logger.warn({ err, channel: 'email' }, 'Email channel delivery failed');
          deliveryStatus.email = 'FAILED';
        }),
      );
    }

    if (channels.includes('sms')) {
      externalDispatches.push(
        smsProvider.send(payload).then((res) => {
          deliveryStatus.sms = res.status;
        }).catch((err) => {
          logger.warn({ err, channel: 'sms' }, 'SMS channel delivery failed');
          deliveryStatus.sms = 'FAILED';
        }),
      );
    }

    if (channels.includes('push')) {
      externalDispatches.push(
        pushProvider.send(payload).then((res) => {
          deliveryStatus.push = res.status;
        }).catch((err) => {
          logger.warn({ err, channel: 'push' }, 'Push channel delivery failed');
          deliveryStatus.push = 'FAILED';
        }),
      );
    }

    await Promise.allSettled(externalDispatches);

    // 3. Persist in-app notification in database
    const notification = await Notification.create({
      _id,
      category,
      eventType: input.eventType,
      title: input.title,
      message: input.message,
      timestamp: now,
      createdAt: now,
      read: false,
      ownerId: input.recipientId,
      recipientRole: input.recipientRole,
      audienceRoles: input.audienceRoles ?? [],
      hospitalId: input.hospitalId,
      linkedEmergency: input.linkedEmergency,
      linkedResource: input.linkedResource,
      idempotencyKey,
      channels,
      deliveryStatus,
      metadata: input.metadata,
    });

    logger.info(
      {
        notificationId: _id,
        eventType: input.eventType,
        recipientId: input.recipientId,
        linkedEmergency: input.linkedEmergency,
        deliveryStatus,
      },
      'Domain notification created and dispatched',
    );

    return notification;
  } catch (err: unknown) {
    // If Mongo duplicate key race condition occurred (E11000)
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('E11000') || (typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000)) {
      if (input.idempotencyKey) {
        const found = await Notification.findOne({ idempotencyKey: input.idempotencyKey });
        if (found) return found;
      }
    }
    logger.error(
      { err, eventType: input.eventType, linkedEmergency: input.linkedEmergency },
      'Notification dispatch encountered an internal failure (non-blocking)',
    );
    return null;
  }
}

// ── Citizen Notifications ──────────────────────────────────────────────────

export async function notifyCitizenOnReport(emergency: {
  _id: string;
  citizenId?: string | null;
  incidentType: string;
  priority: string;
  location?: { address?: string | null };
}): Promise<void> {
  if (!emergency.citizenId) return;
  const address = emergency.location?.address ? ` near ${emergency.location.address}` : '';
  await dispatchNotification({
    eventType: 'EMERGENCY_REPORTED',
    category: 'INFO',
    recipientId: emergency.citizenId,
    recipientRole: 'CITIZEN',
    linkedEmergency: emergency._id,
    idempotencyKey: `evt:citizen:reported:${emergency._id}`,
    title: 'Emergency Report Received',
    message: `Your emergency report for ${emergency.incidentType.replace(/_/g, ' ')}${address} was received. Dispatch Intelligence is evaluating units. (Ref: ${emergency._id})`,
  });
}

export async function notifyCitizenOnConfirmation(emergency: {
  _id: string;
  citizenId?: string | null;
  incidentType: string;
  priority: string;
}): Promise<void> {
  if (!emergency.citizenId) return;
  await dispatchNotification({
    eventType: 'EMERGENCY_CONFIRMED',
    category: 'SUCCESS',
    recipientId: emergency.citizenId,
    recipientRole: 'CITIZEN',
    linkedEmergency: emergency._id,
    idempotencyKey: `evt:citizen:confirmed:${emergency._id}`,
    title: 'Emergency Confirmed by Dispatch',
    message: `Emergency ${emergency._id} has been confirmed with priority ${emergency.priority}. Emergency response resources are being mobilized.`,
  });
}

export async function notifyCitizenOnRejection(
  emergencyId: string,
  citizenId?: string | null,
  reason = 'Closed by dispatcher',
): Promise<void> {
  if (!citizenId) return;
  await dispatchNotification({
    eventType: 'EMERGENCY_REJECTED',
    category: 'WARNING',
    recipientId: citizenId,
    recipientRole: 'CITIZEN',
    linkedEmergency: emergencyId,
    idempotencyKey: `evt:citizen:rejected:${emergencyId}`,
    title: 'Emergency Report Update',
    message: `Emergency report ${emergencyId} was reviewed and closed: ${reason}.`,
  });
}

export async function notifyCitizenOnAmbulanceAssignment(
  emergencyId: string,
  citizenId: string | null | undefined,
  ambulanceId: string,
  etaSeconds?: number | null,
): Promise<void> {
  if (!citizenId) return;
  const etaText = etaSeconds ? ` Estimated arrival: ${Math.round(etaSeconds / 60)} min.` : '';
  await dispatchNotification({
    eventType: 'AMBULANCE_ASSIGNED',
    category: 'SUCCESS',
    recipientId: citizenId,
    recipientRole: 'CITIZEN',
    linkedEmergency: emergencyId,
    linkedResource: ambulanceId,
    idempotencyKey: `evt:citizen:amb_assigned:${emergencyId}:${ambulanceId}`,
    title: 'Ambulance Unit Assigned',
    message: `Unit ${ambulanceId} has been assigned to your incident.${etaText} Track live progress on the map.`,
  });
}

export async function notifyCitizenOnAmbulanceEnRoute(
  emergencyId: string,
  citizenId: string | null | undefined,
  ambulanceId: string,
  etaSeconds?: number | null,
): Promise<void> {
  if (!citizenId) return;
  const etaText = etaSeconds ? ` Estimated arrival: ${Math.round(etaSeconds / 60)} min.` : '';
  await dispatchNotification({
    eventType: 'AMBULANCE_EN_ROUTE',
    category: 'INFO',
    recipientId: citizenId,
    recipientRole: 'CITIZEN',
    linkedEmergency: emergencyId,
    linkedResource: ambulanceId,
    idempotencyKey: `evt:citizen:amb_en_route:${emergencyId}:${ambulanceId}`,
    title: 'Ambulance En Route',
    message: `Ambulance ${ambulanceId} is on the way to your location.${etaText}`,
  });
}

export async function notifyCitizenOnAmbulanceAtScene(
  emergencyId: string,
  citizenId: string | null | undefined,
  ambulanceId: string,
): Promise<void> {
  if (!citizenId) return;
  await dispatchNotification({
    eventType: 'AMBULANCE_AT_SCENE',
    category: 'SUCCESS',
    recipientId: citizenId,
    recipientRole: 'CITIZEN',
    linkedEmergency: emergencyId,
    linkedResource: ambulanceId,
    idempotencyKey: `evt:citizen:amb_at_scene:${emergencyId}:${ambulanceId}`,
    title: 'Ambulance Arrived at Scene',
    message: `Ambulance ${ambulanceId} has arrived at the incident site. First responders are on scene.`,
  });
}

export async function notifyCitizenOnPatientOnboard(
  emergencyId: string,
  citizenId: string | null | undefined,
  ambulanceId: string,
  hospitalId?: string | null,
): Promise<void> {
  if (!citizenId) return;
  const hospText = hospitalId ? ` and preparing for transport to hospital ${hospitalId}` : '';
  await dispatchNotification({
    eventType: 'PATIENT_ONBOARD',
    category: 'INFO',
    recipientId: citizenId,
    recipientRole: 'CITIZEN',
    linkedEmergency: emergencyId,
    linkedResource: ambulanceId,
    idempotencyKey: `evt:citizen:patient_onboard:${emergencyId}`,
    title: 'Patient Received on Ambulance',
    message: `Patient is onboard unit ${ambulanceId}${hospText}.`,
  });
}

export async function notifyCitizenOnHospitalRerouted(
  emergencyId: string,
  citizenId: string | null | undefined,
  hospitalId: string,
  hospitalName?: string,
): Promise<void> {
  if (!citizenId) return;
  const nameText = hospitalName ? ` (${hospitalName})` : '';
  await dispatchNotification({
    eventType: 'HOSPITAL_REROUTED',
    category: 'INFO',
    recipientId: citizenId,
    recipientRole: 'CITIZEN',
    linkedEmergency: emergencyId,
    hospitalId,
    idempotencyKey: `evt:citizen:hosp_rerouted:${emergencyId}:${hospitalId}`,
    title: 'Destination Hospital Selected',
    message: `Destination hospital reserved: ${hospitalId}${nameText}. Trauma admission capacity verified.`,
  });
}

export async function notifyCitizenOnArrivalAtHospital(
  emergencyId: string,
  citizenId: string | null | undefined,
  hospitalId: string,
): Promise<void> {
  if (!citizenId) return;
  await dispatchNotification({
    eventType: 'AMBULANCE_AT_HOSPITAL',
    category: 'SUCCESS',
    recipientId: citizenId,
    recipientRole: 'CITIZEN',
    linkedEmergency: emergencyId,
    hospitalId,
    idempotencyKey: `evt:citizen:at_hospital:${emergencyId}:${hospitalId}`,
    title: 'Arrived at Destination Hospital',
    message: `Ambulance has arrived at hospital ${hospitalId}. Patient transfer to emergency team underway.`,
  });
}

// ── Dispatcher Notifications ───────────────────────────────────────────────

export async function notifyDispatchersOnNewEmergency(emergency: {
  _id: string;
  priority: string;
  incidentType: string;
  location?: { address?: string | null };
}): Promise<void> {
  const address = emergency.location?.address ? ` near ${emergency.location.address}` : '';
  await dispatchNotification({
    eventType: 'EMERGENCY_REPORTED',
    category: emergency.priority === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
    audienceRoles: ['DISPATCHER', 'SUPERVISOR'],
    linkedEmergency: emergency._id,
    idempotencyKey: `evt:dispatcher:new_emg:${emergency._id}`,
    title: `New Emergency Incident ${emergency._id}`,
    message: `Priority ${emergency.priority}: ${emergency.incidentType.replace(/_/g, ' ')}${address}. Manual review & dispatch required.`,
  });
}

export async function notifyDispatchersOnVoiceReport(voiceReport: {
  _id: string;
  summary?: string | null;
  location?: { address?: string | null };
}): Promise<void> {
  await dispatchNotification({
    eventType: 'VOICE_CONFIRMATION_REQUIRED',
    category: 'WARNING',
    audienceRoles: ['DISPATCHER', 'SUPERVISOR'],
    linkedResource: voiceReport._id,
    idempotencyKey: `evt:dispatcher:voice_conf:${voiceReport._id}`,
    title: `Voice Report ${voiceReport._id} Requires Confirmation`,
    message: `A citizen emergency voice submission has been transcribed and requires dispatcher confirmation before response dispatch.`,
  });
}

export async function notifyDispatchersOnNoAmbulance(emergencyId: string): Promise<void> {
  await dispatchNotification({
    eventType: 'NO_AMBULANCE_AVAILABLE',
    category: 'CRITICAL',
    audienceRoles: ['DISPATCHER', 'SUPERVISOR'],
    linkedEmergency: emergencyId,
    idempotencyKey: `evt:dispatcher:no_ambulance:${emergencyId}`,
    title: `No Available Ambulances for ${emergencyId}`,
    message: `Dispatch Intelligence found 0 eligible ambulances within operational radius for incident ${emergencyId}. Supervisor escalation advised.`,
  });
}

export async function notifyDispatchersOnStaleTelemetry(
  ambulanceId: string,
  ageSeconds: number,
): Promise<void> {
  await dispatchNotification({
    eventType: 'TELEMETRY_STALE',
    category: 'WARNING',
    audienceRoles: ['DISPATCHER', 'SUPERVISOR'],
    linkedResource: ambulanceId,
    idempotencyKey: `evt:dispatcher:stale_gps:${ambulanceId}:${Math.floor(Date.now() / 300000)}`,
    title: `Ambulance ${ambulanceId} Telemetry Stale`,
    message: `Ambulance ${ambulanceId} has not sent GPS telemetry for ${Math.round(ageSeconds / 60)} minutes (> 300s threshold). Vehicle may be in a coverage dead zone.`,
  });
}

export async function notifyDispatchersOnHospitalReservationFailure(
  emergencyId: string,
  hospitalId: string,
  reason: string,
): Promise<void> {
  await dispatchNotification({
    eventType: 'HOSPITAL_RESERVATION_FAILED',
    category: 'CRITICAL',
    audienceRoles: ['DISPATCHER', 'SUPERVISOR'],
    linkedEmergency: emergencyId,
    hospitalId,
    idempotencyKey: `evt:dispatcher:hosp_res_failed:${emergencyId}:${hospitalId}`,
    title: `Hospital Reservation Failed for ${emergencyId}`,
    message: `Attempted reservation at ${hospitalId} failed: ${reason}. Please select an alternative facility.`,
  });
}

export async function notifySupervisorsOnOverride(
  emergencyId: string,
  actor: string,
  action: string,
  reason: string,
): Promise<void> {
  await dispatchNotification({
    eventType: 'SUPERVISOR_ATTENTION_REQUIRED',
    category: 'CRITICAL',
    audienceRoles: ['SUPERVISOR'],
    linkedEmergency: emergencyId,
    idempotencyKey: `evt:supervisor:override:${emergencyId}:${Date.now()}`,
    title: `Break-Glass Override on ${emergencyId}`,
    message: `User ${actor} executed emergency override '${action}' on ${emergencyId}. Reason: "${reason}". Review required.`,
  });
}

// ── Ambulance Crew Notifications ───────────────────────────────────────────

export async function notifyCrewOnAssignment(
  ambulanceId: string,
  crewUserIds: string[],
  emergency: {
    _id: string;
    incidentType: string;
    priority: string;
    location?: { address?: string | null };
  },
): Promise<void> {
  const address = emergency.location?.address ? ` at ${emergency.location.address}` : '';
  for (const userId of crewUserIds) {
    await dispatchNotification({
      eventType: 'CREW_ASSIGNED',
      category: emergency.priority === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
      recipientId: userId,
      recipientRole: 'AMBULANCE_CREW',
      linkedEmergency: emergency._id,
      linkedResource: ambulanceId,
      idempotencyKey: `evt:crew:assigned:${ambulanceId}:${emergency._id}:${userId}`,
      title: `Emergency Assignment: ${emergency._id}`,
      message: `Your unit ${ambulanceId} has been dispatched to ${emergency.incidentType.replace(/_/g, ' ')}${address}. Priority: ${emergency.priority}. Proceed safely.`,
    });
  }
}

export async function notifyCrewOnLocationUpdate(
  ambulanceId: string,
  crewUserIds: string[],
  emergencyId: string,
  newAddress: string,
): Promise<void> {
  for (const userId of crewUserIds) {
    await dispatchNotification({
      eventType: 'LOCATION_UPDATED',
      category: 'WARNING',
      recipientId: userId,
      recipientRole: 'AMBULANCE_CREW',
      linkedEmergency: emergencyId,
      linkedResource: ambulanceId,
      idempotencyKey: `evt:crew:location_updated:${emergencyId}:${userId}`,
      title: `Location Update for ${emergencyId}`,
      message: `Destination instructions updated for ${emergencyId}: ${newAddress}. Check navigation map.`,
    });
  }
}

export async function notifyCrewOnHospitalRerouted(
  ambulanceId: string,
  crewUserIds: string[],
  emergencyId: string,
  hospitalId: string,
  hospitalName?: string,
): Promise<void> {
  const nameText = hospitalName ? ` (${hospitalName})` : '';
  for (const userId of crewUserIds) {
    await dispatchNotification({
      eventType: 'HOSPITAL_REROUTED',
      category: 'INFO',
      recipientId: userId,
      recipientRole: 'AMBULANCE_CREW',
      linkedEmergency: emergencyId,
      hospitalId,
      linkedResource: ambulanceId,
      idempotencyKey: `evt:crew:hosp_rerouted:${emergencyId}:${hospitalId}:${userId}`,
      title: `Hospital Destination: ${hospitalId}`,
      message: `Destination hospital set to ${hospitalId}${nameText}. Emergency bay acceptance reserved.`,
    });
  }
}

export async function notifyCrewOnAssignmentCancelled(
  ambulanceId: string,
  crewUserIds: string[],
  emergencyId: string,
  reason = 'Released by dispatch',
): Promise<void> {
  for (const userId of crewUserIds) {
    await dispatchNotification({
      eventType: 'ASSIGNMENT_CANCELLED',
      category: 'INFO',
      recipientId: userId,
      recipientRole: 'AMBULANCE_CREW',
      linkedEmergency: emergencyId,
      linkedResource: ambulanceId,
      idempotencyKey: `evt:crew:cancelled:${emergencyId}:${userId}`,
      title: `Assignment Cancelled: ${emergencyId}`,
      message: `Response assignment for ${emergencyId} on unit ${ambulanceId} has been released: ${reason}. Return to base or await next assignment.`,
    });
  }
}
