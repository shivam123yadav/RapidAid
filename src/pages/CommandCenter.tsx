import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import { formatTime } from '../lib/utils';
import { Siren, Truck, Building2, Clock, AlertTriangle, Activity, MapPin, ArrowRight, Radio, RefreshCw, CheckCircle2 } from 'lucide-react';
import { CommandCenterMap } from '../components/maps/CommandCenterMap';
import type { Emergency, EmergencyPriority, Ambulance, Hospital } from '../types';

function PriorityBadge({ priority }: { priority: EmergencyPriority }) {
  const variants: Record<EmergencyPriority, 'critical' | 'destructive' | 'warning' | 'info'> = {
    CRITICAL: 'critical',
    HIGH: 'destructive',
    MEDIUM: 'warning',
    LOW: 'info',
  };
  return <Badge variant={variants[priority]}>{priority}</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'COMPLETED' ? 'success'
      : status === 'CANCELLED' ? 'outline'
        : status === 'CRITICAL' ? 'critical'
          : 'info';
  return <Badge variant={variant}>{status.replace(/_/g, ' ')}</Badge>;
}

export function CommandCenterPage() {
  const emergenciesQuery = useQuery({
    queryKey: ['emergencies'],
    queryFn: api.emergencies.list,
    refetchInterval: 10_000,
  });
  const ambulancesQuery = useQuery({
    queryKey: ['ambulances'],
    queryFn: api.ambulances.list,
    refetchInterval: 10_000,
  });
  const hospitalsQuery = useQuery({
    queryKey: ['hospitals'],
    queryFn: api.hospitals.list,
  });

  const emergencies = emergenciesQuery.data;
  const ambulances = ambulancesQuery.data;
  const hospitals = hospitalsQuery.data;
  const loading = emergenciesQuery.isLoading || ambulancesQuery.isLoading;
  const hasError = emergenciesQuery.isError || ambulancesQuery.isError || hospitalsQuery.isError;

  const activeEmergencies: Emergency[] = (emergencies || []).filter(
    (e: Emergency) => e.status !== 'COMPLETED' && e.status !== 'CANCELLED',
  );
  const criticalEmergencies = activeEmergencies.filter((e: Emergency) => e.priority === 'CRITICAL');
  const availableAmbulances = ((ambulances || []) as Ambulance[]).filter((a: Ambulance) => a.status === 'AVAILABLE');
  const activeAmbulances = ((ambulances || []) as Ambulance[]).filter(
    (a: Ambulance) => a.status !== 'AVAILABLE' && a.status !== 'MAINTENANCE' && a.status !== 'OFFLINE',
  );
  const priorityOrder: Record<EmergencyPriority, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const mostCritical = [...activeEmergencies].sort(
    (a: Emergency, b: Emergency) => priorityOrder[a.priority] - priorityOrder[b.priority],
  )[0];
  const activeEtas = activeEmergencies
    .map((emergency) => emergency.eta)
    .filter((eta): eta is number => typeof eta === 'number' && eta > 0);
  const meanEta = activeEtas.length
    ? Math.round(activeEtas.reduce((sum, eta) => sum + eta, 0) / activeEtas.length)
    : null;
  const lastUpdated = Math.max(
    emergenciesQuery.dataUpdatedAt,
    ambulancesQuery.dataUpdatedAt,
    hospitalsQuery.dataUpdatedAt,
  );

  const refetchAll = () => {
    void emergenciesQuery.refetch();
    void ambulancesQuery.refetch();
    void hospitalsQuery.refetch();
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-72" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Skeleton className="h-[500px] rounded-xl lg:col-span-2" />
          <Skeleton className="h-[500px] rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations / command center"
        title="Live emergency command center"
        description="Real-time incident, fleet and hospital context from the authenticated API."
        icon={<Activity size={21} />}
        status={
          <Badge variant={hasError ? 'warning' : 'outline'} className="gap-1.5">
            <span className={hasError ? 'status-dot text-[var(--warning)]' : 'status-dot status-dot--live text-[var(--success)]'} aria-hidden="true" />
            {hasError ? 'Partial data' : 'API connected'}
          </Badge>
        }
        actions={
          <div className="flex items-center gap-2">
            <span className="hidden text-[10px] text-[var(--muted-foreground)] sm:inline">
              {lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Awaiting first sync'}
            </span>
            <Button variant="outline" size="sm" onClick={refetchAll} className="gap-1.5">
              <RefreshCw size={13} />
              Refresh
            </Button>
          </div>
        }
      />

      {hasError && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={16} className="mt-0.5 flex-none text-[var(--warning)]" />
            <div>
              <p className="text-sm font-medium">Some operational data could not be loaded</p>
              <p className="text-xs text-[var(--muted-foreground)]">
                Available values are shown below. The API remains the source of truth; nothing has been substituted.
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={refetchAll}>Retry</Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Active emergencies" value={activeEmergencies.length} icon={<Siren size={17} />} tone="danger" hint="Open across all priorities" />
        <StatCard label="Critical" value={criticalEmergencies.length} icon={<AlertTriangle size={17} />} tone="danger" hint="Require immediate attention" />
        <StatCard label="Available units" value={availableAmbulances.length} icon={<Truck size={17} />} tone="success" hint="Ready for assignment" />
        <StatCard label="In service" value={activeAmbulances.length} icon={<Radio size={17} />} tone="info" hint="Assigned or en route" />
        <StatCard label="Hospitals" value={hospitals?.length || 0} icon={<Building2 size={17} />} tone="primary" hint="In the hospital directory" />
        <StatCard
          label="Mean active ETA"
          value={meanEta !== null ? formatTime(meanEta) : '—'}
          icon={<Clock size={17} />}
          tone="warning"
          hint={activeEtas.length ? `Across ${activeEtas.length} active ETA${activeEtas.length === 1 ? '' : 's'}` : 'No ETA available from active incidents'}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <MapPin size={15} className="text-[var(--primary)]" />
                  Operations map
                </CardTitle>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Incidents, ambulances and hospitals on the existing Leaflet map.</p>
              </div>
              <Link to="/tracking">
                <Button variant="ghost" size="sm" className="gap-1.5">
                  Open tracking
                  <ArrowRight size={12} />
                </Button>
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              <div className="h-[440px] border-t border-[var(--border)]">
                <CommandCenterMap
                  emergencies={activeEmergencies}
                  ambulances={(ambulances || []) as Ambulance[]}
                  hospitals={(hospitals || []) as Hospital[]}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {mostCritical ? (
            <Card variant="critical">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-sm text-[var(--danger)]">
                    <AlertTriangle size={15} />
                    Critical incident
                  </CardTitle>
                  <PriorityBadge priority={mostCritical.priority} />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <Link to={`/emergencies/${mostCritical.id}`} className="font-mono text-lg font-semibold tracking-[-0.02em] hover:underline">
                    {mostCritical.id}
                  </Link>
                  <StatusBadge status={mostCritical.status} />
                </div>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Type</span><span className="text-right font-medium">{mostCritical.incidentType.replace(/_/g, ' ')}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Location</span><span className="max-w-[65%] truncate text-right font-medium">{mostCritical.location.address}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Victims</span><span className="font-medium">{mostCritical.victimCount}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Assigned</span><span className="font-mono font-medium">{mostCritical.assignedAmbulance || '—'}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">ETA</span><span className="font-mono font-medium">{mostCritical.eta ? formatTime(mostCritical.eta) : '—'}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Hospital</span><span className="max-w-[65%] truncate text-right font-medium">{mostCritical.destinationHospital || '—'}</span></div>
                </div>
                <div className="flex items-center justify-between border-t border-[var(--border)] pt-3">
                  <span className="text-[10px] text-[var(--muted-foreground)]">Reported {formatDistanceToNow(new Date(mostCritical.reportedAt), { addSuffix: true })}</span>
                  <Link to={`/emergencies/${mostCritical.id}`} className="text-xs font-semibold text-[var(--primary)] hover:underline">
                    Open incident
                  </Link>
                </div>
              </CardContent>
            </Card>
          ) : (
            <EmptyState
              compact
              icon={<CheckCircle2 size={18} />}
              title="No active incidents"
              description="The live queue is clear. New reports will appear here as they arrive."
            />
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm">Active incidents ({activeEmergencies.length})</CardTitle>
              <Link to="/emergencies" className="text-[10px] font-semibold text-[var(--primary)] hover:underline">View queue</Link>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {activeEmergencies.length === 0 ? (
                <p className="py-5 text-center text-xs text-[var(--muted-foreground)]">No active incidents.</p>
              ) : (
                activeEmergencies.slice(0, 6).map((emg) => (
                  <Link
                    key={emg.id}
                    to={`/emergencies/${emg.id}`}
                    className="flex items-center gap-3 rounded-lg border border-transparent px-2.5 py-2 transition-colors hover:border-[var(--border)] hover:bg-[var(--muted)]"
                  >
                    <span className={`h-2 w-2 flex-none rounded-full ${emg.priority === 'CRITICAL' ? 'bg-[var(--danger)]' : emg.priority === 'HIGH' ? 'bg-[var(--warning)]' : 'bg-[var(--info)]'}`} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs font-medium">{emg.id}</p>
                      <p className="truncate text-[10px] text-[var(--muted-foreground)]">{emg.incidentType.replace(/_/g, ' ')} · {formatDistanceToNow(new Date(emg.reportedAt), { addSuffix: true })}</p>
                    </div>
                    <Badge variant={emg.priority === 'CRITICAL' ? 'critical' : emg.priority === 'HIGH' ? 'destructive' : 'warning'} className="hidden text-[8px] sm:inline-flex">
                      {emg.priority}
                    </Badge>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Recent events</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {activeEmergencies.slice(0, 4).flatMap((emg) =>
                emg.timeline.slice(-1).map((t) => ({ ...t, emergencyId: emg.id })),
              ).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).map((event, i) => (
                <div key={`${event.emergencyId}-${i}`} className="flex items-start gap-3 text-xs">
                  <span className="mt-0.5 font-mono text-[10px] text-[var(--muted-foreground)]">
                    {new Date(event.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{event.emergencyId}</span>
                    <span className="text-[var(--muted-foreground)]"> — {event.status.replace(/_/g, ' ')}</span>
                    {event.note && <p className="mt-0.5 line-clamp-2 text-[var(--muted-foreground)]">{event.note}</p>}
                  </div>
                </div>
              ))}
              {activeEmergencies.length === 0 && (
                <p className="py-5 text-center text-xs text-[var(--muted-foreground)]">No recent operational events.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
