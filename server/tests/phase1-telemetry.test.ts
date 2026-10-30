import { describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { Ambulance, Emergency } from '../src/models/index.js';
import {
  isAmbulanceTelemetryFresh,
  isAmbulanceDispatchEligible,
  recommendAmbulances,
} from '../src/services/dispatchService.js';
import { env } from '../src/config/env.js';

useTestDatabase(runSeed);

describe('Phase 1 - Configurable GPS Telemetry Freshness & Dispatch Eligibility', () => {
  const BASE_TIME = new Date('2026-10-29T12:00:00.000Z');

  describe('isAmbulanceTelemetryFresh', () => {
    it('approves telemetry updated within the default threshold (300 seconds)', () => {
      // 120 seconds old
      const lastUpdated = new Date(BASE_TIME.getTime() - 120 * 1000);
      const result = isAmbulanceTelemetryFresh({ lastUpdated }, 300, BASE_TIME);

      expect(result.fresh).toBe(true);
      expect(result.ageSeconds).toBe(120);
      expect(result.thresholdSeconds).toBe(300);
      expect(result.reason).toBeUndefined();
    });

    it('disqualifies telemetry older than the threshold with STALE_TIMESTAMP', () => {
      // 360 seconds old
      const lastUpdated = new Date(BASE_TIME.getTime() - 360 * 1000);
      const result = isAmbulanceTelemetryFresh({ lastUpdated }, 300, BASE_TIME);

      expect(result.fresh).toBe(false);
      expect(result.ageSeconds).toBe(360);
      expect(result.reason).toBe('STALE_TIMESTAMP');
    });

    it('honors a custom threshold parameter', () => {
      // 80 seconds old
      const lastUpdated = new Date(BASE_TIME.getTime() - 80 * 1000);

      // Fresh with threshold 120s
      const passResult = isAmbulanceTelemetryFresh({ lastUpdated }, 120, BASE_TIME);
      expect(passResult.fresh).toBe(true);

      // Stale with threshold 60s
      const failResult = isAmbulanceTelemetryFresh({ lastUpdated }, 60, BASE_TIME);
      expect(failResult.fresh).toBe(false);
      expect(failResult.reason).toBe('STALE_TIMESTAMP');
      expect(failResult.thresholdSeconds).toBe(60);
    });

    it('safely handles missing or null lastUpdated timestamp', () => {
      expect(isAmbulanceTelemetryFresh(null, 300, BASE_TIME)).toEqual({
        fresh: false,
        ageSeconds: null,
        reason: 'MISSING_TIMESTAMP',
        thresholdSeconds: 300,
      });

      expect(isAmbulanceTelemetryFresh({ lastUpdated: null }, 300, BASE_TIME)).toEqual({
        fresh: false,
        ageSeconds: null,
        reason: 'MISSING_TIMESTAMP',
        thresholdSeconds: 300,
      });

      expect(isAmbulanceTelemetryFresh({ lastUpdated: undefined }, 300, BASE_TIME)).toEqual({
        fresh: false,
        ageSeconds: null,
        reason: 'MISSING_TIMESTAMP',
        thresholdSeconds: 300,
      });
    });

    it('safely handles invalid timestamp strings', () => {
      const result = isAmbulanceTelemetryFresh(
        { lastUpdated: 'not-a-valid-date' as unknown as Date },
        300,
        BASE_TIME,
      );

      expect(result.fresh).toBe(false);
      expect(result.ageSeconds).toBe(null);
      expect(result.reason).toBe('INVALID_TIMESTAMP');
    });

    it('safely rejects future timestamps exceeding clock skew allowance', () => {
      // 2 minutes in the future
      const futureTime = new Date(BASE_TIME.getTime() + 120 * 1000);
      const result = isAmbulanceTelemetryFresh({ lastUpdated: futureTime }, 300, BASE_TIME);

      expect(result.fresh).toBe(false);
      expect(result.reason).toBe('FUTURE_TIMESTAMP');
    });
  });

  describe('TELEMETRY_FRESHNESS_THRESHOLD_SECONDS environment configuration', () => {
    it('is loaded into the validated env configuration', () => {
      expect(env.TELEMETRY_FRESHNESS_THRESHOLD_SECONDS).toBeDefined();
      expect(typeof env.TELEMETRY_FRESHNESS_THRESHOLD_SECONDS).toBe('number');
    });

    it('defaults to 300 seconds when not specified', () => {
      expect(env.TELEMETRY_FRESHNESS_THRESHOLD_SECONDS).toBe(300);
    });

    it('satisfies safety bounds (between 30s and 86400s)', () => {
      expect(env.TELEMETRY_FRESHNESS_THRESHOLD_SECONDS).toBeGreaterThanOrEqual(30);
      expect(env.TELEMETRY_FRESHNESS_THRESHOLD_SECONDS).toBeLessThanOrEqual(86400);
    });

    it('is an integer number of seconds', () => {
      expect(Number.isInteger(env.TELEMETRY_FRESHNESS_THRESHOLD_SECONDS)).toBe(true);
    });
  });

  describe('Dispatch Candidate Filtering & Backward Compatibility', () => {
    it('isAmbulanceDispatchEligible combines telemetry and crew duty audit reasons', async () => {
      // Seeded ambulance AMB-001 has historical lastUpdated and no active shift
      const result = await isAmbulanceDispatchEligible('AMB-001', {
        thresholdSeconds: 300,
        atTime: new Date(),
      });

      expect(result.eligible).toBe(false);
      expect(result.disqualificationReasons.length).toBeGreaterThanOrEqual(1);
      expect(result.telemetry.fresh).toBe(false);
      expect(result.crewDuty.eligible).toBe(false);
    });

    it('preserves manual dispatch recommendation visibility by default (filterStaleTelemetry = false)', async () => {
      // Find a seeded emergency (e.g. EMG-20481)
      const emergency = await Emergency.findOne().lean();
      expect(emergency).toBeTruthy();

      // Manual dispatch call without filterStaleTelemetry returns seeded candidate ambulances
      const recommendations = await recommendAmbulances(String(emergency!._id));
      expect(recommendations.length).toBeGreaterThan(0);
    });

    it('excludes stale ambulances when filterStaleTelemetry: true is supplied', async () => {
      const emergency = await Emergency.findOne().lean();
      expect(emergency).toBeTruthy();

      // When strict candidate screening is requested against the live time (where seeded timestamps are days old),
      // stale candidates are safely excluded rather than inventing positions
      const strictRecommendations = await recommendAmbulances(String(emergency!._id), {
        filterStaleTelemetry: true,
        atTime: new Date(),
      });

      expect(strictRecommendations).toEqual([]);
    });
  });
});
