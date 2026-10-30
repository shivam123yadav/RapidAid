export const AMBULANCES_PART_2 = [
  {
    _id: 'AMB-005',
    status: 'AVAILABLE',
    location: { lat: 28.62, lng: 77.215 },
    speed: 0,
    heading: 0,
    crew: [
      { _id: 'C007', name: 'Dr. Reddy', role: 'Physician', certification: ['ACLS', 'Emergency'] },
      { _id: 'C008', name: 'Paramedic Joshi', role: 'Paramedic', certification: ['BLS', 'PHTLS'] },
    ],
    capabilities: ['Basic', 'ICU', 'Oxygen', 'Defibrillator'],
    equipment: ['Standard Kit', 'Oxygen', 'Monitor'],
    lastUpdated: new Date('2026-01-15T08:15:00Z'),
  },
  {
    _id: 'AMB-031',
    status: 'AVAILABLE',
    location: { lat: 28.64, lng: 77.23 },
    speed: 0,
    heading: 0,
    crew: [
      // C009 is the demo login crew@rapidaid.com (USR-002, Dr. Priya Sharma).
      // This userId is what makes "your assigned ambulance" enforceable.
      { _id: 'C009', name: 'Dr. Nair', role: 'Physician', certification: ['ACLS', 'Trauma'], userId: 'USR-002' },
      { _id: 'C010', name: 'EMT Das', role: 'EMT', certification: ['BLS'] },
    ],
    capabilities: ['Trauma', 'Basic', 'Oxygen'],
    equipment: ['Trauma Kit', 'Splint Kit', 'Oxygen'],
    lastUpdated: new Date('2026-01-15T09:00:00Z'),
  },
  {
    _id: 'AMB-042',
    status: 'MAINTENANCE',
    location: { lat: 28.605, lng: 77.205 },
    speed: 0,
    heading: 0,
    crew: [],
    capabilities: ['Basic', 'Oxygen'],
    equipment: ['Standard Kit'],
    lastUpdated: new Date('2026-01-15T06:00:00Z'),
  },
];
