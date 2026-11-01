/**
 * Scenarios 9 and 12–14 from the RBAC brief:
 *   9  — Auditor cannot modify or delete audit evidence.
 *   12 — Sidebar/navigation changes according to role.
 *   13 — Direct URL access is protected (route guard + API).
 *   14 — Every demo account opens a workspace it is actually allowed to open.
 *
 * 12–14 exercise the REAL client modules (`src/lib/navigation.ts`,
 * `src/lib/permissions.ts`) rather than a re-implementation, and they are fed
 * the REAL permission lists from the server registry. The client has no vitest
 * runner, so it is imported here — both files are dependency-light pure logic.
 * If the client matrix and the server registry ever disagree, these fail.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs, DEMO_USERS } from './helpers.js';
import { permissionsFor } from '../src/authz/permissions.js';
import type { Role } from '../src/validation/constants.js';
// Real shipped client code (outside server/, hence the relative climb).
import { navItemsFor, canAccess, homeRouteFor, normalizePath } from '../../src/lib/navigation.js';
import { fleetPermissions } from '../../src/lib/permissions.js';

const app = createApp();
useTestDatabase(runSeed);

const pathsFor = (role: Role) => navItemsFor(role, permissionsFor(role)).map((item) => item.path);

describe('RBAC scenarios 9, 12–14', () => {
  // ── 9. Audit evidence is immutable ──────────────────────────────────────
  describe('9 — audit trail integrity', () => {
    it('offers no write route: PATCH/POST/DELETE on audit evidence all 404', async () => {
      const token = await loginAs(app, 'auditor');
      expect((await request(app).get('/api/audit').set(bearer(token))).status).toBe(200);

      // Not merely 403 — no such endpoint exists, so the method is not routed.
      for (const method of ['patch', 'post', 'put', 'delete'] as const) {
        const res = await request(app)[method]('/api/audit/LOG-1').set(bearer(token));
        expect(res.status, `auditor must not ${method} audit evidence`).toBe(404);
      }
    });

    it('grants the auditor full read while denying the dispatcher (matrix: No Access)', async () => {
      const auditor = await loginAs(app, 'auditor');
      expect((await request(app).get('/api/audit').set(bearer(auditor))).status).toBe(200);

      const dispatcher = await loginAs(app, 'dispatcher');
      expect((await request(app).get('/api/audit').set(bearer(dispatcher))).status).toBe(403);
    });
  });

  // ── 12. Navigation changes according to role ────────────────────────────
  describe('12 — sidebar changes according to role', () => {
    it('gives the administrator every module', () => {
      const paths = pathsFor('ADMIN');
      expect(paths).toEqual(expect.arrayContaining([
        '/command-center', '/emergencies', '/ambulances', '/hospitals', '/tracking', '/shifts', '/maintenance', '/cameras', '/reports',
        '/ai-vision', '/dispatch', '/voice', '/green-corridor', '/alerts', '/audit', '/settings', '/admin/permissions',
      ]));
    });

    it('keeps dispatcher fleet-visible but out of Audit and Simulations', () => {
      const paths = pathsFor('DISPATCHER');
      expect(paths).toContain('/ambulances');
      expect(paths).toContain('/command-center');
      expect(paths).not.toContain('/audit');   // matrix: No Access
      expect(paths).not.toContain('/simulations');
    });

    it('gives crew a simplified workspace with no command center, AI or dispatch', () => {
      const paths = pathsFor('AMBULANCE_CREW');
      expect(paths).toContain('/emergencies');
      expect(paths).toContain('/ambulances');
      expect(paths).toContain('/tracking');
      expect(paths).toContain('/voice');       // matrix: Create Reports
      expect(paths).toContain('/shifts');
      expect(paths).toContain('/maintenance');
      expect(paths).not.toContain('/cameras');
      expect(paths).not.toContain('/command-center');
      expect(paths).not.toContain('/ai-vision');
      expect(paths).not.toContain('/dispatch');
      expect(paths).not.toContain('/audit');   // matrix: Own Activity only
    });

    it('denies the citizen the fleet, command center and audit', () => {
      const paths = pathsFor('CITIZEN');
      expect(paths).toContain('/emergencies');
      expect(paths).not.toContain('/ambulances');
      expect(paths).not.toContain('/command-center');
      expect(paths).not.toContain('/audit');
    });

    it('gives the auditor audit but no settings (matrix: No Access)', () => {
      const paths = pathsFor('AUDITOR');
      expect(paths).toContain('/audit');
      expect(paths).not.toContain('/settings');
    });

    it('leaves every role with at least one page to open', () => {
      // An empty sidebar would leave a demo user with no way forward.
      for (const role of Object.values(DEMO_USERS).map((u) => u.role)) {
        expect(navItemsFor(role, permissionsFor(role)).length, `${role} has no pages`).toBeGreaterThan(0);
      }
    });
  });

  // ── 13. Direct URL access is protected ─────────────────────────────────
  describe('13 — direct URL access is protected', () => {
    it('blocks a role from a page its permissions do not admit', () => {
      expect(canAccess('/audit', 'DISPATCHER', permissionsFor('DISPATCHER'))).toBe(false);
      expect(canAccess('/command-center', 'CITIZEN', permissionsFor('CITIZEN'))).toBe(false);
      expect(canAccess('/ambulances', 'CITIZEN', permissionsFor('CITIZEN'))).toBe(false);
      // …while allowing what the role may see.
      expect(canAccess('/ambulances', 'DISPATCHER', permissionsFor('DISPATCHER'))).toBe(true);
    });

    it('applies the same rule to a deep link under a guarded page', () => {
      // /emergencies/EMG-1 inherits /emergencies' permissions.
      expect(normalizePath('/emergencies/EMG-20481')).toBe('/emergencies');
      expect(canAccess('/emergencies/EMG-20481', 'DISPATCHER', permissionsFor('DISPATCHER'))).toBe(true);
      expect(canAccess('/ai-vision/det-1', 'AMBULANCE_CREW', permissionsFor('AMBULANCE_CREW'))).toBe(false);
    });

    it('fails closed for a user with no server-issued permission list', () => {
      expect(canAccess('/ambulances', 'DISPATCHER', undefined)).toBe(false);
    });

    it('leaves an unmapped path to the API rather than blanking the page', () => {
      expect(canAccess('/some-future-module', 'CITIZEN', permissionsFor('CITIZEN'))).toBe(true);
    });

    it('enforces the same rule server-side, not just in the router', async () => {
      // Unauthenticated callers are rejected at the gateway.
      expect((await request(app).get('/api/ambulances')).status).toBe(401);

      // The UI guard is UX; the API is the real authority. A citizen attempting
      // administrative or audit access receives 403.
      const citizen = await loginAs(app, 'citizen');
      expect((await request(app).get('/api/audit').set(bearer(citizen))).status).toBe(403);
      expect((await request(app).get('/api/cameras').set(bearer(citizen))).status).toBe(403);
      expect((await request(app).post('/api/ambulances').set(bearer(citizen)).send({ location: { lat: 28.6, lng: 77.2 } })).status).toBe(403);

      // Under Phase 4 live tracking, citizens may read only their assigned responding ambulance.
      const ambRes = await request(app).get('/api/ambulances').set(bearer(citizen));
      expect(ambRes.status).toBe(200);
      expect(ambRes.body).toHaveLength(1);
      expect(ambRes.body[0].id).toBe('AMB-023');

      // Probing other fleet ambulances directly returns 404 (hiding their existence).
      expect((await request(app).get('/api/ambulances/AMB-005').set(bearer(citizen))).status).toBe(404);

      // Dispatchers and supervisors retain full fleet visibility (8 units).
      const dispatcher = await loginAs(app, 'dispatcher');
      const dispRes = await request(app).get('/api/ambulances').set(bearer(dispatcher));
      expect(dispRes.status).toBe(200);
      expect(dispRes.body).toHaveLength(8);
    });
  });

  // ── 14. Demo accounts open the right workspace ─────────────────────────
  describe('14 — demo accounts open a workspace they are allowed to open', () => {
    it('logs every demo role in and lands on a page its own permissions admit', async () => {
      for (const [who, creds] of Object.entries(DEMO_USERS)) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email: creds.email, password: creds.password, role: creds.role });
        expect(res.status, `${who} must be able to log in`).toBe(200);

        const role = res.body.user.role as Role;
        const home = homeRouteFor(role);
        expect(canAccess(home, role, permissionsFor(role)), `${who} lands on ${home} without permission`).toBe(true);
      }
    });

    it('serves each role its own permission list at sign-in', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: DEMO_USERS.crew.email, password: DEMO_USERS.crew.password, role: 'AMBULANCE_CREW' });
      expect(res.status).toBe(200);
      // The client renders from this list, so it must be present and scoped.
      expect(res.body.user.permissions).toContain('ambulance:view:own');
      expect(res.body.user.permissions).not.toContain('ambulance:create');
    });

    it('maps each role to distinct fleet controls in the UI', () => {
      const perms = (role: Role) => fleetPermissions(role, permissionsFor(role));

      // Crew: own unit only, no fleet management buttons.
      const crew = perms('AMBULANCE_CREW');
      expect(crew.ownUnitOnly).toBe(true);
      expect(crew.canManageFleet).toBe(false);
      expect(crew.canAssignToEmergency).toBe(false);
      expect(crew.canDeactivate).toBe(false);

      // Dispatcher: assign only — no add/edit/deactivate.
      const dispatcher = perms('DISPATCHER');
      expect(dispatcher.canAssignToEmergency).toBe(true);
      expect(dispatcher.canManageFleet).toBe(false);
      expect(dispatcher.canDeactivate).toBe(false);

      // Admin: everything; Supervisor: management but not deactivation.
      const admin = perms('ADMIN');
      expect(admin.canManageFleet).toBe(true);
      expect(admin.canDeactivate).toBe(true);
      expect(admin.canViewMaintenance).toBe(true);

      const supervisor = perms('SUPERVISOR');
      expect(supervisor.canManageFleet).toBe(true);
      expect(supervisor.canDeactivate).toBe(false);

      // Read-only roles get no operational controls.
      expect(perms('ANALYST').readOnly).toBe(true);
      expect(perms('AUDITOR').readOnly).toBe(true);
    });
  });
});