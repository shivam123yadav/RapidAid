import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { AuditLog, RolePolicy } from '../src/models/index.js';

const app = createApp();
useTestDatabase(runSeed);

describe('fine-grained RBAC and break-glass', () => {
  it('exposes the permission catalog and policy matrix to administrators only', async () => {
    const admin = await loginAs(app, 'admin');
    const dispatcher = await loginAs(app, 'dispatcher');
    const allowed = await request(app).get('/api/admin/permissions').set(bearer(admin));
    expect(allowed.status).toBe(200);
    expect(allowed.body.catalog).toEqual(expect.arrayContaining(['emergency:override', 'permission:manage', 'ambulance:create']));
    expect(allowed.body.roles.ADMIN).toEqual(expect.arrayContaining(['permission:manage']));
    expect((await request(app).get('/api/admin/permissions').set(bearer(dispatcher))).status).toBe(403);
    expect((await request(app).get('/api/admin/users').set(bearer(dispatcher))).status).toBe(403);
  });

  it('records every administrator policy change and invalidates the effective policy', async () => {
    const admin = await loginAs(app, 'admin');
    const before = await RolePolicy.findById('CITIZEN').lean();
    expect(before).toBeNull();
    const matrix = await request(app).get('/api/admin/permissions').set(bearer(admin));
    const response = await request(app)
      .put('/api/admin/permissions/CITIZEN')
      .set(bearer(admin))
      .send({ permissions: matrix.body.roles.CITIZEN, reason: 'Reviewed citizen policy' });
    expect(response.status).toBe(200);
    expect(response.body.revision).toBe(1);
    expect(await RolePolicy.findById('CITIZEN').lean()).toMatchObject({ revision: 1, updatedBy: 'USR-004' });
    const audit = await AuditLog.findOne({ action: 'permission.policy_updated', resourceId: 'CITIZEN' }).lean();
    expect(audit).toMatchObject({ actorId: 'USR-004', reason: 'Reviewed citizen policy' });
  });

  it('allows admin/supervisor override, requires a reason, and denies dispatcher', async () => {
    const admin = await loginAs(app, 'admin');
    const missingReason = await request(app)
      .post('/api/emergencies/EMG-20481/override')
      .set(bearer(admin))
      .send({ action: 'ROUTE_HOSPITAL', hospitalId: 'HOSP-04' });
    expect(missingReason.status).toBe(400);

    const response = await request(app)
      .post('/api/emergencies/EMG-20481/override')
      .set(bearer(admin))
      .send({ action: 'ROUTE_HOSPITAL', hospitalId: 'HOSP-04', reason: 'Critical routing capacity requires supervised change' });
    expect(response.status).toBe(200);
    expect(response.body.emergency.destinationHospital).toBe('HOSP-04');
    const audit = await AuditLog.findOne({ action: 'emergency.override', resourceId: 'HOSP-04' }).lean();
    expect(audit).toMatchObject({ actorId: 'USR-004', reason: 'Critical routing capacity requires supervised change' });
    expect(audit?.previousState).toMatchObject({ destinationHospital: 'HOSP-01' });
    expect(audit?.newState).toMatchObject({ destinationHospital: 'HOSP-04' });

    const dispatcher = await loginAs(app, 'dispatcher');
    const denied = await request(app)
      .post('/api/emergencies/EMG-20481/override')
      .set(bearer(dispatcher))
      .send({ action: 'ESCALATE', reason: 'Dispatcher should not be able to break glass' });
    expect(denied.status).toBe(403);
  });
});
