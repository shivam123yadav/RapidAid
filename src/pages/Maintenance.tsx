import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Lock,
  Plus,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can } from '../lib/permissions';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Textarea } from '../components/ui/textarea';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import type { MaintenanceRequest, MaintenanceSeverity, MaintenanceStatus } from '../types';

const severityVariant = (value: MaintenanceSeverity) =>
  ({ CRITICAL: 'destructive', HIGH: 'warning', MEDIUM: 'info', LOW: 'outline' }[value] as 'destructive' | 'warning' | 'info' | 'outline');
const statusVariant = (value: MaintenanceStatus) =>
  ({ RESOLVED: 'success', APPROVED: 'info', IN_PROGRESS: 'warning', OPEN: 'warning', REJECTED: 'outline' }[value] as 'success' | 'info' | 'warning' | 'outline');

export function MaintenancePage() {
  const user = useAuthStore((state) => state.user);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [ambulanceId, setAmbulanceId] = useState('AMB-031');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<MaintenanceSeverity>('MEDIUM');
  const [error, setError] = useState<string | null>(null);
  const [resolveFor, setResolveFor] = useState<MaintenanceRequest | null>(null);
  const [resolution, setResolution] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | MaintenanceStatus>('ALL');
  const held = user?.permissions;
  const canCreate = can(user?.role, 'maintenance:create', held);
  const canUpdate = can(user?.role, 'maintenance:update', held);
  const canApprove = can(user?.role, 'maintenance:approve', held);
  const historyOnly = !canCreate && !canUpdate && can(user?.role, 'maintenance:history', held);
  const { data: requests, isLoading } = useQuery({ queryKey: ['maintenance'], queryFn: api.maintenance.list });
  const refresh = () => client.invalidateQueries({ queryKey: ['maintenance'] });
  const createMutation = useMutation({
    mutationFn: () => api.maintenance.create({ ambulanceId: ambulanceId.trim(), title: title.trim(), description: description.trim(), severity }),
    onSuccess: () => { setOpen(false); setError(null); void refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Maintenance report failed'),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.maintenance.update>[1] }) => api.maintenance.update(id, data),
    onSuccess: () => { setResolveFor(null); setResolution(''); setError(null); void refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Maintenance update failed'),
  });

  const all = requests ?? [];
  const visible = useMemo(
    () => (statusFilter === 'ALL' ? all : all.filter((request) => request.status === statusFilter)),
    [all, statusFilter],
  );
  const openCount = all.filter((request) => request.status === 'OPEN').length;
  const inProgress = all.filter((request) => request.status === 'IN_PROGRESS').length;
  const resolved = all.filter((request) => request.status === 'RESOLVED').length;
  const critical = all.filter((request) => request.severity === 'CRITICAL' && request.status !== 'RESOLVED' && request.status !== 'REJECTED').length;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-64" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-xl" />)}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-48 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations / fleet readiness"
        title="Maintenance"
        description={
          historyOnly
            ? 'Read-only maintenance history for your role.'
            : canCreate
              ? 'Report and track fleet maintenance. Crew reports are restricted to their assigned ambulance.'
              : 'Fleet maintenance oversight and approval.'
        }
        icon={<Wrench size={21} />}
        status={<Badge variant="outline" className="gap-1.5"><ShieldCheck size={11} /> {historyOnly ? 'Read-only' : 'Audited workflow'}</Badge>}
        actions={
          canCreate ? (
            <Button onClick={() => setOpen(true)}>
              <Plus size={15} />
              Report issue
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Open" value={openCount} icon={<Clock size={17} />} tone="warning" hint="Awaiting triage" />
        <StatCard label="In progress" value={inProgress} icon={<Wrench size={17} />} tone="info" hint="Work underway" />
        <StatCard label="Resolved" value={resolved} icon={<CheckCircle2 size={17} />} tone="success" hint="Closed with a resolution" />
        <StatCard label="Critical open" value={critical} icon={<AlertTriangle size={17} />} tone="danger" hint="Highest severity, unresolved" />
      </div>

      {historyOnly && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--muted)]/60 p-3.5">
          <Lock size={15} className="mt-0.5 flex-none text-[var(--muted-foreground)]" />
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
            Analyst and auditor access is read-only. Approval and resolution controls are hidden because
            the server would refuse those transitions for this role.
          </p>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-[var(--destructive)]">
            <AlertTriangle size={14} className="mt-0.5 flex-none" />
            {error}
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="rounded p-0.5 text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/10"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 w-fit">
        {(['ALL', 'OPEN', 'IN_PROGRESS', 'APPROVED', 'RESOLVED', 'REJECTED'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatusFilter(value)}
            aria-pressed={statusFilter === value}
            className={
              statusFilter === value
                ? 'rounded-md bg-[var(--primary)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--primary-foreground)]'
                : 'rounded-md px-2.5 py-1.5 text-[11px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }
          >
            {value === 'ALL' ? `All (${all.length})` : value.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<Wrench size={20} />}
          title="No maintenance requests"
          description="Fleet issues reported by crews and managers will appear here with their approval and resolution history."
        />
      ) : visible.length === 0 ? (
        <EmptyState compact icon={<Wrench size={18} />} title="No requests match this filter" description="Switch to All to widen the view." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {visible.map((item) => (
            <Card key={item.id} variant={item.severity === 'CRITICAL' && item.status !== 'RESOLVED' ? 'critical' : 'interactive'} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">{item.title}</CardTitle>
                    <p className="mt-1 font-mono text-[11px] text-[var(--muted-foreground)]">
                      {item.id} · {item.ambulanceId}
                    </p>
                  </div>
                  <div className="flex flex-none flex-wrap justify-end gap-1">
                    <Badge variant={severityVariant(item.severity)} className="text-[9px]">{item.severity}</Badge>
                    <Badge variant={statusVariant(item.status)} className="text-[9px]">{item.status.replace(/_/g, ' ')}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3 text-sm">
                <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{item.description}</p>
                {item.resolution && (
                  <p className="rounded-lg border border-[color-mix(in_srgb,var(--success)_28%,var(--border))] bg-[color-mix(in_srgb,var(--success)_6%,transparent)] p-2.5 text-[11px] leading-relaxed text-[var(--success)]">
                    <span className="font-semibold">Resolution:</span> {item.resolution}
                  </p>
                )}
                <div className="mt-auto flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
                  {canApprove && (item.status === 'OPEN' || item.status === 'IN_PROGRESS') && (
                    <>
                      <Button size="sm" disabled={updateMutation.isPending} onClick={() => updateMutation.mutate({ id: item.id, data: { status: 'APPROVED' } })}>
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" disabled={updateMutation.isPending} onClick={() => updateMutation.mutate({ id: item.id, data: { status: 'REJECTED' } })}>
                        Reject
                      </Button>
                    </>
                  )}
                  {canUpdate && item.status === 'OPEN' && (
                    <Button size="sm" variant="outline" disabled={updateMutation.isPending} onClick={() => updateMutation.mutate({ id: item.id, data: { status: 'IN_PROGRESS' } })}>
                      Start work
                    </Button>
                  )}
                  {canUpdate && (item.status === 'APPROVED' || item.status === 'IN_PROGRESS') && (
                    <Button size="sm" disabled={updateMutation.isPending} onClick={() => setResolveFor(item)}>
                      Resolve
                    </Button>
                  )}
                  {!canApprove && !canUpdate && (
                    <p className="text-[11px] text-[var(--muted-foreground)]">No maintenance transitions are available for this role.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Report maintenance</DialogTitle>
            <DialogDescription>Crew reports are restricted to their assigned ambulance. Every transition is audited.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="maint-ambulance">Ambulance ID</Label>
              <Input id="maint-ambulance" value={ambulanceId} onChange={(event) => setAmbulanceId(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maint-title">Title</Label>
              <Input id="maint-title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maint-severity">Severity</Label>
              <Select value={severity} onValueChange={(value) => setSeverity(value as MaintenanceSeverity)}>
                <SelectTrigger id="maint-severity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maint-description">Description</Label>
              <Textarea id="maint-description" value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
          </div>
          {error && (
            <p role="alert" className="rounded-lg border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-2.5 text-xs text-[var(--destructive)]">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!ambulanceId.trim() || title.trim().length < 2 || description.trim().length < 5 || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Submitting…' : 'Submit report'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(resolveFor)}
        onOpenChange={(next) => {
          if (!next) {
            setResolveFor(null);
            setResolution('');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Resolve maintenance</DialogTitle>
            <DialogDescription>
              {resolveFor ? `${resolveFor.id} · ${resolveFor.ambulanceId}` : ''} — record the completed work and test result.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="resolution">Resolution</Label>
            <Textarea
              id="resolution"
              value={resolution}
              onChange={(event) => setResolution(event.target.value)}
              placeholder="Completed work and test result…"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveFor(null)}>Cancel</Button>
            <Button
              disabled={!resolution.trim() || updateMutation.isPending}
              onClick={() => {
                if (!resolveFor) return;
                updateMutation.mutate({ id: resolveFor.id, data: { status: 'RESOLVED', resolution: resolution.trim() } });
              }}
            >
              {updateMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {updateMutation.isPending ? 'Saving…' : 'Mark resolved'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
