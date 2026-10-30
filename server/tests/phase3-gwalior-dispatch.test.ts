import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { seedGwaliorDemoResources } from '../src/seed/seedGwaliorDemo.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { Ambulance, Emergency, Hospital } from '../src/models/index.js';
import {
  isAmbulanceDispatchEligible,
  isAmbulanceTelemetryFresh,
} from '../src/services/dispatchService.js';
import { verifyAmbulanceCrewDuty } from '../src/services/crewDutyService.js';

const app = createApp();

useTestDatabase(async () => {
  await runSeed();
  await seedGwaliorDemoResources();
});

describe('Phase 3 Gwalior Dispatch Demonstration', () => {
  it('returns both Gwalior test ambulances for EMG-20485 ordered by score within 12 km', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .get('/api/dispatch/recommendations/EMG-20485')
      .set(bearer(token));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);

    const ambIds = res.body.map((r: { ambulanceId: string }) => r.ambulanceId);
    expect(ambIds).toContain('AMB-051');
    expect(ambIds).toContain('AMB-052');

    // Both should be within 12 km (12000m)
    for (const rec of res.body) {
      expect(rec.distance).toBeLessThanOrEqual(12000);
      expect(rec.score).toBeGreaterThan(90);
      expect(rec.capabilities).toContain('Oxygen');
      expect(rec.capabilities).toContain('ICU');
    }

    // Top recommended unit is sorted by score
    expect(res.body[0].score).toBeGreaterThanOrEqual(res.body[1].score);
  });

  it('returns both Gwalior test hospitals for EMG-20485 within 15 km', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .get('/api/dispatch/hospital-recommendations/EMG-20485')
      .set(bearer(token));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);

    const hospIds = res.body.map((r: { hospitalId: string }) => r.hospitalId);
    expect(hospIds).toContain('HOSP-81');
    expect(hospIds).toContain('HOSP-82');

    // Both should be within 15 km (15000m) and operational
    for (const rec of res.body) {
      expect(rec.distance).toBeLessThanOrEqual(15000);
      expect(rec.score).toBeGreaterThan(80);
      expect(rec.emergencyCapacity).toBe('AVAILABLE');
      expect(rec.icuCapacity).toBe('AVAILABLE');
    }

    // HOSP-82 is trauma capable, HOSP-81 has general bed capacity
    const hosp82 = res.body.find((r: { hospitalId: string }) => r.hospitalId === 'HOSP-82');
    const hosp81 = res.body.find((r: { hospitalId: string }) => r.hospitalId === 'HOSP-81');
    expect(hosp82.traumaAvailable).toBe(true);
    expect(hosp81.traumaAvailable).toBe(false);
  });

  it('verifies telemetry freshness, crew duty and shift validity for Gwalior fleet', async () => {
    for (const ambId of ['AMB-051', 'AMB-052']) {
      const ambDoc = await Ambulance.findById(ambId).lean();
      expect(ambDoc).not.toBeNull();
      expect(ambDoc?.status).toBe('AVAILABLE');
      expect(ambDoc?.crew.length).toBe(2);

      const telemetry = isAmbulanceTelemetryFresh(ambDoc);
      expect(telemetry.fresh).toBe(true);
      expect(telemetry.ageSeconds).toBeLessThanOrEqual(300);

      const crewDuty = await verifyAmbulanceCrewDuty(ambId);
      expect(crewDuty.eligible).toBe(true);
      expect(crewDuty.verifiedCrewIds?.length).toBe(2);

      const overall = await isAmbulanceDispatchEligible(ambId);
      expect(overall.eligible).toBe(true);
    }
  });

  it('verifies hospital capacity and reservation metadata', async () => {
    const hosp81 = await Hospital.findById('HOSP-81').lean();
    const hosp82 = await Hospital.findById('HOSP-82').lean();

    expect(hosp81?.status).toBe('OPERATIONAL');
    expect(hosp81?.emergencyCapacity).toBe('AVAILABLE');
    expect(hosp81?.generalBeds).toBeGreaterThanOrEqual(50);
    expect(hosp81?.activeReservationIds).toEqual([]);
    expect(hosp81?.incomingAmbulances).toBe(0);

    expect(hosp82?.status).toBe('OPERATIONAL');
    expect(hosp82?.emergencyCapacity).toBe('AVAILABLE');
    expect(hosp82?.traumaAvailable).toBe(true);
    expect(hosp82?.icuBeds).toBeGreaterThanOrEqual(25);
    expect(hosp82?.activeReservationIds).toEqual([]);
    expect(hosp82?.incomingAmbulances).toBe(0);
  });

  it('allows manual dispatcher assignment and hospital reservation without automatic dispatch', async () => {
    const token = await loginAs(app, 'dispatcher');

    // Confirm initial state is unassigned and not automatically dispatched
    const emgBefore = await Emergency.findById('EMG-20485').lean();
    expect(emgBefore?.status).toBe('REPORTED');
    expect(emgBefore?.assignedAmbulance).toBeUndefined();

    // 1. Manual Dispatcher Assignment
    const assignRes = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: 'EMG-20485', ambulanceId: 'AMB-051' });

    expect(assignRes.status).toBe(201);
    expect(assignRes.body.success).toBe(true);
    expect(assignRes.body.emergencyId).toBe('EMG-20485');
    expect(assignRes.body.ambulanceId).toBe('AMB-051');
    expect(assignRes.body.emergency.status).toBe('AMBULANCE_ASSIGNED');
    expect(assignRes.body.emergency.assignedAmbulance).toBe('AMB-051');

    // 2. Manual Hospital Reservation
    const reserveRes = await request(app)
      .post('/api/hospitals/HOSP-82/reserve')
      .set(bearer(token))
      .send({
        emergencyId: 'EMG-20485',
        resourceType: 'EMERGENCY_ACCEPTANCE',
      });

    expect(reserveRes.status).toBe(201);
    expect(reserveRes.body.success).toBe(true);
    expect(reserveRes.body.reservation.hospitalId).toBe('HOSP-82');
    expect(reserveRes.body.reservation.emergencyId).toBe('EMG-20485');
    expect(reserveRes.body.reservation.status).toBe('CONFIRMED');

    // Verify hospital state updated atomically
    const hospAfter = await Hospital.findById('HOSP-82').lean();
    expect(hospAfter?.incomingAmbulances).toBe(1);
    expect(hospAfter?.activeReservationIds).toContain(reserveRes.body.reservation.id);
  });
});
