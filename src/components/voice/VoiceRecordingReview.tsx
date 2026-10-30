import { AlertTriangle, Mic, Send, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { VoicePlaybackPlayer } from './VoicePlaybackPlayer';

/**
 * The review step between "recording stopped" and "sent to the server".
 *
 * The user must be able to hear what they actually captured BEFORE anything is
 * uploaded, and must be able to throw that attempt away and record again. This
 * component owns that decision and nothing else — the Blob it renders is the
 * literal bytes `MediaRecorder` produced, so what is played here is exactly what
 * would be uploaded.
 *
 * It never implies the microphone failed: the copy distinguishes "the recording
 * is ready to review" from "transcription produced nothing", which are
 * completely separate facts.
 */
export interface VoiceRecordingDraft {
  /** The original captured bytes. Never re-encoded. */
  blob: Blob;
  /** Container the browser actually produced, e.g. audio/webm;codecs=opus. */
  mimeType: string | null;
  /** Wall-clock length measured while recording. */
  durationSeconds: number;
  /** On-device transcript, possibly empty — never gates playback. */
  transcript: string;
  /** Set when transcription failed; the audio is still perfectly good. */
  transcriptionError?: string | null;
  /** Client-assigned idempotency key for safe duplicate prevention and retries. */
  idempotencyKey?: string | null;
}

export interface VoiceRecordingReviewProps {
  draft: VoiceRecordingDraft | null;
  /** True while the upload is in flight. */
  uploading: boolean;
  /** Upload failure message; the draft is kept so it can be retried. */
  uploadError?: string | null;
  onSend: () => void;
  onRecordAgain: () => void;
  onDiscard?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function VoiceRecordingReview({
  draft,
  uploading,
  uploadError,
  onSend,
  onRecordAgain,
  onDiscard,
}: VoiceRecordingReviewProps) {
  if (!draft) return null;

  return (
    <section
      className="rounded-lg border border-[var(--primary)]/40 bg-[var(--primary)]/5 p-3 space-y-3"
      data-testid="voice-recording-review"
      aria-label="Recorded voice ready to review"
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        <Mic size={13} />
        Review your recording before sending
      </div>

      {/*
        The ORIGINAL recording, playable immediately. It is not gated on the
        transcript, on upload, or on the AI pipeline.
      */}
      <VoicePlaybackPlayer
        localBlob={draft.blob}
        mimeType={draft.mimeType}
        storedSizeBytes={draft.blob.size}
        reportedDurationSeconds={draft.durationSeconds}
        title="Recorded Voice"
        canListen
        testId="voice-review-player"
      />

      {/*
        Transcription is reported separately from the audio. An empty or
        non-speech result never blocks sending, and never blames the microphone.
      */}
      {draft.transcriptionError ? (
        <p className="text-[11px] text-[var(--warning)]" data-testid="voice-review-transcript-state">
          Transcript unavailable ({draft.transcriptionError}). The original recording is still available above.
        </p>
      ) : (
        <p
          className="text-[11px] text-[var(--muted-foreground)]"
          data-testid="voice-review-transcript-state"
        >
          Transcript:{' '}
          {draft.transcript.trim()
            ? draft.transcript.trim()
            : 'no speech detected — the recording itself captured everything and is unaffected.'}
        </p>
      )}

      {(!draft.transcript.trim() || draft.transcript.trim().length < 20 || draft.transcriptionError) && (
        <div
          className="flex items-start gap-2 rounded border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-2.5 text-xs text-[var(--warning)]"
          data-testid="voice-review-ambiguity-warning"
        >
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-semibold">Human Review Required</p>
            <p className="text-[11px] opacity-90">
              The transcript is brief or ambiguous. This report will be saved as a draft for supervisor/dispatcher review — no active Emergency has been created yet.
            </p>
          </div>
        </div>
      )}

      {uploadError && (
        <p className="text-[11px] text-destructive" role="alert" data-testid="voice-review-upload-error">
          <AlertTriangle size={11} className="mr-1 inline" />
          {uploadError} Your recording is still saved on this device — retry without recording again.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={onSend} disabled={uploading}>
          <Send size={13} className="mr-1" />
          {uploading ? 'Sending…' : 'Send Recording'}
        </Button>
        <Button variant="outline" onClick={onRecordAgain} disabled={uploading}>
          <Mic size={13} className="mr-1" />
          Record Again
        </Button>
        {onDiscard && (
          <Button variant="ghost" onClick={onDiscard} disabled={uploading}>
            <Trash2 size={13} className="mr-1" />
            Discard
          </Button>
        )}
      </div>

      <p className="text-[10px] text-[var(--muted-foreground)]">
        {draft.mimeType ?? 'audio'} · {formatBytes(draft.blob.size)} · {draft.durationSeconds}s · not yet
        uploaded
      </p>
    </section>
  );
}
