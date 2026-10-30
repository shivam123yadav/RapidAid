import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Button } from '../components/ui/button';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { useAuthStore } from '../stores/auth';
import { can } from '../lib/permissions';
import {
  Building2,
  Heart,
  Phone,
  Truck,
  Pencil,
  Search,
  ShieldCheck,
  AlertTriangle,
  Activity,
} from 'lucide-react';
import type { Hospital, CapacityStatus } from '../types';

const capacityVariant = (c: CapacityStatus) => {
  const map: Record<CapacityStatus, 'success' | 'warning' | 'destructive'> = {
    AVAILABLE: 'success',
    LIMITED: 'warning',
    FULL: 'destructive',
  };
  return map[c];
};

export function HospitalsPage() {
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Hospital | null>(null);
  const [query, setQuery] = useState('');
  const canEditOwn = can(user?.role, 'hospital:capacity:update:own', user?.permissions) || can(user?.role, 'hospital:update:all', user?.permissions);
  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.hospitals.updateCapacity(editing!.id, payload),
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['hospitals'] });
    },
  });
  const { data: hospitals, isLoading } = useQuery({
    queryKey: ['hospitals'],
    queryFn: api.hospitals.list,
  });

  const all = hospitals ?? [];
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return all;
    return all.filter(
      (hospital) =>
        hospital.name.toLowerCase().includes(term) ||
        hospital.phone.toLowerCase().includes(term) ||
        hospital.capabilities.some((capability) => capability.toLowerCase().includes(term)),
    );
  }, [all, query]);

  const operational = all.filter((hospital) => hospital.status === 'OPERATIONAL').length;
  const traumaReady = all.filter((hospital) => hospital.traumaAvailable).length;
  const incoming = all.reduce((sum, hospital) => sum + hospital.incomingAmbulances, 0);
  const availableEd = all.filter((hospital) => hospital.emergencyCapacity === 'AVAILABLE').length;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-64" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-60 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations / hospital network"
        title="Hospital network"
        description="Capacity, trauma availability and incoming handoffs from the hospital directory. Update actions are permission-scoped and audited."
        icon={<Building2 size={21} />}
        status={<Badge variant="outline">{all.length} facilities</Badge>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Operational" value={operational} icon={<ShieldCheck size={17} />} tone="success" hint={`${all.length} facilities on record`} />
        <StatCard label="Trauma ready" value={traumaReady} icon={<Heart size={17} />} tone="danger" hint="Trauma capability available" />
        <StatCard label="ED available" value={availableEd} icon={<Activity size={17} />} tone="info" hint="Emergency department not full" />
        <StatCard label="Incoming units" value={incoming} icon={<Truck size={17} />} tone="warning" hint="Across all facilities" />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[var(--success)]" /> Available</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[var(--warning)]" /> Limited</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[var(--destructive)]" /> Full</span>
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search facility, capability, phone…"
            className="h-9 pl-9 text-xs"
            aria-label="Filter hospitals"
          />
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<Building2 size={20} />}
          title="No hospitals on record"
          description="Facilities appear here once the hospital directory is populated by the API."
        />
      ) : visible.length === 0 ? (
        <EmptyState compact icon={<Search size={18} />} title="No facilities match" description="Try a different search term." />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((hosp: Hospital) => {
            const editable = canEditOwn && (user?.hospitalId === hosp.id || can(user?.role, 'hospital:update:all', user?.permissions));
            return (
              <Card key={hosp.id} variant="interactive" className="flex flex-col overflow-hidden">
                <CardContent className="flex flex-1 flex-col gap-4 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_8%,transparent)] text-[var(--primary)]">
                        <Building2 size={16} />
                      </div>
                      <div className="min-w-0">
                        <h2 className="truncate font-display text-[15px] font-semibold tracking-[-0.025em]">{hosp.name}</h2>
                        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--muted-foreground)]">
                          <Phone size={10} />
                          {hosp.phone}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-none items-center gap-1">
                      {editable && (
                        <Button
                          variant="ghost"
                          size="iconSm"
                          onClick={() => setEditing(hosp)}
                          title="Update capacity"
                          aria-label={`Update capacity for ${hosp.name}`}
                        >
                          <Pencil size={13} />
                        </Button>
                      )}
                      <Badge variant={hosp.status === 'OPERATIONAL' ? 'success' : 'destructive'} className="text-[9px]">
                        {hosp.status}
                      </Badge>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] px-3 py-2">
                      <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Emergency dept</p>
                      <Badge variant={capacityVariant(hosp.emergencyCapacity)} className="mt-1.5 text-[9px]">{hosp.emergencyCapacity}</Badge>
                    </div>
                    <div className="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] px-3 py-2">
                      <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">ICU</p>
                      <Badge variant={capacityVariant(hosp.icuCapacity)} className="mt-1.5 text-[9px]">{hosp.icuCapacity}</Badge>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
                    <span className="flex items-center gap-1.5">
                      <Heart size={13} className={hosp.traumaAvailable ? 'text-[var(--success)]' : 'text-[var(--muted-foreground)]'} />
                      Trauma: {hosp.traumaAvailable ? 'Available' : 'Unavailable'}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Truck size={13} className="text-[var(--info)]" />
                      Incoming: {hosp.incomingAmbulances}
                    </span>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center justify-between text-[10px]">
                      <span className="text-[var(--muted-foreground)]">Current load</span>
                      <span className="font-mono font-semibold">{hosp.currentLoad}%</span>
                    </div>
                    <div
                      className="h-1.5 overflow-hidden rounded-full bg-[var(--muted)]"
                      role="progressbar"
                      aria-valuenow={hosp.currentLoad}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${hosp.name} current load`}
                    >
                      <div
                        className={
                          hosp.currentLoad > 80
                            ? 'h-full rounded-full bg-[var(--destructive)]'
                            : hosp.currentLoad > 60
                              ? 'h-full rounded-full bg-[var(--warning)]'
                              : 'h-full rounded-full bg-[var(--success)]'
                        }
                        style={{ width: `${hosp.currentLoad}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {hosp.capabilities.map((cap) => (
                      <span key={cap} className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                        {cap}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <HospitalCapacityDialog
        key={editing?.id ?? 'none'}
        hospital={editing}
        open={Boolean(editing)}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        onSubmit={(payload) => save.mutate(payload)}
        pending={save.isPending}
        error={save.error instanceof ApiError ? save.error.message : undefined}
      />
    </div>
  );
}

function HospitalCapacityDialog({ hospital, open, onOpenChange, onSubmit, pending, error }: { hospital: Hospital | null; open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (payload: Record<string, unknown>) => void; pending: boolean; error?: string }) {
  const [emergencyCapacity, setEmergencyCapacity] = useState<CapacityStatus>(hospital?.emergencyCapacity ?? 'AVAILABLE');
  const [icuCapacity, setIcuCapacity] = useState<CapacityStatus>(hospital?.icuCapacity ?? 'AVAILABLE');
  const [currentLoad, setCurrentLoad] = useState(hospital?.currentLoad ?? 0);
  const [waiting, setWaiting] = useState(hospital?.estimatedWaitingTimeMinutes ?? 0);
  if (!hospital) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle size={17} className="text-[var(--warning)]" />
            Update {hospital.name} capacity
          </DialogTitle>
          <DialogDescription>
            Changes are operational-only and are recorded in the immutable audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            Emergency department
            <select className="mt-1 h-10 w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2" value={emergencyCapacity} onChange={(event) => setEmergencyCapacity(event.target.value as CapacityStatus)}>
              {['AVAILABLE', 'LIMITED', 'FULL'].map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label className="text-sm">
            ICU
            <select className="mt-1 h-10 w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2" value={icuCapacity} onChange={(event) => setIcuCapacity(event.target.value as CapacityStatus)}>
              {['AVAILABLE', 'LIMITED', 'FULL'].map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label className="text-sm">
            Current load (%)
            <input type="number" min={0} max={100} className="mt-1 h-10 w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2" value={currentLoad} onChange={(event) => setCurrentLoad(Number(event.target.value))} />
          </label>
          <label className="text-sm">
            Wait (minutes)
            <input type="number" min={0} max={1440} className="mt-1 h-10 w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2" value={waiting} onChange={(event) => setWaiting(Number(event.target.value))} />
          </label>
        </div>
        {error && <p className="mt-3 text-sm text-[var(--destructive)]">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => onSubmit({ emergencyCapacity, icuCapacity, currentLoad, estimatedWaitingTimeMinutes: waiting })}
            disabled={pending}
          >
            {pending ? 'Saving…' : 'Save capacity'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
