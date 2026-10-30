import { useEffect, useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { api, ApiError } from '../../api/client';
import type { VoiceAccessHistory } from '../../types';

export function VoiceAccessHistoryDialog({
  open,
  onOpenChange,
  reportId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reportId: string;
}) {
  const [data, setData] = useState<VoiceAccessHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.voice
      .getAccessHistory(reportId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not fetch access history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reportId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Access & Action Audit Trail — {reportId}</DialogTitle>
          <DialogDescription>
            Immutable audit records of views, playbacks, downloads, reviews and access evaluations.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {loading ? (
            <p className="text-xs text-[var(--muted-foreground)]">Loading audit records…</p>
          ) : error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : data && data.entries.length > 0 ? (
            <div className="space-y-2">
              {data.entries.map((entry) => (
                <div key={entry.id} className="rounded-md border border-[var(--border)] p-2.5 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-medium text-[var(--foreground)]">{entry.action}</span>
                    <Badge
                      variant={entry.result === 'DENIED' || entry.result === 'REJECTED' ? 'destructive' : 'outline'}
                      className="text-[10px]"
                    >
                      {entry.result}
                    </Badge>
                  </div>
                  <div className="text-[var(--muted-foreground)] flex justify-between">
                    <span>Actor: {entry.actor} ({entry.actorRole})</span>
                    <span>{new Date(entry.timestamp).toLocaleString()}</span>
                  </div>
                  {entry.reason && (
                    <p className="text-[var(--warning)] font-medium">Reason: {entry.reason}</p>
                  )}
                  {entry.details && (
                    <p className="text-[var(--muted-foreground)] text-[11px] font-mono">{entry.details}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[var(--muted-foreground)]">No audit entries found for this report.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
