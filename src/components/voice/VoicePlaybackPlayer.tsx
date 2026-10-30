import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Loader2, Pause, Play, RotateCcw, Volume2 } from 'lucide-react';
import {
  describeMediaError,
  fetchServerRecording,
  resolveFiniteDuration,
  useObjectUrl,
} from '../../lib/audioPlayback';
import { formatDuration } from '../../lib/useVoiceInput';

/**
 * The one voice-recording player in RapidAid.
 *
 * Every surface that plays an emergency recording (the result card, the AI
 * Extracted Information panel, the report inspector) renders THIS component, so
 * playback, duration and error behaviour cannot drift apart between panels.
 *
 * Design rules encoded here:
 *
 * 1. AUDIO EXISTENCE IS NOT TRANSCRIPT EXISTENCE. The player is driven purely by
 *    audio (`localBlob` and/or a stored `reportId`). A transcript is a separate
 *    concern owned by the caller: `[MUSIC PLAYING]`, `[UNINTELLIGIBLE]`, a
 *    failed transcription or a 12% confidence score can never remove, disable
 *    or replace the player.
 * 2. AUTHENTICATED DELIVERY. The stored recording is fetched with the session
 *    bearer token and turned into a Blob before the element sees it. The
 *    protected endpoint is never assigned to `src`, because an `<audio src>`
 *    request cannot carry `Authorization: Bearer` and would 401 into a silent,
 *    unplayable 0:00 / 0:00 control.
 * 3. OBJECT-URL LIFECYCLE. The URL is minted inside the effect (StrictMode safe)
 *    and revoked only when the Blob is replaced or the component unmounts —
 *    never while the element plays it, and never on a theme re-render.
 * 4. LOCAL-FIRST. A `localBlob` (the recording the user just made) is playable
 *    immediately, before upload, transcription or emergency creation finish.
 */
export type VoiceAudioSource = 'server' | 'local';

export type VoiceAudioLoadState = 'idle' | 'loading' | 'ready' | 'failed';

export interface VoicePlaybackPlayerProps {
  /** Stored report to load over the authenticated endpoint. */
  reportId?: string | null;
  /** The just-recorded local blob — playable the instant recording stops. */
  localBlob?: Blob | null;
  /** Container MIME type, when known (metadata only; never synthesised). */
  mimeType?: string | null;
  /** Stored size in bytes, shown as metadata. */
  storedSizeBytes?: number | null;
  /** Server-reported length in seconds, used until the real one is measured. */
  reportedDurationSeconds?: number | null;
  /** Heading above the controls, e.g. "RECORDED VOICE". */
  title?: string;
  /** Listening right. When false nothing is rendered at all. */
  canListen?: boolean;
  /** Download is a separate permission and is never implied by listening. */
  canDownload?: boolean;
  onDownload?: () => void;
  /** Test hook. */
  testId?: string;
}

/** `0:09` for 9.4s, `1:05` for 65s. Never NaN, never Infinity. */
export function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--';
  }
  return formatDuration(Math.floor(seconds));
}

