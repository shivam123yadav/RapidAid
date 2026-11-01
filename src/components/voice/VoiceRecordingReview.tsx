import { useState, useEffect } from 'react';
import { AlertTriangle, Check, CheckSquare, Edit3, FileText, Mic, RotateCcw, Send, Trash2 } from 'lucide-react';
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
  /** Original unedited transcript as recognized by the model. */
  originalTranscript?: string;
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
  /** Invoked with the final confirmed transcript (user-edited or original). */
  onSend: (finalTranscript?: string) => void;
  onRecordAgain: () => void;
  onDiscard?: () => void;
  /** Safe manual reporting fallback when citizen prefers form entry. */
  onManualReport?: () => void;
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
  onManualReport,
}: VoiceRecordingReviewProps) {
  if (!draft) return null;

  const originalText = draft.originalTranscript ?? draft.transcript;
  const [editedText, setEditedText] = useState(draft.transcript);
  const [isEditing, setIsEditing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // Sync state if draft prop changes
  useEffect(() => {
    setEditedText(draft.transcript);
    setConfirmed(false);
  }, [draft.transcript, draft.idempotencyKey]);

  const isUserEdited = editedText.trim() !== originalText.trim();
  const hasUsableText = Boolean(editedText.trim());

  const handleSend = () => {
    onSend(editedText.trim());
  };

  return (
    <section
      className="rounded-lg border border-[var(--primary)]/40 bg-[var(--primary)]/5 p-3 space-y-3"
      data-testid="voice-recording-review"
      aria-label="Recorded voice ready to review"
    >
      <div className="flex items-center justify-between text-xs font-medium">
        <div className="flex items-center gap-2">
          <Mic size={13} />
          Review your recording before sending
        </div>
        {isUserEdited && (
          <span
            className="flex items-center gap-1 rounded bg-[var(--primary)]/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--primary)]"
            data-testid="voice-review-edited-badge"
          >
            <Check size={10} /> Edited by you
          </span>
        )}
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
        Transcription failure vs Success vs Empty state
      */}
      {draft.transcriptionError ? (
        <div
          className="rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2.5 text-[11px] text-[var(--warning)]"
          data-testid="voice-review-model-failure-alert"
        >
          <p className="font-semibold" data-testid="voice-review-transcript-state">
            Transcript unavailable ({draft.transcriptionError}). The original recording is still available above.
          </p>
          <p className="mt-1 opacity-90">
            You can type your report details directly into the box below, record again, or switch to manual reporting.
          </p>
        </div>
      ) : !draft.transcript.trim() ? (
        <div
          className="rounded border border-[var(--muted-foreground)]/30 bg-[var(--muted)]/10 p-2 text-[11px] text-[var(--muted-foreground)]"
          data-testid="voice-review-transcript-state"
        >
          Transcript: no speech detected — the recording itself captured everything and is unaffected.
          <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
            Type what happened below to proceed, or record again.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <p
              className="text-[11px] font-medium text-[var(--foreground)]"
              data-testid="voice-review-transcript-state"
            >
              Transcript: {originalText.trim()}
            </p>
            {!isEditing && (
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="inline-flex items-center gap-1 text-[11px] text-[var(--primary)] hover:underline"
                data-testid="voice-review-edit-toggle"
              >
                <Edit3 size={11} /> Correct text
              </button>
            )}
          </div>
          {isUserEdited && (
            <p className="text-[10px] text-[var(--muted-foreground)]" data-testid="voice-review-original-text">
              <span className="font-medium">Original speech recognition:</span> &ldquo;{originalText.trim()}&rdquo;
            </p>
          )}
        </div>
      )}

      {/*
        Editable Transcript Section: Citizens can review & correct transcription errors
      */}
      <div className="space-y-1.5" data-testid="voice-review-editor-container">
        <div className="flex items-center justify-between">
          <label
            htmlFor="voice-transcript-editor"
            className="text-[11px] font-medium text-[var(--muted-foreground)]"
          >
            Report Transcript {isUserEdited ? '(Modified)' : '(Editable)'}:
          </label>
          {isUserEdited && (
            <button
              type="button"
              onClick={() => {
                setEditedText(originalText);
                setIsEditing(false);
              }}
              className="inline-flex items-center gap-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              data-testid="voice-review-reset-text"
            >
              <RotateCcw size={10} /> Reset to original
            </button>
          )}
        </div>
        <textarea
          id="voice-transcript-editor"
          data-testid="voice-review-transcript-editor"
          value={editedText}
          onChange={(e) => {
            setEditedText(e.target.value);
            setIsEditing(true);
          }}
          placeholder="Verify or type emergency details (e.g. accident location, patient condition, injuries)..."
          rows={3}
          disabled={uploading}
          className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] p-2 text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] disabled:opacity-50"
        />
      </div>

      {/* Ambiguity or Brief Transcript Warning */}
      {(!editedText.trim() || editedText.trim().length < 20 || draft.transcriptionError) && (
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

      {/* Human Confirmation Checkbox: Explicit human verification before emergency creation */}
      {hasUsableText && (
        <label
          className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-xs text-[var(--foreground)] cursor-pointer select-none"
          data-testid="voice-review-confirm-label"
        >
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            disabled={uploading}
            className="h-3.5 w-3.5 rounded border-[var(--input)] text-[var(--primary)] focus:ring-[var(--primary)]"
            data-testid="voice-review-confirm-checkbox"
          />
          <span className="text-[11px]">
            I have confirmed the transcript above accurately describes the situation.
          </span>
        </label>
      )}

      {uploadError && (
        <p className="text-[11px] text-destructive" role="alert" data-testid="voice-review-upload-error">
          <AlertTriangle size={11} className="mr-1 inline" />
          {uploadError} Your recording is still saved on this device — retry without recording again.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={handleSend}
          disabled={uploading}
          data-testid="voice-review-send-button"
        >
          <Send size={13} className="mr-1" />
          {uploading ? 'Sending…' : 'Send Recording'}
        </Button>
        <Button variant="outline" onClick={onRecordAgain} disabled={uploading}>
          <Mic size={13} className="mr-1" />
          Record Again
        </Button>
        {onManualReport && (
          <Button
            variant="outline"
            onClick={onManualReport}
            disabled={uploading}
            data-testid="voice-review-manual-fallback"
          >
            <FileText size={13} className="mr-1" />
            Manual Report
          </Button>
        )}
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
