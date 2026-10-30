import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { useReducedMotion } from 'framer-motion';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import { Link } from 'react-router-dom';
import L from 'leaflet';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can } from '../lib/permissions';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { EmptyState } from '../components/ui/empty-state';
import { Button } from '../components/ui/button';
import { MapPin, Truck, Clock, Activity, Navigation, RefreshCw, Crosshair, Building2 } from 'lucide-react';
import type { Ambulance, Emergency } from '../types';

const DELHI_CENTER: [number, number] = [28.6139, 77.2090];

export function createIcon(
  variant: 'ambulance' | 'emergency' | 'critical' | 'hospital',
  options?: { isStale?: boolean; isSimulated?: boolean },
) {
  let glyph = '';
  if (variant === 'ambulance') {
    glyph =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11v8H3z"/><path d="M14 10h4l3 3v2h-7z"/><circle cx="7" cy="17" r="2"/><circle cx="18" cy="17" r="2"/></svg>';
  } else if (variant === 'hospital') {
    glyph =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>';
  } else {
    glyph =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4"/><path d="M12 16.5h.01"/></svg>';
  }

  const tone =
    variant === 'ambulance'
      ? options?.isStale
        ? 'ambulance map-marker--ambulance-stale'
        : 'ambulance'
      : variant === 'critical'
        ? 'emergency critical'
        : variant;

  const simClass = options?.isSimulated ? ' map-marker--simulated' : '';
  const ring =
    variant === 'critical' || (variant === 'ambulance' && !options?.isStale)
      ? '<span class="map-marker__ring"></span>'
      : '';

  return L.divIcon({
    className: 'custom-marker',
    html: `<div class="map-marker map-marker--${tone.replace(' ', ' map-marker--')}${simClass}">${glyph}${ring}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

export function getTelemetryFreshness(lastUpdated?: string | Date | null) {
  if (!lastUpdated) return { isStale: true, isAging: false, isFresh: false, ageSeconds: null, label: 'No signal' };
  const date = new Date(lastUpdated);
  if (Number.isNaN(date.getTime())) return { isStale: true, isAging: false, isFresh: false, ageSeconds: null, label: 'Invalid' };
  const ageSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (ageSeconds > 300) {
    return { isStale: true, isAging: false, isFresh: false, ageSeconds, label: `${Math.floor(ageSeconds / 60)}m ago (Stale)` };
  }
  if (ageSeconds > 60) {
    return { isStale: false, isAging: true, isFresh: false, ageSeconds, label: `${ageSeconds}s ago (Delayed)` };
  }
  return { isStale: false, isAging: false, isFresh: true, ageSeconds, label: `${ageSeconds}s ago (Live)` };
}

const ambulanceIcon = createIcon('ambulance');
const emergencyIcon = createIcon('emergency');
const criticalEmergencyIcon = createIcon('critical');
const hospitalIcon = createIcon('hospital');

function MapFocus({ target }: { target: [number, number] | null }) {
  const map = useMap();
  const reduce = useReducedMotion() ?? false;
  useEffect(() => {
    if (!target) return;
    map.flyTo(target, Math.max(map.getZoom(), 14), { animate: !reduce, duration: 0.8 });
  }, [map, reduce, target]);
  return null;
}

export function isValidCoordinate(
  location: unknown,
): location is { lat: number; lng: number; address?: string } {
  if (!location || typeof location !== 'object') return false;
  const loc = location as { lat?: unknown; lng?: unknown };
  const lat = typeof loc.lat === 'number' ? loc.lat : typeof loc.lat === 'string' && loc.lat.trim() !== '' ? Number(loc.lat) : NaN;
  const lng = typeof loc.lng === 'number' ? loc.lng : typeof loc.lng === 'string' && loc.lng.trim() !== '' ? Number(loc.lng) : NaN;
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function computeEmergencyDisplayPositions(
  emergencies: Emergency[],
): Map<string, [number, number]> {
  const plottable = emergencies.filter((e) => isValidCoordinate(e.location));
  const coordGroups = new Map<string, Emergency[]>();

  for (const emg of plottable) {
    const key = `${emg.location.lat.toFixed(5)},${emg.location.lng.toFixed(5)}`;
    const group = coordGroups.get(key) || [];
    group.push(emg);
    coordGroups.set(key, group);
  }

  const positions = new Map<string, [number, number]>();

  for (const group of coordGroups.values()) {
    if (group.length === 1) {
      const emg = group[0];
      positions.set(emg.id, [emg.location.lat, emg.location.lng]);
    } else {
      const count = group.length;
      const baseLat = group[0].location.lat;
      const baseLng = group[0].location.lng;
      const latRad = (baseLat * Math.PI) / 180;
      const radiusMeters = 35;
      const latMetersPerDegree = 111320;
      const lngMetersPerDegree = 111320 * Math.cos(latRad);

      group.forEach((emg, index) => {
        const angle = (2 * Math.PI * index) / count - Math.PI / 2;
        const latOffset = (radiusMeters * Math.sin(angle)) / latMetersPerDegree;
        const lngOffset = (radiusMeters * Math.cos(angle)) / lngMetersPerDegree;
        positions.set(emg.id, [baseLat + latOffset, baseLng + lngOffset]);
      });
    }
  }

  return positions;
}

export function TrackingPage() {
  const user = useAuthStore((state) => state.user);
  const reduce = useReducedMotion() ?? false;
  const [selectedAmbulanceId, setSelectedAmbulanceId] = useState<string | null>(null);
  const [selectedEmergencyId, setSelectedEmergencyId] = useState<string | null>(null);
  const canReadFleet = ['ambulance:read:all', 'ambulance:read:own', 'ambulance:read:incoming', 'ambulance:read:historical']
    .some((permission) => can(user?.role, permission as Parameters<typeof can>[1], user?.permissions));
  const canTrackOwn = can(user?.role, 'tracking:read:own', user?.permissions) || can(user?.role, 'tracking:view:own', user?.permissions) || user?.role === 'CITIZEN';

  const ambulancesQuery = useQuery({
    queryKey: ['ambulances'],
    queryFn: api.ambulances.list,
    refetchInterval: 5000,
    enabled: canReadFleet || canTrackOwn,
  });
  const emergenciesQuery = useQuery({
    queryKey: ['emergencies'],
    queryFn: api.emergencies.list,
    refetchInterval: 5000,
  });
  const hospitalsQuery = useQuery({
    queryKey: ['hospitals'],
    queryFn: api.hospitals.list,
    refetchInterval: 15000,
  });

  const ambulances = ambulancesQuery.data;
  const emergencies = emergenciesQuery.data;
  const hospitals = hospitalsQuery.data;
  const plottableEmergencies = (emergencies || []).filter((e: Emergency) => isValidCoordinate(e.location));
  const plottableHospitals = (hospitals || []).filter((h: any) => isValidCoordinate(h.location));
  const emergencyDisplayPositions = computeEmergencyDisplayPositions(emergencies || []);

  const activeAmbulances = (ambulances || []).filter(
    (a: Ambulance) => a.status !== 'OFFLINE' && a.status !== 'MAINTENANCE' && a.currentEmergency,
  );
  const plottableAmbulances = activeAmbulances.filter((a: Ambulance) => isValidCoordinate(a.location));
  const selectedAmbulance = activeAmbulances.find((ambulance) => ambulance.id === selectedAmbulanceId);
  const selectedEmergency = selectedAmbulance
    ? (emergencies || []).find((emergency: Emergency) => emergency.id === selectedAmbulance.currentEmergency)
    : selectedEmergencyId
      ? (emergencies || []).find((emergency: Emergency) => emergency.id === selectedEmergencyId)
      : !canReadFleet && (emergencies || []).length > 0
        ? (emergencies || []).find((e: Emergency) => e.status !== 'COMPLETED' && e.status !== 'CANCELLED') || (emergencies || [])[0]
        : undefined;

  const target: [number, number] | null = selectedAmbulance && isValidCoordinate(selectedAmbulance.location)
    ? [selectedAmbulance.location.lat, selectedAmbulance.location.lng]
    : !canReadFleet && selectedEmergency && isValidCoordinate(selectedEmergency.location)
      ? (emergencyDisplayPositions.get(selectedEmergency.id) ?? [selectedEmergency.location.lat, selectedEmergency.location.lng])
      : plottableAmbulances.length > 0 && isValidCoordinate(plottableAmbulances[0].location)
        ? [plottableAmbulances[0].location.lat, plottableAmbulances[0].location.lng]
        : plottableEmergencies.length > 0
          ? (emergencyDisplayPositions.get(plottableEmergencies[0].id) ?? [plottableEmergencies[0].location.lat, plottableEmergencies[0].location.lng])
          : null;
  const loading = (ambulancesQuery.isLoading && (canReadFleet || canTrackOwn)) || emergenciesQuery.isLoading;
  const hasError = ambulancesQuery.isError || emergenciesQuery.isError;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-64" />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-[520px] rounded-xl lg:col-span-2" />
          <Skeleton className="h-[520px] rounded-xl" />
        </div>
      </div>
    );
  }

  const refresh = () => {
    void ambulancesQuery.refetch();
    void emergenciesQuery.refetch();
    void hospitalsQuery.refetch();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations / live map"
        title={canReadFleet ? 'Live ambulance tracking' : 'My emergency tracking'}
        description={canReadFleet
          ? 'Vehicle positions, active assignments and incident locations from the existing tracking API.'
          : 'Locations and status for emergencies you reported.'}
        icon={<MapPin size={21} />}
        status={
          <Badge variant={hasError ? 'warning' : 'outline'} className="gap-1.5">
            <span className={hasError ? 'status-dot text-[var(--warning)]' : 'status-dot status-dot--live text-[var(--success)]'} aria-hidden="true" />
            {hasError ? 'Stale data' : canReadFleet ? 'Auto-refresh 5s' : 'Scoped view'}
          </Badge>
        }
        actions={
          <Button variant="outline" size="sm" onClick={refresh} className="gap-1.5">
            <RefreshCw size={13} />
            Refresh map
          </Button>
        }
      />

      {hasError && (
        <div role="alert" className="rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 text-sm">
          <p className="font-medium">Live data is temporarily unavailable</p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            The last known positions remain on the map where available. Coordinates are never generated locally.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Navigation size={15} className="text-[var(--primary)]" />
                {canReadFleet ? 'Fleet map' : 'Incident map'}
              </CardTitle>
              <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
                {activeAmbulances.length} active unit{activeAmbulances.length === 1 ? '' : 's'} · {emergencies?.length || 0} incident{(emergencies?.length || 0) === 1 ? '' : 's'}
              </p>
            </div>
            <div className="hidden items-center gap-3 text-[9px] text-[var(--muted-foreground)] sm:flex">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#0ea5e9]" /> Ambulance</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#dc2626]" /> Incident</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#16a34a]" /> Hospital</span>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="h-[540px] border-t border-[var(--border)]">
              <MapContainer
                center={DELHI_CENTER}
                zoom={13}
                className="h-full w-full"
                zoomControl
                scrollWheelZoom
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <MapFocus target={target} />
                {plottableAmbulances.map((amb: Ambulance) => {
                  const freshness = getTelemetryFreshness(amb.lastUpdated);
                  const isSim = Boolean(amb.isSimulated || amb.telemetrySource === 'SIMULATED');
                  const markerIcon = createIcon('ambulance', { isStale: freshness.isStale, isSimulated: isSim });
                  return (
                    <Marker key={amb.id} position={[amb.location.lat, amb.location.lng]} icon={markerIcon}>
                      <Popup>
                        <div className="space-y-1.5 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-mono font-semibold">{amb.id}</p>
                            {isSim ? (
                              <Badge variant="info" className="text-[8px] bg-blue-500/15 border-blue-500/30 text-blue-400 font-mono">SIMULATED</Badge>
                            ) : (
                              <Badge variant="outline" className="text-[8px] font-mono">HARDWARE GPS</Badge>
                            )}
                          </div>
                          <p>Status: {amb.status.replace(/_/g, ' ')}</p>
                          <p>Speed: {amb.speed} km/h</p>
                          {amb.heading !== undefined && <p>Heading: {amb.heading}°</p>}
                          {amb.currentEmergency && <p>Emergency: {amb.currentEmergency}</p>}
                          <div className="border-t border-[var(--border)] pt-1 text-[10px] flex items-center justify-between">
                            <span className="text-[var(--muted-foreground)]">Signal:</span>
                            <span className={freshness.isStale ? 'text-red-500 font-semibold' : freshness.isAging ? 'text-amber-500 font-semibold' : 'text-emerald-500 font-semibold'}>
                              {freshness.label}
                            </span>
                          </div>
                        </div>
                      </Popup>
                    </Marker>
                  );
                })}
                {plottableAmbulances.map((amb: Ambulance) => {
                  const emgPos = amb.currentEmergency ? emergencyDisplayPositions.get(amb.currentEmergency) : undefined;
                  const hasRoadRoute = Boolean(amb.activeRoute?.coordinates && amb.activeRoute.coordinates.length >= 2);
                  const isRouteSuccess = amb.activeRoute?.status === 'SUCCESS';

                  if (hasRoadRoute) {
                    return (
                      <Polyline
                        key={`route-${amb.id}`}
                        positions={amb.activeRoute!.coordinates}
                        pathOptions={{
                          color: selectedAmbulanceId === amb.id ? 'var(--primary)' : isRouteSuccess ? '#0284c7' : '#f59e0b',
                          weight: selectedAmbulanceId === amb.id ? 4.5 : 3,
                          opacity: amb.activeRoute?.isStale ? 0.5 : 0.85,
                          dashArray: amb.activeRoute?.isStale || !isRouteSuccess ? '8, 10' : undefined,
                        }}
                      />
                    );
                  }

                  if (!emgPos) return null;
                  return (
                    <Polyline
                      key={`route-${amb.id}`}
                      positions={[[amb.location.lat, amb.location.lng], emgPos]}
                      pathOptions={{
                        color: selectedAmbulanceId === amb.id ? 'var(--primary)' : '#0ea5e9',
                        weight: selectedAmbulanceId === amb.id ? 4 : 2.5,
                        opacity: 0.72,
                        dashArray: '8, 10',
                      }}
                    />
                  );
                })}
                {plottableEmergencies.map((emg: Emergency) => {
                  const pos = emergencyDisplayPositions.get(emg.id);
                  if (!pos) return null;
                  return (
                    <Marker
                      key={`emergency-${emg.id}`}
                      position={pos}
                      icon={emg.priority === 'CRITICAL' ? criticalEmergencyIcon : emergencyIcon}
                    >
                      <Popup>
                        <div className="space-y-1 text-xs">
                          <p className="font-mono font-semibold">{emg.id}</p>
                          <p>{emg.incidentType.replace(/_/g, ' ')}</p>
                          <p>Priority: {emg.priority}</p>
                          <p>Status: {emg.status.replace(/_/g, ' ')}</p>
                          {emg.assignedAmbulance && <p>Ambulance: {emg.assignedAmbulance}</p>}
                        </div>
                      </Popup>
                    </Marker>
                  );
                })}
                {plottableHospitals.map((hosp: any) => (
                  <Marker
                    key={`hospital-${hosp.id}`}
                    position={[hosp.location.lat, hosp.location.lng]}
                    icon={hospitalIcon}
                  >
                    <Popup>
                      <div className="space-y-1 text-xs">
                        <p className="font-mono font-semibold">{hosp.name || hosp.id}</p>
                        <p>Status: {hosp.status || 'OPERATIONAL'}</p>
                        {hosp.emergencyCapacity && <p>Capacity: {hosp.emergencyCapacity}</p>}
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Truck size={15} className="text-[var(--primary)]" />
                {canReadFleet ? 'Active units' : 'My emergencies'}
              </CardTitle>
              <Badge variant="outline" className="text-[8px]">
                {canReadFleet ? activeAmbulances.length : emergencies?.length || 0}
              </Badge>
            </CardHeader>
            <CardContent className="max-h-[440px] space-y-2 overflow-y-auto">
              {canReadFleet ? (
                activeAmbulances.length === 0 ? (
                  <EmptyState compact icon={<Truck size={18} />} title="No active units" description="Units will appear here when they are assigned." />
                ) : (
                  activeAmbulances.map((amb: Ambulance) => {
                    const emg = (emergencies || []).find((e: Emergency) => e.id === amb.currentEmergency);
                    const isSelected = selectedAmbulanceId === amb.id;
                    const freshness = getTelemetryFreshness(amb.lastUpdated);
                    const isSim = Boolean(amb.isSimulated || amb.telemetrySource === 'SIMULATED');
                    return (
                      <button
                        key={amb.id}
                        type="button"
                        onClick={() => setSelectedAmbulanceId(isSelected ? null : amb.id)}
                        className={`w-full rounded-lg border p-3 text-left transition-colors ${isSelected ? 'border-[var(--primary)] bg-[var(--accent)]' : 'border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] hover:bg-[var(--muted)]'}`}
                        aria-pressed={isSelected}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs font-semibold">{amb.id}</span>
                            {isSim ? (
                              <Badge variant="info" className="text-[7px] py-0 px-1 bg-blue-500/15 border-blue-500/30 text-blue-400 font-mono">SIM</Badge>
                            ) : (
                              <Badge variant="outline" className="text-[7px] py-0 px-1 font-mono">GPS</Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <Badge
                              variant={freshness.isStale ? 'outline' : freshness.isAging ? 'warning' : 'success'}
                              className={`text-[8px] gap-1 ${freshness.isStale ? 'border-red-500/40 text-red-400 bg-red-500/10' : ''}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${freshness.isStale ? 'bg-red-500' : freshness.isAging ? 'bg-amber-500' : 'bg-emerald-500 animate-pulse'}`} />
                              {freshness.isStale ? 'Stale' : freshness.isAging ? 'Delayed' : 'Live'}
                            </Badge>
                            <Badge variant="info" className="text-[8px]">{amb.status.replace(/_/g, ' ')}</Badge>
                          </div>
                        </div>
                        <div className="mt-2 grid gap-1 text-[10px] text-[var(--muted-foreground)]">
                          <span className="flex items-center gap-1.5"><Activity size={10} /> {amb.speed} km/h · {amb.heading}°</span>
                          {amb.eta ? <span className="flex items-center gap-1.5"><Clock size={10} /> ETA {Math.floor(amb.eta / 60)}:{(amb.eta % 60).toString().padStart(2, '0')}</span> : null}
                          {emg ? <span className="flex items-center gap-1.5 truncate"><MapPin size={10} /> {emg.id} · {emg.location?.address ?? 'Location coordinates pending'}</span> : <span className="flex items-center gap-1.5"><MapPin size={10} /> No incident linked</span>}
                        </div>
                        {freshness.isStale && (
                          <p className="mt-1.5 text-[9px] text-red-400 font-medium leading-tight">
                            ⚠️ Stale telemetry ({freshness.label}). Coordinates represent last known fix.
                          </p>
                        )}
                        <span className="mt-2 flex items-center gap-1 text-[9px] font-semibold text-[var(--primary)]">
                          <Crosshair size={10} /> {isSelected ? 'Focused on map' : 'Focus on map'}
                        </span>
                      </button>
                    );
                  })
                )
              ) : (emergencies || []).length === 0 ? (
                <EmptyState compact icon={<MapPin size={18} />} title="No reports yet" description="Emergencies you report will appear here." />
              ) : (
                (emergencies || []).map((emg: Emergency) => {
                  const isSelected = selectedEmergency?.id === emg.id;
                  return (
                    <button
                      key={emg.id}
                      type="button"
                      onClick={() => setSelectedEmergencyId(isSelected ? null : emg.id)}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${
                        isSelected
                          ? 'border-[var(--primary)] bg-[var(--accent)]'
                          : 'border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] hover:bg-[var(--muted)]'
                      }`}
                      aria-pressed={isSelected}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-semibold">{emg.id}</span>
                        <Badge variant="outline" className="text-[8px]">{emg.status.replace(/_/g, ' ')}</Badge>
                      </div>
                      <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--muted-foreground)]">
                        {emg.location?.address ?? emg.incidentType.replace(/_/g, ' ')}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant={emg.assignedAmbulance ? 'success' : 'warning'}
                          className="text-[9px] gap-1"
                        >
                          <Truck size={10} />
                          {emg.assignedAmbulance ? `Unit: ${emg.assignedAmbulance}` : 'Awaiting assignment'}
                        </Badge>
                        {emg.destinationHospital && (
                          <Badge variant="info" className="text-[9px] gap-1">
                            <Building2 size={10} />
                            {emg.destinationHospital}
                          </Badge>
                        )}
                        {emg.eta ? (
                          <Badge variant="outline" className="text-[9px] gap-1 font-mono">
                            <Clock size={10} />
                            ETA {Math.floor(emg.eta / 60)}:{(emg.eta % 60).toString().padStart(2, '0')}
                          </Badge>
                        ) : null}
                      </div>
                      <span className="mt-2 flex items-center gap-1 text-[9px] font-semibold text-[var(--primary)]">
                        <Crosshair size={10} /> {isSelected ? 'Focused on map' : 'Focus on map'}
                      </span>
                    </button>
                  );
                })
              )}
            </CardContent>
          </Card>

          {selectedAmbulance && selectedEmergency && (
            <Card variant="elevated">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Selected unit context</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Unit</span><span className="font-mono font-semibold">{selectedAmbulance.id}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Incident</span><span className="font-mono font-semibold">{selectedEmergency.id}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Priority</span><Badge variant={selectedEmergency.priority === 'CRITICAL' ? 'critical' : 'warning'} className="text-[8px]">{selectedEmergency.priority}</Badge></div>
                <div className="flex justify-between gap-3">
                  <span className="text-[var(--muted-foreground)]">GPS Freshness</span>
                  {(() => {
                    const f = getTelemetryFreshness(selectedAmbulance.lastUpdated);
                    const isSim = Boolean(selectedAmbulance.isSimulated || selectedAmbulance.telemetrySource === 'SIMULATED');
                    return (
                      <span className={f.isStale ? 'text-red-400 font-semibold' : f.isAging ? 'text-amber-400 font-semibold' : 'text-emerald-400 font-semibold'}>
                        {f.label} ({isSim ? 'Simulated' : 'Hardware GPS'})
                      </span>
                    );
                  })()}
                </div>
                <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Last Signal</span><span>{selectedAmbulance.lastUpdated ? formatDistanceToNow(new Date(selectedAmbulance.lastUpdated), { addSuffix: true }) : 'Unknown'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Speed & Heading</span><span>{selectedAmbulance.speed} km/h · {selectedAmbulance.heading}°</span></div>
                {selectedAmbulance.activeRoute ? (
                  <>
                    <div className="flex justify-between gap-3">
                      <span className="text-[var(--muted-foreground)]">Road Distance</span>
                      <span className="font-semibold text-sky-400">
                        {(selectedAmbulance.activeRoute.distanceMeters / 1000).toFixed(1)} km road network
                      </span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-[var(--muted-foreground)]">Dynamic Road ETA</span>
                      {selectedAmbulance.activeRoute.status === 'SUCCESS' && selectedAmbulance.eta ? (
                        <span className="font-mono font-semibold text-emerald-400">
                          {Math.floor(selectedAmbulance.eta / 60)}:{(selectedAmbulance.eta % 60).toString().padStart(2, '0')} min
                          {selectedAmbulance.activeRoute.isStale ? ' (Stale)' : ''}
                        </span>
                      ) : (
                        <span className="text-amber-400 font-semibold">ETA unavailable</span>
                      )}
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-[var(--muted-foreground)]">Routing Engine</span>
                      <span className="text-[11px] font-mono">{selectedAmbulance.activeRoute.provider.toUpperCase()} (driving)</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-[var(--muted-foreground)]">Last Route Update</span>
                      <span>
                        {selectedAmbulance.activeRoute.calculatedAt
                          ? formatDistanceToNow(new Date(selectedAmbulance.activeRoute.calculatedAt), { addSuffix: true })
                          : 'Pending'}
                      </span>
                    </div>
                  </>
                ) : null}
                <div className="border-t border-[var(--border)] pt-2 text-[10px] text-[var(--muted-foreground)]">
                  {selectedAmbulance.activeRoute?.status === 'SUCCESS'
                    ? 'Road geometry provided by OSRM OpenStreetMap road network. ETA calculated from actual driving travel time.'
                    : "Route line connects the unit's current reported position to the incident's reported location. No interpolation or generated coordinates."}
                </div>
              </CardContent>
            </Card>
          )}

          {!canReadFleet && selectedEmergency && (
            <Card variant="elevated">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">Emergency tracking context</CardTitle>
                  <Badge variant={selectedEmergency.priority === 'CRITICAL' ? 'critical' : 'warning'} className="text-[8px]">
                    {selectedEmergency.priority}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Incident</span><span className="font-mono font-semibold">{selectedEmergency.id}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Status</span><Badge variant="outline" className="text-[8px]">{selectedEmergency.status.replace(/_/g, ' ')}</Badge></div>
                <div className="flex justify-between gap-3">
                  <span className="text-[var(--muted-foreground)]">Assigned unit</span>
                  {selectedEmergency.assignedAmbulance ? (
                    <span className="font-mono font-semibold text-[var(--success)]">{selectedEmergency.assignedAmbulance}</span>
                  ) : (
                    <span className="text-[var(--warning)] font-medium">Awaiting assignment</span>
                  )}
                </div>
                {selectedEmergency.assignedAmbulance && (
                  (() => {
                    const assignedAmb = (ambulances || []).find((a: Ambulance) => a.id === selectedEmergency.assignedAmbulance);
                    if (!assignedAmb) return null;
                    const freshness = getTelemetryFreshness(assignedAmb.lastUpdated);
                    const isSim = Boolean(assignedAmb.isSimulated || assignedAmb.telemetrySource === 'SIMULATED');
                    return (
                      <>
                        <div className="flex justify-between gap-3">
                          <span className="text-[var(--muted-foreground)]">Live GPS status</span>
                          <span className={freshness.isStale ? 'text-red-400 font-semibold' : freshness.isAging ? 'text-amber-400 font-semibold' : 'text-emerald-400 font-semibold'}>
                            {freshness.label} {isSim ? '(Simulated)' : ''}
                          </span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-[var(--muted-foreground)]">Speed & Heading</span>
                          <span>{assignedAmb.speed} km/h · {assignedAmb.heading}°</span>
                        </div>
                      </>
                    );
                  })()
                )}
                {(() => {
                  const assignedAmb = (ambulances || []).find((a: Ambulance) => a.id === selectedEmergency.assignedAmbulance);
                  if (assignedAmb?.activeRoute?.distanceMeters) {
                    return (
                      <div className="flex justify-between gap-3">
                        <span className="text-[var(--muted-foreground)]">Road Distance</span>
                        <span className="font-semibold text-sky-400">
                          {(assignedAmb.activeRoute.distanceMeters / 1000).toFixed(1)} km road network
                        </span>
                      </div>
                    );
                  }
                  return null;
                })()}
                {selectedEmergency.assignedAmbulance && (
                  <div className="flex justify-between gap-3">
                    <span className="text-[var(--muted-foreground)]">Estimated arrival</span>
                    {selectedEmergency.eta ? (
                      <span className="font-mono font-semibold text-emerald-400">
                        {Math.floor(selectedEmergency.eta / 60)}:{(selectedEmergency.eta % 60).toString().padStart(2, '0')} (Road ETA)
                      </span>
                    ) : (
                      <span className="text-amber-400 font-semibold text-[11px]">ETA unavailable</span>
                    )}
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <span className="text-[var(--muted-foreground)]">Destination hospital</span>
                  {selectedEmergency.destinationHospital ? (
                    <span className="font-mono font-semibold text-[var(--info)]">{selectedEmergency.destinationHospital}</span>
                  ) : (
                    <span className="text-[var(--muted-foreground)]">Routing in progress</span>
                  )}
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-[var(--muted-foreground)]">Location</span>
                  <span className="max-w-[65%] truncate text-right font-medium">
                    {selectedEmergency.location?.address ?? `${selectedEmergency.location.lat.toFixed(4)}, ${selectedEmergency.location.lng.toFixed(4)}`}
                  </span>
                </div>
                <div className="flex justify-between gap-3"><span className="text-[var(--muted-foreground)]">Reported</span><span>{formatDistanceToNow(new Date(selectedEmergency.reportedAt), { addSuffix: true })}</span></div>
                <div className="border-t border-[var(--border)] pt-2 flex items-center justify-between text-[10px]">
                  <span className="text-[var(--muted-foreground)]">Auto-refresh active</span>
                  <Link to={`/emergencies/${selectedEmergency.id}`} className="font-semibold text-[var(--primary)] hover:underline">
                    View incident details
                  </Link>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-[10px] leading-relaxed text-[var(--muted-foreground)]">
            <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-[var(--success)]" aria-hidden="true" />
            Map tiles require network access. Coordinates and status come from the API; only tile pixels respond to the active theme.
          </div>
        </div>
      </div>
    </div>
  );
}
