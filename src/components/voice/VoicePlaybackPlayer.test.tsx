import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  VoicePlaybackPlayer,
  VoiceTranscriptPanel,
  classifyTranscript,
  presentTranscript,
} from './VoicePlaybackPlayer';
import * as playback from '../../lib/audioPlayback';
import type { ServerAudioResult } from '../../lib/audioPlayback';

// jsdom has no object-URL support and no media stack; both are stubbed here so
// the component's own logic (lifecycle, states, wiring) is what is under test.
let urlCounter = 0;
beforeEach(() => {
  urlCounter = 0;
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (obj: Blob | MediaSource) => {
        const size = obj instanceof Blob ? obj.size : 0;
        urlCounter += 1;
        return `blob:test-${urlCounter}-${size}`;
      },
    });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => undefined });
  }
  // jsdom's HTMLMediaElement is inert: give it the state the component reads.
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const webmBlob = (bytes = 4096) =>
  new Blob([new Uint8Array(bytes)], { type: 'audio/webm' });

function okServer() {
  return {
    ok: true as const,
    blob: webmBlob(2048),
    status: 200,
    contentType: 'audio/webm',
    size: 2048,
  };
}

/** Replaces the authenticated fetch with a scripted outcome. */
function mockFetch(impl: (reportId: string) => Promise<ServerAudioResult>) {
  return vi
    .spyOn(playback, 'fetchServerRecording')
    .mockImplementation((reportId: string) => impl(reportId));
}

/**
 * THE LOAD-BEARING INVARIANT
 *
 * A recording exists ⇏ a transcript exists. Every case below pins one point of
 * that separation: whenever audio exists, the player is rendered and usable,
 * no matter what the transcription stage produced.
 */
describe('audio exists ⇒ player visible, whatever the transcript says', () => {
  const transcripts: Array<[string, string | null]> = [
    ['a real transcript', 'Accident near Rajwada Square in Indore. Two people are injured.'],
    ['[MUSIC PLAYING]', '[MUSIC PLAYING]'],
    ['[UNINTELLIGIBLE]', '[UNINTELLIGIBLE]'],
    ['an empty transcript', ''],
    ['a null transcript', null],
  ];

  it.each(transcripts)('keeps the player with %s', async (_label, transcript) => {
    mockFetch(async () => okServer());
    render(
      <div>
        <VoicePlaybackPlayer reportId="VR-1" testId="p" />
        <VoiceTranscriptPanel transcript={transcript} audioAvailable />
      </div>,
    );
    // Player present and enabled.
    expect(await screen.findByRole('button', { name: /play recorded emergency voice report/i }))
      .toBeInTheDocument();
    // And never a microphone accusation anywhere on the card.
    expect(screen.queryByText(/check your microphone/i)).toBeNull();
    expect(screen.queryByText(/no speech captured/i)).toBeNull();
  });

  it('shows the [MUSIC PLAYING] transcript verbatim alongside the player', async () => {
    mockFetch(async () => okServer());
    render(
      <div>
        <VoicePlaybackPlayer reportId="VR-2" testId="p" />
        <VoiceTranscriptPanel transcript="[MUSIC PLAYING]" audioAvailable />
      </div>,
    );
    expect(await screen.findByText('[MUSIC PLAYING]')).toBeInTheDocument();
    expect(screen.getByTestId('voice-transcript-status')).toHaveTextContent(/no speech detected/i);
    // The reassurance is present…
    expect(screen.getByTestId('voice-transcript-note')).toHaveTextContent(/still available above/i);
    // …and the player survived it.
    expect(screen.getByTestId('p-audio')).toBeInTheDocument();
  });
});

describe('State A — no recording at all', () => {
  it('says there is no recording and never blames the microphone on a transcript alone', async () => {
    render(
      <div>
        <VoicePlaybackPlayer reportId={null} testId="p" />
        <VoiceTranscriptPanel transcript="" audioAvailable={false} />
      </div>,
    );
    expect(screen.getByText(/no voice recording available/i)).toBeInTheDocument();
    expect(screen.queryByTestId('p-audio')).toBeNull();
    // No audio → the transcript panel may report unavailable, but still must not
    // tell the user to check a microphone that produced nothing.
    expect(screen.queryByText(/check your microphone/i)).toBeNull();
  });
});

