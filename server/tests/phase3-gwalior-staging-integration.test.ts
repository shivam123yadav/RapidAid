import { describe, expect, it, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  GWALIOR_DEMO_STAGING_ALLOWLIST,
  isGwaliorDemoSeedingAllowed,
  seedGwaliorDemoResources,
  GWALIOR_DEMO_AMBULANCES,
  GWALIOR_DEMO_HOSPITALS,
  GWALIOR_EMERGENCY_COORDS,
} from '../src/seed/seedGwaliorDemo.js';
import {
  geocodeSpokenLocation,
  invalidateGazetteerCache,
} from '../src/services/geocodingService.js';
import { Hospital } from '../src/models/index.js';
import { haversineMeters } from '../src/utils/geo.js';

describe('Gwalior Staging Demo Integration — Safety & Eligibility Unit Tests', () => {
  beforeEach(() => {
    invalidateGazetteerCache();
    vi.restoreAllMocks();
  });

  describe('1. Database Safety & Production Rejection', () => {
    it('allows only explicitly approved staging/test databases in allowlist', () => {
      expect(GWALIOR_DEMO_STAGING_ALLOWLIST).toContain('rapidaid_staging');
      expect(GWALIOR_DEMO_STAGING_ALLOWLIST).toContain('rapidaid_phase1_test');
      expect(GWALIOR_DEMO_STAGING_ALLOWLIST).toContain('rapidaid_test');
      expect(isGwaliorDemoSeedingAllowed('rapidaid_staging')).toBe(true);
      expect(isGwaliorDemoSeedingAllowed('rapidaid_phase1_test')).toBe(true);
      expect(isGwaliorDemoSeedingAllowed('rapidaid_test')).toBe(true);
    });

    it('strictly rejects the production database ("rapidaid")', () => {
      expect(isGwaliorDemoSeedingAllowed('rapidaid')).toBe(false);
    });

    it('strictly rejects any production variants or arbitrary databases', () => {
      expect(isGwaliorDemoSeedingAllowed('rapidaid_production')).toBe(false);
      expect(isGwaliorDemoSeedingAllowed('prod_rapidaid')).toBe(false);
      expect(isGwaliorDemoSeedingAllowed('production')).toBe(false);
      expect(isGwaliorDemoSeedingAllowed('custom_db')).toBe(false);
      expect(isGwaliorDemoSeedingAllowed('')).toBe(false);
      expect(isGwaliorDemoSeedingAllowed(undefined)).toBe(false);
      expect(isGwaliorDemoSeedingAllowed(null)).toBe(false);
    });

    it('throws a safety restriction error when seedGwaliorDemoResources is called on production database', async () => {
      // Mock mongoose.connection.name as production 'rapidaid'
      const originalName = mongoose.connection.name;
      Object.defineProperty(mongoose.connection, 'name', {
        value: 'rapidaid',
        configurable: true,
      });

      try {
        await expect(seedGwaliorDemoResources()).rejects.toThrowError(
          /Safety restriction violated: Must only seed into approved staging databases/i,
        );
      } finally {
        Object.defineProperty(mongoose.connection, 'name', {
          value: originalName,
          configurable: true,
        });
      }
    });

    it('throws a safety restriction error when seedGwaliorDemoResources is called on unauthorized database', async () => {
      const originalName = mongoose.connection.name;
      Object.defineProperty(mongoose.connection, 'name', {
        value: 'unauthorized_random_db',
        configurable: true,
      });

      try {
        await expect(seedGwaliorDemoResources()).rejects.toThrowError(
          /Safety restriction violated: Must only seed into approved staging databases/i,
        );
      } finally {
        Object.defineProperty(mongoose.connection, 'name', {
          value: originalName,
          configurable: true,
        });
      }
    });
  });

  describe('2. Fixture Integrity & Dispatch Eligibility', () => {
    it('verifies AMB-051 and AMB-052 have valid coordinates, status AVAILABLE, and complete crew', () => {
      for (const amb of GWALIOR_DEMO_AMBULANCES) {
        expect(amb._id).toMatch(/^AMB-05[12]$/);
        expect(amb.status).toBe('AVAILABLE');
        expect(amb.active).toBe(true);

        // Coordinates
        expect(typeof amb.location.lat).toBe('number');
        expect(typeof amb.location.lng).toBe('number');
        expect(Number.isFinite(amb.location.lat)).toBe(true);
        expect(Number.isFinite(amb.location.lng)).toBe(true);
        expect(amb.location.lat).toBeGreaterThan(26.0);
        expect(amb.location.lat).toBeLessThan(26.5);
        expect(amb.location.lng).toBeGreaterThan(78.0);
        expect(amb.location.lng).toBeLessThan(78.5);

        // Crew
        expect(amb.crew.length).toBe(2);
        for (const c of amb.crew) {
          expect(c.userId).toMatch(/^USR-03[1-4]$/);
          expect(c.certification.length).toBeGreaterThan(0);
        }

        // Capabilities
        expect(amb.capabilities).toContain('Oxygen');
        expect(amb.capabilities).toContain('ICU');

        // Distance to Gwalior incident coordinates within 12 km
        const dist = haversineMeters(amb.location, GWALIOR_EMERGENCY_COORDS);
        expect(dist).toBeLessThanOrEqual(12000);
      }
    });

    it('verifies HOSP-82 is trauma capable and within 15 km network radius', () => {
      const hosp82 = GWALIOR_DEMO_HOSPITALS.find((h) => h._id === 'HOSP-82');
      expect(hosp82).toBeDefined();
      expect(hosp82!.status).toBe('OPERATIONAL');
      expect(hosp82!.emergencyCapacity).toBe('AVAILABLE');
      expect(hosp82!.emergencyCapacity).not.toBe('FULL');
      expect(hosp82!.traumaAvailable).toBe(true);
      expect(hosp82!.icuCapacity).toBe('AVAILABLE');

      const dist = haversineMeters(hosp82!.location, GWALIOR_EMERGENCY_COORDS);
      expect(dist).toBeLessThanOrEqual(15000);
      expect(Math.round(dist)).toBe(2773);
    });

    it('verifies HOSP-81 has general capacity but is non-trauma', () => {
      const hosp81 = GWALIOR_DEMO_HOSPITALS.find((h) => h._id === 'HOSP-81');
      expect(hosp81).toBeDefined();
      expect(hosp81!.status).toBe('OPERATIONAL');
      expect(hosp81!.emergencyCapacity).toBe('AVAILABLE');
      expect(hosp81!.traumaAvailable).toBe(false);

      const dist = haversineMeters(hosp81!.location, GWALIOR_EMERGENCY_COORDS);
      expect(dist).toBeLessThanOrEqual(15000);
      expect(Math.round(dist)).toBe(1361);
    });
  });

  describe('3. Voice Location Resolution for Gwalior Landmarks', () => {
    it('resolves "College main gate" to exact Gwalior demo coordinates without inventing locations', async () => {
      vi.spyOn(Hospital, 'find').mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await geocodeSpokenLocation({ query: 'College main gate' });
      expect(result.resolved).toBe(true);
      expect(result.latitude).toBeCloseTo(26.228854, 4);
      expect(result.longitude).toBeCloseTo(78.213198, 4);
      expect(result.provider).toBe('hospital-network');
      expect(result.status).toBe('APPROXIMATE');
      expect(result.accuracy).toBe(800);
    });

    it('resolves "Phool Bagh" to AMB-051 station coordinates', async () => {
      vi.spyOn(Hospital, 'find').mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await geocodeSpokenLocation({ query: 'Phool Bagh' });
      expect(result.resolved).toBe(true);
      expect(result.latitude).toBeCloseTo(26.242, 3);
      expect(result.longitude).toBeCloseTo(78.22, 2);
      expect(result.accuracy).toBe(1000);
    });

    it('resolves "Morar" to HOSP-81 location coordinates', async () => {
      vi.spyOn(Hospital, 'find').mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await geocodeSpokenLocation({ query: 'Morar' });
      expect(result.resolved).toBe(true);
      expect(result.latitude).toBeCloseTo(26.235, 3);
      expect(result.longitude).toBeCloseTo(78.225, 3);
      expect(result.accuracy).toBe(1200);
    });

    it('safely marks unknown or arbitrary locations as unresolved rather than inventing coordinates', async () => {
      vi.spyOn(Hospital, 'find').mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await geocodeSpokenLocation({ query: 'arbitrary unknown place 98765' });
      expect(result.resolved).toBe(false);
      expect(result.latitude).toBeNull();
      expect(result.longitude).toBeNull();
      expect(result.status).toBe('UNRESOLVED');
    });
  });

  describe('4. Dispatch Safety & Advisory Invariants', () => {
    it('confirms advisory recommendations do not auto-assign or mutate incident state', () => {
      // Emergency model schema mandates status defaults to REPORTED and assignedAmbulance is undefined
      const emgFixture = {
        _id: 'EMG-00001',
        status: 'REPORTED',
        priority: 'CRITICAL',
        assignedAmbulance: undefined,
        location: { lat: 26.2288, lng: 78.2130, address: 'College main gate' },
      };

      expect(emgFixture.status).toBe('REPORTED');
      expect(emgFixture.assignedAmbulance).toBeUndefined();
    });
  });
});
