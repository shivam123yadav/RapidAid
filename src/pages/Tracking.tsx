import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { MapPin, Truck, Clock, Activity } from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import type { Ambulance, Emergency } from '../types';

const DELHI_CENTER: [number, number] = [28.6139, 77.2090];

function createIcon(color: string, emoji: string) {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background:${color};width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid white;">${emoji}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

const ambulanceIcon = createIcon('#0ea5e9', '🚑');
const emergencyIcon = createIcon('#dc2626', '🚨');

export function TrackingPage() {
  const { data: ambulances, isLoading: loadingAmbulances } = useQuery({
    queryKey: ['ambulances'],
    queryFn: api.ambulances.list,
    refetchInterval: 5000,
  });

  const { data: emergencies } = useQuery({
    queryKey: ['emergencies'],
    queryFn: api.emergencies.list,
  });

  const activeAmbulances = (ambulances || []).filter((a: Ambulance) => 
    a.status !== 'OFFLINE' && a.status !== 'MAINTENANCE' && a.currentEmergency
  );

  if (loadingAmbulances) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[500px] rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <MapPin size={24} className="text-[var(--primary)]" />
          Live Ambulance Tracking
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">Real-time ambulance locations and routes</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardContent className="p-0">
            <div className="h-[500px]">
              <MapContainer
                center={DELHI_CENTER}
                zoom={13}
                className="h-full w-full"
                zoomControl={false}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {activeAmbulances.map((amb: Ambulance) => (
                  <Marker key={amb.id} position={[amb.location.lat, amb.location.lng]} icon={ambulanceIcon}>
                    <Popup>
                      <div style={{ fontSize: '12px' }}>
                        <strong>{amb.id}</strong><br />
                        Status: {amb.status}<br />
                        Speed: {amb.speed} km/h
                      </div>
                    </Popup>
                  </Marker>
                ))}
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
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Truck size={16} />
                Active Ambulances
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {activeAmbulances.length === 0 ? (
                <p className="text-sm text-[var(--muted-foreground)]">No active ambulances</p>
              ) : (
                activeAmbulances.map((amb: Ambulance) => (
                  <div key={amb.id} className="rounded-lg border border-[var(--border)] p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono font-bold text-sm">{amb.id}</span>
                      <Badge variant="info" className="text-[10px]">{amb.status.replace(/_/g, ' ')}</Badge>
                    </div>
                    <div className="space-y-1 text-xs">
                      <div className="flex items-center gap-1 text-[var(--muted-foreground)]">
                        <Activity size={10} />
                        <span>Speed: {amb.speed} km/h</span>
                      </div>
                      {amb.eta && (
                        <div className="flex items-center gap-1 text-[var(--muted-foreground)]">
                          <Clock size={10} />
                          <span>ETA: {Math.floor(amb.eta / 60)}:{(amb.eta % 60).toString().padStart(2, '0')}</span>
                        </div>
                      )}
                      {amb.currentEmergency && (
                        <div className="pt-1 border-t border-[var(--border)]">
                          <span className="text-[var(--muted-foreground)]">Emergency: </span>
                          <span className="font-mono">{amb.currentEmergency}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
