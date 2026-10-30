import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { extractFromTranscript } from '../src/services/voiceExtractionService.js';
import { INCIDENT_TYPES, INCIDENT_TYPE_LABELS } from '../src/validation/constants.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';

const app = createApp();
useTestDatabase(runSeed);

/**
 * The incident vocabulary is mirrored in the report dialog
 * (src/components/emergency/ReportEmergencyDialog.tsx). These tests pin the
 * server side of that contract: every advertised type must be labelable
 * (analytics pie chart), creatable through the API, and understood by the
 * voice extractor / dispatch engine.
 */
describe('incident type vocabulary', () => {
  it('labels every advertised incident type (analytics contract)', () => {
    expect(Object.keys(INCIDENT_TYPE_LABELS).sort()).toEqual([...INCIDENT_TYPES].sort());
    for (const type of INCIDENT_TYPES) {
      expect(INCIDENT_TYPE_LABELS[type], `missing label for ${type}`).toBeTruthy();
    }
    expect(INCIDENT_TYPES.length).toBeGreaterThanOrEqual(19);
    expect(new Set(INCIDENT_TYPES).size).toBe(INCIDENT_TYPES.length); // no duplicates
  });

  it('accepts every advertised incident type on POST /api/emergencies', async () => {
    const token = await loginAs(app, 'citizen');
    for (const incidentType of INCIDENT_TYPES) {
      const res = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .send({
          incidentType,
          priority: 'HIGH',
          location: { lat: 28.6139, lng: 77.209, address: `Vocabulary coverage ${incidentType}` },
          description: `Vocabulary coverage report for ${incidentType}`,
          victimCount: 1,
          source: 'CITIZEN_REPORT',
        });
      expect(res.status, `expected 201 for ${incidentType}: ${JSON.stringify(res.body)}`).toBe(201);
      expect(res.body.incidentType).toBe(incidentType);
      expect(res.body.priority).toBe('HIGH');
    }
  });

  it('rejects an incident type outside the vocabulary (400)', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .send({
        incidentType: 'ALIEN_INVASION',
        priority: 'HIGH',
        location: { lat: 28.62, lng: 77.21, address: 'Unknown type lane' },
        description: 'Unknown incident types must be rejected by zod',
        victimCount: 1,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('incidentType');
  });
});

describe('voice extraction with the extended vocabulary', () => {
  const cases: [string, string][] = [
    ['My father is having a stroke and his speech is slurred', 'STROKE'],
    ['The child is having a seizure and convulsing on the floor', 'SEIZURE'],
    ['She is pregnant and having contractions near the clinic', 'OBSTETRIC_EMERGENCY'],
    ['There is a gas leak near the school gate, people are dizzy', 'GAS_LEAK'],
    ['A worker got an electric shock from a live wire', 'ELECTROCUTION'],
    ['He swallowed pesticide at the farm and is vomiting', 'POISONING'],
    ['A cylinder blast destroyed the shop front', 'EXPLOSION'],
    ['Mass casualty at the station, many injured', 'MASS_CASUALTY'],
    ['He was stabbed near the bus stand', 'ASSAULT'],
    ['She is choking and cannot breathe properly', 'RESPIRATORY_DISTRESS'],
    ['A boy is drowning in the canal', 'DROWNING'],
    ['He fell from a ladder and hurt his back', 'FALL_INJURY'],
    ['She is bleeding badly from her arm', 'MEDICAL_EMERGENCY'],
    ['A car hit a motorcycle outside the market', 'VEHICLE_COLLISION'],
  ];

  for (const [transcript, expected] of cases) {
    it(`maps "${transcript}" to ${expected}`, () => {
      expect(extractFromTranscript(transcript).extractedData.incidentType).toBe(expected);
    });
  }
});

describe('dispatch with the extended vocabulary', () => {
  it('routes a mass casualty to trauma-capable hospitals and capable ambulances', async () => {
    const token = await loginAs(app, 'dispatcher');
    const create = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .send({
        incidentType: 'MASS_CASUALTY',
        priority: 'MEDIUM',
        location: { lat: 28.62, lng: 77.214, address: 'Mass casualty corridor' },
        description: 'Mass casualty dispatch coverage test',
        victimCount: 12,
        source: 'DISPATCHER',
      });
    expect(create.status).toBe(201);
    const emergencyId = create.body.id as string;

    // MEDIUM priority, but the incident type alone must still gate on trauma care.
    const hospitals = await request(app)
      .get(`/api/dispatch/hospital-recommendations/${emergencyId}`)
      .set(bearer(token));
    expect(hospitals.status).toBe(200);
    expect(hospitals.body.length).toBeGreaterThan(0);
    for (const rec of hospitals.body) expect(rec.traumaAvailable).toBe(true);

    const ambulances = await request(app)
      .get(`/api/dispatch/recommendations/${emergencyId}`)
      .set(bearer(token));
    expect(ambulances.status).toBe(200);
    expect(ambulances.body.length).toBeGreaterThan(0);
    for (const rec of ambulances.body) {
      expect(rec.reasons[0]).toContain('Matches required capabilities');
      const matched = String(rec.reasons[0])
        .replace('Matches required capabilities: ', '')
        .split(', ');
      // Enum- and priority-derived requirements merge without duplicates.
      expect(new Set(matched).size).toBe(matched.length);
    }
  });

  it('keeps priority-derived capabilities deduped (STROKE + HIGH needs ICU once)', async () => {
    const token = await loginAs(app, 'dispatcher');
    const create = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .send({
        incidentType: 'STROKE',
        priority: 'HIGH',
        location: { lat: 28.62, lng: 77.214, address: 'Stroke care corridor' },
        description: 'Stroke dispatch capability merge test',
        victimCount: 1,
        source: 'DISPATCHER',
      });
    expect(create.status).toBe(201);

    const ambulances = await request(app)
      .get(`/api/dispatch/recommendations/${create.body.id}`)
      .set(bearer(token));
    expect(ambulances.status).toBe(200);
    expect(ambulances.body.length).toBeGreaterThan(0);
    for (const rec of ambulances.body) {
      const text = rec.reasons.join(' | ');
      expect(text.match(/ICU/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});
