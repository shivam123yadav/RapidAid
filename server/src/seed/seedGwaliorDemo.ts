import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {
  Ambulance,
  Hospital,
  Shift,
  User,
  Emergency,
} from '../models/index.js';
import { logger } from '../config/logger.js';
import { haversineMeters } from '../utils/geo.js';

export const GWALIOR_EMERGENCY_COORDS = {
  lat: 26.228854,
  lng: 78.213198,
};

export const GWALIOR_DEMO_USERS = [
  {
    _id: 'USR-031',
    name: 'DEMO Paramedic Rahul Verma',
    email: 'crew-gwl-01@rapidaid.com',
    role: 'AMBULANCE_CREW' as const,
    active: true,
    emailVerified: true,
  },
  {
    _id: 'USR-032',
    name: 'DEMO EMT Sunita Rao',
    email: 'crew-gwl-02@rapidaid.com',
    role: 'AMBULANCE_CREW' as const,
    active: true,
    emailVerified: true,
  },
  {
    _id: 'USR-033',
    name: 'DEMO Dr. Alok Mishra',
    email: 'crew-gwl-03@rapidaid.com',
    role: 'AMBULANCE_CREW' as const,
    active: true,
    emailVerified: true,
  },
  {
    _id: 'USR-034',
    name: 'DEMO EMT Neha Gupta',
    email: 'crew-gwl-04@rapidaid.com',
    role: 'AMBULANCE_CREW' as const,
    active: true,
    emailVerified: true,
  },
];

export const GWALIOR_DEMO_AMBULANCES = [
  {
    _id: 'AMB-051',
    status: 'AVAILABLE' as const,
    location: {
      lat: 26.242,
      lng: 78.22,
      address: 'DEMO Fleet Station North, Phool Bagh, Gwalior',
    },
    speed: 0,
    heading: 0,
    crew: [
      {
        _id: 'C031',
        name: 'DEMO Paramedic Rahul Verma',
        role: 'Paramedic',
        certification: ['ACLS', 'Trauma'],
        userId: 'USR-031',
      },
      {
        _id: 'C032',
        name: 'DEMO EMT Sunita Rao',
        role: 'EMT',
        certification: ['BLS', 'PHTLS'],
        userId: 'USR-032',
      },
    ],
    capabilities: ['Trauma', 'ICU', 'Oxygen', 'Defibrillator', 'Basic'],
    equipment: ['Trauma Kit', 'ICU Monitor', 'Oxygen Cylinder', 'Defibrillator', 'IV Supplies'],
    active: true,
  },
  {
    _id: 'AMB-052',
    status: 'AVAILABLE' as const,
    location: {
      lat: 26.215,
      lng: 78.2,
      address: 'DEMO Fleet Station South, Lashkar, Gwalior',
    },
    speed: 0,
    heading: 0,
    crew: [
      {
        _id: 'C033',
        name: 'DEMO Dr. Alok Mishra',
        role: 'Physician',
        certification: ['ACLS', 'Critical Care'],
        userId: 'USR-033',
      },
      {
        _id: 'C034',
        name: 'DEMO EMT Neha Gupta',
        role: 'EMT',
        certification: ['BLS'],
        userId: 'USR-034',
      },
    ],
    capabilities: ['ICU', 'Oxygen', 'Ventilator', 'Basic', 'Medications'],
    equipment: ['Ventilator', 'Oxygen Cylinder', 'Medication Kit', 'Stretcher', 'Cardiac Monitor'],
    active: true,
  },
];

