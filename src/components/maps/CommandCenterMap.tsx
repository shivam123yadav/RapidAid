import { useEffect, useRef, useState } from 'react';
import type { Emergency, Ambulance, Hospital } from '../../types';

interface CommandCenterMapProps {
  emergencies: Emergency[];
  ambulances: Ambulance[];
  hospitals: Hospital[];
}

export function CommandCenterMap({ emergencies, ambulances, hospitals }: CommandCenterMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let map: any = null;
    let mounted = true;

    async function initMap() {
      try {
        const L = await import('leaflet');
        
        if (!mounted || !mapRef.current) return;

        // Fix default icon
        delete (L.Icon.Default.prototype as any)._getIconUrl;
        L.Icon.Default.mergeOptions({
          iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
          iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
          shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
        });

        map = L.map(mapRef.current, {
          center: [28.6139, 77.2090],
          zoom: 13,
          zoomControl: false,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap',
        }).addTo(map);

        L.control.zoom({ position: 'bottomright' }).addTo(map);

        // Add emergency markers
        emergencies.forEach(emg => {
          const icon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="background:#dc2626;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid white;">🚨</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          });
          L.marker([emg.location.lat, emg.location.lng], { icon })
            .addTo(map)
            .bindPopup(`<div style="font-size:12px;"><strong>${emg.id}</strong><br/>${emg.incidentType.replace(/_/g, ' ')}<br/>Priority: ${emg.priority}<br/>Victims: ${emg.victimCount}</div>`);
        });

        // Add ambulance markers
        ambulances.filter(a => a.status !== 'OFFLINE' && a.status !== 'MAINTENANCE').forEach(amb => {
          const icon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="background:#0ea5e9;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid white;">🚑</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          });
          L.marker([amb.location.lat, amb.location.lng], { icon })
            .addTo(map)
            .bindPopup(`<div style="font-size:12px;"><strong>${amb.id}</strong><br/>Status: ${amb.status}<br/>Speed: ${amb.speed} km/h</div>`);
        });

        // Add hospital markers
        hospitals.forEach(hosp => {
          const icon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="background:#16a34a;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid white;">🏥</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          });
          L.marker([hosp.location.lat, hosp.location.lng], { icon })
            .addTo(map)
            .bindPopup(`<div style="font-size:12px;"><strong>${hosp.name}</strong><br/>Load: ${hosp.currentLoad}%<br/>Trauma: ${hosp.traumaAvailable ? 'Yes' : 'No'}</div>`);
        });

        // Draw routes for en-route ambulances
        ambulances.filter(a => a.currentEmergency && a.status === 'EN_ROUTE').forEach(amb => {
          const emg = emergencies.find(e => e.id === amb.currentEmergency);
          if (emg) {
            L.polyline(
              [[amb.location.lat, amb.location.lng], [emg.location.lat, emg.location.lng]],
              { color: '#0ea5e9', weight: 3, dashArray: '10, 10' }
            ).addTo(map);
          }
        });

        if (mounted) setMapLoaded(true);
      } catch (err) {
        console.error('Map initialization error:', err);
        if (mounted) setError('Failed to load map');
      }
    }

    initMap();

    return () => {
      mounted = false;
      if (map) {
        map.remove();
      }
    };
  }, [emergencies, ambulances, hospitals]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--muted)]">
        <div className="text-center space-y-2">
          <p className="text-sm text-[var(--muted-foreground)]">{error}</p>
          <p className="text-xs text-[var(--muted-foreground)]">Map visualization unavailable</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full rounded-xl overflow-hidden border border-[var(--border)]">
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
