export const DEMO_CAMERAS = [
  {
    _id: 'CAM-NH-24', name: 'NH-24 Intersection Camera', zone: 'Connaught Place',
    location: { lat: 28.6139, lng: 77.209, address: 'NH-24 Intersection' },
    status: 'ONLINE', liveEnabled: true, recordingEnabled: true, retentionDays: 30,
    lastHeartbeatAt: new Date('2026-01-15T09:20:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-15T09:20:00Z'),
  },
  {
    _id: 'CAM-CP-08', name: 'Connaught Place Sector 3', zone: 'Connaught Place',
    location: { lat: 28.63, lng: 77.22, address: 'Connaught Place Sector 3' },
    status: 'ONLINE', liveEnabled: true, recordingEnabled: true, retentionDays: 45,
    lastHeartbeatAt: new Date('2026-01-15T09:15:30Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-15T09:15:30Z'),
  },
  {
    _id: 'CAM-RK-12', name: 'Rajpath Crossing Camera', zone: 'Rajpath',
    location: { lat: 28.618, lng: 77.228, address: 'Rajpath Crossing' },
    status: 'DEGRADED', liveEnabled: true, recordingEnabled: false, retentionDays: 14,
    lastHeartbeatAt: new Date('2026-01-15T09:10:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-15T09:10:00Z'),
  },
];

const shiftStart = new Date(Date.now() - 60 * 60 * 1000);
const shiftEnd = new Date(shiftStart.getTime() + 8 * 60 * 60 * 1000);
export const DEMO_SHIFTS = [{
  _id: 'SH-001', title: 'North District Trauma Shift', startsAt: shiftStart, endsAt: shiftEnd,
  status: 'PLANNED', crewIds: ['USR-002'], ambulanceId: 'AMB-031', createdBy: 'USR-005',
  notes: 'Primary trauma response unit for the northern district.', createdAt: new Date(), updatedAt: new Date(),
}];

export const DEMO_MAINTENANCE = [{
  _id: 'MNT-001', ambulanceId: 'AMB-031', title: 'Oxygen regulator inspection',
  description: 'Quarterly inspection requested after pressure reading variance.', severity: 'MEDIUM',
  status: 'OPEN', reportedBy: 'USR-002', createdAt: new Date('2026-01-15T08:45:00Z'),
  updatedAt: new Date('2026-01-15T08:45:00Z'),
}];

export const DEMO_REPORTS = [{
  _id: 'RPT-001', title: 'Daily Operations Snapshot', reportType: 'INCIDENT_SUMMARY',
  periodFrom: new Date('2026-01-15T00:00:00Z'), periodTo: new Date('2026-01-15T23:59:59Z'),
  status: 'READY', createdBy: 'USR-007', generatedBy: 'USR-007',
  emergencyIds: ['EMG-20481', 'EMG-20482', 'EMG-20483', 'EMG-20484'],
  summary: { totalEmergencies: 4, activeEmergencies: 3, completedEmergencies: 1,
    cancelledEmergencies: 0, criticalEmergencies: 1, totalVictims: 6, averageVictims: 1.5,
    byPriority: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1 },
    byStatus: { EN_ROUTE: 1, AT_SCENE: 1, PATIENT_ONBOARD: 1, COMPLETED: 1 } },
  generatedAt: new Date('2026-01-15T10:00:00Z'), createdAt: new Date('2026-01-15T10:00:00Z'),
  updatedAt: new Date('2026-01-15T10:00:00Z'),
}];
