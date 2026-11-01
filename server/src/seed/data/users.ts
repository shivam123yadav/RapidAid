// ── Demo users (password for all: demo123) ──────────────────────────────
// emailVerified is true for every seeded account: these are known demo
// personas, not self-registered citizens, so their login flow is unchanged.
export const DEMO_USERS = [
  { _id: 'USR-001', name: 'Arjun Khan', email: 'dispatcher@rapidaid.com', role: 'DISPATCHER' },
  { _id: 'USR-002', name: 'Dr. Priya Sharma', email: 'crew@rapidaid.com', role: 'AMBULANCE_CREW' },
  { _id: 'USR-003', name: 'Dr. Rajesh Patel', email: 'hospital@rapidaid.com', role: 'HOSPITAL_STAFF', hospitalId: 'HOSP-01' },
  { _id: 'USR-004', name: 'System Administrator', email: 'admin@rapidaid.com', role: 'ADMIN' },
  { _id: 'USR-005', name: 'Meera Iyer', email: 'supervisor@rapidaid.com', role: 'SUPERVISOR' },
  { _id: 'USR-006', name: 'Vikram Sethi', email: 'auditor@rapidaid.com', role: 'AUDITOR' },
  { _id: 'USR-007', name: 'Sana Qureshi', email: 'analyst@rapidaid.com', role: 'ANALYST' },
  { _id: 'USR-008', name: 'Rohan Verma', email: 'citizen@rapidaid.com', role: 'CITIZEN' },
].map((user) => ({ ...user, emailVerified: true }));

// Counter start positions so generated IDs never collide with seeded ones.
export const DEMO_COUNTERS: Record<string, number> = {
  user: DEMO_USERS.length,
  emergency: 20485,
  notification: 6,
  audit: 6,
  // VR-001 and VR-002 are seeded below, so the next allocated id is VR-003.
  voiceReport: 2,
  ambulance: 42,
  hospital: 12,
  shift: 1,
  maintenance: 1,
  camera: 0,
  report: 1,
};
