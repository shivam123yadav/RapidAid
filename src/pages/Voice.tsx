import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import {
  Mic, MicOff, CheckCircle, AlertTriangle, Volume2, FileText,
  MapPin, Building2, Route, BellRing, Play, Search, ShieldCheck,
} from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can } from '../lib/permissions';
import { useVoiceInput, formatDuration } from '../lib/useVoiceInput';
import { buildVoiceRecordingFormData } from '../lib/audioNormalize';
// All audio playback lives in the shared player, so this page holds no
// object-URL, fetch or media-error logic of its own.
import { getDeviceLocation } from '../lib/geolocation';
import {
  VoicePlaybackPlayer,
  VoiceTranscriptPanel,
} from '../components/voice/VoicePlaybackPlayer';
import {
  VoiceRecordingReview,
  type VoiceRecordingDraft,
} from '../components/voice/VoiceRecordingReview';
import { getTabsForRole } from '../components/voice/VoiceScopeTabs';
import { VoiceScopedDetail } from '../components/voice/VoiceScopedDetail';
import type { VoiceRecordingResult } from '../types';


const DEMO_TRANSCRIPT =
  "There's been an accident near Rajpath crossing. A car hit a motorcycle. The rider is on the ground and not moving. I think his leg is badly injured. Please send help quickly.";

/** One labelled row in the result card. */
function ResultRow({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: typeof MapPin;
  label: string;
  value: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneClass = {
    default: 'text-sm font-medium',
    good: 'text-sm font-medium text-[var(--success)]',
    warn: 'text-sm font-medium text-[var(--warning)]',
    bad: 'text-sm font-medium text-destructive',
  }[tone];
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] py-2 last:border-0">
      <span className="flex items-center gap-1.5 text-sm text-[var(--muted-foreground)]">
        <Icon size={13} className="mt-0.5 flex-shrink-0" />
        {label}
      </span>
      <span className={`text-right ${toneClass}`}>{value}</span>
    </div>
  );
}

/**
 * The complete voice-emergency result.
 *
 * Every field reflects what the pipeline actually did. A step that failed is
 * shown as failed with its reason — the card never renders a success it did
 * not receive (no hospital, no coordinates and no notification are never
 * dressed up as done).
 */
