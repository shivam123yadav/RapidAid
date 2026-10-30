import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { api, ApiError } from '../../api/client';
import type { VoiceReportDetail } from '../../types';

export function VoiceEditDialog({
  open,
  onOpenChange,
  detail,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: VoiceReportDetail;
  onSuccess?: () => void;
}) {
  const [transcript, setTranscript] = useState(detail.transcript ?? '');
  const [incidentType, setIncidentType] = useState(detail.extractedData?.incidentType ?? '');
  const [location, setLocation] = useState(detail.extractedData?.location ?? '');
  const [victimCount, setVictimCount] = useState(detail.extractedData?.victimCount ?? 1);
  const [description, setDescription] = useState(detail.extractedData?.description ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    try {
      setPending(true);
      setError(null);
      await api.voice.updateReport(detail.id, {
        transcript,
        extractedData: {
          incidentType: incidentType as any,
          location,
          victimCount: Number(victimCount),
          description,
        },
      });
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Correction failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Correct Voice Report — {detail.id}</DialogTitle>
          <DialogDescription>Corrections are audited and tracked in the system access history.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-[var(--muted-foreground)]">Transcript</label>
            <Textarea rows={4} className="mt-1" value={transcript} onChange={(e) => setTranscript(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-[var(--muted-foreground)]">Incident Type</label>
              <Input className="mt-1" value={incidentType} onChange={(e) => setIncidentType(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--muted-foreground)]">Victim Count</label>
              <Input type="number" min={0} className="mt-1" value={victimCount} onChange={(e) => setVictimCount(Number(e.target.value))} />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--muted-foreground)]">Location</label>
            <Input className="mt-1" value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--muted-foreground)]">Description</label>
            <Textarea rows={2} className="mt-1" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={pending}>
            {pending ? 'Saving Corrections…' : 'Save Corrections'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
