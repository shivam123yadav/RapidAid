import { describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { Emergency, User } from '../src/models/index.js';

useTestDatabase(runSeed);

describe('demo ownership backfill', () => {
  it('fills ownership introduced after a legacy seed without overwriting current links', async () => {
    await User.updateOne({ _id: 'USR-003' }, { $unset: { hospitalId: '' } }).exec();
    await Emergency.updateOne(
      { _id: 'EMG-20482' },
      { $unset: { citizenId: '', assignedCrewIds: '', assignedDispatcher: '' } },
    ).exec();
    await Emergency.updateOne(
      { _id: 'EMG-20481' },
      { $set: { citizenId: 'USR-CUSTOM', assignedCrewIds: ['USR-CUSTOM'], assignedDispatcher: 'USR-CUSTOM' } },
    ).exec();

    await runSeed();

    const hospitalUser = await User.findById('USR-003').lean();
    const citizenIncident = await Emergency.findById('EMG-20482').lean();
    const customIncident = await Emergency.findById('EMG-20481').lean();
    expect(hospitalUser?.hospitalId).toBe('HOSP-01');
    expect(citizenIncident).toMatchObject({ citizenId: 'USR-008', assignedCrewIds: ['USR-002'], assignedDispatcher: 'USR-001' });
    expect(customIncident).toMatchObject({ citizenId: 'USR-CUSTOM', assignedCrewIds: ['USR-CUSTOM'], assignedDispatcher: 'USR-CUSTOM' });
  });
});
