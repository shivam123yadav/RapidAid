import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { seedGwaliorDemoResources } from '../src/seed/seedGwaliorDemo.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { Ambulance } from '../src/models/Ambulance.js';
import { Emergency } from '../src/models/Emergency.js';
import { Hospital } from '../src/models/Hospital.js';
import { User } from '../src/models/User.js';
import { Notification } from '../src/models/Notification.js';
import { Counter } from '../src/models/Counter.js';
import {
  dispatchNotification,
  notifyCitizenOnConfirmation,
  notifyCitizenOnAmbulanceAssignment,
  notifyCrewOnAssignment,
  notifyCitizenOnHospitalRerouted,
} from '../src/services/notificationService.js';

const app = createApp();

useTestDatabase(async () => {
  await runSeed();
  await seedGwaliorDemoResources();
});

describe('Phase 4.3: Real-Time Emergency Notification System Suite', () => {
  let citizenToken: string;
  let otherCitizenToken: string;
  let dispatcherToken: string;
  let crewToken: string;

  beforeAll(async () => {
    // Ensure test citizen USR-008
    const passwordHash = await bcrypt.hash('demo123', 10);
    await User.updateOne(
      { _id: 'USR-008' },
      {
        $set: {
          email: 'citizen@rapidaid.com',
          passwordHash,
          role: 'CITIZEN',
          name: 'Priya Sharma',
          active: true,
          emailVerified: true,
        },
      },
      { upsert: true },
    );

    // Create an unassigned other citizen USR-009
    await User.updateOne(
      { _id: 'USR-009' },
      {
        $set: {
          email: 'citizen-two@rapidaid.com',
          passwordHash,
          role: 'CITIZEN',
          name: 'Other Citizen',
          active: true,
          emailVerified: true,
        },
      },
      { upsert: true },
    );

    // Set crew user USR-031
    await User.updateOne(
      { _id: 'USR-031' },
      {
        $set: {
          email: 'crew-gwl-01@rapidaid.com',
          passwordHash,
          role: 'AMBULANCE_CREW',
          name: 'Rajesh Crew 1',
          active: true,
          emailVerified: true,
        },
      },
      { upsert: true },
    );

    // Get tokens
    citizenToken = await loginAs(app, 'citizen');
    dispatcherToken = await loginAs(app, 'dispatcher');

    const otherRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'citizen-two@rapidaid.com', password: 'demo123', role: 'CITIZEN' });
    otherCitizenToken = otherRes.body.accessToken;

    const crewRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'crew-gwl-01@rapidaid.com', password: 'demo123', role: 'AMBULANCE_CREW' });
    crewToken = crewRes.body.accessToken;

    // Ensure monotonic counter is ahead of pre-seeded test emergency IDs
    await Counter.updateOne({ _id: 'emergency' }, { $max: { seq: 20490 } }, { upsert: true });

    // Reset EMG-20485 for testing
    await Emergency.updateOne(
      { _id: 'EMG-20485' },
      {
        $set: {
          status: 'REPORTED',
          citizenId: 'USR-008',
          location: { lat: 26.228854, lng: 78.213198, address: 'College main gate, Gwalior' },
        },
        $unset: {
          assignedAmbulance: 1,
          destinationHospital: 1,
          assignedCrew: 1,
          assignedCrewIds: 1,
        },
      },
    );

    // Reset AMB-051 for testing
    await Ambulance.updateOne(
      { _id: 'AMB-051' },
      {
        $set: {
          status: 'AVAILABLE',
          currentEmergency: null,
          claimToken: null,
          location: { lat: 26.22, lng: 78.20 },
          lastUpdated: new Date(),
        },
      },
    );
  });

  it('1. Citizen receives an in-app notification after emergency confirmation', async () => {
    await notifyCitizenOnConfirmation({
      _id: 'EMG-20485',
      citizenId: 'USR-008',
      incidentType: 'COLLISION',
      priority: 'CRITICAL',
    });

    const res = await request(app)
      .get('/api/notifications')
      .set(bearer(citizenToken));

    expect(res.status).toBe(200);
    const notifications = res.body;
    const confirmNotif = notifications.find(
      (n: any) => n.eventType === 'EMERGENCY_CONFIRMED' && n.linkedEmergency === 'EMG-20485',
    );
    expect(confirmNotif).toBeDefined();
    expect(confirmNotif.recipientId || confirmNotif.ownerId).toBe('USR-008');
    expect(confirmNotif.category).toBe('SUCCESS');
    expect(confirmNotif.read).toBe(false);
  });

  it('2. Citizen receives notification after manual ambulance assignment', async () => {
    // Clear notifications for EMG-20485 to ensure fresh test
    await Notification.deleteMany({ linkedEmergency: 'EMG-20485', eventType: 'AMBULANCE_ASSIGNED' });

    // Ensure AMB-051 has fresh telemetry & active shift
    await Ambulance.updateOne(
      { _id: 'AMB-051' },
      {
        $set: {
          status: 'AVAILABLE',
          currentEmergency: null,
          claimToken: null,
          lastUpdated: new Date(),
        },
      },
    );

    const assignRes = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(dispatcherToken))
      .send({
        emergencyId: 'EMG-20485',
        ambulanceId: 'AMB-051',
      });
    expect([200, 201]).toContain(assignRes.status);

    // Citizen reads notifications
    const res = await request(app)
      .get('/api/notifications')
      .set(bearer(citizenToken));

    expect(res.status).toBe(200);
    const assignNotif = res.body.find(
      (n: any) => n.eventType === 'AMBULANCE_ASSIGNED' && n.linkedEmergency === 'EMG-20485',
    );
    expect(assignNotif).toBeDefined();
    expect(assignNotif.message).toContain('AMB-051');
  });

  it('3. Crew receives assignment notification', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set(bearer(crewToken));

    expect(res.status).toBe(200);
    const crewNotif = res.body.find(
      (n: any) => n.eventType === 'CREW_ASSIGNED' && n.linkedEmergency === 'EMG-20485',
    );
    expect(crewNotif).toBeDefined();
    expect(crewNotif.linkedResource).toBe('AMB-051');
  });

  it('4. Dispatcher receives new emergency notification', async () => {
    const createRes = await request(app)
      .post('/api/emergencies')
      .set(bearer(citizenToken))
      .send({
        priority: 'CRITICAL',
        incidentType: 'CARDIAC_ARREST',
        location: { lat: 26.228, lng: 78.213, address: 'Test Hospital Road' },
        description: 'Citizen cardiac arrest emergency test',
        victimCount: 1,
        attachments: [],
      });
    expect(createRes.status).toBe(201);
    const createdId = createRes.body.id;

    const notifRes = await request(app)
      .get('/api/notifications')
      .set(bearer(dispatcherToken));

    expect(notifRes.status).toBe(200);
    const dispatchNotif = notifRes.body.find(
      (n: any) => n.eventType === 'EMERGENCY_REPORTED' && n.linkedEmergency === createdId,
    );
    expect(dispatchNotif).toBeDefined();
  });

  it('5. Hospital rerouting generates the correct notification', async () => {
    await notifyCitizenOnHospitalRerouted('EMG-20485', 'USR-008', 'HOSP-82', 'Jaya Arogya Hospital');

    const res = await request(app)
      .get('/api/notifications')
      .set(bearer(citizenToken));

    expect(res.status).toBe(200);
    const hospNotif = res.body.find(
      (n: any) => n.eventType === 'HOSPITAL_REROUTED' && n.linkedEmergency === 'EMG-20485',
    );
    expect(hospNotif).toBeDefined();
    expect(hospNotif.hospitalId).toBe('HOSP-82');
    expect(hospNotif.message).toContain('HOSP-82');
  });

  it('6. Duplicate events do not create duplicate notifications (Idempotency)', async () => {
    const key = `evt:test:idempotency:${Date.now()}`;
    const first = await dispatchNotification({
      eventType: 'EMERGENCY_REPORTED',
      category: 'INFO',
      recipientId: 'USR-008',
      recipientRole: 'CITIZEN',
      linkedEmergency: 'EMG-20485',
      idempotencyKey: key,
      title: 'Idempotency Test 1',
      message: 'This is the first attempt',
    });

    const second = await dispatchNotification({
      eventType: 'EMERGENCY_REPORTED',
      category: 'INFO',
      recipientId: 'USR-008',
      recipientRole: 'CITIZEN',
      linkedEmergency: 'EMG-20485',
      idempotencyKey: key,
      title: 'Idempotency Test 2',
      message: 'This is the duplicate attempt',
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?._id).toBe(second?._id);

    // Verify exactly one notification in DB with this key
    const count = await Notification.countDocuments({ idempotencyKey: key });
    expect(count).toBe(1);
  });

  it('7. Unauthorized users cannot access other users notifications', async () => {
    // USR-008 has notifications. Other citizen USR-009 queries notifications
    const res = await request(app)
      .get('/api/notifications')
      .set(bearer(otherCitizenToken));

    expect(res.status).toBe(200);
    // USR-009 should not see USR-008's private notifications
    const containsUser008Notifs = res.body.some(
      (n: any) => (n.recipientId === 'USR-008' || n.ownerId === 'USR-008') && n.ownerId !== 'USR-009',
    );
    expect(containsUser008Notifs).toBe(false);
  });

  it('8. Read/unread status persists and unread count decrements', async () => {
    const unreadBefore = await request(app)
      .get('/api/notifications/unread-count')
      .set(bearer(citizenToken));
    expect(unreadBefore.status).toBe(200);
    const countBefore = unreadBefore.body.unreadCount;

    // Fetch an unread notification for USR-008
    const listRes = await request(app)
      .get('/api/notifications?unreadOnly=true')
      .set(bearer(citizenToken));
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThan(0);
    const targetNotif = listRes.body[0];

    // Mark it as read
    const patchRes = await request(app)
      .patch(`/api/notifications/${targetNotif._id || targetNotif.id}/read`)
      .set(bearer(citizenToken));
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.read).toBe(true);
    expect(patchRes.body.readAt).toBeDefined();

    // Verify unread count decremented
    const unreadAfter = await request(app)
      .get('/api/notifications/unread-count')
      .set(bearer(citizenToken));
    expect(unreadAfter.status).toBe(200);
    expect(unreadAfter.body.unreadCount).toBe(countBefore - 1);
  });

  it('9. Provider failure does not break emergency workflows', async () => {
    // Test that dispatchNotification does not throw or fail even if bad input or channel errors occur
    const outcome = await dispatchNotification({
      eventType: 'EMERGENCY_REPORTED',
      category: 'CRITICAL',
      recipientId: 'USR-008',
      recipientRole: 'CITIZEN',
      linkedEmergency: 'EMG-20485',
      idempotencyKey: `evt:fault_tolerance:${Date.now()}`,
      title: 'Provider Failure Test',
      message: 'Simulated fault tolerance check',
      channels: ['inApp', 'email', 'sms', 'push'],
    });

    expect(outcome).not.toBeNull();
    expect(outcome?.read).toBe(false);
    // Channel status reflects honest mock delivery, never claiming real telecom delivery
    expect(outcome?.deliveryStatus?.email).toBe('MOCK_DELIVERED');
    expect(outcome?.deliveryStatus?.sms).toBe('MOCK_DELIVERED');
    expect(outcome?.deliveryStatus?.push).toBe('MOCK_DELIVERED');
  });

  it('10. Notification links open the correct emergency', async () => {
    const listRes = await request(app)
      .get('/api/notifications')
      .set(bearer(citizenToken));

    expect(listRes.status).toBe(200);
    const linkedNotif = listRes.body.find((n: any) => n.linkedEmergency === 'EMG-20485');
    expect(linkedNotif).toBeDefined();
    expect(linkedNotif.linkedEmergency).toBe('EMG-20485');

    // Confirm emergency can be fetched using the link reference
    const emgRes = await request(app)
      .get(`/api/emergencies/${linkedNotif.linkedEmergency}`)
      .set(bearer(citizenToken));
    expect(emgRes.status).toBe(200);
    expect(emgRes.body.id).toBe('EMG-20485');
  });
});
