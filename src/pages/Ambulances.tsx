import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import {
  Truck, MapPin, Users, Activity, Plus, Lock, Zap, Radio, Pencil, PowerOff,
  Search, ShieldCheck, Wrench, CheckCircle2,
} from 'lucide-react';
import { useAuthStore } from '../stores/auth';
import { fleetPermissions } from '../lib/permissions';
import type { Ambulance, AmbulanceAvailability, AmbulanceStatus } from '../types';

const statusVariant = (status: AmbulanceStatus) => {
  const map: Record<AmbulanceStatus, 'success' | 'warning' | 'destructive' | 'info' | 'outline' | 'secondary'> = {
    AVAILABLE: 'success',
    RESERVED: 'info',
    ASSIGNED: 'warning',
    EN_ROUTE: 'warning',
    AT_SCENE: 'destructive',
    TRANSPORTING: 'info',
    AT_HOSPITAL: 'success',
    MAINTENANCE: 'secondary',
    OFFLINE: 'outline',
  };
  return map[status];
};

const CAPABILITY_OPTIONS = ['Basic', 'Advanced', 'ICU', 'Trauma', 'Neonatal', 'Oxygen', 'Ventilator'];
const AVAILABILITY_OPTIONS: AmbulanceAvailability[] = ['AVAILABLE', 'MAINTENANCE', 'OFFLINE'];
/** Operational states a crew member may set on their OWN unit via telemetry. */
const OPERATIONAL_STATUS_OPTIONS: AmbulanceStatus[] = [
  'AVAILABLE',
  'EN_ROUTE',
  'AT_SCENE',
  'TRANSPORTING',
  'AT_HOSPITAL',
  'OFFLINE',
];

/** Fleet status board. Which controls render is driven by `fleetPermissions`;
 *  the API independently enforces the same matrix, so this is UX only. */
