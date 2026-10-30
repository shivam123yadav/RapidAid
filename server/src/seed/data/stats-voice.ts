
export const DEMO_DAILY_STATS = [
  { _id: '2026-01-09', emergencyCount: 42, medianResponseSeconds: 480, p90ResponseSeconds: 720, ambulanceUtilizationPct: 72 },
  { _id: '2026-01-10', emergencyCount: 38, medianResponseSeconds: 450, p90ResponseSeconds: 690, ambulanceUtilizationPct: 68 },
  { _id: '2026-01-11', emergencyCount: 51, medianResponseSeconds: 510, p90ResponseSeconds: 780, ambulanceUtilizationPct: 81 },
  { _id: '2026-01-12', emergencyCount: 45, medianResponseSeconds: 460, p90ResponseSeconds: 700, ambulanceUtilizationPct: 74 },
  { _id: '2026-01-13', emergencyCount: 39, medianResponseSeconds: 440, p90ResponseSeconds: 660, ambulanceUtilizationPct: 65 },
  { _id: '2026-01-14', emergencyCount: 47, medianResponseSeconds: 470, p90ResponseSeconds: 710, ambulanceUtilizationPct: 70 },
  { _id: '2026-01-15', emergencyCount: 53, medianResponseSeconds: 430, p90ResponseSeconds: 650, ambulanceUtilizationPct: 78 },
];

/**
 * How long each seeded demo recording claims to be, in seconds.
 *
 * The bytes themselves are synthesised at seed time rather than committed, and
 * the `audio` metadata is filled in by the seeder — the storage key is minted
 * per upload, so it cannot be a static value in a data file.
 */
export const DEMO_VOICE_AUDIO_SECONDS: Record<string, number> = { 'VR-001': 11, 'VR-002': 8 };

/**
 * VR-001 — a live draft on an active emergency.
 *
 * Deliberately `DRAFT`: this is the record that demonstrates the review queue,
 * so it must not be visible as confirmed evidence to an Auditor or an Analyst.
 * `EMG-20482` is the citizen's own report and is assigned to crew `USR-002`, so
 * the citizen, that crew member and the dispatcher all reach it through
 * *different* scopes — which is exactly what the access tests exercise.
 */
export const DEMO_VOICE_REPORT = {
  _id: 'VR-001',
  ownerId: 'USR-008',
  emergencyId: 'EMG-20482',
  transcript:
    "There's been an accident near Rajpath crossing. A car hit a motorcycle. The rider is on the ground and not moving. I think his leg is badly injured. Please send help quickly.",
  extractedData: {
    incidentType: 'VEHICLE_COLLISION',
    location: 'Rajpath crossing, New Delhi',
    victimCount: 1,
    description: 'Car-motorcycle collision, rider injured, possible leg injury',
  },
  extractedInformation: {
    emergencyType: 'VEHICLE_COLLISION',
    severity: 'HIGH',
    description: 'Car-motorcycle collision, rider injured, possible leg injury',
    injuredPeople: 1,
    spokenLocation: 'Rajpath crossing',
    landmarks: ['Rajpath crossing'],
    city: 'New Delhi',
    state: 'Delhi',
    dispatchHints: ['Possible leg injury', 'Rider unresponsive'],
  },
  confidence: 89.4,
  status: 'DRAFT',
  dispatchStatus: 'DISPATCHER_NOTIFIED',
  location: {
    latitude: 28.6129,
    longitude: 77.2295,
    address: 'Rajpath crossing, New Delhi',
    spokenLocation: 'Rajpath crossing',
    source: 'SPOKEN',
    status: 'RESOLVED',
  },
  createdAt: new Date('2026-01-15T09:22:00Z'),
};

/**
 * VR-002 — a confirmed record routed to a hospital.
 *
 * `CONFIRMED` plus a `hospitalRouting` block is what puts it in the auditable
 * evidence set and the analytical set, and the routing to `HOSP-01` is what the
 * `HOSPITAL_STAFF` account is scoped against. This is the report a hospital
 * login and an auditor can legitimately open, and the one whose recording a
 * hospital login is allowed to play.
 */
export const DEMO_VOICE_REPORT_CONFIRMED = {
  _id: 'VR-002',
  ownerId: 'USR-008',
  emergencyId: 'EMG-20481',
  transcript:
    'My father collapsed at the bus stop near the hospital gate. He is breathing but he is not responding to me. He has chest pain and he looks grey.',
  extractedData: {
    incidentType: 'CARDIAC_ARREST',
    location: 'AIIMS main gate, New Delhi',
    victimCount: 1,
    description: 'Sudden collapse, unresponsive, chest pain',
  },
  extractedInformation: {
    emergencyType: 'CARDIAC_ARREST',
    severity: 'CRITICAL',
    description: 'Sudden collapse, unresponsive, chest pain',
    injuredPeople: 1,
    spokenLocation: 'near the hospital gate',
    landmarks: ['AIIMS main gate'],
    city: 'New Delhi',
    state: 'Delhi',
    dispatchHints: ['Unresponsive', 'Chest pain', 'Possible cardiac arrest'],
  },
  confidence: 92.1,
  status: 'CONFIRMED',
  dispatchStatus: 'COMPLETED',
  location: {
    latitude: 28.5672,
    longitude: 77.21,
    address: 'AIIMS Trauma Center, New Delhi',
    spokenLocation: 'near the hospital gate',
    source: 'SPOKEN',
    status: 'RESOLVED',
  },
  hospitalRouting: {
    hospitalId: 'HOSP-01',
    hospitalName: 'AIIMS Trauma Center',
    distance: 1.2,
    etaSeconds: 240,
    routingReason: 'NEAREST_WITH_REQUIRED_CAPABILITY',
    selectedAt: new Date('2026-01-15T08:26:00Z'),
  },
  createdAt: new Date('2026-01-15T08:21:40Z'),
};

/** Every seeded voice report, in display order. */
export const DEMO_VOICE_REPORTS = [DEMO_VOICE_REPORT, DEMO_VOICE_REPORT_CONFIRMED];

