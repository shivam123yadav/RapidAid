import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Emergency, Ambulance, Hospital } from '../../types/index';

const DELHI_CENTER: [number, number] = [28.6139, 77.2090];

function createIcon(color: string, emoji: string) {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background:${color};width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid white;">${emoji}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

const emergencyIcon = createIcon('#dc2626', '🚨');
const ambulanceIcon = createIcon('#0ea5e9', '🚑');
const hospitalIcon = createIcon('#16a34a', '🏥');

interface CommandCenterMapProps {
  emergencies: Emergency[];
  ambulances: Ambulance[];
  hospitals: Hospital[];
}

export function CommandCenterMap({ emergencies, ambulances, hospitals }: CommandCenterMapProps) {
  return (
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
      {emergencies.map((emg) => (
        <Marker key={emg.id} position={[emg.location.lat, emg.location.lng]} icon={emergencyIcon}>
          <Popup>
            <div className="text-xs">
              <strong>{emg.id}</strong><br />
              {emg.incidentType.replace(/_/g, ' ')}<br />
              Priority: {emg.priority}<br />
              Victims: {emg.victimCount}
            </div>
          </Popup>
        </Marker>
      ))}
      {ambulances.filter(a => a.status !== 'OFFLINE' && a.status !== 'MAINTENANCE').map((amb) => (
        <Marker key={amb.id} position={[amb.location.lat, amb.location.lng]} icon={ambulanceIcon}>
          <Popup>
            <div className="text-xs">
              <strong>{amb.id}</strong><br />
              Status: {amb.status}<br />
              Speed: {amb.speed} km/h
            </div>
          </Popup>
        </Marker>
      ))}
      {hospitals.map((hosp) => (
        <Marker key={hosp.id} position={[hosp.location.lat, hosp.location.lng]} icon={hospitalIcon}>
          <Popup>
            <div className="text-xs">
              <strong>{hosp.name}</strong><br />
              Load: {hosp.currentLoad}%<br />
              Trauma: {hosp.traumaAvailable ? 'Yes' : 'No'}
            </div>
          </Popup>
        </Marker>
      ))}
      {/* Show route for active emergency */}
      {ambulances.filter(a => a.currentEmergency && a.status === 'EN_ROUTE').map(amb => {
        const emg = emergencies.find(e => e.id === amb.currentEmergency);
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
  );
}
