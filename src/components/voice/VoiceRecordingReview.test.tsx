import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  VoiceRecordingReview,
  type VoiceRecordingDraft,
} from './VoiceRecordingReview';

beforeEach(() => {
  if (typeof URL.createObjectURL !== 'function') {
    let n = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, writable: true, value: () => `blob:review-${(n += 1)}`,
    });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true, writable: true, value: () => undefined,
    });
  }
});
afterEach(() => vi.restoreAllMocks());

/** The literal bytes MediaRecorder produced — EBML header + payload. */
const capturedBlob = () =>
  new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])], { type: 'audio/webm' });

function draft(overrides: Partial<VoiceRecordingDraft> = {}): VoiceRecordingDraft {
  return {
    blob: capturedBlob(),
    mimeType: 'audio/webm;codecs=opus',
    durationSeconds: 9,
    transcript: 'Accident near Rajwada Square in Indore.',
    transcriptionError: null,
    ...overrides,
  };
}

function setup(props: Partial<React.ComponentProps<typeof VoiceRecordingReview>> = {}) {
  const onSend = vi.fn();
  const onRecordAgain = vi.fn();
  const onDiscard = vi.fn();
  render(
    <VoiceRecordingReview
      draft={draft()}
      uploading={false}
      onSend={onSend}
      onRecordAgain={onRecordAgain}
      onDiscard={onDiscard}
      {...props}
    />,
  );
  return { onSend, onRecordAgain, onDiscard };
}

describe('review before send', () => {
  it('plays the ORIGINAL recording immediately, before anything is uploaded', () => {
    const { onSend } = setup();
    // The player is present and bound to a blob of the captured bytes…
    const audio = screen.getByTestId('voice-review-player-audio');
    expect(audio.getAttribute('src') ?? '').toMatch(/^blob:/);
    // …and nothing has been sent yet.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows the real container, size and duration of the capture', () => {
    setup();
    const meta = screen.getByTestId('voice-review-player-meta');
    expect(meta).toHaveTextContent(/audio\/webm/);
    expect(meta).toHaveTextContent(/0:09/);
  });

  it('offers Send and Record Again', async () => {
    const user = userEvent.setup();
    const { onSend, onRecordAgain } = setup();
    await user.click(screen.getByRole('button', { name: /send recording/i }));
    expect(onSend).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /record again/i }));
    expect(onRecordAgain).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when there is no draft', () => {
    const { container } = render(
      <VoiceRecordingReview draft={null} uploading={false} onSend={vi.fn()} onRecordAgain={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('transcription never gates the audio', () => {
  it('keeps the player for an empty transcript and never blames the microphone', () => {
    setup({ draft: draft({ transcript: '' }) });
    expect(screen.getByTestId('voice-review-player-audio')).toBeInTheDocument();
    expect(screen.getByTestId('voice-review-transcript-state')).toHaveTextContent(/no speech detected/i);
    expect(screen.queryByText(/check your microphone/i)).toBeNull();
  });

  it('keeps the player for [MUSIC PLAYING]', () => {
    setup({ draft: draft({ transcript: '[MUSIC PLAYING]' }) });
    expect(screen.getByTestId('voice-review-player-audio')).toBeInTheDocument();
    expect(screen.getByTestId('voice-review-transcript-state')).toHaveTextContent('[MUSIC PLAYING]');
    expect(screen.queryByText(/check your microphone/i)).toBeNull();
  });

  it('keeps the player when transcription itself failed', () => {
    setup({ draft: draft({ transcript: '', transcriptionError: 'model unavailable' }) });
    expect(screen.getByTestId('voice-review-player-audio')).toBeInTheDocument();
    expect(screen.getByTestId('voice-review-transcript-state')).toHaveTextContent(
      /transcript unavailable/i,
    );
    // The recording is still sendable.
    expect(screen.getByRole('button', { name: /send recording/i })).toBeEnabled();
  });
});

describe('upload failure keeps the recording', () => {
  it('keeps the player and the actions, and says the audio is still local', () => {
    setup({ uploadError: 'The recording could not be uploaded.' });
    expect(screen.getByTestId('voice-recording-review')).toBeInTheDocument();
    expect(screen.getByTestId('voice-review-player-audio')).toBeInTheDocument();
    expect(screen.getByTestId('voice-review-upload-error')).toHaveTextContent(
      /still saved on this device/i,
    );
    // Retry and re-record are both still available — no re-recording forced.
    expect(screen.getByRole('button', { name: /send recording/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /record again/i })).toBeEnabled();
  });

  it('disables both actions while the upload is in flight', () => {
    setup({ uploading: true });
    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /record again/i })).toBeDisabled();
  });

  it('warns citizen when transcript is brief or ambiguous that human review is required', () => {
    setup({ draft: draft({ transcript: 'Short cry' }) });
    expect(screen.getByTestId('voice-review-ambiguity-warning')).toBeInTheDocument();
    expect(screen.getByText(/Human Review Required/i)).toBeInTheDocument();
    expect(screen.getByText(/no active Emergency has been created yet/i)).toBeInTheDocument();
  });
});
