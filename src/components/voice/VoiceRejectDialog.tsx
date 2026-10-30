import { useState } from 'react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { api, ApiError } from '../../api/client';

export function VoiceRejectDialog({
  open,
  onOpenChange,
  reportId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reportId: string;
  onSuccess?: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReject = async () => {
    if (!reason.trim() || reason.trim().length < 3) {
      setError('A valid rejection reason is required (at least 3 characters)');
      return;
    }
    try {
      setPending(true);
      setError(null);
      await api.voice.rejectReport(reportId, reason.trim());
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rejection failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject Voice Report — {reportId}</DialogTitle>
          <DialogDescription>
            Draft will be marked REJECTED and retained as audit evidence without creating an emergency.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-[var(--muted-foreground)]">
              Rejection Reason (audited, mandatory)
            </label>
            <Textarea
              rows={3}
              className="mt-1"
              placeholder="Explain why this voice report is being rejected…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" onClick={handleReject} disabled={pending}>
            {pending ? 'Rejecting…' : 'Reject Draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
