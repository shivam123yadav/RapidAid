import request from 'supertest';
import type { Express } from 'express';

/** Demo credentials seeded by runSeed() — one per role. */
export const DEMO_USERS = {
  dispatcher: { email: 'dispatcher@rapidaid.com', password: 'demo123', role: 'DISPATCHER' as const },
  crew: { email: 'crew@rapidaid.com', password: 'demo123', role: 'AMBULANCE_CREW' as const },
  hospital: { email: 'hospital@rapidaid.com', password: 'demo123', role: 'HOSPITAL_STAFF' as const },
  admin: { email: 'admin@rapidaid.com', password: 'demo123', role: 'ADMIN' as const },
  supervisor: { email: 'supervisor@rapidaid.com', password: 'demo123', role: 'SUPERVISOR' as const },
  auditor: { email: 'auditor@rapidaid.com', password: 'demo123', role: 'AUDITOR' as const },
  analyst: { email: 'analyst@rapidaid.com', password: 'demo123', role: 'ANALYST' as const },
  citizen: { email: 'citizen@rapidaid.com', password: 'demo123', role: 'CITIZEN' as const },
} as const;

export type DemoRole = keyof typeof DEMO_USERS;

/** Logs in a demo user and returns a bearer token for Authorization headers. */
export async function loginAs(app: Express, who: DemoRole): Promise<string> {
  const creds = DEMO_USERS[who];
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: creds.email, password: creds.password, role: creds.role });
  if (res.status !== 200) {
    throw new Error(`loginAs(${who}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

/** Convenience: Authorization header object for supertest chains. */
export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
