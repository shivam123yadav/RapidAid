import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  Gauge,
  MapPin,
  Play,
  Route,
  ShieldCheck,
  TrafficCone,
  Zap,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import { api, ApiError } from '../api/client';
import { formatTime } from '../lib/utils';
import { useAuthStore } from '../stores/auth';
import { can } from '../lib/permissions';

/** Project real route coordinates onto a 400×200 viewBox. */
function projectRoute(points: { lat: number; lng: number }[]) {
  if (points.length < 2) return [];
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const spanLat = maxLat - minLat || 1;
  const spanLng = maxLng - minLng || 1;
  const pad = 28;
  return points.map((point) => ({
    x: pad + ((point.lng - minLng) / spanLng) * (400 - pad * 2),
    // SVG y grows downward, so invert latitude.
    y: pad + ((maxLat - point.lat) / spanLat) * (200 - pad * 2),
  }));
}

export function GreenCorridorPage() {
  const user = useAuthStore((state) => state.user);
  const canControl = can(user?.role, 'green-corridor:control', user?.permissions);
  const [simulating, setSimulating] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: emergencies, isLoading: loadingEmergencies } = useQuery({ queryKey: ['emergencies'], queryFn: api.emergencies.list });
  const emergency = emergencies?.find((item) => !['COMPLETED', 'CANCELLED'].includes(item.status) && item.assignedAmbulance && item.destinationHospital)
    ?? emergencies?.find((item) => !['COMPLETED', 'CANCELLED'].includes(item.status));
  const emergencyId = emergency?.id;
  const { data: sim, isLoading } = useQuery({
    queryKey: ['green-corridor', emergencyId],
    queryFn: () => api.simulations.getGreenCorridor(emergencyId!),
    enabled: Boolean(emergencyId),
  });

  const runMutation = useMutation({
    mutationFn: () => api.simulations.runGreenCorridor(emergencyId!),
    onMutate: () => {
      setSimulating(true);
      setRunError(null);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(['green-corridor', emergencyId], result);
    },
    onError: (err) => setRunError(err instanceof ApiError ? err.message : 'Simulation failed'),
    onSettled: () => setSimulating(false),
  });

  const handleSimulate = () => {
    if (!runMutation.isPending) runMutation.mutate();
  };

  const simComplete = !!sim && !simulating;
  const projected = useMemo(() => projectRoute(sim?.route ?? []), [sim?.route]);
  const hasRoute = projected.length >= 2;
  const polyline = projected.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const start = projected[0];
  const end = projected[projected.length - 1];
  const improvement = sim && sim.baselineETA > 0 ? Math.round((sim.timeSaved / sim.baselineETA) * 100) : null;

  if (loadingEmergencies) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-64" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-xl" />)}
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }

  if (!emergency) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Planning / green corridor"
          title="Green corridor simulation"
          description="Model signal coordination for an active incident. No real traffic infrastructure is controlled."
          icon={<TrafficCone size={21} />}
          status={<Badge variant="outline" className="gap-1.5"><ShieldCheck size={11} /> Simulation only</Badge>}
        />
        <EmptyState
          icon={<TrafficCone size={20} />}
          title="No active emergency in your scope"
          description="A green corridor simulation needs an open incident. Once one is visible to your role it will appear here."
        />
      </div>
    );
  }

  const ambulanceLabel = emergency.assignedAmbulance ?? 'Unassigned';
  const hospitalLabel = emergency.destinationHospital ?? 'Destination pending';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Planning / green corridor / ${emergency.id}`}
        title="Green corridor simulation"
        description={`Modeled route for ${ambulanceLabel} → ${hospitalLabel}. Results are estimates for planning and never control real signals.`}
        icon={<TrafficCone size={21} />}
        status={
          <Badge variant={simComplete ? 'success' : 'warning'} className="gap-1.5">
            <ShieldCheck size={11} />
            {simComplete ? 'Model complete' : simulating ? 'Simulating' : 'Not run'}
          </Badge>
        }
        actions={
          canControl ? (
            <Button onClick={handleSimulate} disabled={simulating || !emergencyId}>
              <Play size={14} />
              {simulating ? 'Simulating…' : simComplete ? 'Run again' : 'Run simulation'}
            </Button>
          ) : undefined
        }
      />

      {runError && (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
          <AlertTriangle size={15} className="mt-0.5 flex-none text-[var(--destructive)]" />
          <p className="text-xs leading-relaxed text-[var(--destructive)]">{runError}</p>
        </div>
      )}

      <div className="flex items-start gap-2.5 rounded-xl border border-[var(--warning)]/35 bg-[color-mix(in_srgb,var(--warning)_7%,transparent)] p-3.5">
        <AlertTriangle size={15} className="mt-0.5 flex-none text-[var(--warning)]" />
        <div>
          <p className="text-xs font-semibold text-[var(--warning)]">Simulation — no real traffic signal control</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-foreground)]">
            This environment models a corridor for planning. No actual traffic signals are being controlled,
            and each figure below comes from the simulation endpoint rather than a live road network.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Baseline ETA"
          value={sim ? formatTime(sim.baselineETA) : '—'}
          icon={<Clock size={17} />}
          tone="neutral"
          hint="Modeled without coordination"
        />
        <StatCard
          label="Simulated ETA"
          value={sim ? formatTime(sim.simulatedETA) : '—'}
          icon={<Route size={17} />}
          tone={sim ? 'success' : 'neutral'}
          hint="Modeled with corridor"
        />
        <StatCard
          label="Time saved"
          value={sim ? formatTime(sim.timeSaved) : '—'}
          icon={<Zap size={17} />}
          tone={sim ? 'primary' : 'neutral'}
          hint={improvement !== null ? `${improvement}% of baseline` : 'Run the model to estimate'}
        />
        <StatCard
          label="Signals affected"
          value={sim ? sim.signalsAffected : '—'}
          icon={<Gauge size={17} />}
          tone={sim ? 'info' : 'neutral'}
          hint="Signals in the modeled corridor"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MapPin size={15} className="text-[var(--primary)]" />
              Route geometry
            </CardTitle>
            <CardDescription>
              {emergency.id} · {ambulanceLabel} <ArrowRight size={11} className="inline" /> {hospitalLabel}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="relative h-72 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--muted)]/30">
              <div
                aria-hidden="true"
                className="absolute inset-0 opacity-40"
                style={{
                  backgroundImage:
                    'linear-gradient(to right, color-mix(in srgb, var(--border) 55%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--border) 55%, transparent) 1px, transparent 1px)',
                  backgroundSize: '32px 32px',
                }}
              />
              {hasRoute && start && end ? (
                <svg
                  className="absolute inset-0 h-full w-full"
                  viewBox="0 0 400 200"
                  role="img"
                  aria-label={`Modeled route from ${ambulanceLabel} to ${hospitalLabel}, ${sim?.signalsAffected ?? 0} signals affected`}
                >
                  <polyline
                    points={polyline}
                    fill="none"
                    stroke={simComplete ? 'var(--success)' : simulating ? 'var(--warning)' : 'var(--muted-foreground)'}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={simulating ? '8 4' : undefined}
                    className={simulating ? 'animate-pulse' : undefined}
                  />
                  <circle cx={start.x} cy={start.y} r="6" fill="var(--primary)" />
                  <text x={start.x} y={start.y - 12} textAnchor="middle" fontSize="9" className="fill-[var(--muted-foreground)]">
                    {ambulanceLabel}
                  </text>
                  <circle cx={end.x} cy={end.y} r="6" fill="var(--success)" />
                  <text x={end.x} y={end.y - 12} textAnchor="middle" fontSize="9" className="fill-[var(--muted-foreground)]">
                    {hospitalLabel}
                  </text>
                </svg>
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                  <Route size={26} className="text-[var(--muted-foreground)] opacity-60" />
                  <p className="text-xs font-medium">
                    {sim ? 'The simulation returned no route geometry' : 'Run the simulation to project the route'}
                  </p>
                  <p className="max-w-xs text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                    {sim
                      ? 'No coordinates have been invented to fill the map.'
                      : 'The model needs an active incident with a modeled corridor.'}
                  </p>
                </div>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-[var(--muted-foreground)]">
              Route points are the coordinates returned by the simulation endpoint. The grid is a reference
              background, not a street map.
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Gauge size={15} className="text-[var(--primary)]" />
              Simulation result
            </CardTitle>
            <CardDescription>Computed by the server for this incident.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading || simulating || !sim ? (
              <div className="space-y-3">
                <Skeleton className="h-16 rounded-lg" />
                <Skeleton className="h-16 rounded-lg" />
                <Skeleton className="h-16 rounded-lg" />
              </div>
            ) : (
              <>
                <div className="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] p-3">
                  <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Baseline ETA</p>
                  <p className="operational-number mt-1 text-xl font-semibold">{formatTime(sim.baselineETA)}</p>
                </div>
                <div className="rounded-lg border border-[color-mix(in_srgb,var(--success)_30%,var(--border))] bg-[color-mix(in_srgb,var(--success)_7%,transparent)] p-3">
                  <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Simulated ETA</p>
                  <p className="operational-number mt-1 text-xl font-semibold text-[var(--success)]">{formatTime(sim.simulatedETA)}</p>
                </div>
                <div className="rounded-lg border border-[color-mix(in_srgb,var(--primary)_30%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_6%,transparent)] p-3">
                  <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Time saved</p>
                  <p className="operational-number mt-1 text-xl font-semibold text-[var(--primary)]">{formatTime(sim.timeSaved)}</p>
                </div>
                <dl className="space-y-2 border-t border-[var(--border)] pt-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-[var(--muted-foreground)]">Signals affected</dt>
                    <dd className="font-mono font-semibold">{sim.signalsAffected}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-[var(--muted-foreground)]">Improvement</dt>
                    <dd className="font-mono font-semibold">{improvement !== null ? `${improvement}%` : '—'}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-[var(--muted-foreground)]">Route points</dt>
                    <dd className="font-mono font-semibold">{sim.route.length}</dd>
                  </div>
                </dl>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {!canControl && (
        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
          Running a simulation requires the green-corridor control permission. The modeled result remains
          readable if your role can view this workspace.
        </p>
      )}
    </div>
  );
}
