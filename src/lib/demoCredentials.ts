import type { UserRole } from '../types';

/**
 * Demo personas seeded server-side (server/src/seed/data/users.ts).
 *
 * The password is intentionally public: these accounts exist only in the
 * demonstration environment and are listed on the sign-in screen.
 */
export const DEMO_PASSWORD = 'demo123';

export const DEMO_CREDENTIALS: Record<UserRole, string> = {
  DISPATCHER: 'dispatcher@rapidaid.com',
  AMBULANCE_CREW: 'crew@rapidaid.com',
  HOSPITAL_STAFF: 'hospital@rapidaid.com',
  ADMIN: 'admin@rapidaid.com',
  SUPERVISOR: 'supervisor@rapidaid.com',
  ANALYST: 'analyst@rapidaid.com',
  AUDITOR: 'auditor@rapidaid.com',
  CITIZEN: 'citizen@rapidaid.com',
};