function VoiceResultCard({
  result,
  audioBlob,
  onDismiss,
}: {
  result: VoiceRecordingResult;
  /** The just-recorded blob, so playback works before the server copy is read. */
  audioBlob: Blob | null;
  onDismiss: () => void;
}) {
  const { extractedInformation: extracted, location, hospital } = result;
  const audioMeta = result.report.audio;
  const reportId = result.report.id;
  const confidence = result.report?.confidence ?? extracted.confidence ?? 0;

  const isFullyConfirmed = Boolean(
    result.emergency &&
    result.report?.status === 'CONFIRMED' &&
    result.dispatchStatus !== 'BLOCKED_NO_HOSPITAL' &&
    result.dispatchStatus !== 'AWAITING_REVIEW',
  );

  return (
    <Card className={isFullyConfirmed ? 'border-[var(--success)]/40' : 'border-[var(--warning)]/40'}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle
              size={16}
              className={isFullyConfirmed ? 'text-[var(--success)]' : 'text-[var(--warning)]'}
            />
            VOICE EMERGENCY {isFullyConfirmed ? 'PROCESSED' : 'SAVED — AWAITING REVIEW'}
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {result.warning && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-[var(--warning)]" />
            <p className="text-xs text-[var(--warning)]">{result.warning}</p>
          </div>
        )}

        {!isFullyConfirmed && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-3 text-xs text-[var(--warning)]">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold">Human Review Required</p>
              <p className="mt-0.5 text-[11px] opacity-90">
                {location.source === 'DEVICE' ? 'Device GPS location is unverified. ' : ''}
                {confidence < 75 ? `Confidence (${confidence}%) requires confirmation. ` : ''}
                {extracted.emergencyType === 'OTHER' ? 'Incident type is unclassified. ' : ''}
                This report is saved as a draft awaiting supervisor/dispatcher review. No active Emergency has been created yet.
              </p>
            </div>
          </div>
        )}

        <div>
          <p className="mb-1 text-xs text-[var(--muted-foreground)]">Transcript</p>
          <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm leading-relaxed">
            {result.transcript || (
              <span className="text-[var(--muted-foreground)]">No transcript was produced.</span>
            )}
          </p>
        </div>

        <div className="rounded-lg border border-[var(--border)] p-3">
          <ResultRow
            icon={AlertTriangle}
            label="Detected emergency"
            value={extracted.emergencyType.replace(/_/g, ' ')}
          />
          <ResultRow
            icon={AlertTriangle}
            label="Extraction confidence"
            value={`${confidence}%`}
            tone={confidence >= 75 ? 'good' : 'warn'}
          />
          <ResultRow
            icon={AlertTriangle}
            label="Severity"
            value={extracted.severity}
            tone={
              extracted.severity === 'CRITICAL'
                ? 'bad'
                : extracted.severity === 'HIGH'
                  ? 'warn'
                  : 'default'
            }
          />
          <ResultRow
            icon={FileText}
            label="People affected"
            value={extracted.injuredPeople ?? 'Not stated'}
          />
          <ResultRow
            icon={MapPin}
            label="Detected location"
            value={extracted.spokenLocation ?? 'None detected'}
            tone={extracted.spokenLocation ? 'default' : 'warn'}
          />
          {extracted.landmarks.length > 0 && (
            <ResultRow icon={MapPin} label="Landmarks" value={extracted.landmarks.join(', ')} />
          )}
          <ResultRow
            icon={MapPin}
            label="Location source"
            value={location.source}
            tone={location.source === 'UNRESOLVED' ? 'bad' : 'default'}
          />
          <ResultRow
            icon={MapPin}
            label="Coordinates"
            value={
              location.latitude !== null && location.longitude !== null
                ? `${location.latitude}, ${location.longitude}${
                    location.status === 'APPROXIMATE' && location.accuracy
                      ? ` (approx. ±${Math.round(location.accuracy / 1000)} km)`
                      : ''
                  }`
                : 'Not resolved'
            }
            tone={location.resolved ? 'good' : 'bad'}
          />
          <ResultRow
            icon={Building2}
            label="Nearest suitable hospital"
            value={hospital ? hospital.name : 'None selected'}
            tone={hospital ? 'good' : 'bad'}
          />
          <ResultRow
            icon={Route}
            label="Distance"
            value={
              result.distance !== null
                ? `${(result.distance / 1000).toFixed(1)} km · ETA ${
                    hospital ? Math.round(hospital.etaSeconds / 60) : 0
                  } min`
                : '—'
            }
          />
          <ResultRow
            icon={Building2}
            label="Hospital Dispatch Routing"
            value={result.dispatchStatus}
            tone={result.dispatchStatus === 'DISPATCHER_NOTIFIED' ? 'good' : 'warn'}
          />
          <ResultRow
            icon={FileText}
            label="Emergency ID"
            value={result.emergency?.id ?? 'Not created'}
            tone={result.emergency ? 'good' : 'warn'}
          />
          <ResultRow
            icon={CheckCircle}
            label="Emergency Status"
            value={result.emergency?.status ?? 'No active Emergency created (Pending Review)'}
            tone={result.emergency ? 'good' : 'warn'}
          />
          <ResultRow
            icon={BellRing}
            label="Hospital notification"
            value={result.hospitalNotificationSent ? 'Sent' : 'Not sent'}
            tone={result.hospitalNotificationSent ? 'good' : 'warn'}
          />
        </div>

        {/*
          The player is the shared component: this card and the AI Extracted
          Information panel below must never disagree about how a recording is
          fetched, played, measured or reported.
        */}
        <VoicePlaybackPlayer
          reportId={reportId}
          localBlob={audioBlob}
          mimeType={audioMeta?.mimeType ?? null}
          storedSizeBytes={audioMeta?.size ?? null}
          reportedDurationSeconds={audioMeta?.durationSeconds ?? null}
          title="Recorded Voice"
          canListen
          testId="voice-result-player"
        />
        {audioMeta && (
          <p className="text-[11px] text-[var(--muted-foreground)]">
            Stored on the server as {audioMeta.filename}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface MicButtonProps {
  isRecording: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** Round mic/stop control shared by the empty and draft Voice states. */
function MicButton({ isRecording, disabled = false, onClick }: MicButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={isRecording ? 'Stop recording' : 'Start recording'}
      className={`relative flex h-24 w-24 items-center justify-center rounded-full transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
        isRecording
          ? 'bg-[var(--destructive)] shadow-lg shadow-[0_8px_24px_-8px_var(--destructive)] scale-110'
          : 'bg-[var(--primary)] hover:scale-105'
      }`}
    >
      {isRecording ? (
        <MicOff size={32} className="text-[var(--destructive-foreground)]" />
      ) : (
        <Mic size={32} className="text-[var(--primary-foreground)]" />
      )}
      {isRecording && (
        <span className="absolute inset-0 rounded-full animate-ping bg-[var(--destructive)]/30" />
      )}
    </button>
  );
}

/** Live mic-level bars — heights follow the real input RMS level. */
function LevelMeter({ isRecording, inputLevel }: { isRecording: boolean; inputLevel: number }) {
  if (!isRecording) return null;
  return (
    <div className="mt-3 flex h-14 items-center gap-1" aria-hidden="true">
      {Array.from({ length: 20 }).map((_, i) => {
        // Symmetric weight gives the meter a center-peaked, voice-like shape.
        const weight = 0.35 + 0.65 * Math.sin(((i + 1) / 21) * Math.PI);
        const height = 8 + inputLevel * 56 * weight;
        return (
          <div
            key={i}
            className="w-1 rounded-full bg-[var(--primary)] transition-[height] duration-100 ease-out"
            style={{ height: `${height}px` }}
          />
        );
      })}
    </div>
  );
}

export function VoicePage() {
  const user = useAuthStore((state) => state.user);
  const held = user?.permissions;
  const canCreate = can(user?.role, 'voice:create', held);
  const canConfirm = can(user?.role, 'voice:confirm', held);
  const canDiscard = can(user?.role, 'voice:delete:own', held) || canConfirm;
  /**
   * Listening and downloading are separate rights, exactly as the server
   * enforces them (`assertVoiceAccess(..., 'listen' | 'download')`). Listening
   * is what the player needs; download is opt-in and never implied by it.
   */
  const canListen =
    can(user?.role, 'voice:listen:all', held) ||
    can(user?.role, 'voice:listen:own', held) ||
    can(user?.role, 'voice:listen:assigned', held) ||
    can(user?.role, 'voice:listen:hospital', held) ||
    can(user?.role, 'voice:listen:relevant', held) ||
    can(user?.role, 'voice:listen:historical', held) ||
    can(user?.role, 'voice:listen:analytical', held);
  const canDownload =
    can(user?.role, 'voice:download:all', held) ||
    can(user?.role, 'voice:download:authorized', held) ||
    can(user?.role, 'voice:download:own', held);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Role-appropriate Workspace scoping and report inspector
  const roleTabs = useMemo(() => getTabsForRole(user?.role), [user?.role]);
  const [selectedTabKey, setSelectedTabKey] = useState<string>(() => roleTabs[0]?.key ?? 'all');
  const activeTabDef = roleTabs.find((t) => t.key === selectedTabKey) ?? roleTabs[0];

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);

  const { data: reportsData, isLoading: reportsLoading, refetch: refetchList } = useQuery({
    queryKey: ['voice-reports', activeTabDef?.scope, activeTabDef?.status, searchQuery],
    queryFn: () =>
      api.voice.listReports({
        scope: activeTabDef?.scope,
        status: activeTabDef?.status,
        search: searchQuery.trim() || undefined,
        limit: 50,
      }),
  });

  const { data: selectedDetail, isLoading: detailLoading, refetch: refetchDetail } = useQuery({
    queryKey: ['voice-report-detail', selectedReportId],
    queryFn: () => (selectedReportId ? api.voice.getReport(selectedReportId) : null),
    enabled: Boolean(selectedReportId),
  });


  // Draft report comes from the API (seeded VR-001 on first boot).
  const { data: report, isLoading } = useQuery({
    queryKey: ['voice-report'],
    queryFn: api.voice.getCurrentReport,
    retry: false,
  });

  // Human confirmation → creates a real emergency (source VOICE_REPORT).
  const confirmMutation = useMutation({
    mutationFn: (reportId: string) => api.voice.confirmReport(reportId),
    onSuccess: ({ emergency }) => {
      setActionError(null);
      setIsRecordingSession(false);
      setRecordingResult(null);
      setRecordingBlob(null);
      void queryClient.invalidateQueries({ queryKey: ['emergencies'] });
      void queryClient.invalidateQueries({ queryKey: ['voice-report'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      navigate(`/emergencies/${emergency.id}`);
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'Confirmation failed'),
  });

  const discardMutation = useMutation({
    mutationFn: (reportId: string) => api.voice.discardReport(reportId),
    onSuccess: () => {
      setActionError(null);
      setIsRecordingSession(false);
      setRecordingResult(null);
      setRecordingBlob(null);
      void queryClient.invalidateQueries({ queryKey: ['voice-report'] });
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'Discard failed'),
  });

  // After confirm/discard there is no draft — allow generating a new one.
  const newDraftMutation = useMutation({
    mutationFn: () => api.voice.submitTranscript(DEMO_TRANSCRIPT),
    onSuccess: () => {
      setActionError(null);
      setIsRecordingSession(false);
      setRecordingResult(null);
      setRecordingBlob(null);
      void queryClient.invalidateQueries({ queryKey: ['voice-report'] });
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'Could not create draft'),
  });

  // Real microphone capture → on-device transcript → upload + full pipeline.
  // The recording blob is uploaded as multipart/form-data (the browser sets the
  // boundary), and the server stores the audio, extracts the emergency facts,
  // geocodes the spoken location and selects the nearest suitable hospital.
  const [recordingResult, setRecordingResult] = useState<VoiceRecordingResult | null>(null);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  /**
   * The unsent recording, held as ORIGINAL BYTES.
   *
   * This is deliberately separate from `recordingBlob` (the blob that was
   * confirmed stored) and from any server URL: the local Blob is never replaced
   * by a URL and never cleared until an upload has actually succeeded, so a
   * failed upload never costs the user their recording.
   */
  const [draft, setDraft] = useState<VoiceRecordingDraft | null>(null);
  /**
   * Flags whether a new recording session has been initiated by the user.
   * When true, older unrelated reports are never displayed in the recording/transcript panel.
   */
  const [isRecordingSession, setIsRecordingSession] = useState(false);

  const recordMutation = useMutation({
    mutationFn: async (payload: { form: FormData; blob: Blob; idempotencyKey?: string | null }) => {
      const result = await api.voice.submitRecording(payload.form, payload.idempotencyKey ?? undefined);
      return { result, blob: payload.blob };
    },
    onSuccess: ({ result, blob }) => {
      setRecordingResult(result);
      setRecordingBlob(blob);
      // The upload is confirmed, so the draft has done its job.
      setDraft(null);
      setUploadError(null);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['voice-report'] });
      void queryClient.invalidateQueries({ queryKey: ['emergencies'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (err) => {
      // The local Blob is KEPT, so retrying never requires re-recording.
      setUploadError(
        err instanceof ApiError
          ? err.message
          : 'The recording could not be uploaded.',
      );
      setActionError(null);
    },
  });

  const {
    isRecording,
    isProcessing,
    elapsedSeconds,
    inputLevel,
    transcribeProgress,
    recordingSupported,
    error: voiceError,
    selectedLanguage,
    setSelectedLanguage,
    start: startVoice,
    stop: stopVoice,
  } = useVoiceInput();

  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleMicClick = () => {
    if (isRecording) {
      void (async () => {
        const result = await stopVoice();
        // AUDIO AND TRANSCRIPTION ARE SEPARATE STAGES.
        //
        // The Blob is the evidence of a successful capture. A short, empty or
        // non-speech transcript says nothing about the recording, so it must
        // never be reported as a microphone failure and never blocks sending.
        if (!result.blob) {
          // Genuinely nothing was captured — ONLY here is a mic error correct.
          setActionError('No audio was captured — check your microphone and try again.');
          return;
        }
        // Stage the ORIGINAL bytes for review. Nothing is uploaded yet: the
        // user listens first and decides.
        setDraft({
          blob: result.blob,
          mimeType: result.mimeType,
          durationSeconds: result.durationSeconds,
          transcript: result.text,
          originalTranscript: result.text,
          transcriptionError: result.error,
          idempotencyKey: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `rec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        });
        setUploadError(null);
        setActionError(null);
      })();
      return;
    }
    // A new recording has begun: clear previous recording results and bottom transcript panel.
    setIsRecordingSession(true);
    setRecordingResult(null);
    setRecordingBlob(null);
    setDraft(null);
    setActionError(null);
    setUploadError(null);
    void startVoice();
  };

  /** Uploads the staged recording. The Blob survives any failure for a retry. */
  const sendDraft = useCallback(async (finalTranscript?: string) => {
    if (!draft) return;
    const textToSend = (finalTranscript ?? draft.transcript).trim();
    // Device GPS is a best-effort fallback: it is only sent so the server can
    // fall back to it when the spoken location cannot be resolved.
    const device = await getDeviceLocation();
    if (!device.ok) {
      setUploadError(
        `${device.message} The recording is saved locally — a spoken location is still required.`,
      );
      return;
    }
    const form = buildVoiceRecordingFormData({
      blob: draft.blob,
      transcript: textToSend,
      durationSeconds: draft.durationSeconds,
      ...(device.ok
        ? {
            deviceLatitude: device.location.latitude,
            deviceLongitude: device.location.longitude,
            deviceAccuracy: device.location.accuracy,
          }
        : {}),
    });
    recordMutation.mutate({ form, blob: draft.blob, idempotencyKey: draft.idempotencyKey });
  }, [draft, recordMutation]);

  /** Throws away ONLY the unsent attempt; stored reports are untouched. */
  const recordAgain = useCallback(() => {
    setIsRecordingSession(true);
    setRecordingResult(null);
    setRecordingBlob(null);
    setDraft(null);
    setUploadError(null);
    setActionError(null);
    void startVoice();
  }, [startVoice]);

  const recordingDisabled =
    !canCreate || !recordingSupported || isProcessing || recordMutation.isPending;

  // The AI Extracted Information card needs a report. While the query has not
  // produced one yet there is nothing to describe, and no recording to play.
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-64" />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </div>
    );
  }

  const resultCard = recordingResult && (
    <VoiceResultCard
      result={recordingResult}
      audioBlob={recordingBlob}
      onDismiss={() => {
        setRecordingResult(null);
        setIsRecordingSession(false);
      }}
    />
  );

  /**
   * Active report for the intake/reporting workflow:
   * 1. If the user recorded or uploaded in this session, the authoritative report
   *    is `recordingResult.report`.
   * 2. If a new recording has started (or is in draft/review), active report is null
   *    so old/unrelated reports are NEVER displayed in this intake workflow.
   * 3. Only if the session is not recording and no new session was started, we show
   *    the current active draft (if one exists).
   */
  const activeReport = recordingResult ? recordingResult.report : (isRecordingSession ? null : report);

  /**
   * Authoritative transcript:
   * 1. If uploaded, the backend transcription associated with THIS recording is authoritative.
   * 2. If a new recording has started or is in review, the bottom panel is cleared ("").
   * 3. Never silently falls back to a previous transcript if transcription fails.
   */
  const authoritativeTranscript = recordingResult
    ? (recordingResult.report?.transcript ?? recordingResult.transcript ?? '')
    : (isRecordingSession ? '' : (report?.transcript ?? ''));

  /**
   * The local recording is only paired with a report when it IS that report's
   * recording. After a reload there is no local blob and the player falls back
   * to the authenticated stored copy; it never pairs one citizen's blob with
   * another report.
   */
  const localAudioBlob =
    recordingResult && recordingBlob && recordingResult.report.id === activeReport?.id ? recordingBlob : null;

  const handleDownload = async () => {
    if (!canDownload || !activeReport) return;
    try {
      setDownloading(true);
      setDownloadError(null);
      await api.voice.downloadRecording(activeReport.id);
    } catch (err) {
      setDownloadError(err instanceof ApiError ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const workspaceCard = (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText size={18} className="text-[var(--primary)]" />
              Voice Reports Workspace
            </CardTitle>
            <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
              Scoped by role authority ({user?.role ?? 'CITIZEN'}). Transcripts, audio playback and downloads are permission-governed.
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5" data-testid="voice-scope-tabs">
            {roleTabs.map((tab) => (
              <Button
                key={tab.key}
                size="sm"
                variant={selectedTabKey === tab.key ? 'default' : 'outline'}
                onClick={() => {
                  setSelectedTabKey(tab.key);
                  setSelectedReportId(null);
                }}
              >
                {tab.label}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
            <Input
              placeholder="Filter by Report ID (e.g. VR-001)..."
              className="pl-8 h-9 text-xs"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <span className="text-xs text-[var(--muted-foreground)]">
            {reportsData?.count ?? 0} report(s) available in this scope
          </span>
        </div>

        {reportsLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : !reportsData || reportsData.reports.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--border)] p-8 text-center text-xs text-[var(--muted-foreground)]">
            No voice reports found in this scope.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {reportsData.reports.map((row) => {
              const isSelected = selectedReportId === row.id;
              return (
                <button
                  key={row.id}
                  data-testid="voice-report-card"
                  data-report-id={row.id}
                  onClick={() => setSelectedReportId(isSelected ? null : row.id)}
                  className={`flex flex-col justify-between rounded-lg border p-3 text-left transition-colors ${
                    isSelected
                      ? 'border-[var(--primary)] bg-[var(--primary)]/5 shadow-sm'
                      : 'border-[var(--border)] bg-[var(--card)] hover:bg-[var(--muted)]/50'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-mono text-xs font-bold">{row.id}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {row.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs font-medium text-[var(--foreground)] truncate">
                      {row.incidentType?.replace(/_/g, ' ') ?? 'General Incident'}
                      {row.locationLabel ? ` · ${row.locationLabel}` : ''}
                    </p>
                    <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)] truncate">
                      {row.hospitalName ? `Routed: ${row.hospitalName}` : 'Pending Hospital'}
                    </p>
                  </div>

                  <div className="mt-3 pt-2 border-t border-[var(--border)] flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
                    <span className="font-medium text-[var(--foreground)]">{row.accessLabel}</span>
                    <span>{row.createdAt ? new Date(row.createdAt).toLocaleDateString() : '—'}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {selectedReportId && (
          <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-sm">
            {detailLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : selectedDetail ? (
              <VoiceScopedDetail
                detail={selectedDetail}
                onConfirm={() => confirmMutation.mutate(selectedDetail.id)}
                onDiscard={() => discardMutation.mutate(selectedDetail.id)}
                confirming={confirmMutation.isPending}
                discarding={discardMutation.isPending}
                onUpdated={() => {
                  refetchList();
                  refetchDetail();
                }}
              />
            ) : (
              <p className="text-xs text-destructive">Failed to load report detail or unauthorized.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations / voice intake"
        title="Voice emergency reporting"
        description="Record a call, review the transcript and extracted facts, then confirm — only an authorized person can turn the draft into an emergency."
        icon={<Volume2 size={21} />}
        status={
          activeReport?.status === 'CONFIRMED' ? (
            <Badge variant="outline" className="gap-1.5"><ShieldCheck size={11} /> Emergency created</Badge>
          ) : (
            <Badge variant="warning" className="gap-1.5"><AlertTriangle size={11} /> Human confirmation required</Badge>
          )
        }
      />
      {resultCard}
      {workspaceCard}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Voice Input</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col items-center justify-center py-8">
              {!isRecording && !isProcessing && !draft && (
                <div className="mb-4 flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] p-1 text-xs" data-testid="voice-language-selector">
                  <span className="px-2 text-[11px] text-[var(--muted-foreground)]">Language:</span>
                  {(['auto', 'en', 'hi'] as const).map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => setSelectedLanguage(lang)}
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                        selectedLanguage === lang
                          ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                          : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                      }`}
                      data-testid={`voice-lang-${lang}`}
                    >
                      {lang === 'auto' ? 'Auto-detect' : lang === 'en' ? 'English' : 'हिंदी (Hindi)'}
                    </button>
                  ))}
                </div>
              )}
              <MicButton isRecording={isRecording} disabled={recordingDisabled} onClick={handleMicClick} />
              <p className="mt-4 text-sm font-medium" aria-live="polite">
                {recordMutation.isPending
                  ? 'Sending recording…'
                  : draft
                    ? 'Review your recording below'
                    : isProcessing
                      ? transcribeProgress !== null
                        ? `Preparing speech engine… ${transcribeProgress}%`
                        : 'Transcribing your voice…'
                      : isRecording
                        ? `Recording ${formatDuration(elapsedSeconds)} — tap to stop`
                        : 'Tap to record'}
              </p>
              <LevelMeter isRecording={isRecording} inputLevel={inputLevel} />
              {/* The unsent recording: playable immediately, before upload. */}
              {draft && (
                <div className="mt-4 w-full max-w-md text-left">
                  <VoiceRecordingReview
                    draft={draft}
                    uploading={recordMutation.isPending}
                    uploadError={uploadError}
                    onSend={(finalText) => void sendDraft(finalText)}
                    onRecordAgain={recordAgain}
                    onManualReport={() => navigate('/emergencies/new')}
                    onDiscard={() => {
                      setDraft(null);
                      setUploadError(null);
                      setIsRecordingSession(false);
                    }}
                  />
                </div>
              )}
              {!recordingSupported && (
                <p className="mt-3 max-w-xs text-center text-xs text-destructive">
                  Voice recording is not supported in this browser — use Chrome or Edge.
                </p>
              )}
              {voiceError && <p className="mt-3 max-w-xs text-center text-xs text-destructive">{voiceError}</p>}
            </div>

            {/* Transcript — live while recording, staged review, or authoritative result */}
            <div className="rounded-lg border border-[var(--border)] p-4 bg-[var(--surface)]">
              <p className="text-xs text-[var(--muted-foreground)] mb-2">
                Transcript:
              </p>
              <p className="text-sm leading-relaxed">
                {isRecording
                  ? <span className="text-[var(--muted-foreground)]">Recording everything you say — transcribed when you stop.</span>
                  : isProcessing
                    ? transcribeProgress !== null
                      ? `Preparing speech engine… ${transcribeProgress}%`
                      : 'Transcribing your voice…'
                    : draft
                      ? draft.transcript || (draft.transcriptionError ? <span className="text-[var(--warning)]">Local transcription failed: {draft.transcriptionError}</span> : <span className="text-[var(--muted-foreground)]">No speech detected.</span>)
                      : recordingResult
                        ? (authoritativeTranscript || <span className="text-[var(--muted-foreground)]">No transcript produced.</span>)
                        : (activeReport ? activeReport.transcript : <span className="text-[var(--muted-foreground)]">No active recording transcript.</span>)}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* AI Extracted Information */}
        {activeReport ? (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">AI Extracted Information</CardTitle>
                <Badge variant={activeReport.status === 'CONFIRMED' ? 'outline' : 'warning'}>
                  {activeReport.status === 'CONFIRMED' ? 'CONFIRMED' : 'DRAFT — Requires Confirmation'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
                <p className="flex items-center gap-2 text-xs font-medium text-[var(--warning)]">
                  <AlertTriangle size={12} />
                  AI output is a draft requiring human confirmation before emergency creation
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                  <span className="text-sm text-[var(--muted-foreground)]">Incident Type</span>
                  <Badge variant="outline">{activeReport.extractedData?.incidentType?.replace(/_/g, ' ') || 'OTHER'}</Badge>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                  <span className="text-sm text-[var(--muted-foreground)]">Location</span>
                  <span className="text-sm font-medium">{activeReport.extractedData?.location || 'Unknown location'}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                  <span className="text-sm text-[var(--muted-foreground)]">Victim Count</span>
                  <span className="text-sm font-medium">{activeReport.extractedData?.victimCount ?? '—'}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                  <span className="text-sm text-[var(--muted-foreground)]">Confidence</span>
                  <span className="text-sm font-mono font-bold">{activeReport.confidence ?? 0}%</span>
                </div>
                <div className="py-2">
                  <span className="text-sm text-[var(--muted-foreground)]">Description:</span>
                  <p className="text-sm mt-1">{activeReport.extractedData?.description || activeReport.transcript || '—'}</p>
                </div>
              </div>

              {/*
                RECORDED VOICE + TRANSCRIPT.
                Audio and transcription are separate stages.
                The player is driven by the recording alone — never by whether a transcript exists.
                The bottom transcript panel displays the authoritative backend transcript of THIS recording,
                and never silently falls back to an older report's transcript.
              */}
              <div className="space-y-3 border-t border-[var(--border)] pt-4">
                <VoicePlaybackPlayer
                  reportId={activeReport.id}
                  localBlob={localAudioBlob}
                  mimeType={activeReport.audio?.mimeType ?? null}
                  storedSizeBytes={activeReport.audio?.size ?? null}
                  reportedDurationSeconds={activeReport.audio?.durationSeconds ?? null}
                  title="Recorded Voice"
                  canListen={canListen}
                  canDownload={canDownload}
                  onDownload={handleDownload}
                  testId="voice-ai-extraction-player"
                />
                <VoiceTranscriptPanel
                  transcript={authoritativeTranscript}
                  audioAvailable={Boolean(activeReport.audio || localAudioBlob)}
                />
              </div>

              <div className="flex gap-2 pt-4 border-t border-[var(--border)]">
                {canDiscard && (
                  <Button variant="outline" className="flex-1" onClick={() => discardMutation.mutate(activeReport.id)} disabled={discardMutation.isPending}>
                    <MicOff size={14} className="mr-1" />
                    {discardMutation.isPending ? 'Discarding…' : 'Discard'}
                  </Button>
                )}
                {canConfirm ? (
                  <Button className="flex-1" onClick={() => confirmMutation.mutate(activeReport.id)} disabled={confirmMutation.isPending}>
                    <CheckCircle size={14} className="mr-1" />
                    {confirmMutation.isPending ? 'Creating…' : 'Confirm & Create Emergency'}
                  </Button>
                ) : (
                  <p className="flex flex-1 items-center justify-center rounded-md bg-muted px-3 text-center text-xs text-[var(--muted-foreground)]">Awaiting confirmation by an authorized dispatcher.</p>
                )}
              </div>
              {actionError && (
                <p className="text-xs text-destructive text-center pt-1">{actionError}</p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">AI Extracted Information</CardTitle>
                <Badge variant="outline">
                  {isRecording ? 'Listening…' : isProcessing ? 'Processing…' : draft ? 'Draft Ready' : 'Awaiting Input'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 py-8 text-center">
              <Volume2 size={32} className={`mx-auto text-[var(--muted-foreground)] ${isRecording ? 'animate-pulse text-destructive' : 'opacity-50'}`} />
              <div>
                <p className="text-sm font-semibold">
                  {isRecording
                    ? 'Recording emergency audio…'
                    : isProcessing
                      ? 'Transcribing audio on device…'
                      : draft
                        ? 'Recording staged for review'
                        : 'No active voice report'}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground)] max-w-sm mx-auto">
                  {isRecording
                    ? 'Speak clearly into your microphone. Tap stop when finished.'
                    : isProcessing
                      ? 'Preparing transcript before review…'
                      : draft
                        ? 'Review your recording on the left. Click "Send Emergency Recording" to upload and generate authoritative report.'
                        : 'Record an emergency call or generate a demo draft to begin.'}
                </p>
              </div>
              {/* Bottom transcript panel is cleared when a new recording starts or in review */}
              <div className="pt-2 max-w-md mx-auto text-left">
                <VoiceTranscriptPanel
                  transcript=""
                  audioAvailable={Boolean(draft?.blob)}
                />
              </div>
              {canCreate && !draft && !isRecording && (
                <div className="pt-2">
                  <Button onClick={() => newDraftMutation.mutate()} disabled={newDraftMutation.isPending}>
                    <FileText size={14} className="mr-1" />
                    {newDraftMutation.isPending ? 'Creating draft…' : 'Generate demo draft'}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
