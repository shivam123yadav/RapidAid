import { useCallback, useEffect, useRef, useState } from 'react';
import { preloadTranscriber, transcribeBlob } from './transcribeAudio';

/** Mirrors the server-side `voiceTranscriptSchema` minimum length. */
export const MIN_TRANSCRIPT_LENGTH = 10;

/** Formats a recording duration as `M:SS`. */
export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** `processing` covers stop → finalize → on-device transcription. */
type VoicePhase = 'idle' | 'recording' | 'processing';

/** Preferred MediaRecorder containers, best first. */
const RECORDER_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

/**
 * Safety cap: transcription time scales with recording length, so sessions
 * stop automatically at 5 minutes and go through the normal stop pipeline.
 */
const MAX_RECORDING_SECONDS = 300;

export interface VoiceStopResult {
  /** Final transcript; empty when nothing usable was captured. */
  text: string;
  /** User-facing failure message, if local transcription failed. */
  error: string | null;
  /**
   * The raw recording, preserved so it can be uploaded and stored on the
   * server. It survives a transcription failure — the audio is never lost.
   */
  blob: Blob | null;
  /** Actual container MIME type reported by MediaRecorder (never assumed). */
  mimeType: string | null;
  /** Wall-clock recording length in seconds. */
  durationSeconds: number;
}

export interface UseVoiceInputResult {
  phase: VoicePhase;
  isRecording: boolean;
  isProcessing: boolean;
  /** Seconds since recording started (ticks while recording). */
  elapsedSeconds: number;
  /** Live microphone level 0-1 while recording (drives the input meter). */
  inputLevel: number;
  /** Model-load / transcription progress while processing, or null. */
  transcribeProgress: number | null;
  /** MediaRecorder + getUserMedia available (voice recording works). */
  recordingSupported: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<VoiceStopResult>;
}

/**
 * Voice capture: the whole session is recorded locally with MediaRecorder
 * and transcribed on-device with the free bundled Whisper model (see
 * `transcribeAudio.ts`) — no cloud speech API, no API keys, nothing spoken
 * is skipped. `stop()` resolves with a transcript of everything said.
 */