export const GWALIOR_DEMO_HOSPITALS = [
  {
    _id: 'HOSP-81',
    name: 'DEMO Gwalior District Hospital',
    status: 'OPERATIONAL' as const,
    operationalStatus: 'OPERATIONAL' as const,
    active: true,
    verificationStatus: 'VERIFIED' as const,
    hospitalType: 'GOVERNMENT' as const,
    city: 'Gwalior',
    state: 'Madhya Pradesh',
    location: {
      lat: 26.235,
      lng: 78.225,
      address: 'DEMO Medical Enclave, Morar, Gwalior',
    },
    emergencyCapacity: 'AVAILABLE' as const,
    icuCapacity: 'AVAILABLE' as const,
    traumaAvailable: false,
    capabilities: ['General', 'Emergency', 'Cardiac', 'Pediatric', 'Internal Medicine'],
    generalBeds: 50,
    icuBeds: 10,
    traumaCapacity: 'LIMITED' as const,
    ventilatorAvailability: 'AVAILABLE' as const,
    operatingTheatreAvailability: 'AVAILABLE' as const,
    specialistAvailability: 'AVAILABLE' as const,
    bloodAvailability: 'AVAILABLE' as const,
    estimatedWaitingTimeMinutes: 15,
    incomingAmbulances: 0,
    activeReservationIds: [],
    currentLoad: 40,
    phone: '+91-751-2400081',
    geo: {
      type: 'Point' as const,
      coordinates: [78.225, 26.235],
    },
  },
  {
    _id: 'HOSP-82',
    name: 'DEMO Gwalior Trauma & Multi-Specialty Center',
    status: 'OPERATIONAL' as const,
    operationalStatus: 'OPERATIONAL' as const,
    active: true,
    verificationStatus: 'VERIFIED' as const,
    hospitalType: 'MULTISPECIALITY' as const,
    city: 'Gwalior',
    state: 'Madhya Pradesh',
    location: {
      lat: 26.21,
      lng: 78.195,
      address: 'DEMO Health City, City Center, Gwalior',
    },
    emergencyCapacity: 'AVAILABLE' as const,
    icuCapacity: 'AVAILABLE' as const,
    traumaAvailable: true,
    capabilities: ['Trauma', 'ICU', 'Cardiac', 'Neuro', 'Burn', 'Orthopedic'],
    generalBeds: 75,
    icuBeds: 25,
    traumaCapacity: 'AVAILABLE' as const,
    ventilatorAvailability: 'AVAILABLE' as const,
    operatingTheatreAvailability: 'AVAILABLE' as const,
    specialistAvailability: 'AVAILABLE' as const,
    bloodAvailability: 'AVAILABLE' as const,
    estimatedWaitingTimeMinutes: 10,
    incomingAmbulances: 0,
    activeReservationIds: [],
    currentLoad: 35,
    phone: '+91-751-2400082',
    geo: {
      type: 'Point' as const,
      coordinates: [78.195, 26.21],
    },
  },
];

/**
 * Explicit staging-only database allowlist for Gwalior demo resources.
 * Production databases ('rapidaid') are strictly excluded and rejected.
 */
export const GWALIOR_DEMO_STAGING_ALLOWLIST = [
  'rapidaid_staging',
  'rapidaid_phase1_test',
  'rapidaid_test',
] as const;

/**
 * Validates whether the active database is permitted to seed Gwalior demo resources.
 * Explicitly rejects any production database names ('rapidaid', '*prod*').
 */
export function isGwaliorDemoSeedingAllowed(dbName: string | undefined | null): boolean {
  if (!dbName) return false;
  const clean = dbName.trim().toLowerCase();
  if (clean === 'rapidaid' || clean.includes('prod')) {
    return false;
  }
  return (GWALIOR_DEMO_STAGING_ALLOWLIST as readonly string[]).includes(clean);
}

/**
 * Idempotently seeds Gwalior demo resources into approved staging/test databases.
 * Strictly checks the active database name to prevent writing to any production database.
 */
