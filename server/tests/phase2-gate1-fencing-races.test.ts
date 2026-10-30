import { describe, expect, it, vi } from 'vitest';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { Ambulance, Emergency, AuditLog } from '../src/models/index.js';
import {
  assignAmbulance,
  overrideEmergency,
  reconcileStrandedAmbulances,
  DEFAULT_IN_FLIGHT_ASSIGNMENT_GRACE_MS,
} from '../src/services/emergencyService.js';
import { toClientEmergency, type AuthContext } from '../src/authz/access.js';

useTestDatabase(runSeed);

describe('Phase 2 Gate 1.1 - Assignment Consistency and Stale-Claim Fencing Races', () => {
  async function createTestEmergency(id: string, overrides: Partial<Record<string, unknown>> = {}) {
    return Emergency.create({
      _id: id,
      status: 'REPORTED',
      priority: 'HIGH',
      incidentType: 'VEHICLE_COLLISION',
      location: { lat: 28.6139, lng: 77.209, address: 'Connaught Place' },
      source: 'DISPATCHER',
      description: 'Test emergency for Gate 1.1 fencing races',
      victimCount: 1,
      reportedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
  }

  async function ensureAmbulance(
    ambulanceId: string,
    overrides: {
      status?: string;
      currentEmergency?: string | null;
      claimToken?: string | null;
      lastUpdated?: Date;
      crew?: Array<{ name: string; role: string; userId?: string }>;
    } = {},
  ) {
    return Ambulance.findOneAndUpdate(
      { _id: ambulanceId },
      {
        $set: {
          status: overrides.status ?? 'AVAILABLE',
          currentEmergency: overrides.currentEmergency ?? null,
          claimToken: overrides.claimToken ?? null,
          lastUpdated: overrides.lastUpdated ?? new Date(),
          location: { lat: 28.62, lng: 77.215 },
          capabilities: ['Basic', 'Trauma'],
          crew: overrides.crew ?? [{ name: 'Test Paramedic', role: 'PARAMEDIC', userId: 'USR-CREW-1' }],
          active: true,
        },
      },
      { upsert: true, new: true },
    );
  }

  it('Scenario 1: Delayed assignment crossing grace period -> reconciled -> competing assignment claims unit -> delayed assignment aborts without corrupting competing unit', async () => {
    const ambId = 'AMB-FENCE-1';
    const emg1Id = 'EMG-DELAYED-1';
    const emg2Id = 'EMG-COMPETING-2';

    await ensureAmbulance(ambId, { status: 'AVAILABLE' });
    await createTestEmergency(emg1Id);
    await createTestEmergency(emg2Id);

    let capturedClaimToken1 = '';
    let releaseBarrier: () => void = () => {};
    const barrierPromise = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    // Launch delayed assignment for EMG-1 with an injected barrier hook
    const delayedAssignmentPromise = assignAmbulance(emg1Id, ambId, {
      requestId: 'req-delayed-1',
      actor: 'dispatcher1',
      actorRole: 'DISPATCHER',
      policy: 'MANUAL',
      beforeEmergencyCommit: async ({ claimToken }) => {
        capturedClaimToken1 = claimToken;
        // Pause here while holding the ambulance claim
        await barrierPromise;
      },
    });

    // Wait until the hook has executed and claimed the ambulance
    await vi.waitFor(async () => {
      const amb = await Ambulance.findById(ambId).lean();
      expect(amb?.status).toBe('ASSIGNED');
      expect(amb?.currentEmergency).toBe(emg1Id);
      expect(amb?.claimToken).toBeTruthy();
      expect(capturedClaimToken1).toBeTruthy();
    });

    // 1. Simulate passage of time past grace period
    const staleTime = new Date(Date.now() - (DEFAULT_IN_FLIGHT_ASSIGNMENT_GRACE_MS + 5_000));
    await Ambulance.updateOne({ _id: ambId }, { $set: { lastUpdated: staleTime } });

    // 2. Reconciler runs: sees unlinked ambulance whose grace period has expired
    const reconResult = await reconcileStrandedAmbulances();
    expect(reconResult.released).toContain(ambId);

    const ambAfterRecon = await Ambulance.findById(ambId).lean();
    expect(ambAfterRecon?.status).toBe('AVAILABLE');
    expect(ambAfterRecon?.currentEmergency).toBeNull();
    expect(ambAfterRecon?.claimToken).toBeNull();

    // 3. Competing assignment for EMG-2 claims the now-available unit
    const competingResult = await assignAmbulance(emg2Id, ambId, {
      requestId: 'req-competing-2',
      actor: 'dispatcher2',
      actorRole: 'DISPATCHER',
      policy: 'MANUAL',
    });
    expect(competingResult.ambulanceId).toBe(ambId);

    const ambAfterCompeting = await Ambulance.findById(ambId).lean();
    expect(ambAfterCompeting?.status).toBe('ASSIGNED');
    expect(ambAfterCompeting?.currentEmergency).toBe(emg2Id);
    const capturedClaimToken2 = ambAfterCompeting?.claimToken;
    expect(capturedClaimToken2).toBeTruthy();
    expect(capturedClaimToken2).not.toBe(capturedClaimToken1);

    // 4. Now release the barrier: delayed assignment for EMG-1 attempts to commit
    releaseBarrier();

    // Delayed assignment MUST fail with 409 Conflict due to mutual fencing verification
    await expect(delayedAssignmentPromise).rejects.toThrow(/superseded|reclaimed/i);

    // 5. Verify invariants:
    // Competing emergency EMG-2 is 100% intact and linked
    const emg2After = await Emergency.findById(emg2Id).lean();
    expect(emg2After?.assignedAmbulance).toBe(ambId);
    expect(emg2After?.ambulanceClaimToken).toBe(capturedClaimToken2);

    // Ambulance remains assigned to EMG-2 with claimToken2
    const ambFinal = await Ambulance.findById(ambId).lean();
    expect(ambFinal?.status).toBe('ASSIGNED');
    expect(ambFinal?.currentEmergency).toBe(emg2Id);
    expect(ambFinal?.claimToken).toBe(capturedClaimToken2);

    // Delayed emergency EMG-1 was rolled back safely and is NOT linked to ambId
    const emg1After = await Emergency.findById(emg1Id).lean();
    expect(emg1After?.assignedAmbulance).toBeFalsy();
    expect(emg1After?.ambulanceClaimToken).toBeFalsy();
    expect(emg1After?.status).toBe('REPORTED');
  });

  it('Scenario 2: Delayed assignment resumes after emergency was reassigned via supervisor override -> failed commit never clears newer assignment', async () => {
    const amb1Id = 'AMB-FENCE-OVERRIDE-1';
    const amb2Id = 'AMB-FENCE-OVERRIDE-2';
    const emgId = 'EMG-FENCE-OVERRIDE';

    await ensureAmbulance(amb1Id, { status: 'AVAILABLE' });
    await ensureAmbulance(amb2Id, { status: 'AVAILABLE' });
    await createTestEmergency(emgId);

    let releaseBarrier: () => void = () => {};
    const barrierPromise = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    // Launch delayed assignment of AMB-1
    const delayedAssignmentPromise = assignAmbulance(emgId, amb1Id, {
      requestId: 'req-delayed-override',
      actor: 'dispatcher1',
      actorRole: 'DISPATCHER',
      policy: 'MANUAL',
      beforeEmergencyCommit: async () => {
        await barrierPromise;
      },
    });

    // Wait until AMB-1 is claimed
    await vi.waitFor(async () => {
      const amb1 = await Ambulance.findById(amb1Id).lean();
      expect(amb1?.status).toBe('ASSIGNED');
      expect(amb1?.currentEmergency).toBe(emgId);
    });

    // In the meantime, supervisor break-glass overrides the emergency to assign AMB-2
    const overrideResult = await overrideEmergency(
      emgId,
      {
        action: 'REASSIGN_AMBULANCE',
        ambulanceId: amb2Id,
        reason: 'Supervisor override to faster unit',
      },
      {
        requestId: 'req-override-reassign',
        actor: 'supervisor1',
        actorId: 'USR-SUP-1',
        actorRole: 'SUPERVISOR',
      },
    );
    expect(overrideResult.emergency.assignedAmbulance).toBe(amb2Id);
    const amb2ClaimToken = (await Emergency.findById(emgId).lean())?.ambulanceClaimToken;
    expect(amb2ClaimToken).toBeTruthy();

    // Now release the delayed assignment for AMB-1
    releaseBarrier();

    // Delayed assignment MUST fail because the emergency already has assignedAmbulance: AMB-2
    await expect(delayedAssignmentPromise).rejects.toThrow(/concurrently modified|aborted/i);

    // Verify emergency is STILL assigned to AMB-2 with AMB-2's claimToken
    const emgFinal = await Emergency.findById(emgId).lean();
    expect(emgFinal?.assignedAmbulance).toBe(amb2Id);
    expect(emgFinal?.ambulanceClaimToken).toBe(amb2ClaimToken);

    // AMB-1 compensation was executed: AMB-1 is back to AVAILABLE
    const amb1Final = await Ambulance.findById(amb1Id).lean();
    expect(amb1Final?.status).toBe('AVAILABLE');
    expect(amb1Final?.currentEmergency).toBeNull();
    expect(amb1Final?.claimToken).toBeNull();

    // AMB-2 remains assigned to emgId
    const amb2Final = await Ambulance.findById(amb2Id).lean();
    expect(amb2Final?.status).toBe('ASSIGNED');
    expect(amb2Final?.currentEmergency).toBe(emgId);
  });

  it('Scenario 3: Same emergency can be retried cleanly after a claim generation expires or changes', async () => {
    const ambId = 'AMB-RETRY-1';
    const emgId = 'EMG-RETRY-1';

    await ensureAmbulance(ambId, { status: 'AVAILABLE' });
    await createTestEmergency(emgId);

    let releaseBarrier: () => void = () => {};
    const barrierPromise = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    // Attempt 1: interrupted/delayed
    const attempt1 = assignAmbulance(emgId, ambId, {
      requestId: 'req-retry-1',
      actor: 'dispatcher1',
      actorRole: 'DISPATCHER',
      policy: 'MANUAL',
      beforeEmergencyCommit: async () => {
        await barrierPromise;
      },
    });

    await vi.waitFor(async () => {
      const amb = await Ambulance.findById(ambId).lean();
      expect(amb?.status).toBe('ASSIGNED');
    });

    // Reconcile after grace period to simulate timeout/abandonment
    await Ambulance.updateOne(
      { _id: ambId },
      { $set: { lastUpdated: new Date(Date.now() - 20_000) } },
    );
    await reconcileStrandedAmbulances();

    // Release barrier so attempt 1 terminates with conflict
    releaseBarrier();
    await expect(attempt1).rejects.toThrow();

    // Attempt 2: retry assigning the same emergency to the same ambulance
    const attempt2Result = await assignAmbulance(emgId, ambId, {
      requestId: 'req-retry-2',
      actor: 'dispatcher1',
      actorRole: 'DISPATCHER',
      policy: 'MANUAL',
    });

    expect(attempt2Result.emergencyId).toBe(emgId);
    expect(attempt2Result.ambulanceId).toBe(ambId);

    const emgFinal = await Emergency.findById(emgId).lean();
    expect(emgFinal?.assignedAmbulance).toBe(ambId);
    expect(emgFinal?.status).toBe('AMBULANCE_ASSIGNED');

    const ambFinal = await Ambulance.findById(ambId).lean();
    expect(ambFinal?.status).toBe('ASSIGNED');
    expect(ambFinal?.currentEmergency).toBe(emgId);
    expect(ambFinal?.claimToken).toBe(emgFinal?.ambulanceClaimToken);
  });

  it('Scenario 4: Two concurrent reconciliation workers race against the same stranded unit (idempotent, single release)', async () => {
    const ambId = 'AMB-CONCURRENT-RECON';
    const emgId = 'EMG-CONCURRENT-RECON';

    // Stranded ambulance linked to completed emergency
    await ensureAmbulance(ambId, {
      status: 'ASSIGNED',
      currentEmergency: emgId,
      claimToken: 'clm-stale-1',
      lastUpdated: new Date(Date.now() - 30_000),
    });
    await createTestEmergency(emgId, { status: 'COMPLETED' });

    // Run two reconciliation sweeps concurrently
    const [result1, result2] = await Promise.all([
      reconcileStrandedAmbulances(),
      reconcileStrandedAmbulances(),
    ]);

    // Exactly one worker should have performed the release; the other was a CAS no-op
    const totalReleased = (result1.released.includes(ambId) ? 1 : 0) + (result2.released.includes(ambId) ? 1 : 0);
    expect(totalReleased).toBe(1);

    const ambFinal = await Ambulance.findById(ambId).lean();
    expect(ambFinal?.status).toBe('AVAILABLE');
    expect(ambFinal?.currentEmergency).toBeNull();
    expect(ambFinal?.claimToken).toBeNull();
  });

  it('Scenario 5: Normal manual assignment and supervisor override remain compatible and strip claimToken from client response', async () => {
    const ambId = 'AMB-NORMAL-1';
    const emgId = 'EMG-NORMAL-1';

    await ensureAmbulance(ambId, { status: 'AVAILABLE' });
    await createTestEmergency(emgId);

    // 1. Normal manual assignment
    const result = await assignAmbulance(emgId, ambId, {
      requestId: 'req-normal-1',
      actor: 'dispatcher1',
      actorRole: 'DISPATCHER',
      policy: 'MANUAL',
    });
    expect(result.ambulanceId).toBe(ambId);
    expect(result.emergencyId).toBe(emgId);

    const emg = await Emergency.findById(emgId);
    expect(emg?.assignedAmbulance).toBe(ambId);
    expect(emg?.ambulanceClaimToken).toBeTruthy();

    // 2. Client response sanitization test
    // ambulanceClaimToken MUST be stripped as an internal field
    const auth: AuthContext = {
      userId: 'USR-DISPATCHER-1',
      role: 'DISPATCHER',
      name: 'Dispatcher One',
      email: 'disp1@rapidaid.test',
      permissions: ['emergency:read:all'],
    };
    const sanitized = toClientEmergency(auth, emg!);
    expect(sanitized.ambulanceClaimToken).toBeUndefined();

    // 3. Reconciliation sweep leaves active assignment untouched
    const recon = await reconcileStrandedAmbulances();
    expect(recon.released).not.toContain(ambId);
    expect(recon.skippedActive).toContain(ambId);

    // 4. Idempotent re-assignment of the same unit succeeds without error
    const reassignSame = await assignAmbulance(emgId, ambId, {
      requestId: 'req-normal-same',
      actor: 'dispatcher1',
      actorRole: 'DISPATCHER',
      policy: 'MANUAL',
    });
    expect(reassignSame.ambulanceId).toBe(ambId);
  });

  it('Scenario 6: Reconciliation racing with in-flight assignment preserves unit within grace period and after link completion', async () => {
    const ambId = 'AMB-RACE-ASSIGN-RECON';
    const emgId = 'EMG-RACE-ASSIGN-RECON';

    await ensureAmbulance(ambId, { status: 'AVAILABLE' });
    await createTestEmergency(emgId);

    let releaseBarrier: () => void = () => {};
    const barrierPromise = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const assignmentPromise = assignAmbulance(emgId, ambId, {
      requestId: 'req-race-in-flight',
      actor: 'dispatcher1',
      actorRole: 'DISPATCHER',
      policy: 'MANUAL',
      beforeEmergencyCommit: async () => {
        await barrierPromise;
      },
    });

    // Wait until ambulance is claimed
    await vi.waitFor(async () => {
      const amb = await Ambulance.findById(ambId).lean();
      expect(amb?.status).toBe('ASSIGNED');
    });

    // Reconciler runs while assignment is holding the claim within grace period
    const reconDuringClaim = await reconcileStrandedAmbulances();
    expect(reconDuringClaim.released).not.toContain(ambId);
    expect(reconDuringClaim.skippedActive).toContain(ambId);

    // Now let assignment proceed to emergency commit
    releaseBarrier();
    const result = await assignmentPromise;
    expect(result.ambulanceId).toBe(ambId);

    // Reconciler runs after assignment completed
    const reconAfterCommit = await reconcileStrandedAmbulances();
    expect(reconAfterCommit.released).not.toContain(ambId);
    expect(reconAfterCommit.skippedActive).toContain(ambId);

    const ambFinal = await Ambulance.findById(ambId).lean();
    expect(ambFinal?.status).toBe('ASSIGNED');
    expect(ambFinal?.currentEmergency).toBe(emgId);
  });
});