export function useVoiceInput(): UseVoiceInputResult {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [transcribeProgress, setTranscribeProgress] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const opRef = useRef(false); // one start/stop operation at a time
  const mountedRef = useRef(true);
  const startedAtRef = useRef(0);
  /** Actual container MIME type MediaRecorder negotiated — never assumed. */
  const recorderMimeTypeRef = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef(0);
  const stopRef = useRef<(() => Promise<VoiceStopResult>) | null>(null);

  const recordingSupported =
    typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

  // Recording-duration ticker (drives the elapsed-time display) + safety cap.
  useEffect(() => {
    if (phase !== 'recording') return;
    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    const id = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAtRef.current) / 1000);
      setElapsedSeconds(elapsed);
      if (elapsed >= MAX_RECORDING_SECONDS) {
        clearInterval(id);
        void stopRef.current?.();
      }
    }, 500);
    return () => clearInterval(id);
  }, [phase]);

  // Live microphone level for the input meter (state updates throttled to
  // ~20 fps so recording doesn't re-render the page on every animation frame).
  useEffect(() => {
    if (phase !== 'recording') return;
    const analyser = analyserRef.current;
    if (!analyser) return;
    const samples = new Float32Array(analyser.fftSize);
    let lastUpdate = 0;
    const tick = (time: number) => {
      rafRef.current = requestAnimationFrame(tick);
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      if (time - lastUpdate >= 50) {
        lastUpdate = time;
        if (mountedRef.current) setInputLevel(Math.min(1, rms * 3.5));
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (mountedRef.current) setInputLevel(0);
    };
  }, [phase]);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  /** Stops the level meter and releases the Web Audio graph. */
  const teardownMeter = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    analyserRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => undefined);
    }
  }, []);

  /** Stops the recorder and resolves with the collected audio, if any. */
  const stopRecorder = useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const collect = () => {
      if (chunks.length === 0) return null;
      const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
      return blob.size > 0 ? blob : null;
    };
    if (!recorder || recorder.state === 'inactive') {
      recorderRef.current = null;
      return Promise.resolve(collect());
    }
    return new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        recorder.onstop = null;
        recorderRef.current = null;
        resolve(collect());
      };
      try {
        recorder.stop();
      } catch {
        recorder.onstop = null;
        recorderRef.current = null;
        resolve(collect());
      }
    });
  }, []);

  const start = useCallback(async () => {
    if (opRef.current || phase === 'recording') return;
    opRef.current = true;
    setError(null);
    setTranscribeProgress(null);
    setElapsedSeconds(0);
    try {
      if (!recordingSupported) {
        setError('Voice recording is not supported in this browser. Use Chrome or Edge.');
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Microphone access was denied. Allow microphone permission for this site, then try again.'
            : 'No microphone was found. Connect a microphone and try again.',
        );
        return;
      }
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];
      // Live input meter: tap the stream so the UI reacts to real mic levels.
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        void ctx.resume().catch(() => undefined);
      } catch {
        // The meter is cosmetic — recording continues without it.
      }
      const mime = RECORDER_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      let recorder: MediaRecorder;
      try {
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch {
        releaseStream();
        teardownMeter();
        setError('Could not start audio recording in this browser.');
        return;
      }
      // Record what the browser actually produced (e.g. 'audio/webm;codecs=opus')
      // instead of assuming WAV/MP3 — the container drives the stored filename.
      recorderMimeTypeRef.current = recorder.mimeType || mime || null;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorderRef.current = recorder;
      // 1-second chunks stream audio incrementally so nothing spoken is lost
      // even if the session is interrupted before stop().
      recorder.start(1000);
      setPhase('recording');
      // Warm up the bundled transcriber while the user speaks (no-op once ready).
      preloadTranscriber();
    } finally {
      opRef.current = false;
    }
  }, [phase, recordingSupported, releaseStream, teardownMeter]);

  const stop = useCallback(async (): Promise<VoiceStopResult> => {
    if (phase !== 'recording' || opRef.current) {
      return { text: '', error: null, blob: null, mimeType: null, durationSeconds: 0 };
    }
    opRef.current = true;
    setPhase('processing');
    setError(null);

    let localError: string | null = null;
    let text = '';
    const blob = await stopRecorder();
    const mimeType = blob?.type || recorderMimeTypeRef.current || null;
    const durationSeconds = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
    releaseStream();
    teardownMeter();

    if (!blob) {
      localError = 'No audio was captured — check your microphone and try again.';
    } else {
      setTranscribeProgress(null);
      try {
        // Transcribe everything spoken with the bundled free Whisper model.
        text = await transcribeBlob(blob, (percent) => {
          if (mountedRef.current) setTranscribeProgress(percent);
        });
      } catch (err) {
        localError =
          err instanceof Error && err.message ? err.message : 'Could not transcribe the recording.';
        text = '';
      } finally {
        if (mountedRef.current) setTranscribeProgress(null);
      }
    }

    if (mountedRef.current) {
      if (localError) setError(localError);
      setInputLevel(0);
      setPhase('idle');
    }
    opRef.current = false;
    // The blob is returned even when transcription failed: the recording is
    // still uploaded so it can be stored and reviewed later.
    return { text, error: localError, blob, mimeType, durationSeconds };
  }, [phase, releaseStream, stopRecorder, teardownMeter]);

  // Keep the latest `stop` reachable from the duration-ticker effect.
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Already stopped.
        }
      }
      releaseStream();
      teardownMeter();
    };
  }, [releaseStream, teardownMeter]);

  return {
    phase,
    isRecording: phase === 'recording',
    isProcessing: phase === 'processing',
    elapsedSeconds,
    inputLevel,
    transcribeProgress,
    recordingSupported,
    error,
    start,
    stop,
  };
}

