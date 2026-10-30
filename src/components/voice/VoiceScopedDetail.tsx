import { useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { CheckCircle, Download, History, Lock, MicOff, Pencil, XCircle } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { VoicePlaybackPlayer, VoiceTranscriptPanel } from './VoicePlaybackPlayer';
import type { VoiceReportDetail } from '../../types';
import { VoiceEditDialog } from './VoiceEditDialog';
import { VoiceRejectDialog } from './VoiceRejectDialog';
import { VoiceAccessHistoryDialog } from './VoiceAccessHistoryDialog';

export interface VoiceScopedDetailProps {
  detail: VoiceReportDetail;
  onConfirm?: () => void;
  onDiscard?: () => void;
  confirming?: boolean;
  discarding?: boolean;
  onUpdated?: () => void;
}

export function VoiceScopedDetail({
  detail,
  onConfirm,
  onDiscard,
  confirming,
  discarding,
  onUpdated,
}: VoiceScopedDetailProps) {
  const caps = detail.capabilities;
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const handleDownload = async () => {
    if (!caps.download) return;
    try {
      setDownloading(true);
      setDownloadError(null);
      await api.voice.downloadRecording(detail.id);
    } catch (err) {
      setDownloadError(err instanceof ApiError ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4 text-left" data-testid="voice-scoped-detail">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="font-mono text-base font-bold">{detail.id}</h4>
            <Badge variant="outline">{detail.status}</Badge>
            <Badge variant="secondary">{detail.accessLabel}</Badge>
            {detail.emergencyId && (
              <Badge variant="outline" className="font-mono">{detail.emergencyId}</Badge>
            )}
          </div>
          <p className="text-xs text-[var(--muted-foreground)] mt-1">
            Created: {detail.createdAt ? new Date(detail.createdAt).toLocaleString() : '—'}
            {detail.ownerId ? ` · Owner: ${detail.ownerId}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {caps.download && (
            <Button size="sm" variant="outline" onClick={handleDownload} disabled={downloading}>
              <Download size={13} className="mr-1" />
              {downloading ? 'Downloading…' : 'Download Audio'}
            </Button>
          )}
          {caps.edit && (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil size={13} className="mr-1" />
              Correct / Edit
            </Button>
          )}
          {caps.confirm && onConfirm && (
            <Button size="sm" onClick={onConfirm} disabled={confirming}>
              <CheckCircle size={13} className="mr-1" />
              {confirming ? 'Confirming…' : 'Confirm Draft'}
            </Button>
          )}
          {caps.reject && (
            <Button size="sm" variant="destructive" onClick={() => setRejectOpen(true)}>
              <XCircle size={13} className="mr-1" />
              Reject Draft
            </Button>
          )}
          {caps.discard && onDiscard && (
            <Button size="sm" variant="outline" onClick={onDiscard} disabled={discarding}>
              <MicOff size={13} className="mr-1" />
              {discarding ? 'Discarding…' : 'Discard'}
            </Button>
          )}
          {caps.accessHistory && (
            <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
              <History size={13} className="mr-1" />
              Access Audit Log
            </Button>
          )}
        </div>
      </div>

      {downloadError && <p className="text-xs text-destructive">{downloadError}</p>}

      {/*
        One shared player for the whole app. `caps.listen` is the server-derived
        flag, so an unauthorized caller is never even offered the control; the
        download right stays separate and is never implied by listening.
      */}
      <VoicePlaybackPlayer
        reportId={detail.id}
        mimeType={detail.audio?.mimeType ?? null}
        storedSizeBytes={detail.audio?.size ?? null}
        reportedDurationSeconds={detail.audio?.durationSeconds ?? null}
        title="Recorded Voice"
        canListen={caps.listen}
        canDownload={caps.download}
        onDownload={handleDownload}
        testId="voice-scoped-player"
      />

      <div className="rounded-lg border border-[var(--border)] p-3 bg-[var(--surface)]">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-[var(--muted-foreground)] uppercase tracking-wide">
            Spoken Transcript
          </span>
          {!caps.transcript && (
            <Badge variant="outline" className="text-[10px] text-[var(--warning)]">
              <Lock size={10} className="mr-1" />
              Transcript Restricted
            </Badge>
          )}
        </div>
        {/*
          Transcript and audio are independent: a restricted or missing
          transcript is reported as such and never affects the player above.
        */}
        <VoiceTranscriptPanel
          transcript={detail.transcript}
          audioAvailable={caps.listen}
          restricted={!caps.transcript || detail.transcriptRestricted}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg border border-[var(--border)] p-3 space-y-2">
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Incident Type:</span>
            <Badge variant="outline">{detail.extractedData?.incidentType?.replace(/_/g, ' ') ?? 'None'}</Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Extracted Location:</span>
            <span className="font-medium">{detail.extractedData?.location || 'Unspecified'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Victims:</span>
            <span className="font-medium">{detail.extractedData?.victimCount ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Confidence:</span>
            <span className="font-mono font-bold">{detail.confidence ?? 0}%</span>
          </div>
        </div>

        <div className="rounded-lg border border-[var(--border)] p-3 space-y-2">
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Assigned / Routed Hospital:</span>
            <span className="font-medium">{detail.hospitalName ?? 'None assigned'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Audio Size:</span>
            <span>
              {detail.audio?.size ? `${Math.round(detail.audio.size / 1024)} KB (${detail.audio.mimeType})` : 'No stored audio'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Audio Duration:</span>
            <span>{detail.audio?.durationSeconds ? `${detail.audio.durationSeconds}s` : '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Hospital Dispatch Routing:</span>
            <span className="font-medium">{detail.dispatchStatus ?? '—'}</span>
          </div>
          {detail.emergencyId ? (
            <div className="flex justify-between">
              <span className="text-[var(--muted-foreground)]">Emergency Status:</span>
              <Badge variant="outline">{detail.emergencyStatus ?? 'REPORTED'}</Badge>
            </div>
          ) : (
            <div className="flex justify-between">
              <span className="text-[var(--muted-foreground)]">Emergency Status:</span>
              <span className="text-xs text-[var(--muted-foreground)] italic">No active Emergency created</span>
            </div>
          )}
        </div>
      </div>

      {detail.extractedData?.description && (
        <div className="rounded-lg border border-[var(--border)] p-3 text-sm">
          <span className="text-xs text-[var(--muted-foreground)] block mb-1">Description / Notes:</span>
          <p>{detail.extractedData.description}</p>
        </div>
      )}

      <VoiceEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        detail={detail}
        onSuccess={onUpdated}
      />

      <VoiceRejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        reportId={detail.id}
        onSuccess={onUpdated}
      />

      <VoiceAccessHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        reportId={detail.id}
      />
    </div>
  );
}