describe('transcription states (STATE G/H)', () => {
  it('classifies transcripts without ever consulting audio', () => {
    expect(classifyTranscript('Accident near Rajwada Square.')).toBe('AVAILABLE');
    expect(classifyTranscript('[MUSIC PLAYING]')).toBe('NON_SPEECH');
    expect(classifyTranscript('[MUSIC]')).toBe('NON_SPEECH');
    expect(classifyTranscript('[applause]')).toBe('NON_SPEECH');
    expect(classifyTranscript('[UNINTELLIGIBLE]')).toBe('UNINTELLIGIBLE');
    expect(classifyTranscript('[inaudible]')).toBe('UNINTELLIGIBLE');
    expect(classifyTranscript('')).toBe('UNAVAILABLE');
    expect(classifyTranscript(null)).toBe('UNAVAILABLE');
  });

  it('presents a failed transcription as unavailable, not as a mic failure', () => {
    const view = presentTranscript('', true);
    expect(view.status).toBe('UNAVAILABLE');
    expect(view.text).toBeNull();
    expect(view.audioStillAvailable).toBe(true);
  });

  it('reports an RBAC transcript restriction separately from a missing transcript', () => {
    const restricted = presentTranscript('anything', true, true);
    expect(restricted.label).toBe('RESTRICTED');
    render(<VoiceTranscriptPanel transcript="anything" audioAvailable restricted />);
    expect(screen.getByText(/not authorized to view the transcript/i)).toBeInTheDocument();
  });

  it('tells the user the recording survives an unavailable transcript', () => {
    render(<VoiceTranscriptPanel transcript="" audioAvailable />);
    expect(screen.getByText(/transcript unavailable\. you can still listen/i)).toBeInTheDocument();
    expect(screen.getByTestId('voice-transcript-note')).toHaveTextContent(/still available above/i);
  });
});


describe('authenticated delivery and object-URL lifecycle', () => {
  it('loads the stored copy through the authenticated fetch, never via <audio src>', async () => {
    const fetchSpy = mockFetch(async () => okServer());
    render(<VoicePlaybackPlayer reportId="VR-9" testId="p" />);

    expect(await screen.findByTestId('p-audio')).toBeInTheDocument();
    // The report id went through the authenticated helper…
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('VR-9'));
    // …and the element plays a blob: URL, NOT the protected API path.
    const src = screen.getByTestId('p-audio').getAttribute('src') ?? '';
    expect(src.startsWith('blob:')).toBe(true);
    expect(src).not.toContain('/api/voice/reports/');
  });

  it('does not revoke the URL the element is currently playing', async () => {
    mockFetch(async () => okServer());
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    render(<VoicePlaybackPlayer reportId="VR-10" testId="p" />);
    const audio = await screen.findByTestId('p-audio');
    const src = audio.getAttribute('src') ?? '';
    await waitFor(() => expect(src).not.toBe(''));
    expect(revokeSpy).not.toHaveBeenCalledWith(src);
  });

  it('revokes the previous URL when the recording is replaced, not the new one', async () => {
    mockFetch(async () => okServer());
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const { rerender } = render(<VoicePlaybackPlayer reportId="VR-11" testId="p" />);
    const firstSrc = (await screen.findByTestId('p-audio')).getAttribute('src') ?? '';
    await waitFor(() => expect(firstSrc).not.toBe(''));

    rerender(<VoicePlaybackPlayer reportId="VR-12" testId="p" />);
    await waitFor(() => {
      const src = screen.getByTestId('p-audio')?.getAttribute('src') ?? '';
      expect(src).not.toBe(firstSrc);
    });
    const secondSrc = screen.getByTestId('p-audio').getAttribute('src') ?? '';
    // The old URL is released; the live one is not.
    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith(firstSrc));
    expect(revokeSpy).not.toHaveBeenCalledWith(secondSrc);
  });

  it('survives a theme re-render without swapping the source (audio must not restart)', async () => {
    mockFetch(async () => okServer());
    const { rerender } = render(
      <div data-theme="command-pulse">
        <VoicePlaybackPlayer reportId="VR-13" testId="p" />
      </div>,
    );
    const before = (await screen.findByTestId('p-audio')).getAttribute('src') ?? '';
    await waitFor(() => expect(before).not.toBe(''));

    rerender(
      <div data-theme="aether-command">
        <VoicePlaybackPlayer reportId="VR-13" testId="p" />
      </div>,
    );
    const after = screen.getByTestId('p-audio').getAttribute('src') ?? '';
    expect(after).toBe(before);
  });
});

describe('local blob is playable without any server round-trip', () => {
  it('plays the just-recorded blob immediately (no transcription needed)', async () => {
    const fetchSpy = mockFetch(async () => okServer());
    render(<VoicePlaybackPlayer localBlob={webmBlob()} testId="p" />);

    const audio = await screen.findByTestId('p-audio');
    const src = audio.getAttribute('src') ?? '';
    expect(src.startsWith('blob:')).toBe(true);
    // Local-first: no stored fetch is needed when we already hold the audio.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the local recording when the stored copy cannot load', async () => {
    mockFetch(async () => ({ ok: false as const, status: 500, message: 'Server error' }));
    render(<VoicePlaybackPlayer reportId="VR-14" localBlob={webmBlob()} testId="p" />);

    expect(await screen.findByTestId('p-audio')).toBeInTheDocument();
    expect(await screen.findByText(/playing the local recording/i)).toBeInTheDocument();
  });
});