export async function seedGwaliorDemoResources(): Promise<{
  ambulances: Array<{ id: string; distanceMeters: number }>;
  hospitals: Array<{ id: string; distanceMeters: number }>;
}> {
  const currentDbName = mongoose.connection.name;
  if (!isGwaliorDemoSeedingAllowed(currentDbName)) {
    throw new Error(
      `Safety restriction violated: Must only seed into approved staging databases (${GWALIOR_DEMO_STAGING_ALLOWLIST.join(
        ', ',
      )}), current database is '${currentDbName}'`,
    );
  }

  const now = new Date();
  const passwordHash = await bcrypt.hash('demo123', 10);

  // 1. Upsert Crew Users
  for (const u of GWALIOR_DEMO_USERS) {
    await User.updateOne(
      { _id: u._id },
      {
        $set: {
          name: u.name,
          email: u.email,
          role: u.role,
          active: u.active,
          emailVerified: u.emailVerified,
        },
        $setOnInsert: {
          _id: u._id,
          passwordHash,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }

  // 2. Upsert Ambulances with fresh telemetry
  const ambulanceResults: Array<{ id: string; distanceMeters: number }> = [];
  for (const a of GWALIOR_DEMO_AMBULANCES) {
    const dist = Math.round(haversineMeters(a.location, GWALIOR_EMERGENCY_COORDS));
    ambulanceResults.push({ id: a._id, distanceMeters: dist });

    await Ambulance.updateOne(
      { _id: a._id },
      {
        $set: {
          status: a.status,
          location: a.location,
          speed: a.speed,
          heading: a.heading,
          crew: a.crew,
          capabilities: a.capabilities,
          equipment: a.equipment,
          active: a.active,
          lastUpdated: now, // Fresh telemetry timestamp (diff < 300s)
        },
        $setOnInsert: {
          _id: a._id,
        },
        $unset: {
          currentEmergency: 1,
          claimToken: 1,
          destinationHospital: 1,
          eta: 1,
        },
      },
      { upsert: true },
    );
  }

  // 3. Upsert Active Crew Shifts
  const shiftStart = new Date(now.getTime() - 4 * 3600 * 1000); // Started 4h ago
  const shiftEnd = new Date(now.getTime() + 8 * 3600 * 1000); // Ends in 8h

  const shiftsToUpsert = [
    {
      _id: 'SH-031',
      title: 'DEMO Gwalior North Emergency Shift',
      ambulanceId: 'AMB-051',
      crewIds: ['USR-031', 'USR-032'],
      status: 'ACTIVE' as const,
      createdBy: 'USR-005',
      notes: 'DEMO synthetic shift for Phase 3 dispatch demonstration',
    },
    {
      _id: 'SH-032',
      title: 'DEMO Gwalior South ALS Shift',
      ambulanceId: 'AMB-052',
      crewIds: ['USR-033', 'USR-034'],
      status: 'ACTIVE' as const,
      createdBy: 'USR-005',
      notes: 'DEMO synthetic shift for Phase 3 dispatch demonstration',
    },
  ];

  for (const s of shiftsToUpsert) {
    await Shift.updateOne(
      { _id: s._id },
      {
        $set: {
          title: s.title,
          ambulanceId: s.ambulanceId,
          crewIds: s.crewIds,
          status: s.status,
          startsAt: shiftStart,
          endsAt: shiftEnd,
          createdBy: s.createdBy,
          notes: s.notes,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: s._id,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }

  // 4. Upsert Hospitals
  const hospitalResults: Array<{ id: string; distanceMeters: number }> = [];
  for (const h of GWALIOR_DEMO_HOSPITALS) {
    const dist = Math.round(haversineMeters(h.location, GWALIOR_EMERGENCY_COORDS));
    hospitalResults.push({ id: h._id, distanceMeters: dist });

    await Hospital.updateOne(
      { _id: h._id },
      {
        $set: {
          name: h.name,
          status: h.status,
          operationalStatus: h.operationalStatus,
          active: h.active,
          verificationStatus: h.verificationStatus,
          hospitalType: h.hospitalType,
          city: h.city,
          state: h.state,
          location: h.location,
          emergencyCapacity: h.emergencyCapacity,
          icuCapacity: h.icuCapacity,
          traumaAvailable: h.traumaAvailable,
          capabilities: h.capabilities,
          generalBeds: h.generalBeds,
          icuBeds: h.icuBeds,
          traumaCapacity: h.traumaCapacity,
          ventilatorAvailability: h.ventilatorAvailability,
          operatingTheatreAvailability: h.operatingTheatreAvailability,
          specialistAvailability: h.specialistAvailability,
          bloodAvailability: h.bloodAvailability,
          estimatedWaitingTimeMinutes: h.estimatedWaitingTimeMinutes,
          incomingAmbulances: h.incomingAmbulances,
          activeReservationIds: h.activeReservationIds,
          currentLoad: h.currentLoad,
          phone: h.phone,
          geo: h.geo,
        },
        $setOnInsert: {
          _id: h._id,
        },
      },
      { upsert: true },
    );
  }

  // 5. Ensure EMG-20485 is preserved in REPORTED unassigned state
  await Emergency.updateOne(
    { _id: 'EMG-20485' },
    {
      $set: {
        status: 'REPORTED',
        priority: 'HIGH',
        incidentType: 'OTHER',
        source: 'VOICE_REPORT',
        location: {
          lat: GWALIOR_EMERGENCY_COORDS.lat,
          lng: GWALIOR_EMERGENCY_COORDS.lng,
          address: 'College main gate',
        },
        updatedAt: now,
      },
      $setOnInsert: {
        _id: 'EMG-20485',
        description: 'Emergency reported near College main gate',
        victimCount: 1,
        reportedAt: now,
        timeline: [{ status: 'REPORTED', timestamp: now }],
        greenCorridorActive: false,
        overrideCount: 0,
        attachments: [],
      },
      $unset: {
        assignedAmbulance: 1,
        assignedCrew: 1,
        assignedCrewIds: 1,
        destinationHospital: 1,
      },
    },
    { upsert: true },
  );

  logger.info(
    { ambulances: ambulanceResults, hospitals: hospitalResults },
    'Gwalior demo test resources successfully seeded',
  );

  return {
    ambulances: ambulanceResults,
    hospitals: hospitalResults,
  };
}
