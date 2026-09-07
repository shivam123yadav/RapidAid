import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { formatTime } from '../lib/utils';
import { Siren, Truck, Building2, Clock, AlertTriangle, Activity, MapPin } from 'lucide-react';
import { CommandCenterMap } from '../components/maps/CommandCenterMap';
import type { Emergency, EmergencyPriority, Ambulance, Hospital } from '../types';

function MetricCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string | number; accent?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${accent || 'bg-[var(--muted)]'}`}>
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-[var(--muted-foreground)]">{label}</p>
      </div>
    </div>
  );
}

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
  const variant = status === 'COMPLETED' ? 'success' : status === 'CRITICAL' ? 'critical' : 'outline';
  return <Badge variant={variant as any}>{status.replace(/_/g, ' ')}</Badge>;
}

export function CommandCenterPage() {
  const { data: emergencies, isLoading: loadingEmergencies } = useQuery({
    queryKey: ['emergencies'],
    queryFn: api.emergencies.list,
    refetchInterval: 10000,
  });

  const { data: ambulances, isLoading: loadingAmbulances } = useQuery({
    queryKey: ['ambulances'],
    queryFn: api.ambulances.list,
    refetchInterval: 10000,
  });

  const { data: hospitals } = useQuery({
    queryKey: ['hospitals'],
    queryFn: api.hospitals.list,
  });

  const activeEmergencies: Emergency[] = (emergencies || []).filter((e: Emergency) => e.status !== 'COMPLETED' && e.status !== 'CANCELLED');
  const criticalEmergencies = activeEmergencies.filter((e: Emergency) => e.priority === 'CRITICAL');
  const availableAmbulances = ((ambulances || []) as Ambulance[]).filter((a: Ambulance) => a.status === 'AVAILABLE');
  const activeAmbulances = ((ambulances || []) as Ambulance[]).filter((a: Ambulance) => a.status !== 'AVAILABLE' && a.status !== 'MAINTENANCE' && a.status !== 'OFFLINE');
  const priorityOrder: Record<EmergencyPriority, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const mostCritical = [...activeEmergencies].sort((a: Emergency, b: Emergency) => priorityOrder[a.priority] - priorityOrder[b.priority])[0];

  if (loadingEmergencies || loadingAmbulances) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-[500px] lg:col-span-2 rounded-xl" />
          <Skeleton className="h-[500px] rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Activity size={24} className="text-[var(--primary)]" />
            Live Emergency Command Center
          </h2>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">Real-time emergency operations overview</p>
        </div>
        <Badge variant="outline" className="gap-1.5">
          <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
          System Operational
        </Badge>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <MetricCard
          icon={<Siren size={20} className="text-[var(--destructive)]" />}
          label="Active Emergencies"
          value={activeEmergencies.length}
          accent="bg-red-500/10"
        />
        <MetricCard
          icon={<AlertTriangle size={20} className="text-[var(--destructive)]" />}
          label="Critical"
          value={criticalEmergencies.length}
          accent="bg-red-500/10"
        />
        <MetricCard
          icon={<Truck size={20} className="text-[var(--success)]" />}
          label="Available Ambulances"
          value={availableAmbulances.length}
          accent="bg-green-500/10"
        />
        <MetricCard
          icon={<Truck size={20} className="text-[var(--primary)]" />}
          label="Active Ambulances"
          value={activeAmbulances.length}
          accent="bg-blue-500/10"
        />
        <MetricCard
          icon={<Building2 size={20} className="text-[var(--info)]" />}
          label="Hospitals Available"
          value={hospitals?.length || 0}
          accent="bg-cyan-500/10"
        />
        <MetricCard
          icon={<Clock size={20} className="text-[var(--warning)]" />}
          label="Avg Response Time"
          value="7:12"
          accent="bg-amber-500/10"
        />
      </div>

      {/* Main Area */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Map */}
        <div className="lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <MapPin size={16} />
                Operations Map
                <span className="text-xs font-normal text-[var(--muted-foreground)]">— DEMO DATA</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="h-[450px]">
                <CommandCenterMap
                  emergencies={activeEmergencies}
                  ambulances={(ambulances || []) as Ambulance[]}
                  hospitals={(hospitals || []) as Hospital[]}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Critical Incident Panel */}
        <div className="space-y-4">
          {mostCritical && (
            <Card className="border-[var(--destructive)]/30 bg-[var(--card)]">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm text-[var(--destructive)] flex items-center gap-2">
                    <AlertTriangle size={16} className="animate-pulse" />
                    CRITICAL INCIDENT
                  </CardTitle>
                  <PriorityBadge priority={mostCritical.priority} />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Emergency ID</span>
                    <span className="font-mono font-medium">{mostCritical.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Type</span>
                    <span>{mostCritical.incidentType.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Location</span>
                    <span className="text-right max-w-[60%] truncate">{mostCritical.location.address}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Victims</span>
                    <span className="font-medium">{mostCritical.victimCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Assigned</span>
                    <span className="font-mono">{mostCritical.assignedAmbulance || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">ETA</span>
                    <span className="font-mono">{mostCritical.eta ? formatTime(mostCritical.eta) : '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Hospital</span>
                    <span className="text-right max-w-[60%] truncate">{mostCritical.destinationHospital || '—'}</span>
                  </div>
                </div>
                <div className="pt-2 border-t border-[var(--border)]">
                  <StatusBadge status={mostCritical.status} />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Active Incidents List */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Active Incidents ({activeEmergencies.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {activeEmergencies.map((emg) => (
                <div key={emg.id} className="flex items-center gap-3 rounded-lg border border-[var(--border)] p-2.5 hover:bg-[var(--muted)] transition-colors cursor-pointer">
                  <div className={`h-2 w-2 rounded-full ${emg.priority === 'CRITICAL' ? 'bg-red-500 animate-pulse' : emg.priority === 'HIGH' ? 'bg-orange-500' : 'bg-amber-500'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{emg.id}</p>
                    <p className="text-xs text-[var(--muted-foreground)] truncate">{emg.incidentType.replace(/_/g, ' ')}</p>
                  </div>
                  <span className="text-xs text-[var(--muted-foreground)]">{emg.status.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Recent Timeline */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Recent Events</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {activeEmergencies.slice(0, 4).flatMap(emg => emg.timeline.slice(-1).map(t => ({
                ...t,
                emergencyId: emg.id,
              }))).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).map((event, i) => (
                <div key={i} className="flex items-start gap-3 text-xs">
                  <span className="text-[var(--muted-foreground)] font-mono mt-0.5">
                    {new Date(event.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <div className="flex-1">
                    <span className="font-medium">{event.emergencyId}</span>
                    <span className="text-[var(--muted-foreground)]"> — {event.status.replace(/_/g, ' ')}</span>
                    {event.note && <p className="text-[var(--muted-foreground)] mt-0.5">{event.note}</p>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