export function AmbulancesPage() {
  const user = useAuthStore((state) => state.user);
  // `user.permissions` is issued by the server at login; without it every flag
  // would fall back to `false` and the page would render no controls at all.
  const perms = fleetPermissions(user?.role, user?.permissions);
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Ambulance | null>(null);
  const [crewFor, setCrewFor] = useState<Ambulance | null>(null);
  const [assignFor, setAssignFor] = useState<Ambulance | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'AVAILABLE' | 'MISSION' | 'MAINTENANCE' | 'OFFLINE'>('ALL');

  const { data: ambulances, isLoading, error } = useQuery({
    queryKey: ['ambulances'],
    queryFn: api.ambulances.list,
  });

  const availability = useMutation({
    mutationFn: ({ id, status }: { id: string; status: AmbulanceAvailability }) =>
      api.ambulances.setAvailability(id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ambulances'] }),
  });

  /** Crew status heartbeat — server restricts this to the caller's own unit. */
  const ownStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: AmbulanceStatus }) =>
      api.ambulances.updateTelemetry(id, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ambulances'] }),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.ambulances.deactivate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ambulances'] }),
  });

  const all = useMemo(() => ambulances ?? [], [ambulances]);
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return all.filter((amb) => {
      const onMission = Boolean(amb.currentEmergency) || ['ASSIGNED', 'EN_ROUTE', 'AT_SCENE', 'TRANSPORTING', 'AT_HOSPITAL'].includes(amb.status);
      if (statusFilter === 'MISSION' && !onMission) return false;
      if (statusFilter === 'AVAILABLE' && amb.status !== 'AVAILABLE') return false;
      if (statusFilter === 'MAINTENANCE' && amb.status !== 'MAINTENANCE') return false;
      if (statusFilter === 'OFFLINE' && amb.status !== 'OFFLINE') return false;
      if (!term) return true;
      return (
        amb.id.toLowerCase().includes(term) ||
        (amb.currentEmergency ?? '').toLowerCase().includes(term) ||
        amb.crew.some((member) => member.name.toLowerCase().includes(term)) ||
        amb.capabilities.some((capability) => capability.toLowerCase().includes(term))
      );
    });
  }, [all, query, statusFilter]);
  const available = all.filter((amb) => amb.status === 'AVAILABLE').length;
  const onMission = all.filter(
    (amb) => Boolean(amb.currentEmergency) || ['ASSIGNED', 'EN_ROUTE', 'AT_SCENE', 'TRANSPORTING', 'AT_HOSPITAL'].includes(amb.status),
  ).length;
  const maintenance = all.filter((amb) => amb.status === 'MAINTENANCE').length;
  const units = visible;

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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      </div>
    );
  }

  // A 403 here means the role has no fleet access at all (e.g. Citizen).
  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Operations / fleet"
          title={perms.ownUnitOnly ? 'My ambulance' : 'Ambulance fleet'}
          description="Fleet records are scoped by role on the server."
          icon={<Truck size={21} />}
        />
        <EmptyState
          icon={<Lock size={20} />}
          title="Ambulance data is not available for your role"
          description={error instanceof ApiError ? error.message : 'Please try again later.'}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations / fleet"
        title={perms.ownUnitOnly ? 'My ambulance' : 'Ambulance fleet'}
        description={
          perms.ownUnitOnly
            ? 'Operational status for the unit you are assigned to. The server scopes every update to that vehicle.'
            : 'Current status, crew and capability coverage across the fleet. Every control is permission-scoped and re-checked by the API.'
        }
        icon={<Truck size={21} />}
        status={<Badge variant="outline" className="gap-1.5"><ShieldCheck size={11} /> {perms.readOnly ? 'Read-only' : 'Operational control'}</Badge>}
        actions={
          perms.canCreate ? (
            <Button onClick={() => setAddOpen(true)}>
              <Plus size={15} />
              Add ambulance
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Fleet size" value={all.length} icon={<Truck size={17} />} tone="primary" hint="Units visible to this session" />
        <StatCard label="Available" value={available} icon={<CheckCircle2 size={17} />} tone="success" hint="Ready for assignment" />
        <StatCard label="On mission" value={onMission} icon={<Radio size={17} />} tone="warning" hint="Assigned or with an incident" />
        <StatCard label="Maintenance" value={maintenance} icon={<Wrench size={17} />} tone={maintenance > 0 ? 'danger' : 'neutral'} hint="Out of service" />
      </div>

      {perms.readOnly && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--muted)]/60 p-3.5">
          <Lock size={15} className="mt-0.5 flex-none text-[var(--muted-foreground)]" />
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
            Read-only access — ambulance records, assignments and logs are view-only for your role.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 w-fit">
          {(['ALL', 'AVAILABLE', 'MISSION', 'MAINTENANCE', 'OFFLINE'] as const).map((value) => (
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
              {value === 'ALL' ? `All (${all.length})` : value === 'MISSION' ? 'On mission' : `${value.charAt(0)}${value.slice(1).toLowerCase()}`}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search unit, crew, capability…"
            className="h-9 pl-9 text-xs"
            aria-label="Search ambulances"
          />
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<Truck size={20} />}
          title={perms.ownUnitOnly ? 'No unit assigned' : 'No ambulances on record'}
          description={
            perms.ownUnitOnly
              ? 'You are not currently assigned to an ambulance. An administrator can bind your login to a unit.'
              : 'Register a fleet unit to begin tracking status, crew and capability coverage.'
          }
          action={
            perms.canCreate ? (
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus size={14} />
                Add ambulance
              </Button>
            ) : undefined
          }
        />
      ) : units.length === 0 ? (
        <EmptyState compact icon={<Search size={18} />} title="No units match this view" description="Adjust the status filter or search text." />
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {units.map((amb: Ambulance) => (
          <Card
            key={amb.id}
            variant={amb.status === 'AT_SCENE' ? 'critical' : 'interactive'}
            className="flex flex-col"
          >
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Truck size={16} className="text-[var(--primary)]" />
                    <span className="font-mono">{amb.id}</span>
                  </CardTitle>
                  <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                    {amb.currentEmergency ? `Incident ${amb.currentEmergency}` : amb.destinationHospital ? `To ${amb.destinationHospital}` : 'No incident attached'}
                  </p>
                </div>
                <Badge variant={statusVariant(amb.status)} className="flex-none text-[9px]">{amb.status.replace(/_/g, ' ')}</Badge>
              </div>
              {deactivate.isError && (
                <p className="mt-1 text-xs text-destructive">
                  {deactivate.error instanceof ApiError ? deactivate.error.message : 'Deactivate failed'}
                </p>
              )}
            </CardHeader>
            <CardContent className="flex flex-1 flex-col space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] px-2.5 py-2">
                  <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Position</p>
                  <p className="mt-1 flex items-center gap-1 font-mono text-[11px]">
                    <MapPin size={10} className="flex-none" />
                    {amb.location.lat.toFixed(4)}, {amb.location.lng.toFixed(4)}
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] px-2.5 py-2">
                  <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Speed</p>
                  <p className="mt-1 flex items-center gap-1 font-mono text-[11px]">
                    <Activity size={10} className="flex-none" />
                    {amb.speed} km/h
                  </p>
                </div>
              </div>

              {amb.currentEmergency && (
                <div className="rounded-lg border border-[color-mix(in_srgb,var(--warning)_30%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_6%,transparent)] px-3 py-2">
                  <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Assigned emergency</p>
                  <p className="mt-0.5 font-mono text-xs font-semibold">{amb.currentEmergency}</p>
                  {amb.eta && (
                    <p className="text-[11px] text-[var(--muted-foreground)]">
                      ETA {Math.floor(amb.eta / 60)}:{(amb.eta % 60).toString().padStart(2, '0')}
                    </p>
                  )}
                </div>
              )}

              <div>
                <p className="mb-1 flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
                  <Users size={10} /> Crew
                </p>
                <div className="flex flex-wrap gap-1">
                  {amb.crew.map((member) => (
                    <span key={member.id} className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px]">{member.name}</span>
                  ))}
                  {amb.crew.length === 0 && <span className="text-[11px] text-[var(--muted-foreground)]">No crew assigned</span>}
                </div>
              </div>

              <div>
                <p className="mb-1 flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
                  <Zap size={10} /> Capabilities
                </p>
                <div className="flex flex-wrap gap-1">
                  {amb.capabilities.map((cap) => (
                    <span key={cap} className="rounded-full bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] px-2 py-0.5 text-[10px] text-[var(--primary)]">{cap}</span>
                  ))}
                  {amb.capabilities.length === 0 && <span className="text-[11px] text-[var(--muted-foreground)]">None recorded</span>}
                </div>
              </div>

              {(perms.canManageFleet || perms.canAssignToEmergency || perms.canDeactivate) && (
                <div className="flex flex-wrap gap-1.5 border-t border-[var(--border)] pt-3">
                  {perms.canAssignToEmergency && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAssignFor(amb)}>
                      <Radio size={12} /> Assign emergency
                    </Button>
                  )}
                  {perms.canEditFleet && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditing(amb)}>
                      <Pencil size={12} /> Edit
                    </Button>
                  )}
                  {perms.canAssignCrew && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setCrewFor(amb)}>
                      <Users size={12} /> Assign crew
                    </Button>
                  )}
                  {perms.canDeactivate && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-[var(--destructive)]" onClick={() => deactivate.mutate(amb.id)}>
                      <PowerOff size={12} /> Deactivate
                    </Button>
                  )}
                </div>
              )}

              {/* Crew: "Update My Status" for the unit they are assigned to.
                  The server scopes this to the caller's own ambulance, so a
                  crew member cannot move another unit through this control. */}
              {perms.canUpdateOwnTelemetry && perms.ownUnitOnly && (
                <div className="space-y-1.5 border-t pt-3">
                  <Label className="text-xs text-[var(--muted-foreground)]">My Status</Label>
                  <Select
                    value={amb.status}
                    onValueChange={(next) =>
                      ownStatus.mutate({ id: amb.id, status: next as AmbulanceStatus })
                    }
                    disabled={ownStatus.isPending}
                  >
                    <SelectTrigger className="h-8 text-xs" aria-label={`Update my status for ${amb.id}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPERATIONAL_STATUS_OPTIONS.map((opt) => (
                        <SelectItem key={opt} value={opt}>{opt.replace(/_/g, ' ')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {ownStatus.isError && (
                    <p className="text-xs text-destructive">
                      {ownStatus.error instanceof ApiError ? ownStatus.error.message : 'Update failed'}
                    </p>
                  )}
                </div>
              )}

              {/* Availability tracking — dispatcher/manager only. A crew
                  member updates their own unit's status through telemetry
                  instead, and read-only roles get no control here. */}
              {perms.canSetAvailability && (
                <div className="space-y-1.5 border-t pt-3">
                  <Label className="text-xs text-[var(--muted-foreground)]">Availability</Label>
                  <Select
                    value={(AVAILABILITY_OPTIONS as string[]).includes(amb.status) ? amb.status : undefined}
                    onValueChange={(next) =>
                      availability.mutate({ id: amb.id, status: next as AmbulanceAvailability })
                    }
                    disabled={availability.isPending}
                  >
                    <SelectTrigger className="h-8 text-xs" aria-label={`Set availability for ${amb.id}`}>
                      <SelectValue placeholder="Set availability" />
                    </SelectTrigger>
                    <SelectContent>
                      {AVAILABILITY_OPTIONS.map((opt) => (
                        <SelectItem key={opt} value={opt}>{opt.replace(/_/g, ' ')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {availability.isError && (
                    <p className="text-xs text-destructive">
                      {availability.error instanceof ApiError ? availability.error.message : 'Update failed'}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      )}

      <AddAmbulanceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['ambulances'] })}
      />

      {editing && (
        <EditAmbulanceDialog
          ambulance={editing}
          onClose={() => setEditing(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['ambulances'] })}
        />
      )}

      {crewFor && (
        <AssignCrewDialog
          ambulance={crewFor}
          onClose={() => setCrewFor(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['ambulances'] })}
        />
      )}

      {assignFor && (
        <AssignEmergencyDialog
          ambulance={assignFor}
          onClose={() => setAssignFor(null)}
          onAssigned={() => {
            queryClient.invalidateQueries({ queryKey: ['ambulances'] });
            queryClient.invalidateQueries({ queryKey: ['emergencies'] });
            queryClient.invalidateQueries({ queryKey: ['emergency'] });
          }}
        />
      )}
    </div>
  );
}

/**
 * Register a new ambulance. Rendered only for ADMIN / SUPERVISOR
 * (`perms.canManageFleet`) — a dispatcher, crew member or read-only role never
 * sees the trigger, and the API rejects their POST with 403 regardless.
 */
function AddAmbulanceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [lat, setLat] = useState('28.6139');
  const [lng, setLng] = useState('77.2090');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [crewName, setCrewName] = useState('');
  const [crewRole, setCrewRole] = useState('EMT');
  const [crewUserId, setCrewUserId] = useState('');

  const reset = () => {
    setLat('28.6139');
    setLng('77.2090');
    setCapabilities([]);
    setCrewName('');
    setCrewRole('EMT');
    setCrewUserId('');
  };

  const create = useMutation({
    mutationFn: () =>
      api.ambulances.create({
        status: 'AVAILABLE',
        location: { lat: Number(lat), lng: Number(lng) },
        capabilities,
        crew: crewName.trim()
          ? [
              {
                id: `C-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
                name: crewName.trim(),
                role: crewRole.trim() || 'EMT',
                certification: [],
                // Binding a seat to a login is what lets that crew member see
                // and update this unit; leave blank for an unstaffed seat.
                ...(crewUserId.trim() ? { userId: crewUserId.trim() } : {}),
              },
            ]
          : [],
      }),
    onSuccess: () => {
      reset();
      onCreated();
      onOpenChange(false);
    },
  });

  const toggleCapability = (cap: string) =>
    setCapabilities((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Ambulance</DialogTitle>
          <DialogDescription>
            Register a new fleet unit. Crew seats can be bound to a login so that person
            gets access to this ambulance.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="amb-lat">Latitude</Label>
              <Input id="amb-lat" value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="amb-lng">Longitude</Label>
              <Input id="amb-lng" value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Capabilities</Label>
            <div className="flex flex-wrap gap-2">
              {CAPABILITY_OPTIONS.map((cap) => (
                <button
                  key={cap}
                  type="button"
                  onClick={() => toggleCapability(cap)}
                  className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                    capabilities.includes(cap)
                      ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                      : 'bg-[var(--surface)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]'
                  }`}
                >
                  {cap}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5 rounded-lg border p-3">
            <Label className="text-xs text-[var(--muted-foreground)]">Assign crew (optional)</Label>
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Crew name"
                value={crewName}
                onChange={(e) => setCrewName(e.target.value)}
                aria-label="Crew name"
              />
              <Input
                placeholder="Role (e.g. EMT)"
                value={crewRole}
                onChange={(e) => setCrewRole(e.target.value)}
                aria-label="Crew role"
              />
            </div>
            <Input
              placeholder="Login id (e.g. USR-002) — grants unit access"
              value={crewUserId}
              onChange={(e) => setCrewUserId(e.target.value)}
              aria-label="Crew login id"
            />
          </div>

          {create.isError && (
            <p className="text-sm text-destructive">
              {create.error instanceof ApiError ? create.error.message : 'Could not create ambulance'}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create Ambulance'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Edit a unit's record (capabilities, equipment, location). ADMIN / SUPERVISOR. */
function EditAmbulanceDialog({
  ambulance,
  onClose,
  onSaved,
}: {
  ambulance: Ambulance;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [lat, setLat] = useState(String(ambulance.location.lat));
  const [lng, setLng] = useState(String(ambulance.location.lng));
  const [capabilities, setCapabilities] = useState<string[]>(ambulance.capabilities);

  const save = useMutation({
    mutationFn: () =>
      api.ambulances.update(ambulance.id, {
        location: { lat: Number(lat), lng: Number(lng) },
        capabilities,
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const toggle = (cap: string) =>
    setCapabilities((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]));

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {ambulance.id}</DialogTitle>
          <DialogDescription>Update location and capabilities for this unit.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-lat">Latitude</Label>
              <Input id="edit-lat" value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-lng">Longitude</Label>
              <Input id="edit-lng" value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Capabilities</Label>
            <div className="flex flex-wrap gap-2">
              {CAPABILITY_OPTIONS.map((cap) => (
                <button
                  key={cap}
                  type="button"
                  onClick={() => toggle(cap)}
                  className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                    capabilities.includes(cap)
                      ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                      : 'bg-[var(--surface)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]'
                  }`}
                >
                  {cap}

                </button>
              ))}
            </div>
          </div>

          {save.isError && (
            <p className="text-sm text-destructive">
              {save.error instanceof ApiError ? save.error.message : 'Could not save changes'}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


/**
 * Assign / reassign the crew roster. ADMIN / SUPERVISOR.
 * Binding a seat to a login id is what grants that crew member access to the
 * unit, so it is editable here rather than hidden.
 */
function AssignCrewDialog({
  ambulance,
  onClose,
  onSaved,
}: {
  ambulance: Ambulance;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Seed the form from the unit's current roster.
  const [rows, setRows] = useState(
    ambulance.crew.map((c) => ({ id: c.id, name: c.name, role: c.role, userId: c.userId ?? '' })),
  );

  const save = useMutation({
    mutationFn: () =>
      api.ambulances.assignCrew(
        ambulance.id,
        rows
          .filter((r) => r.name.trim())
          .map((r, i) => ({
            id: r.id || `C-${i + 1}`,
            name: r.name.trim(),
            role: r.role.trim() || 'EMT',
            certification: [],
            ...(r.userId.trim() ? { userId: r.userId.trim() } : {}),
          })),
      ),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const update = (i: number, patch: Partial<(typeof rows)[number]>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Assign Crew — {ambulance.id}</DialogTitle>
          <DialogDescription>
            Bind a seat to a login id (e.g. USR-002) to grant that crew member access to this unit.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <Input className="col-span-4" placeholder="Name" value={row.name}
                onChange={(e) => update(i, { name: e.target.value })} aria-label={`Crew ${i + 1} name`} />
              <Input className="col-span-3" placeholder="Role" value={row.role}
                onChange={(e) => update(i, { role: e.target.value })} aria-label={`Crew ${i + 1} role`} />
              <Input className="col-span-3" placeholder="Login id" value={row.userId}
                onChange={(e) => update(i, { userId: e.target.value })} aria-label={`Crew ${i + 1} login id`} />
              <Button variant="ghost" size="sm" className="col-span-2"
                onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                aria-label={`Remove crew ${i + 1}`}>
                Remove
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm"
            onClick={() => setRows((prev) => [...prev, { id: '', name: '', role: 'EMT', userId: '' }])}>
            <Plus size={14} className="mr-1" /> Add Crew Member
          </Button>
        </div>

        {save.isError && (
          <p className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : 'Could not assign crew'}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save Crew'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dispatch an ambulance to an emergency. Visible to ADMIN / SUPERVISOR /
 * DISPATCHER — the three roles that may bind a unit to an incident. A
 * dispatcher can therefore assign work but can never create or edit the unit
 * itself, which is the distinction the access rules draw.
 */
function AssignEmergencyDialog({
  ambulance,
  onClose,
  onAssigned,
}: {
  ambulance: Ambulance;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [emergencyId, setEmergencyId] = useState('');
  const queryClient = useQueryClient();

  const { data: emergencies, isLoading } = useQuery({
    queryKey: ['emergencies'],
    queryFn: api.emergencies.list,
  });

  /** Only open incidents that are not already committed to another unit. */
  const dispatchable = (emergencies ?? []).filter(
    (e) => e.status !== 'COMPLETED' && e.status !== 'CANCELLED' && !e.assignedAmbulance,
  );

  const assign = useMutation({
    mutationFn: () => api.dispatch.assign(emergencyId, ambulance.id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ambulances'] });
      queryClient.invalidateQueries({ queryKey: ['emergencies'] });
      queryClient.invalidateQueries({ queryKey: ['emergency', emergencyId] });
      queryClient.invalidateQueries({ queryKey: ['emergency'] });
      if (data?.emergency) {
        queryClient.setQueryData(['emergency', emergencyId], data.emergency);
      }
      onAssigned();
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign Emergency — {ambulance.id}</DialogTitle>
          <DialogDescription>
            Bind this unit to an open emergency. Dispatch state changes only; the
            ambulance record itself is not modified.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="assign-emergency">Emergency</Label>
          <Select value={emergencyId} onValueChange={setEmergencyId} disabled={isLoading || assign.isPending}>
            <SelectTrigger id="assign-emergency" aria-label="Select an emergency">
              <SelectValue
                placeholder={
                  isLoading
                    ? 'Loading open emergencies…'
                    : dispatchable.length === 0
                      ? 'No unassigned emergencies'
                      : 'Choose an emergency'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {dispatchable.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.id} — {e.incidentType.replace(/_/g, ' ')} ({e.priority})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!isLoading && dispatchable.length === 0 && (
            <p className="text-xs text-[var(--muted-foreground)]">
              Every open emergency already has an ambulance assigned.
            </p>
          )}
        </div>

        {assign.isError && (
          <p className="text-sm text-destructive">
            {assign.error instanceof ApiError ? assign.error.message : 'Assignment failed'}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => assign.mutate()}
            disabled={!emergencyId || assign.isPending}
          >
            <Radio size={14} className="mr-1" />
            {assign.isPending ? 'Assigning…' : 'Assign Ambulance'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
