import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Truck, MapPin, Users, Activity, Clock, Zap } from 'lucide-react';
import type { Ambulance, AmbulanceStatus } from '../types';

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

export function AmbulancesPage() {
  const { data: ambulances, isLoading } = useQuery({
    queryKey: ['ambulances'],
    queryFn: api.ambulances.list,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-48 rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Ambulance Fleet</h2>
        <p className="text-sm text-[var(--muted-foreground)]">Real-time ambulance status and crew information</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {(ambulances || []).map((amb: Ambulance) => (
          <Card key={amb.id} className="hover:shadow-md transition-shadow">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Truck size={16} />
                  {amb.id}
                </CardTitle>
                <Badge variant={statusVariant(amb.status)}>{amb.status.replace(/_/g, ' ')}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-1.5 text-[var(--muted-foreground)]">
                  <MapPin size={12} />
                  <span>{amb.location.lat.toFixed(4)}, {amb.location.lng.toFixed(4)}</span>
                </div>
                <div className="flex items-center gap-1.5 text-[var(--muted-foreground)]">
                  <Activity size={12} />
                  <span>{amb.speed} km/h</span>
                </div>
              </div>

              {amb.currentEmergency && (
                <div className="rounded-lg bg-[var(--muted)] p-2">
                  <p className="text-xs text-[var(--muted-foreground)]">Assigned Emergency</p>
                  <p className="font-mono font-medium">{amb.currentEmergency}</p>
                  {amb.eta && <p className="text-xs text-[var(--muted-foreground)]">ETA: {Math.floor(amb.eta / 60)}:{(amb.eta % 60).toString().padStart(2, '0')}</p>}
                </div>
              )}

              <div>
                <p className="text-xs text-[var(--muted-foreground)] mb-1 flex items-center gap-1"><Users size={10} /> Crew</p>
                <div className="flex flex-wrap gap-1">
                  {amb.crew.map(c => (
                    <span key={c.id} className="text-xs bg-[var(--surface)] px-2 py-0.5 rounded-full">{c.name}</span>
                  ))}
                  {amb.crew.length === 0 && <span className="text-xs text-[var(--muted-foreground)]">No crew assigned</span>}
                </div>
              </div>

              <div>
                <p className="text-xs text-[var(--muted-foreground)] mb-1 flex items-center gap-1"><Zap size={10} /> Capabilities</p>
                <div className="flex flex-wrap gap-1">
                  {amb.capabilities.map(cap => (
                    <span key={cap} className="text-xs bg-[var(--primary)]/10 text-[var(--primary)] px-2 py-0.5 rounded-full">{cap}</span>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
