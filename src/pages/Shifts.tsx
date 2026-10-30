import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock,
  Loader2,
  Plus,
  ShieldCheck,
  UserRoundX,
  Users,
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
import { Skeleton } from '../components/ui/skeleton';
import { Textarea } from '../components/ui/textarea';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import type { Shift, ShiftStatus } from '../types';

const variant = (status: ShiftStatus) =>
  status === 'ACTIVE' ? 'success' : status === 'PLANNED' ? 'warning' : status === 'COMPLETED' ? 'info' : 'outline';

export function ShiftsPage() {
  const user = useAuthStore((state) => state.user);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('Emergency Response Shift');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [crewIds, setCrewIds] = useState('USR-002');
  const [ambulanceId, setAmbulanceId] = useState('AMB-031');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unavailableFor, setUnavailableFor] = useState<Shift | null>(null);
  const [unavailableNote, setUnavailableNote] = useState('');
  const held = user?.permissions;
  const canCreate = can(user?.role, 'shift:create', held);
  const canStart = can(user?.role, 'shift:start', held);
  const canEnd = can(user?.role, 'shift:end', held);
  const canUnavailable = can(user?.role, 'shift:unavailable', held);
  const canManageAll = can(user?.role, 'shift:update', held);
  const { data: shifts, isLoading } = useQuery({ queryKey: ['shifts'], queryFn: api.shifts.list });
  const refresh = () => client.invalidateQueries({ queryKey: ['shifts'] });
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'COMPLETED' }) => api.shifts.setStatus(id, status),
    onSuccess: () => { setError(null); void refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Shift update failed'),
  });
  const unavailableMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => api.shifts.reportUnavailable(id, note),
    onSuccess: () => {
      setUnavailableFor(null);
      setUnavailableNote('');
      setError(null);
      void refresh();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Availability report failed'),
  });
  const createMutation = useMutation({
    mutationFn: () => api.shifts.create({
      title: title.trim(),
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      crewIds: crewIds.split(',').map((id) => id.trim()).filter(Boolean),
      ...(ambulanceId.trim() ? { ambulanceId: ambulanceId.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    }),
    onSuccess: () => { setOpen(false); setError(null); void refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Shift creation failed'),
  });
  const owns = (shift: Shift) => shift.crewIds.includes(user?.id ?? '') || shift.createdBy === user?.id;

  const all = shifts ?? [];
  const activeCount = all.filter((shift) => shift.status === 'ACTIVE').length;
  const planned = all.filter((shift) => shift.status === 'PLANNED').length;
  const completed = all.filter((shift) => shift.status === 'COMPLETED').length;
  const unassigned = all.filter((shift) => shift.crewIds.length === 0).length;

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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-52 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations / rostering"
        title="Shift workspace"
        description={
          canManageAll
            ? 'Plan and monitor operational coverage. Assignments are independently permission-checked and audited.'
            : 'Your assigned shifts, coverage status and availability reporting.'
        }
        icon={<CalendarDays size={21} />}
        status={<Badge variant="outline" className="gap-1.5"><ShieldCheck size={11} /> {canManageAll ? 'Coverage planning' : 'My shifts'}</Badge>}
        actions={
          canCreate ? (
            <Button onClick={() => setOpen(true)}>
              <Plus size={15} />
              Create shift
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Active" value={activeCount} icon={<Clock size={17} />} tone="success" hint="Currently on duty" />
        <StatCard label="Planned" value={planned} icon={<CalendarDays size={17} />} tone="warning" hint="Scheduled ahead" />
        <StatCard label="Completed" value={completed} icon={<CheckCircle2 size={17} />} tone="info" hint="Finished coverage" />
        <StatCard label="Unassigned" value={unassigned} icon={<UserRoundX size={17} />} tone={unassigned > 0 ? 'danger' : 'neutral'} hint="No crew listed" />
      </div>

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

      {all.length === 0 ? (
        <EmptyState
          icon={<CalendarDays size={20} />}
          title="No shifts on record"
          description={
            canCreate
              ? 'Create a shift to define coverage and assign crew to a vehicle.'
              : 'Shifts assigned to you will appear here once a planner creates them.'
          }
          action={
            canCreate ? (
              <Button size="sm" onClick={() => setOpen(true)}>
                <Plus size={14} />
                Create shift
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {all.map((shift) => {
            const mayManage = canManageAll || owns(shift);
            const next = shift.status === 'PLANNED' && canStart ? 'ACTIVE' : shift.status === 'ACTIVE' && canEnd ? 'COMPLETED' : null;
            return (
              <Card key={shift.id} variant="interactive" className="flex flex-col">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base">{shift.title}</CardTitle>
                      <p className="mt-1 font-mono text-[11px] text-[var(--muted-foreground)]">{shift.id}</p>
                    </div>
                    <Badge variant={variant(shift.status)} className="flex-none text-[9px]">{shift.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3 text-sm">
                  <p className="flex items-start gap-2 text-xs">
                    <Clock size={14} className="mt-0.5 flex-none text-[var(--muted-foreground)]" />
                    <span>
                      {new Date(shift.startsAt).toLocaleString()} – {new Date(shift.endsAt).toLocaleTimeString()}
                    </span>
                  </p>
                  <p className="flex items-start gap-2 text-xs">
                    <Users size={14} className="mt-0.5 flex-none text-[var(--muted-foreground)]" />
                    <span>
                      {shift.crewIds.join(', ') || 'Unassigned'}
                      {shift.ambulanceId ? ` · ${shift.ambulanceId}` : ''}
                    </span>
                  </p>
                  {shift.notes && (
                    <p className="rounded-lg border border-[var(--border)] bg-[var(--muted)]/50 p-2.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                      {shift.notes}
                    </p>
                  )}
                  {(mayManage && (next || canUnavailable)) && (
                    <div className="mt-auto flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
                      {mayManage && next && (
                        <Button
                          size="sm"
                          disabled={statusMutation.isPending}
                          onClick={() => statusMutation.mutate({ id: shift.id, status: next })}
                        >
                          {statusMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                          {next === 'ACTIVE' ? 'Start shift' : 'Complete shift'}
                        </Button>
                      )}
                      {mayManage && canUnavailable && (
                        <Button variant="outline" size="sm" onClick={() => setUnavailableFor(shift)}>
                          <UserRoundX size={13} />
                          Report unavailable
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create shift</DialogTitle>
            <DialogDescription>Assignments are independently permission-checked and audited.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="shift-title">Title</Label>
              <Input id="shift-title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shift-start">Starts</Label>
              <Input id="shift-start" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shift-end">Ends</Label>
              <Input id="shift-end" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shift-crew">Crew IDs</Label>
              <Input id="shift-crew" value={crewIds} onChange={(event) => setCrewIds(event.target.value)} placeholder="USR-002, USR-004" />
              <p className="text-[11px] text-[var(--muted-foreground)]">Comma-separated user ids.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shift-ambulance">Ambulance ID</Label>
              <Input id="shift-ambulance" value={ambulanceId} onChange={(event) => setAmbulanceId(event.target.value)} placeholder="AMB-031" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="shift-notes">Notes</Label>
              <Textarea id="shift-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
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
              disabled={!title.trim() || !startsAt || !endsAt || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Creating…' : 'Create shift'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(unavailableFor)}
        onOpenChange={(next) => {
          if (!next) {
            setUnavailableFor(null);
            setUnavailableNote('');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Report unavailable</DialogTitle>
            <DialogDescription>
              {unavailableFor ? `${unavailableFor.id} · ${unavailableFor.title}` : ''} — the note is recorded
              with the availability report.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="unavailable-note">Reason</Label>
            <Textarea
              id="unavailable-note"
              value={unavailableNote}
              onChange={(event) => setUnavailableNote(event.target.value)}
              placeholder="Describe the availability issue…"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnavailableFor(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!unavailableNote.trim() || unavailableMutation.isPending}
              onClick={() => {
                if (!unavailableFor) return;
                unavailableMutation.mutate({ id: unavailableFor.id, note: unavailableNote.trim() });
              }}
            >
              {unavailableMutation.isPending ? 'Reporting…' : 'Report unavailable'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
