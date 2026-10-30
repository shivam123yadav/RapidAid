import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { seedGwaliorDemoResources } from '../src/seed/seedGwaliorDemo.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { Ambulance } from '../src/models/Ambulance.js';
import { Emergency } from '../src/models/Emergency.js';
import { Hospital } from '../src/models/Hospital.js';
import { User } from '../src/models/User.js';
import {
  getRoutingProvider,
  setRoutingProvider,
  resetRoutingProvider,
  MockRoutingProvider,
  OsrmRoutingProvider,
  calculateRouteDeviation,
} from '../src/services/routing/index.js';
import { updateAmbulanceRoute, clearRouteCache } from '../src/services/routing/routeService.js';

const app = createApp();

useTestDatabase(async () => {
  await runSeed();
  await seedGwaliorDemoResources();
});

describe('Phase 4.2: Real Road Routing & Dynamic ETA Suite', () => {
  let dispatcherToken: string;
  let citizenToken: string;
  let unassignedCitizenToken: string;
  let assignedCrewToken: string;
  let unassignedCrewToken: string;

  beforeAll(async () => {
    // Reset test emergency EMG-20485 and ambulance AMB-051
    await Emergency.updateOne(
      { _id: 'EMG-20485' },
      {
        $set: {
          citizenId: 'USR-008',
          assignedAmbulance: 'AMB-051',
          status: 'AMBULANCE_ASSIGNED',
          location: { lat: 26.228854, lng: 78.213198, address: 'College main gate, Gwalior' },
          destinationHospital: undefined,
        },
      },
    );
    await Ambulance.updateOne(
      { _id: 'AMB-051' },
      {
        $set: {
          currentEmergency: 'EMG-20485',
          status: 'ASSIGNED',
          location: { lat: 26.242, lng: 78.22 },
          destinationHospital: undefined,
        },
        $unset: { activeRoute: 1, eta: 1 },
      },
    );

    // Auth tokens
    dispatcherToken = await loginAs(app, 'dispatcher');
    citizenToken = await loginAs(app, 'citizen');

    // Unassigned citizen
    const hash = await bcrypt.hash('demo123', 10);
    await User.updateOne(
      { _id: 'USR-099' },
      {
        $set: {
          name: 'Unassigned Citizen',
          email: 'citizen.other@rapidaid.com',
          passwordHash: hash,
          role: 'CITIZEN',
          active: true,
          emailVerified: true,
        },
      },
      { upsert: true },
    );
    const unassignedCitLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'citizen.other@rapidaid.com', password: 'demo123', role: 'CITIZEN' });
    unassignedCitizenToken = unassignedCitLogin.body.accessToken;

    // Assigned crew on AMB-051
    const crewLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'crew-gwl-01@rapidaid.com', password: 'demo123', role: 'AMBULANCE_CREW' });
    assignedCrewToken = crewLogin.body.accessToken;

    // Unassigned crew (Delhi crew)
    unassignedCrewToken = await loginAs(app, 'crew');
  });

  afterAll(() => {
    resetRoutingProvider();
    clearRouteCache();
  });

  it('1. Generates a real road route from AMB-051 to EMG-20485 following mapped roads', async () => {
    clearRouteCache();
    const route = await updateAmbulanceRoute('AMB-051', { lat: 26.242, lng: 78.22 }, { force: true });

    expect(route).not.toBeNull();
    expect(route!.status).toBe('SUCCESS');
    expect(route!.destinationType).toBe('INCIDENT');
    expect(route!.destinationId).toBe('EMG-20485');

    // Road distance should be between 1.4 km and 2.2 km in Gwalior
    expect(route!.distanceMeters).toBeGreaterThan(1000);
    expect(route!.distanceMeters).toBeLessThan(3500);

    // Travel duration in seconds (dynamic ETA)
    expect(route!.durationSeconds).toBeGreaterThan(60);
    expect(route!.durationSeconds).toBeLessThan(600);

    // Route coordinates must follow road geometry (not just start and end)
    expect(route!.coordinates.length).toBeGreaterThan(5);

    // Verify all points are in Gwalior region
    for (const [lat, lng] of route!.coordinates) {
      expect(lat).toBeGreaterThan(26.1);
      expect(lat).toBeLessThan(26.4);
      expect(lng).toBeGreaterThan(78.1);
      expect(lng).toBeLessThan(78.3);
    }

    // Verify database synchronization: both Ambulance and Emergency have matching ETA
    const ambDoc = await Ambulance.findById('AMB-051').lean();
    const emgDoc = await Emergency.findById('EMG-20485').lean();

    expect(ambDoc?.eta).toBe(Math.round(route!.durationSeconds));
    expect(emgDoc?.eta).toBe(Math.round(route!.durationSeconds));
    expect(ambDoc?.activeRoute?.distanceMeters).toBe(route!.distanceMeters);
  });

  it('2. Generates a road route from ambulance to hospital when patient is onboard', async () => {
    clearRouteCache();
    // Advance emergency to PATIENT_ONBOARD with destination HOSP-82
    await Emergency.updateOne(
      { _id: 'EMG-20485' },
      {
        $set: {
          status: 'PATIENT_ONBOARD',
          destinationHospital: 'HOSP-82',
        },
      },
    );
    await Ambulance.updateOne(
      { _id: 'AMB-051' },
      {
        $set: {
          status: 'TRANSPORTING',
          destinationHospital: 'HOSP-82',
          location: { lat: 26.228854, lng: 78.213198 }, // At incident scene
        },
      },
    );

    const hospitalRoute = await updateAmbulanceRoute(
      'AMB-051',
      { lat: 26.228854, lng: 78.213198 },
      { force: true },
    );

    expect(hospitalRoute).not.toBeNull();
    expect(hospitalRoute!.status).toBe('SUCCESS');
    expect(hospitalRoute!.destinationType).toBe('HOSPITAL');
    expect(hospitalRoute!.destinationId).toBe('HOSP-82');

    // Hospital HOSP-82 is ~4.5 - 5.5 km from incident site
    expect(hospitalRoute!.distanceMeters).toBeGreaterThan(3500);
    expect(hospitalRoute!.distanceMeters).toBeLessThan(7000);
    expect(hospitalRoute!.durationSeconds).toBeGreaterThan(200);

    const ambDoc = await Ambulance.findById('AMB-051').lean();
    expect(ambDoc?.activeRoute?.destinationType).toBe('HOSPITAL');
    expect(ambDoc?.activeRoute?.destinationId).toBe('HOSP-82');
  });

  it('3. Detects significant route deviation and triggers recalculation', async () => {
    // Reset to incident route
    await Emergency.updateOne(
      { _id: 'EMG-20485' },
      { $set: { status: 'AMBULANCE_ASSIGNED', destinationHospital: undefined } },
    );
    await Ambulance.updateOne(
      { _id: 'AMB-051' },
      {
        $set: {
          status: 'ASSIGNED',
          location: { lat: 26.242, lng: 78.22 },
          destinationHospital: undefined,
          lastUpdated: new Date(Date.now() - 120000),
        },
      },
    );

    const initialRoute = await updateAmbulanceRoute('AMB-051', { lat: 26.242, lng: 78.22 }, { force: true });
    expect(initialRoute).not.toBeNull();

    // Check deviation calculation for a point 500m off the active route
    const offRoutePosition = { lat: 26.248, lng: 78.228 }; // Deviated east of route
    const dev = calculateRouteDeviation(offRoutePosition, initialRoute!.coordinates, 100);

    expect(dev.isDeviated).toBe(true);
    expect(dev.minDistanceMeters).toBeGreaterThan(100);

    // Reset lastUpdated so telemetry timestamp is monotonically increasing and speed is realistic
    await Ambulance.updateOne(
      { _id: 'AMB-051' },
      { $set: { lastUpdated: new Date(Date.now() - 30000) } },
    );

    // Feeding this off-route telemetry update to the endpoint triggers recalculation
    const res = await request(app)
      .patch('/api/ambulances/AMB-051/telemetry')
      .set(bearer(assignedCrewToken))
      .send({
        location: offRoutePosition,
        speed: 35,
        heading: 45,
        timestamp: new Date().toISOString(),
      });

    expect(res.status).toBe(200);
    expect(res.body.activeRoute).toBeDefined();
    // Route origin should now be updated to the new deviated location
    expect(res.body.activeRoute.routeOrigin.lat).toBeCloseTo(offRoutePosition.lat, 2);
  });

  it('4. Updates dynamic ETA when simulated GPS moves along the route', async () => {
    // Reset lastUpdated so movement time window allows physically valid travel speed
    await Ambulance.updateOne(
      { _id: 'AMB-051' },
      { $set: { lastUpdated: new Date(Date.now() - 60000) } },
    );

    // Ambulance moves closer to incident: 26.230, 78.214 (just 200m from incident)
    const closerPosition = { lat: 26.2305, lng: 78.214 };

    const res = await request(app)
      .patch('/api/ambulances/AMB-051/telemetry')
      .set(bearer(assignedCrewToken))
      .send({
        location: closerPosition,
        speed: 40,
        heading: 190,
        timestamp: new Date().toISOString(),
      });

    expect(res.status).toBe(200);
    expect(res.body.eta).toBeDefined();

    // Remaining duration should now be much shorter (< 150 seconds)
    expect(res.body.eta).toBeLessThan(150);

    // Emergency document eta should also be updated
    const emg = await Emergency.findById('EMG-20485').lean();
    expect(emg?.eta).toBe(res.body.eta);
  });

  it('5. Provider failures do not produce fabricated routes or ETAs', async () => {
    const mockProvider = new MockRoutingProvider();
    mockProvider.setFailureMode(true, 'OSRM upstream outage simulation');
    setRoutingProvider(mockProvider);

    clearRouteCache();

    const failedRoute = await updateAmbulanceRoute(
      'AMB-051',
      { lat: 26.235, lng: 78.216 },
      { force: true },
    );

    expect(failedRoute).not.toBeNull();
    expect(failedRoute!.status).toBe('FAILED');
    expect(failedRoute!.isStale).toBe(true);

    // Never invent an ETA or synthetic geometry on failure
    const amb = await Ambulance.findById('AMB-051').lean();
    const emg = await Emergency.findById('EMG-20485').lean();

    expect(amb?.eta).toBeUndefined();
    expect(emg?.eta).toBeUndefined();

    // Reset back to real provider
    resetRoutingProvider();
  });

  it('6. Dispatcher-authorized destination change synchronizes routing', async () => {
    // Dispatcher reserves HOSP-82 for EMG-20485 via hospital capacity reservation
    const reserveRes = await request(app)
      .post('/api/hospitals/HOSP-82/reserve')
      .set(bearer(dispatcherToken))
      .send({
        emergencyId: 'EMG-20485',
        resourceType: 'ICU_BED',
      });

    expect(reserveRes.status).toBe(201);

    // Update emergency status to TRANSPORTING and refresh route
    await Emergency.updateOne({ _id: 'EMG-20485' }, { $set: { status: 'TRANSPORTING' } });
    await Ambulance.updateOne({ _id: 'AMB-051' }, { $set: { status: 'TRANSPORTING' } });

    const rerouted = await updateAmbulanceRoute('AMB-051', undefined, { force: true });
    expect(rerouted).not.toBeNull();
    expect(rerouted!.destinationType).toBe('HOSPITAL');
    expect(rerouted!.destinationId).toBe('HOSP-82');
  });

  it('7. Exposes GET /api/ambulances/:id/route with RBAC authorization', async () => {
    // 1. Dispatcher can view route
    const dispRes = await request(app)
      .get('/api/ambulances/AMB-051/route')
      .set(bearer(dispatcherToken));
    expect(dispRes.status).toBe(200);
    expect(dispRes.body.ambulanceId).toBe('AMB-051');
    expect(dispRes.body.activeRoute).toBeDefined();

    // 2. Assigned citizen (USR-008) can view route
    const citRes = await request(app)
      .get('/api/ambulances/AMB-051/route')
      .set(bearer(citizenToken));
    expect(citRes.status).toBe(200);
    expect(citRes.body.ambulanceId).toBe('AMB-051');

    // 3. Unassigned citizen cannot read route (404 not found)
    const unassignedCitRes = await request(app)
      .get('/api/ambulances/AMB-051/route')
      .set(bearer(unassignedCitizenToken));
    expect(unassignedCitRes.status).toBe(404);

    // 4. Unassigned crew cannot read route (404 not found)
    const unassignedCrewRes = await request(app)
      .get('/api/ambulances/AMB-051/route')
      .set(bearer(unassignedCrewToken));
    expect(unassignedCrewRes.status).toBe(404);
  });
});
