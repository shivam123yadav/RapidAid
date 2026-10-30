import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can } from '../lib/permissions';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import {
  AlertTriangle,
  Camera,
  CheckCircle,
  CheckCircle2,
  Clock,
  Eye,
  ShieldCheck,
  ScanLine,
  XCircle,
} from 'lucide-react';
import type { AIDetection, DetectionStatus } from '../types';

const statusVariant = (s: DetectionStatus) => {
  const map: Record<DetectionStatus, 'warning' | 'success' | 'destructive' | 'info'> = {
    PENDING_REVIEW: 'warning',
    CONFIRMED: 'success',
    REJECTED: 'destructive',
    CONVERTED_TO_INCIDENT: 'info',
  };
  return map[s];
};

export function AIVisionPage() {
  const user = useAuthStore((state) => state.user);
  const held = user?.permissions;
  const canConfirm = can(user?.role, 'ai:confirm', held);
  const canReject = can(user?.role, 'ai:reject', held);
  const canCreateEmergency = can(user?.role, 'ai:create-emergency', held);
  const queryClient = useQueryClient();
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');

  const { data: detections, isLoading } = useQuery({
    queryKey: ['detections'],
    queryFn: api.vision.detections,
  });

  // Human-in-the-loop review: CONFIRMED / REJECTED / CONVERTED_TO_INCIDENT.
  // The server enforces RBAC and only a CONVERT action creates an incident.
  const reviewMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: DetectionStatus }) =>
      api.vision.review(id, status),
    onSuccess: (_result, variables) => {
      setReviewError(null);
      void queryClient.invalidateQueries({ queryKey: ['detections'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      if (variables.status === 'CONVERTED_TO_INCIDENT') {
        void queryClient.invalidateQueries({ queryKey: ['emergencies'] });
      }
    },
    onError: (err) => setReviewError(err instanceof Error ? err.message : 'Review failed'),
  });

  const all = detections ?? [];
  const pending = all.filter((detection) => detection.status === 'PENDING_REVIEW');
  const confirmed = all.filter(
    (detection) => detection.status === 'CONFIRMED' || detection.status === 'CONVERTED_TO_INCIDENT',
  );
  const visible = useMemo(
    () => (filter === 'pending' ? pending : all),
    [all, filter, pending],
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-64" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-72 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Intelligence / vision review"
        title="AI vision workspace"
        description="Camera detections arrive as candidates. A person reviews the evidence before any incident is created."
        icon={<Eye size={21} />}
        status={<Badge variant="outline" className="gap-1.5"><ShieldCheck size={11} /> Human review required</Badge>}
      />

      <div className="flex items-start gap-2.5 rounded-xl border border-[var(--warning)]/30 bg-[color-mix(in_srgb,var(--warning)_6%,transparent)] p-3.5">
        <AlertTriangle size={15} className="mt-0.5 flex-none text-[var(--warning)]" />
        <div>
          <p className="text-xs font-semibold">AI detection safety protocol</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-foreground)]">
            Detections are candidates requiring human review. They do not automatically create
            emergencies. Conversion is an explicit, permissioned action.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label="Pending review" value={pending.length} icon={<Clock size={17} />} tone="warning" hint="Awaiting a human decision" />
        <StatCard label="Confirmed or converted" value={confirmed.length} icon={<CheckCircle2 size={17} />} tone="success" hint="Reviewed as credible" />
        <StatCard label="Total detections" value={all.length} icon={<ScanLine size={17} />} tone="info" hint="Visible to this session" />
      </div>

      {reviewError && (
        <div role="alert" className="rounded-xl border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
          <p className="text-xs leading-relaxed text-[var(--destructive)]">{reviewError}</p>
        </div>
      )}

      <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 w-fit">
        {(['pending', 'all'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
            className={
              filter === value
                ? 'rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-foreground)]'
                : 'rounded-md px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }
          >
            {value === 'pending' ? `Pending (${pending.length})` : `All (${all.length})`}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 size={20} />}
          title={filter === 'pending' ? 'No detections awaiting review' : 'No detections on record'}
          description={
            filter === 'pending'
              ? 'Every visible detection has been reviewed. New candidates will appear here.'
              : 'The vision endpoint returned no detections for this session.'
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {visible.map((det: AIDetection) => (
            <Card key={det.id} variant="interactive">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Camera size={14} className="text-[var(--primary)]" />
                    <span className="font-mono">{det.cameraId}</span>
                  </CardTitle>
                  <Badge variant={statusVariant(det.status)} className="text-[9px]">
                    {det.status.replace(/_/g, ' ')}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="relative h-44 overflow-hidden rounded-lg border border-[var(--border)] bg-[#0a1220]">
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 opacity-[0.35]"
                    style={{
                      backgroundImage:
                        'linear-gradient(to right, rgba(103,232,249,0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(103,232,249,0.16) 1px, transparent 1px)',
                      backgroundSize: '32px 32px',
                    }}
                  />
                  <div className="absolute inset-0 flex items-center justify-center text-[#4b6178]">
                    <Camera size={34} className="opacity-40" />
                  </div>
                  <div aria-hidden="true" className="animate-scan absolute inset-x-0 top-0 h-px bg-[#67e8f9]/60" />
                  {det.boundingBoxes.map((box, i) => (
                    <div
                      key={i}
                      className="absolute border-2 border-[#ef4444] bg-[#ef4444]/10"
                      style={{
                        left: `${(box.x / 640) * 100}%`,
                        top: `${(box.y / 480) * 100}%`,
                        width: `${(box.width / 640) * 100}%`,
                        height: `${(box.height / 480) * 100}%`,
                      }}
                    >
                      <span className="absolute -top-4 left-0 rounded-sm bg-[#ef4444] px-1 font-mono text-[9px] text-white">
                        {box.label} {box.confidence.toFixed(0)}%
                      </span>
                    </div>
                  ))}
                  <div className="absolute inset-x-0 top-0 flex items-center justify-between px-2.5 py-2">
                    <span className="rounded-full border border-white/10 bg-black/35 px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.12em] text-white/60 backdrop-blur-sm">
                      Bounding boxes from detection API
                    </span>
                  </div>
                </div>

                <div className="grid gap-1.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-[var(--muted-foreground)]">Detected event</span>
                    <span className="text-right text-xs font-medium">{det.detectedEvent.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-[var(--muted-foreground)]">Confidence</span>
                    <span className="font-mono text-xs font-semibold">{det.confidence}%</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-[var(--muted-foreground)]">Location</span>
                    <span className="max-w-[62%] truncate text-right text-xs">{det.cameraLocation.address}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-[var(--muted-foreground)]">Timestamp</span>
                    <span className="text-right text-xs">{new Date(det.timestamp).toLocaleString()}</span>
                  </div>
                </div>

                {det.status === 'PENDING_REVIEW' && (canConfirm || canReject || canCreateEmergency) && (
                  <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
                    {canConfirm && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        disabled={reviewMutation.isPending}
                        onClick={() => reviewMutation.mutate({ id: det.id, status: 'CONFIRMED' })}
                      >
                        <Eye size={12} />
                        Confirm
                      </Button>
                    )}
                    {canReject && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        disabled={reviewMutation.isPending}
                        onClick={() => reviewMutation.mutate({ id: det.id, status: 'REJECTED' })}
                      >
                        <XCircle size={12} />
                        Reject
                      </Button>
                    )}
                    {canCreateEmergency && (
                      <Button
                        size="sm"
                        className="flex-1"
                        disabled={reviewMutation.isPending}
                        onClick={() => reviewMutation.mutate({ id: det.id, status: 'CONVERTED_TO_INCIDENT' })}
                      >
                        <CheckCircle size={12} />
                        Create incident
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