export function VoicePlaybackPlayer({
  reportId,
  localBlob = null,
  mimeType = null,
  storedSizeBytes = null,
  reportedDurationSeconds = null,
  title,
  canListen = true,
  canDownload = false,
  onDownload,
  testId = 'voice-playback-player',
}: VoicePlaybackPlayerProps) {
  // ── Stored copy: authenticated fetch → Blob ──────────────────────────────
  const [serverBlob, setServerBlob] = useState<Blob | null>(null);
  const [loadState, setLoadState] = useState<VoiceAudioLoadState>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverInfo, setServerInfo] = useState<{
    status: number;
    contentType: string;
    size: number;
  } | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const localUrl = useObjectUrl(localBlob);
  const serverUrl = useObjectUrl(serverBlob);

  useEffect(() => {
    // An unauthorized caller must not even request the bytes: the endpoint is
    // the real enforcement, but the UI must not generate the traffic either.
    if (!reportId || !canListen) return;
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    void fetchServerRecording(reportId).then((outcome) => {
      if (cancelled) return;
      if (outcome.ok) {
        setServerBlob(outcome.blob);
        setServerInfo({
          status: outcome.status,
          contentType: outcome.contentType,
          size: outcome.size,
        });
        setLoadState('ready');
      } else {
        // The stored copy failed, but a local recording may still be playable —
        // that decision belongs to source selection below, not to this error.
        setLoadState('failed');
        setLoadError(outcome.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reportId, retryToken, canListen]);

  // A different report must never keep the previous report's bytes on screen.
  useEffect(() => {
    setServerBlob(null);
    setServerInfo(null);
    setLoadState(reportId ? 'loading' : 'idle');
    setLoadError(null);
  }, [reportId]);

  // ── Source selection ────────────────────────────────────────────────────
  // The server copy is preferred (it is the durable one) but the local
  // recording is a first-class fallback, so a server hiccup never takes the
  // recording away. Once the user presses play the choice is locked so a late
  // server copy cannot interrupt audio that is already running.
  const [lockedSource, setLockedSource] = useState<VoiceAudioSource | null>(null);
  const serverReady = loadState === 'ready' && serverUrl !== null;
  const source: VoiceAudioSource | null =
    lockedSource ?? (serverReady ? 'server' : localUrl ? 'local' : null);
  const src = source === 'server' ? serverUrl : source === 'local' ? localUrl : null;

  // ── Playback state ──────────────────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  useEffect(() => {
    setDuration(null);
    setCurrentTime(0);
    setIsPlaying(false);
    setMediaError(null);
  }, [src]);

  const handleLoadedMetadata = useCallback((): void => {
    const media = audioRef.current;
    if (!media) return;
    void resolveFiniteDuration(media).then((real) => {
      // `resolveFiniteDuration` scans a Duration-less WebM; the server's
      // reported length is only a fallback when the browser never answers.
      if (real !== null) setDuration(real);
      else if (Number.isFinite(media.duration) && media.duration > 0) setDuration(media.duration);
    });
  }, []);

  const toggle = useCallback((): void => {
    const media = audioRef.current;
    if (!media) return;
    if (media.paused) {
      if (source) setLockedSource(source);
      void media.play().catch(() => undefined);
    } else {
      media.pause();
    }
  }, [source]);

  const replay = useCallback((): void => {
    const media = audioRef.current;
    if (!media) return;
    media.currentTime = 0;
    if (source) setLockedSource(source);
    void media.play().catch(() => undefined);
  }, [source]);

  const retry = useCallback((): void => {
    setRetryToken((token) => token + 1);
  }, []);

  // A caller with no listen right is never offered the control.
  if (!canListen) return null;

  // ── States A–H ──────────────────────────────────────────────────────────
  const hasAudio = Boolean(src);
  const isLoading = Boolean(reportId) && loadState === 'loading' && !localUrl;
  // `storedFailed` is the outcome of the SERVER copy; `loadFailed` is the state
  // the user is actually stuck in — which only happens when no local recording
  // can stand in for the stored one.
  const storedFailed = Boolean(reportId) && loadState === 'failed';
  const loadFailed = storedFailed && !localUrl;
  // Metadata line: the REAL container the server stored / the browser recorded.
  const effectiveMime = serverInfo?.contentType ?? mimeType ?? (src ? 'audio' : null);
  const effectiveSize = serverInfo?.size ?? storedSizeBytes ?? localBlob?.size ?? null;
  const shownDuration = duration ?? reportedDurationSeconds;

  return (
    <section
      className="rounded-lg border border-[var(--border)] p-3"
      data-testid={testId}
      aria-label="Recorded voice"
    >
      {title && (
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
          {title}
        </p>
      )}

      {/* STATE A — nothing to play. */}
      {!hasAudio && !isLoading && !loadFailed && (
        <p className="text-xs text-[var(--muted-foreground)]">No voice recording available.</p>
      )}

      {/* STATE B/C — uploading / waiting on bytes. */}
      {isLoading && (
        <p
          className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]"
          aria-live="polite"
        >
          <Loader2 size={13} className="animate-spin" />
          Loading recording…
        </p>
      )}

      {/* STATE F — the audio itself could not be loaded. */}
      {loadFailed && (
        <div className="space-y-2" role="alert">
          <p className="text-xs text-destructive">Recording could not be loaded.</p>
          {loadError && <p className="text-[11px] text-[var(--muted-foreground)]">{loadError}</p>}
          <Button variant="outline" size="sm" onClick={retry}>
            <RotateCcw size={13} className="mr-1" />
            Retry
          </Button>
        </div>
      )}

      {/* STATE D/E — ready or playing. */}
      {hasAudio && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={isPlaying ? 'secondary' : 'default'}
              onClick={toggle}
              aria-label={
                isPlaying
                  ? 'Pause recorded emergency voice report'
                  : 'Play recorded emergency voice report'
              }
            >
              {isPlaying ? <Pause size={13} className="mr-1" /> : <Play size={13} className="mr-1" />}
              {isPlaying ? 'Pause' : 'Play Recording'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={replay}
              aria-label="Restart recorded emergency voice report from the beginning"
            >
              <RotateCcw size={13} className="mr-1" />
              Replay
            </Button>
            {canDownload && onDownload && (
              <Button variant="ghost" size="sm" onClick={onDownload}>
                <Volume2 size={13} className="mr-1" />
                Download
              </Button>
            )}
          </div>


          {/* The real element: native seek + volume, driven by a Blob URL. */}
          <audio
            ref={audioRef}
            src={src ?? undefined}
            data-testid={`${testId}-audio`}
            className="w-full"
            controls
            preload="metadata"
            aria-label="Recorded emergency voice report audio"
            onLoadedMetadata={handleLoadedMetadata}
            onDurationChange={handleLoadedMetadata}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            onError={() => {
              setMediaError(describeMediaError(audioRef.current?.error?.code ?? null));
              setIsPlaying(false);
            }}
          />

          {/* Visible progress, readable by assistive tech. */}
          <div
            role="progressbar"
            aria-label="Recording playback progress"
            aria-valuemin={0}
            aria-valuemax={shownDuration ?? 0}
            aria-valuenow={Math.floor(currentTime)}
            aria-valuetext={`${clock(currentTime)} of ${clock(shownDuration)}`}
            className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--muted)]"
          >
            <div
              className="h-full bg-[var(--primary)] transition-[width]"
              style={{
                width: `${shownDuration && shownDuration > 0
                  ? Math.min(100, (currentTime / shownDuration) * 100)
                  : 0}%`,
              }}
            />
          </div>
          <p
            data-testid={`${testId}-clock`}
            className="text-[11px] tabular-nums text-[var(--muted-foreground)]"
          >
            {clock(currentTime)} — {clock(shownDuration)}
          </p>

          <p
            data-testid={`${testId}-meta`}
            className="text-[11px] text-[var(--muted-foreground)]"
          >
            {effectiveMime ? `${effectiveMime} • ` : ''}
            {effectiveSize !== null ? `${Math.max(1, Math.round(effectiveSize / 1024))} KB` : null}
            {shownDuration ? ` • ${clock(shownDuration)}` : ''}
            {source ? ` • ${source === 'server' ? 'stored copy' : 'local recording'}` : ''}
          </p>

          {mediaError && (
            <p data-testid={`${testId}-error`} className="text-[11px] text-destructive" role="alert">
              {mediaError}
            </p>
          )}


          {/* Dev-only diagnostics: state and metadata, never samples or tokens. */}
          {import.meta.env.DEV && (
            <details className="text-[var(--muted-foreground)]">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide">
                Playback diagnostics
              </summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[10px] leading-4">
                {JSON.stringify(
                  {
                    source,
                    loadState,
                    server: serverInfo ?? loadError ?? null,
                    localBlob: localBlob ? { type: localBlob.type, size: localBlob.size } : null,
                    blob: serverBlob ? { type: serverBlob.type, size: serverBlob.size } : null,
                    player: {
                      duration,
                      currentTime,
                      readyState: audioRef.current?.readyState ?? null,
                      networkState: audioRef.current?.networkState ?? null,
                      mediaError,
                    },
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* A failed stored copy never silently downgrades the local recording. */}
      {storedFailed && localUrl && (
        <p className="mt-2 text-[11px] text-[var(--warning)]">
          Stored copy unavailable ({loadError}) — playing the local recording.
        </p>
      )}
      {storedFailed && localUrl && (
        <Button variant="ghost" size="sm" className="mt-1" onClick={retry}>
          <RotateCcw size={13} className="mr-1" />
          Retry Server Audio
        </Button>
      )}
    </section>
  );
}


// ── Transcript state (deliberately independent of audio) ───────────────────

export type TranscriptStatus =
  | 'AVAILABLE'
  | 'NON_SPEECH'
  | 'UNINTELLIGIBLE'
  | 'UNAVAILABLE';

/**
 * Classifies a transcript WITHOUT ever consulting the audio.
 *
 * The point of this helper: a transcript outcome can only change what is written
 * next to the player, never whether the player exists. A recording of
 * `[MUSIC PLAYING]` is a real, playable emergency recording.
 */
export function classifyTranscript(transcript: string | null | undefined): TranscriptStatus {
  const text = (transcript ?? '').trim();
  if (!text) return 'UNAVAILABLE';
  // Unintelligible speech is checked FIRST: `[inaudible]`/`[unclear]` describe
  // speech that was captured but not understood, which is a different (and more
  // actionable) outcome than a recording that simply contains no speech.
  if (/^[\[\(]?\s*(unintelligible|unclear|inaudible)\b/i.test(text)) return 'UNINTELLIGIBLE';
  // Whisper's non-speech tags, in either casing, bracketed or not.
  if (/^[\[\(]?\s*(music|applause|noise|silence|background noise)\b/i.test(text)) {
    return 'NON_SPEECH';
  }
  return 'AVAILABLE';
}

export interface TranscriptPresentation {
  status: TranscriptStatus;
  /** The text to show, or null when there is genuinely nothing to show. */
  text: string | null;
  /** Human label for the status chip. */
  label: string;
  /** True when the caller can listen, so the copy can point back at the player. */
  audioStillAvailable: boolean;
}

/**
 * Builds the transcript block. `audioAvailable` is passed in purely so the copy
 * can say "the original recording is still available" — it never gates the
 * audio, which is the caller's job.
 */
export function presentTranscript(
  transcript: string | null | undefined,
  audioAvailable: boolean,
  restricted = false,
): TranscriptPresentation {
  if (restricted) {
    return { status: 'UNAVAILABLE', text: null, label: 'RESTRICTED', audioStillAvailable: audioAvailable };
  }
  const status = classifyTranscript(transcript);
  switch (status) {
    case 'AVAILABLE':
      return {
        status,
        text: (transcript ?? '').trim(),
        label: 'TRANSCRIBED',
        audioStillAvailable: audioAvailable,
      };
    case 'NON_SPEECH':
      return {
        status,
        text: (transcript ?? '').trim(),
        label: 'NO SPEECH DETECTED',
        audioStillAvailable: audioAvailable,
      };
    case 'UNINTELLIGIBLE':
      return {
        status,
        text: (transcript ?? '').trim(),
        label: 'UNINTELLIGIBLE',
        audioStillAvailable: audioAvailable,
      };
    default:
      return { status: 'UNAVAILABLE', text: null, label: 'UNAVAILABLE', audioStillAvailable: audioAvailable };
  }
}


export interface VoiceTranscriptPanelProps {
  transcript: string | null | undefined;
  /** True when the caller may listen — drives the reassuring copy only. */
  audioAvailable: boolean;
  /** The caller holds no transcript grant (RBAC), distinct from "no audio". */
  restricted?: boolean;
  title?: string;
}

/**
 * The transcript block that sits directly under the player.
 *
 * It renders a *status* rather than a verdict about the recording. Nothing in
 * here can hide, disable or unmount {@link VoicePlaybackPlayer}.
 */
export function VoiceTranscriptPanel({
  transcript,
  audioAvailable,
  restricted = false,
  title = 'TRANSCRIPT',
}: VoiceTranscriptPanelProps) {
  const view = presentTranscript(transcript, audioAvailable, restricted);

  return (
    <section
      className="rounded-lg border border-[var(--border)] p-3"
      data-testid="voice-transcript-panel"
      aria-label="Voice report transcript"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
          {title}
        </p>
        <span
          data-testid="voice-transcript-status"
          className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]"
        >
          {view.label}
        </span>
      </div>

      {view.text ? (
        <p
          data-testid="voice-transcript-text"
          className="rounded-md bg-[var(--surface)] p-2 text-sm leading-relaxed"
        >
          {view.text}
        </p>
      ) : (
        <p
          data-testid="voice-transcript-text"
          className="rounded-md bg-[var(--surface)] p-2 text-sm text-[var(--muted-foreground)]"
        >
          {restricted
            ? 'You are not authorized to view the transcript of this recording.'
            : 'Transcript unavailable. You can still listen to the recording.'}
        </p>
      )}

      {/*
        A non-speech or unintelligible transcript is a TRANSCRIPTION outcome.
        Saying "check your microphone" here would be wrong: the microphone
        worked, the audio exists, and the player above is proof of it.
      */}
      {(view.status === 'NON_SPEECH' || view.status === 'UNINTELLIGIBLE') && (
        <p data-testid="voice-transcript-note" className="mt-1.5 text-[11px] text-[var(--muted-foreground)]">
          No recognisable speech was detected in this recording. The original audio was captured
          successfully{view.audioStillAvailable ? ' and is still available above' : ''} — listen to
          it and add the incident details manually before confirming.
        </p>
      )}
      {view.status === 'UNAVAILABLE' && !restricted && view.audioStillAvailable && (
        <p data-testid="voice-transcript-note" className="mt-1.5 text-[11px] text-[var(--muted-foreground)]">
          The original recording is still available above.
        </p>
      )}
    </section>
  );
}

