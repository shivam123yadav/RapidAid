import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { AuditLog } from '../src/models/index.js';

const app = createApp();
useTestDatabase(runSeed);

describe('operational modules and report exports', () => {
  it('seeds cameras with capability-aware metadata and enforces evidence export', async () => {
    const dispatcher = await loginAs(app, 'dispatcher');
    const liveView = await request(app).get('/api/cameras').set(bearer(dispatcher));
    expect(liveView.status).toBe(200);
    expect(liveView.body).toHaveLength(3);
    expect(liveView.body[0]).not.toHaveProperty('recordingEnabled');
    expect(liveView.body[0]).not.toHaveProperty('retentionDays');

    const analyst = await loginAs(app, 'analyst');
    const evidenceView = await request(app).get('/api/cameras').set(bearer(analyst));
    expect(evidenceView.status).toBe(200);
    expect(evidenceView.body[0]).toHaveProperty('recordingEnabled');
    expect(evidenceView.body[0]).toHaveProperty('retentionDays');

    const auditor = await loginAs(app, 'auditor');
    const admin = await loginAs(app, 'admin');
    expect((await request(app).get('/api/cameras/CAM-NH-24/evidence-export').set(bearer(auditor))).status).toBe(200);
    expect((await request(app).get('/api/cameras/CAM-NH-24/evidence-export').set(bearer(admin))).status).toBe(200);
    expect((await request(app).get('/api/cameras/CAM-NH-24/evidence-export').set(bearer(analyst))).status).toBe(403);

    for (const who of ['crew', 'hospital', 'citizen'] as const) {
      expect((await request(app).get('/api/cameras').set(bearer(await loginAs(app, who)))).status).toBe(403);
    }
  });

  it('lets crew manage only an assigned shift and enforces its state machine', async () => {
    const crew = await loginAs(app, 'crew');
    const list = await request(app).get('/api/shifts').set(bearer(crew));
    expect(list.status).toBe(200);
    expect(list.body.map((shift: { id: string }) => shift.id)).toEqual(['SH-001']);

    const started = await request(app).patch('/api/shifts/SH-001/status').set(bearer(crew)).send({ status: 'ACTIVE' });
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('ACTIVE');
    const duplicate = await request(app).patch('/api/shifts/SH-001/status').set(bearer(crew)).send({ status: 'ACTIVE' });
    expect(duplicate.status).toBe(409);

    const completed = await request(app).patch('/api/shifts/SH-001/status').set(bearer(crew)).send({ status: 'COMPLETED' });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('COMPLETED');

    const unavailable = await request(app).patch('/api/shifts/SH-001/unavailable').set(bearer(crew)).send({ note: 'Unit returned to depot for inspection' });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.notes).toContain('inspection');
  });

  it('allows supervisors to create assigned shifts but not dispatchers or crew', async () => {
    const body = {
      title: 'Central Response Shift',
      startsAt: '2026-02-01T06:00:00.000Z',
      endsAt: '2026-02-01T14:00:00.000Z',
      crewIds: ['USR-002'],
      ambulanceId: 'AMB-031',
    };
    const supervisor = await request(app).post('/api/shifts').set(bearer(await loginAs(app, 'supervisor'))).send(body);
    expect(supervisor.status).toBe(201);
    expect(supervisor.body).toMatchObject({ status: 'PLANNED', crewIds: ['USR-002'], ambulanceId: 'AMB-031' });

    for (const who of ['dispatcher', 'crew', 'analyst', 'auditor', 'hospital', 'citizen'] as const) {
      expect((await request(app).post('/api/shifts').set(bearer(await loginAs(app, who))).send(body)).status).toBe(403);
    }
  });

  it('scopes maintenance reporting and requires approval/resolution workflow', async () => {
    const crew = await loginAs(app, 'crew');
    const own = await request(app).get('/api/maintenance').set(bearer(crew));
    expect(own.status).toBe(200);
    expect(own.body.map((item: { id: string }) => item.id)).toEqual(['MNT-001']);

    const created = await request(app).post('/api/maintenance').set(bearer(crew)).send({
      ambulanceId: 'AMB-031', title: 'Monitor battery check', description: 'Battery drops below twenty percent during transport.', severity: 'HIGH',
    });
    expect(created.status).toBe(201);
    const foreign = await request(app).post('/api/maintenance').set(bearer(crew)).send({
      ambulanceId: 'AMB-017', title: 'Foreign unit check', description: 'This report must be rejected by the ownership guard.', severity: 'LOW',
    });
    expect(foreign.status).toBe(403);

    const supervisor = await loginAs(app, 'supervisor');
    const approved = await request(app).patch('/api/maintenance/MNT-001').set(bearer(supervisor)).send({ status: 'APPROVED' });
    expect(approved.status).toBe(200);
    const missingResolution = await request(app).patch('/api/maintenance/MNT-001').set(bearer(supervisor)).send({ status: 'RESOLVED' });
    expect(missingResolution.status).toBe(400);
    const resolved = await request(app).patch('/api/maintenance/MNT-001').set(bearer(supervisor)).send({ status: 'RESOLVED', resolution: 'Regulator replaced and pressure test passed.' });
    expect(resolved.status).toBe(200);

    for (const who of ['analyst', 'auditor'] as const) {
      const history = await request(app).get('/api/maintenance').set(bearer(await loginAs(app, who)));
      expect(history.status).toBe(200);
      expect(history.body.length).toBeGreaterThanOrEqual(2);
    }
    for (const who of ['hospital', 'citizen'] as const) {
      expect((await request(app).get('/api/maintenance').set(bearer(await loginAs(app, who)))).status).toBe(403);
    }
  });

  it('scopes generated reports to the creator and exports only sanitized data by default', async () => {
    const period = { periodFrom: '2026-01-01T00:00:00.000Z', periodTo: '2026-01-31T23:59:59.000Z' };
    const citizen = await loginAs(app, 'citizen');
    const generated = await request(app).post('/api/reports').set(bearer(citizen)).send({ title: 'My January Incidents', reportType: 'INCIDENT_SUMMARY', ...period });
    expect(generated.status).toBe(201);
    expect(generated.body.summary).toMatchObject({ totalEmergencies: 1, criticalEmergencies: 0 });
    expect(generated.body.emergencyIds).toEqual(['EMG-20482']);
    expect(generated.body).not.toHaveProperty('description');

    const ownList = await request(app).get('/api/reports').set(bearer(citizen));
    expect(ownList.status).toBe(200);
    expect(ownList.body).toHaveLength(1);
    expect((await request(app).get('/api/reports/RPT-001').set(bearer(citizen))).status).toBe(404);

    for (const who of ['crew', 'hospital', 'citizen'] as const) {
      expect((await request(app).get(`/api/reports/${generated.body.id}/export`).set(bearer(await loginAs(app, who)))).status).toBe(403);
    }
    for (const who of ['supervisor', 'dispatcher', 'analyst', 'auditor', 'admin'] as const) {
      const exported = await request(app).get(`/api/reports/${generated.body.id}/export`).set(bearer(await loginAs(app, who)));
      expect(exported.status, `${who} sanitized export`).toBe(200);
      expect(exported.body.classification).toBe('SANITIZED');
      expect(exported.body).not.toHaveProperty('emergencies');
    }
  });

  it('requires all sensitive-report permissions and audits both denial and success', async () => {
    for (const who of ['supervisor', 'dispatcher', 'analyst', 'auditor'] as const) {
      const denied = await request(app).get('/api/reports/RPT-001/sensitive-export').set(bearer(await loginAs(app, who)));
      expect(denied.status, `${who} sensitive export`).toBe(403);
    }
    for (const who of ['crew', 'hospital', 'citizen'] as const) {
      const hidden = await request(app).get('/api/reports/RPT-001/sensitive-export').set(bearer(await loginAs(app, who)));
      expect(hidden.status, `${who} report ownership concealment`).toBe(404);
    }
    const exported = await request(app).get('/api/reports/RPT-001/sensitive-export').set(bearer(await loginAs(app, 'admin')));
    expect(exported.status).toBe(200);
    expect(exported.body.classification).toBe('SENSITIVE');
    expect(exported.body.emergencies).toHaveLength(4);
    expect(exported.body.emergencies[0]).not.toHaveProperty('_id');

    expect(await AuditLog.exists({ action: 'report.sensitive_export_denied', actorId: 'USR-007' })).not.toBeNull();
    expect(await AuditLog.exists({ action: 'report.sensitive_exported', actorId: 'USR-004', resourceId: 'RPT-001' })).not.toBeNull();
  });

  it('minimizes patient fields by scope and never leaks internal ownership ids', async () => {
    const dispatcher = await loginAs(app, 'dispatcher');
    const dispatcherList = await request(app).get('/api/emergencies').set(bearer(dispatcher));
    expect(dispatcherList.status).toBe(200);
    const emg = dispatcherList.body.find((item: { id: string }) => item.id === 'EMG-20482');
    expect(emg).not.toHaveProperty('citizenId');
    expect(emg).not.toHaveProperty('assignedDispatcher');
    expect(emg).not.toHaveProperty('assignedCrewIds');
    expect(emg).toHaveProperty('description');
    expect(emg).toHaveProperty('location');
    expect(emg).not.toHaveProperty('attachments');

    const analyst = await loginAs(app, 'analyst');
    const analystList = await request(app).get('/api/emergencies').set(bearer(analyst));
    expect(analystList.status).toBe(200);
    const analystEmg = analystList.body.find((item: { id: string }) => item.id === 'EMG-20482');
    expect(analystEmg).not.toHaveProperty('citizenId');
    expect(analystEmg).not.toHaveProperty('description');
    expect(analystEmg).not.toHaveProperty('location');
    expect(analystEmg).not.toHaveProperty('attachments');
    expect(analystEmg.timeline[0]).not.toHaveProperty('note');

    const citizen = await loginAs(app, 'citizen');
    const own = await request(app).get('/api/emergencies/EMG-20482').set(bearer(citizen));
    expect(own.status).toBe(200);
    expect(own.body).not.toHaveProperty('citizenId');
    expect(own.body).toHaveProperty('description');
    expect(own.body).toHaveProperty('location');

    const hospital = await loginAs(app, 'hospital');
    const hospIncident = await request(app).get('/api/emergencies/EMG-20481').set(bearer(hospital));
    expect(hospIncident.status).toBe(200);
    expect(hospIncident.body).not.toHaveProperty('citizenId');
    expect(hospIncident.body).toHaveProperty('description');
    expect(hospIncident.body).toHaveProperty('location');
  });

});

