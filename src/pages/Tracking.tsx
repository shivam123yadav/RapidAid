import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { MapPin, Activity, Clock, Truck } from 'lucide-react';
import { formatTime } from '../lib/utils';
import type { Ambulance, Emergency } from '../types';

function LiveMap({ ambulances, emergencies }: { ambulances: Ambulance[]; emergencies: Emergency[] }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  useEffect(() => {
    let map: any = null;
    let mounted = true;

    async function initMap() {
      try {
        const L = await import('leaflet');
        if (!mounted || !mapRef.current) return;

        map = L.map(mapRef.current, {
          center: [28.6139, 77.2090],
          zoom: 13,
          zoomControl: false,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap',
        }).addTo(map);

        L.control.zoom({ position: 'bottomright' }).addTo(map);

        // Add ambulance markers with smooth animation
        ambulances.filter(a => a.status !== 'OFFLINE' && a.status !== 'MAINTENANCE').forEach(amb => {
          const color = amb.status === 'EN_ROUTE' || amb.status === 'TRANSPORTING' ? '#f59e0b' : '#0ea5e9';
          const icon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="background:${color};width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:3px solid white;transition:all 0.5s ease;">🚑</div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
          });
          L.marker([amb.location.lat, amb.location.lng], { icon })
            .addTo(map)
            .bindPopup(`<div style="font-size:12px;"><strong>${amb.id}</strong><br/>Status: ${amb.status}<br/>Speed: ${amb.speed} km/h${amb.eta ? '<br/>ETA: ' + formatTime(amb.eta) : ''}</div>`);
        });

        // Add emergency markers
        emergencies.filter(e => e.status !== 'COMPLETED' && e.status !== 'CANCELLED').forEach(emg => {
          const icon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="background:#dc2626;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid white;animation:pulse 2s infinite;">🚨</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          });
          L.marker([emg.location.lat, emg.location.lng], { icon })
            .addTo(map)
            .bindPopup(`<div style="font-size:12px;"><strong>${emg.id}</strong><br/>${emg.incidentType.replace(/_/g, ' ')}<br/>Priority: ${emg.priority}</div>`);
        });

        // Draw routes
        ambulances.filter(a => a.currentEmergency && (a.status === 'EN_ROUTE' || a.status === 'TRANSPORTING')).forEach(amb => {
          const emg = emergencies.find(e => e.id === amb.currentEmergency);
          if (emg) {
            L.polyline(
              [[amb.location.lat, amb.location.lng], [emg.location.lat, emg.location.lng]],
              { color: '#0ea5e9', weight: 3, dashArray: '10, 10', opacity: 0.8 }
            ).addTo(map);
          }
        });

        if (mounted) setMapLoaded(true);
      } catch (err) {
        console.error('Map error:', err);
      }
    }

    initMap();
    return () => { mounted = false; if (map) map.remove(); };
  }, [ambulances, emergencies]);

  return (
    <div className="relative h-[400px] lg:h-[500px] rounded-xl overflow-hidden border border-[var(--border)]">
      <div ref={mapRef} className="h-full w-full" />
      {!mapLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--muted)]">
          <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
            Loading map...
          </div>
        </div>
      )}
    </div>
  );
}

export function TrackingPage() {
  const { data: ambulances, isLoading: loadingAmb } = useQuery({
    queryKey: ['ambulances'],
    queryFn: api.ambulances.list,
    refetchInterval: 5000,
  });

  const { data: emergencies, isLoading: loadingEmg } = useQuery({
    queryKey: ['emergencies'],
    queryFn: api.emergencies.list,
    refetchInterval: 5000,
  });

  const activeAmbulances = (ambulances || []).filter((a: Ambulance) => 
    a.status === 'EN_ROUTE' || a.status === 'TRANSPORTING' || a.status === 'AT_SCENE'
  );

  if (loadingAmb || loadingEmg) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-[500px] rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <MapPin size={24} className="text-[var(--primary)]" />
          Live Tracking
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">Real-time ambulance locations and emergency response tracking</p>
      </div>

      <LiveMap ambulances={ambulances || []} emergencies={emergencies || []} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {activeAmbulances.map((amb: Ambulance) => (
          <Card key={amb.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Truck size={14} />
                  {amb.id}
                </CardTitle>
                <Badge variant={amb.status === 'EN_ROUTE' ? 'warning' : 'info'} className="text-[10px]">
                  {amb.status.replace(/_/g, ' ')}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1 text-[var(--muted-foreground)]">
                  <Activity size={10} /> Speed
                </span>
                <span className="font-mono">{amb.speed} km/h</span>
              </div>
              {amb.eta && (
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1 text-[var(--muted-foreground)]">
                    <Clock size={10} /> ETA
                  </span>
                  <span className="font-mono">{formatTime(amb.eta)}</span>
                </div>
              )}
              {amb.currentEmergency && (
                <div className="pt-2 border-t border-[var(--border)]">
                  <p className="text-xs text-[var(--muted-foreground)]">Emergency</p>
                  <p className="font-mono text-sm font-medium">{amb.currentEmergency}</p>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
