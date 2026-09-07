import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { MapPin, Truck, Clock, Activity } from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import type { Ambulance, Emergency } from '../types';

function createIcon(color: string, emoji: string) {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background:${color};width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid white;">${emoji}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

export function TrackingPage() {
  const { data: ambulances, isLoading } = useQuery({
    queryKey: ['ambulances'],
    queryFn: api.ambulances.list,
  });

  const { data: emergencies } = useQuery({
    queryKey: ['emergencies'],
    queryFn: api.emergencies.list,
  });

  if (isLoading) return <Skeleton className="h-[500px] rounded-xl" />;

  const activeAmbulances = (ambulances || []).filter((a: Ambulance) => a.status === 'EN_ROUTE' || a.status === 'TRANSPORTING');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <MapPin size={24} className="text-[var(--primary)]" />
          Live Ambulance Tracking
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">Real-time ambulance positions and movement</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 overflow-hidden">
          <CardContent className="p-0 h-[500px]">
            <MapContainer center={[28.6139, 77.2090]} zoom={13} className="h-full w-full" zoomControl={false}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              {(ambulances || []).filter((a: Ambulance) => a.status !== 'OFFLINE' && a.status !== 'MAINTENANCE').map((amb: Ambulance) => (
                <Marker key={amb.id} position={[amb.location.lat, amb.location.lng]} icon={createIcon('#0ea5e9', '🚑')}>
                  <Popup>
                    <div className="text-xs">
                      <strong>{amb.id}</strong><br />
                      Status: {amb.status}<br />
                      Speed: {amb.speed} km/h<br />
                      Heading: {amb.heading}°
                    </div>
                  </Popup>
                </Marker>
              ))}
              {/* Routes for active ambulances */}
              {activeAmbulances.map((amb: Ambulance) => {
                const emg = (emergencies || []).find((e: Emergency) => e.id === amb.currentEmergency);
                if (!emg) return null;
                return (
                  <Polyline
                    key={`route-${amb.id}`}
                    positions={[[amb.location.lat, amb.location.lng], [emg.location.lat, emg.location.lng]]}
                    pathOptions={{ color: '#0ea5e9', weight: 3, dashArray: '10, 10' }}
                  />
                );
              })}
            </MapContainer>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Active Transports</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {activeAmbulances.map((amb: Ambulance) => (
                <div key={amb.id} className="rounded-lg border border-[var(--border)] p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono font-bold text-sm">{amb.id}</span>
                    <Badge variant="info">{amb.status.replace(/_/g, ' ')}</Badge>
                  </div>
                  <div className="space-y-1 text-xs text-[var(--muted-foreground)]">
                    <div className="flex items-center gap-1"><Activity size={10} /> Speed: {amb.speed} km/h</div>
                    <div className="flex items-center gap-1"><Clock size={10} /> ETA: {amb.eta ? `${Math.floor(amb.eta / 60)}:${(amb.eta % 60).toString().padStart(2, '0')}` : '—'}</div>
                    <div className="flex items-center gap-1"><MapPin size={10} /> Emergency: {amb.currentEmergency || '—'}</div>
                  </div>
                </div>
              ))}
              {activeAmbulances.length === 0 && (
                <p className="text-sm text-[var(--muted-foreground)] text-center py-4">No active transports</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
