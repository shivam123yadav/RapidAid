import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Building2, Heart, Brain, Activity, Phone, Truck } from 'lucide-react';
import type { Hospital, CapacityStatus } from '../types';

const capacityVariant = (c: CapacityStatus) => {
  const map: Record<CapacityStatus, 'success' | 'warning' | 'destructive'> = { AVAILABLE: 'success', LIMITED: 'warning', FULL: 'destructive' };
  return map[c];
};

export function HospitalsPage() {
  const { data: hospitals, isLoading } = useQuery({
    queryKey: ['hospitals'],
    queryFn: api.hospitals.list,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-56 rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Hospital Network</h2>
        <p className="text-sm text-[var(--muted-foreground)]">Hospital capacity and availability status</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(hospitals || []).map((hosp: Hospital) => (
          <Card key={hosp.id} className="hover:shadow-md transition-shadow">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Building2 size={16} />
                  {hosp.name}
                </CardTitle>
                <Badge variant={hosp.status === 'OPERATIONAL' ? 'success' : 'destructive'}>
                  {hosp.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-[var(--muted-foreground)]">Emergency Dept</p>
                  <Badge variant={capacityVariant(hosp.emergencyCapacity)} className="mt-1">{hosp.emergencyCapacity}</Badge>
                </div>
                <div>
                  <p className="text-xs text-[var(--muted-foreground)]">ICU</p>
                  <Badge variant={capacityVariant(hosp.icuCapacity)} className="mt-1">{hosp.icuCapacity}</Badge>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <Heart size={14} className={hosp.traumaAvailable ? 'text-[var(--success)]' : 'text-[var(--muted-foreground)]'} />
                  <span className="text-xs">Trauma: {hosp.traumaAvailable ? 'Available' : 'Unavailable'}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Truck size={14} className="text-[var(--info)]" />
                  <span className="text-xs">Incoming: {hosp.incomingAmbulances}</span>
                </div>
              </div>

              <div>
                <p className="text-xs text-[var(--muted-foreground)] mb-1">Current Load</p>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 rounded-full bg-[var(--muted)] overflow-hidden">
                    <div
                      className={`h-full rounded-full ${hosp.currentLoad > 80 ? 'bg-[var(--destructive)]' : hosp.currentLoad > 60 ? 'bg-[var(--warning)]' : 'bg-[var(--success)]'}`}
                      style={{ width: `${hosp.currentLoad}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono">{hosp.currentLoad}%</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-1">
                {hosp.capabilities.map(cap => (
                  <span key={cap} className="text-xs bg-[var(--primary)]/10 text-[var(--primary)] px-2 py-0.5 rounded-full">{cap}</span>
                ))}
              </div>

              <div className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                <Phone size={12} />
                {hosp.phone}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
