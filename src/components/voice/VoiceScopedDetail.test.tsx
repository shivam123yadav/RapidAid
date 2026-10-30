import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoiceScopedDetail } from '../../components/voice/VoiceScopedDetail';
import * as playback from '../../lib/audioPlayback';
import type { ServerAudioResult } from '../../lib/audioPlayback';
import type { VoiceReportDetail, VoiceReportCapabilities } from '../../types';

/**
 * The report inspector now renders the SHARED player
 * (`VoicePlaybackPlayer`); the player's own behaviour is covered in
 * `VoicePlaybackPlayer.test.tsx`. What matters here is the wiring this panel is
 * responsible for:
 *
 *  - it honours the server-derived `listen` / `download` capabilities;
 *  - a restricted or non-speech transcript never hides the recording;
 *  - selecting a different report never reuses the previous recording.
 */
function caps(overrides: Partial<VoiceReportCapabilities>): VoiceReportCapabilities {
  return {
    read: true, listen: true, transcript: true, download: false,
    confirm: false, reject: false, edit: false, discard: false,
    accessHistory: false, evidence: false, canPlayRecording: true,
    accessLabel: 'Active Report',
    ...overrides,
  } as VoiceReportCapabilities;
}

function detail(overrides: Partial<VoiceReportDetail> = {}): VoiceReportDetail {
  return {
    id: 'VR-901',
    status: 'DRAFT',
    createdAt: new Date().toISOString(),
    ownerId: 'USR-001',
    emergencyId: null,
    transcript: 'Accident near Rajwada Square in Indore. Two people are injured.',
    transcriptRestricted: false,
    confidence: 90,
    dispatchStatus: 'DISPATCH_PENDING',
    hospitalId: null,
    hospitalName: null,
    accessLabel: 'Active Report',
    extractedData: {
      incidentType: 'VEHICLE_COLLISION',
      location: 'Rajwada Square',
      victimCount: 2,
      description: 'Accident',
    },
    audio: {
      filename: 'voice-emergency-1.webm',
      mimeType: 'audio/webm',
      size: 2048,
      durationSeconds: 7,
      status: 'STORED',
    },
    capabilities: caps({}),
    ...overrides,
  } as unknown as VoiceReportDetail;
}

const serverOk = (): ServerAudioResult => ({
  ok: true,
  blob: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])], { type: 'audio/webm' }),
  status: 200,
  contentType: 'audio/webm',
  size: 5,
});

beforeEach(() => {
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, writable: true, value: () => 'blob:scoped-1',
    });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true, writable: true, value: () => undefined,
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockServer(outcome: ServerAudioResult) {
  return vi.spyOn(playback, 'fetchServerRecording').mockResolvedValue(outcome);
}

describe('VoiceScopedDetail wiring', () => {
  it('renders the shared player and loads the stored copy over authenticated fetch', async () => {
    const spy = mockServer(serverOk());
    render(<VoiceScopedDetail detail={detail()} />);

    expect(screen.getByTestId('voice-scoped-player')).toBeInTheDocument();
    await waitFor(() => expect(spy).toHaveBeenCalledWith('VR-901'));
    // A blob: URL, never the protected API path in <audio src>.
    const audio = await screen.findByTestId('voice-scoped-player-audio');
    expect(audio.getAttribute('src') ?? '').not.toContain('/api/voice/reports/');
  });

  it('hides the player entirely when the caller holds no listen capability', () => {
    const spy = mockServer(serverOk());
    render(<VoiceScopedDetail detail={detail({ capabilities: caps({ listen: false }) })} />);
    expect(screen.queryByTestId('voice-scoped-player')).toBeNull();
    // And no audio request is even attempted.
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the player when the transcript is restricted (RBAC applies to text only)', async () => {
    mockServer(serverOk());
    render(
      <VoiceScopedDetail
        detail={detail({
          transcript: null,
          transcriptRestricted: true,
          capabilities: caps({ listen: true, transcript: false }),
        })}
      />,
    );
    expect(screen.getByTestId('voice-scoped-player')).toBeInTheDocument();
    expect(screen.getByText(/not authorized to view the transcript/i)).toBeInTheDocument();
    expect(screen.queryByText(/check your microphone/i)).toBeNull();
  });

  it('shows the recording for [MUSIC PLAYING] without a microphone error', async () => {
    mockServer(serverOk());
    render(<VoiceScopedDetail detail={detail({ transcript: '[MUSIC PLAYING]' })} />);
    expect(await screen.findByText('[MUSIC PLAYING]')).toBeInTheDocument();
    expect(screen.getByTestId('voice-scoped-player')).toBeInTheDocument();
    expect(screen.queryByText(/no speech captured/i)).toBeNull();
    expect(screen.queryByText(/check your microphone/i)).toBeNull();
  });

  it('offers Download only with the download capability', async () => {
    mockServer(serverOk());
    const { rerender } = render(<VoiceScopedDetail detail={detail()} />);
    await screen.findByTestId('voice-scoped-player-audio');
    expect(screen.queryByRole('button', { name: 'Download Audio' })).toBeNull();

    rerender(<VoiceScopedDetail detail={detail({ capabilities: caps({ download: true }) })} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download Audio' })).toBeInTheDocument());
  });

  it('does not reuse the previous report recording when the selection changes', async () => {
    const user = userEvent.setup();
    const spy = mockServer(serverOk());
    const { rerender } = render(<VoiceScopedDetail detail={detail()} />);
    await screen.findByTestId('voice-scoped-player-audio');

    rerender(<VoiceScopedDetail detail={detail({ id: 'VR-902' })} />);
    await waitFor(() => expect(screen.getByText('VR-902')).toBeInTheDocument());
    await waitFor(() => expect(spy).toHaveBeenCalledWith('VR-902'));
    void user;
  });

  it('displays separate Hospital Dispatch Routing and Emergency Status states', () => {
    mockServer(serverOk());
    const { rerender } = render(
      <VoiceScopedDetail
        detail={detail({
          dispatchStatus: 'BLOCKED_NO_HOSPITAL',
          emergencyId: null,
          confidence: 55,
        })}
      />,
    );

    expect(screen.getByText(/Hospital Dispatch Routing:/i)).toBeInTheDocument();
    expect(screen.getByText('BLOCKED_NO_HOSPITAL')).toBeInTheDocument();
    expect(screen.getByText(/No active Emergency created/i)).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.getByText('VEHICLE COLLISION')).toBeInTheDocument();

    // When an emergency is linked, display actual emergency status
    rerender(
      <VoiceScopedDetail
        detail={detail({
          dispatchStatus: 'DISPATCH_PENDING',
          emergencyId: 'EMG-20487',
          emergencyStatus: 'REPORTED',
          confidence: 90,
        })}
      />,
    );

    expect(screen.getByText('DISPATCH_PENDING')).toBeInTheDocument();
    expect(screen.getByText('EMG-20487')).toBeInTheDocument();
    expect(screen.getByText('REPORTED')).toBeInTheDocument();
  });
});