describe('load / failure / retry states', () => {
  it('shows a loading state while the stored audio is in flight', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<ServerAudioResult>((resolve) => {
      release = () => resolve(okServer());
    });
    mockFetch(() => pending);
    render(<VoicePlaybackPlayer reportId="VR-15" testId="p" />);
    expect(screen.getByText(/loading recording/i)).toBeInTheDocument();
    release?.();
    expect(await screen.findByTestId('p-audio')).toBeInTheDocument();
  });

  it('STATE F — a failed load offers Retry, not a microphone error', async () => {
    const fetchSpy = mockFetch(async () => ({
      ok: false as const,
      status: 500,
      message: 'The server errored.',
    }));
    render(<VoicePlaybackPlayer reportId="VR-16" testId="p" />);

    expect(await screen.findByText(/recording could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    // A playback failure is NOT a speech/microphone failure.
    expect(screen.queryByText(/check your microphone/i)).toBeNull();

    // Retry re-issues the authenticated fetch and recovers.
    fetchSpy.mockResolvedValue(okServer());
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByTestId('p-audio')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('duration, controls and accessibility', () => {
  it('resolves a REAL duration for a Duration-less WebM (no 0:00 / 0:00)', async () => {
    mockFetch(async () => okServer());
    // jsdom reports NaN/Infinity; the seek-scan is what produces a real number.
    const scan = vi
      .spyOn(playback, 'resolveFiniteDuration')
      .mockResolvedValue(9.36);
    render(<VoicePlaybackPlayer reportId="VR-17" testId="p" />);
    const audio = await screen.findByTestId('p-audio');
    fireEvent.loadedMetadata(audio);

    await waitFor(() => expect(scan).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByTestId('p-clock')).toHaveTextContent('0:00 — 0:09');
    });
    // Metadata line shows the real container and a plausible size. Scoped to the
    // player so the dev-diagnostics JSON (which also names the MIME type) is
    // never mistaken for the user-visible line.
    expect(screen.getByTestId('p-meta')).toHaveTextContent(/audio\/webm/);
  });

  it('falls back to the server-reported length when the browser never answers', async () => {
    mockFetch(async () => okServer());
    vi.spyOn(playback, 'resolveFiniteDuration').mockResolvedValue(null);
    render(
      <VoicePlaybackPlayer reportId="VR-18" reportedDurationSeconds={12} testId="p" />,
    );
    const audio = await screen.findByTestId('p-audio');
    fireEvent.loadedMetadata(audio);
    await waitFor(() => expect(screen.getByTestId('p-clock')).toHaveTextContent('0:12'));
  });

  it('exposes play/pause, seek and volume through a labelled native control', async () => {
    mockFetch(async () => okServer());
    const user = userEvent.setup();
    render(<VoicePlaybackPlayer reportId="VR-19" testId="p" />);
    await screen.findByTestId('p-audio');

    const play = screen.getByRole('button', { name: 'Play recorded emergency voice report' });
    expect(play).toBeInTheDocument();
    await user.click(play);
    // jsdom never really plays media, so the element announces the state itself.
    fireEvent.play(screen.getByTestId('p-audio'));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Pause recorded emergency voice report' }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: /restart recorded emergency voice report/i }),
    ).toBeInTheDocument();

    // Seek + volume come from the real element, so they exist whenever audio does.
    const audio = screen.getByTestId('p-audio') as HTMLAudioElement;
    expect(audio.controls).toBe(true);
    expect(audio).toHaveAttribute('aria-label', 'Recorded emergency voice report audio');
    // Progress is visible and announced.
    expect(screen.getByRole('progressbar', { name: /playback progress/i })).toBeInTheDocument();
  });

  it('surfaces a media error as an audio error, never as a speech error', async () => {
    mockFetch(async () => okServer());
    const media = Object.defineProperty(window.HTMLMediaElement.prototype, 'error', {
      configurable: true,
      get: () => ({ code: 3 }),
    });
    render(<VoicePlaybackPlayer reportId="VR-20" testId="p" />);
    const audio = await screen.findByTestId('p-audio');
    fireEvent.error(audio);
    expect(screen.getByTestId('p-error')).toHaveTextContent(/could not be decoded/i);
    expect(screen.queryByText(/check your microphone/i)).toBeNull();
    void media;
  });
});

describe('RBAC and download separation', () => {
  it('renders nothing at all when the caller holds no listen right', async () => {
    const fetchSpy = mockFetch(async () => okServer());
    const { container } = render(<VoicePlaybackPlayer reportId="VR-21" canListen={false} testId="p" />);
    expect(container.firstChild).toBeNull();
    // Critically: it does not even try to fetch the audio.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('download stays hidden without the download right, and is offered with it', async () => {
    mockFetch(async () => okServer());
    const onDownload = vi.fn();
    const { rerender } = render(
      <VoicePlaybackPlayer reportId="VR-22" testId="p" canDownload={false} onDownload={onDownload} />,
    );
    await screen.findByTestId('p-audio');
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();

    rerender(
      <VoicePlaybackPlayer reportId="VR-22" testId="p" canDownload onDownload={onDownload} />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument());
  });
});

