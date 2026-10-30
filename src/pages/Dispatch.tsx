import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can } from '../lib/permissions';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { EmptyState } from '../components/ui/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import {
  AlertTriangle,
  Brain,
  Building2,
  CheckCircle2,
  Clock,
  MapPin,
  Radio,
  RefreshCw,
  Route,
  Truck,
  Zap,
  ExternalLink,
} from 'lucide-react';
import type {
  DispatchRecommendation,
  Emergency,
  EmergencyPriority,
  HospitalRecommendation,
} from '../types';

const PRIORITY_VARIANT: Record<EmergencyPriority, 'critical' | 'destructive' | 'warning' | 'info'> = {
  CRITICAL: 'critical',
  HIGH: 'destructive',
  MEDIUM: 'warning',
  LOW: 'info',
};

function isOpen(emergency: Emergency) {
  return emergency.status !== 'COMPLETED' && emergency.status !== 'CANCELLED';
}

function isEligibleForDispatch(emergency: Emergency) {
  return (
    isOpen(emergency) &&
    !emergency.assignedAmbulance &&
    emergency.status !== 'AMBULANCE_ASSIGNED' &&
    emergency.status !== 'EN_ROUTE'
  );
}

function getQueryEmergencyId(): string {
  if (typeof window !== 'undefined' && window.location?.search) {
    const params = new URLSearchParams(window.location.search);
    return params.get('emergencyId') || params.get('id') || '';
  }
  return '';
}

export function DispatchPage() {
  const user = useAuthStore((state) => state.user);
  const canAssign = can(user?.role, 'dispatch:assign', user?.permissions);
  const queryClient = useQueryClient();

  const paramEmergencyId = getQueryEmergencyId();
  const [selectedEmergencyId, setSelectedEmergencyId] = useState<string>(paramEmergencyId);
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [reservedHospitalId, setReservedHospitalId] = useState<string | null>(null);
  const [reserveError, setReserveError] = useState<string | null>(null);

  // Fetch authorized emergency list
  const {
    data: emergencies,
    isLoading: loadingEmergencies,
    error: emergenciesError,
  } = useQuery({
    queryKey: ['emergencies'],
    queryFn: () => api.emergencies.list(),
  });

  useEffect(() => {
    if (paramEmergencyId && emergencies?.some((e) => e.id === paramEmergencyId)) {
      setSelectedEmergencyId(paramEmergencyId);
    }
  }, [paramEmergencyId, emergencies]);

  // Prefer unassigned, active incidents that are eligible for dispatch review
  const sortedEmergencies = useMemo(() => {
    if (!emergencies) return [];
    return [...emergencies].sort((a, b) => {
      // 1. Prefer unassigned & active (eligible for dispatch review)
      const aEligible = isEligibleForDispatch(a);
      const bEligible = isEligibleForDispatch(b);
      if (aEligible && !bEligible) return -1;
      if (!aEligible && bEligible) return 1;

      // 2. Next prefer active over closed
      const aOpen = isOpen(a);
      const bOpen = isOpen(b);
      if (aOpen && !bOpen) return -1;
      if (!aOpen && bOpen) return 1;

      // 3. Newest first
      return new Date(b.reportedAt).getTime() - new Date(a.reportedAt).getTime();
    });
  }, [emergencies]);

  const preferredIncident = useMemo(() => {
    if (!sortedEmergencies.length) return null;
    return sortedEmergencies[0];
  }, [sortedEmergencies]);

  const currentEmergencyId = useMemo(() => {
    if (selectedEmergencyId && emergencies?.some((e) => e.id === selectedEmergencyId)) {
      return selectedEmergencyId;
    }
    if (paramEmergencyId && emergencies?.some((e) => e.id === paramEmergencyId)) {
      return paramEmergencyId;
    }
    return preferredIncident?.id ?? '';
  }, [selectedEmergencyId, paramEmergencyId, emergencies, preferredIncident]);

  const selectedEmergency = useMemo(() => {
    return emergencies?.find((e) => e.id === currentEmergencyId);
  }, [emergencies, currentEmergencyId]);

  const isAlreadyAssignedOrEnRoute = Boolean(
    selectedEmergency?.assignedAmbulance ||
      selectedEmergency?.status === 'AMBULANCE_ASSIGNED' ||
      selectedEmergency?.status === 'EN_ROUTE',
  );

  const {
    data: recommendations,
    isLoading: loadingRecs,
    error: recsError,
    refetch: refetchAmbulances,
  } = useQuery({
    queryKey: ['dispatch-recommendations', currentEmergencyId],
    queryFn: () => api.dispatch.getRecommendations(currentEmergencyId),
    enabled: Boolean(currentEmergencyId),
  });

  const {
    data: hospitalRecs,
    isLoading: loadingHospitals,
    error: hospitalRecsError,
    refetch: refetchHospitals,
  } = useQuery({
    queryKey: ['hospital-recommendations', currentEmergencyId],
    queryFn: () => api.dispatch.getHospitalRecommendations(currentEmergencyId),
    enabled: Boolean(currentEmergencyId),
  });

  const handleSelectIncident = (id: string) => {
    setSelectedEmergencyId(id);
    setAssignedTo(null);
    setAssignError(null);
    setReservedHospitalId(null);
    setReserveError(null);
  };

  const handleRefresh = () => {
    if (currentEmergencyId) {
      void refetchAmbulances();
      void refetchHospitals();
    }
  };

  // Recommendation ≠ assignment: the dispatcher must explicitly assign.
  const assignMutation = useMutation({
    mutationFn: (ambulanceId: string) => api.dispatch.assign(currentEmergencyId, ambulanceId),
    onSuccess: (result, ambulanceId) => {
      setAssignError(null);
      setAssignedTo(ambulanceId);
      void queryClient.invalidateQueries({ queryKey: ['emergencies'] });
      void queryClient.invalidateQueries({ queryKey: ['emergency', currentEmergencyId] });
      void queryClient.invalidateQueries({ queryKey: ['emergency'] });
      void queryClient.invalidateQueries({ queryKey: ['ambulances'] });
      void queryClient.invalidateQueries({ queryKey: ['dispatch-recommendations', currentEmergencyId] });
      void queryClient.invalidateQueries({ queryKey: ['hospital-recommendations', currentEmergencyId] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      if (result?.emergency) {
        queryClient.setQueryData(['emergency', currentEmergencyId], result.emergency);
      }
    },
    onError: (err) => setAssignError(err instanceof ApiError ? err.message : 'Assignment failed'),
  });

  // Hospital reservation — executed after ambulance assignment to complete the routing workflow.
  const reserveMutation = useMutation({
    mutationFn: (hospitalId: string) =>
      api.dispatch.reserveHospital(hospitalId, currentEmergencyId, 'EMERGENCY_ACCEPTANCE'),
    onSuccess: (_result, hospitalId) => {
      setReserveError(null);
      setReservedHospitalId(hospitalId);
      void queryClient.invalidateQueries({ queryKey: ['emergencies'] });
      void queryClient.invalidateQueries({ queryKey: ['emergency', currentEmergencyId] });
      void queryClient.invalidateQueries({ queryKey: ['hospitals'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (err) => setReserveError(err instanceof ApiError ? err.message : 'Hospital reservation failed'),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Operations / dispatch / ${currentEmergencyId || 'select-incident'}`}
        title="Dispatch intelligence"
        description="Ranked ambulance and hospital recommendations for the active incident. Recommendations are advisory; assignment is a separate, explicit action."
        icon={<Radio size={21} />}
        status={<Badge variant="outline" className="gap-1.5"><Brain size={11} /> Advisory scores</Badge>}
      />

      {/* Dry-run Advisory Disclaimer */}
      <div className="flex items-start gap-2.5 rounded-xl border border-[var(--info)]/30 bg-[color-mix(in_srgb,var(--info)_6%,transparent)] p-3.5">
        <AlertTriangle size={15} className="mt-0.5 flex-none text-[var(--info)]" />
        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
          <span className="font-semibold text-[var(--foreground)]">Recommendation is not assignment.</span>{' '}
          The dispatcher must review the evidence and explicitly assign. A recommendation never changes
          an incident or a vehicle on its own.
        </p>
      </div>

      {/* Incident Selection & Status Header */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-1 flex-col gap-1.5 sm:flex-row sm:items-center">
              <label htmlFor="incident-select" className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)] sm:mr-2">
                Incident:
              </label>
              {loadingEmergencies ? (
                <Skeleton className="h-10 w-full sm:w-80" />
              ) : sortedEmergencies.length === 0 ? (
                <p className="text-xs text-[var(--muted-foreground)]">No incidents available</p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={currentEmergencyId}
                    onValueChange={handleSelectIncident}
                  >
                    <SelectTrigger
                      id="incident-select"
                      data-testid="incident-selector"
                      aria-label="Select incident for dispatch review"
                      className="h-10 w-full sm:w-96 text-xs"
                    >
                      <SelectValue placeholder="Select an incident..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-80">
                      {sortedEmergencies.map((emg) => {
                        const isAssigned =
                          Boolean(emg.assignedAmbulance) ||
                          emg.status === 'AMBULANCE_ASSIGNED' ||
                          emg.status === 'EN_ROUTE';
                        const assignmentState = emg.assignedAmbulance
                          ? `Assigned (${emg.assignedAmbulance})`
                          : isAssigned
                            ? 'Assigned'
                            : 'Unassigned';

                        return (
                          <SelectItem
                            key={emg.id}
                            value={emg.id}
                            data-testid={`incident-option-${emg.id}`}
                          >
                            <span className="font-mono font-semibold">{emg.id}</span>
                            {' — '}
                            <span>{emg.status.replace(/_/g, ' ')}</span>
                            {' — '}
                            <span
                              className={
                                emg.assignedAmbulance
                                  ? 'text-[var(--warning)]'
                                  : !isAssigned
                                    ? 'text-[var(--success)]'
                                    : 'text-[var(--muted-foreground)]'
                              }
                            >
                              {assignmentState}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleRefresh}
                    disabled={loadingRecs || loadingHospitals || !currentEmergencyId}
                    className="gap-1.5"
                    aria-label="Refresh recommendations"
                  >
                    <RefreshCw size={13} className={loadingRecs || loadingHospitals ? 'animate-spin' : ''} />
                    Refresh
                  </Button>
                </div>
              )}
            </div>

            {selectedEmergency && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono font-semibold text-sm">{selectedEmergency.id}</span>
                <Badge variant={PRIORITY_VARIANT[selectedEmergency.priority] ?? 'default'}>
                  {selectedEmergency.priority}
                </Badge>
                <Badge variant="outline">{selectedEmergency.status.replace(/_/g, ' ')}</Badge>
                {selectedEmergency.location && (
                  <Badge variant="outline" className="gap-1 text-[10px] text-[var(--muted-foreground)]">
                    <MapPin size={10} className="text-[var(--primary)]" />
                    <span>{selectedEmergency.location.address || 'Unknown address'}</span>
                    {selectedEmergency.location.lat != null && selectedEmergency.location.lng != null && (
                      <span className="font-mono text-[9px] opacity-80">
                        ({selectedEmergency.location.lat.toFixed(4)}, {selectedEmergency.location.lng.toFixed(4)})
                      </span>
                    )}
                  </Badge>
                )}
                <Badge
                  variant={selectedEmergency.assignedAmbulance ? 'warning' : 'success'}
                  className="gap-1 text-[10px]"
                >
                  <Truck size={10} />
                  {selectedEmergency.assignedAmbulance
                    ? `Assigned: ${selectedEmergency.assignedAmbulance}`
                    : 'Unassigned'}
                </Badge>
                {selectedEmergency.destinationHospital && (
                  <Badge variant="info" className="gap-1 text-[10px]">
                    <Building2 size={10} />
                    Hospital: {selectedEmergency.destinationHospital}
                  </Badge>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Advisory Notice for Incidents with Ambulance Assigned or EN_ROUTE */}
      {isAlreadyAssignedOrEnRoute && selectedEmergency && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-[color-mix(in_srgb,var(--warning)_35%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] p-3.5"
        >
          <AlertTriangle size={15} className="mt-0.5 flex-none text-[var(--warning)]" />
          <div className="space-y-0.5 text-xs leading-relaxed">
            <p className="font-semibold text-[var(--foreground)]">
              Incident {selectedEmergency.id} is already {selectedEmergency.status.replace(/_/g, ' ')}
              {selectedEmergency.assignedAmbulance ? ` with ${selectedEmergency.assignedAmbulance} assigned.` : '.'}
            </p>
            <p className="text-[var(--muted-foreground)]">
              Recommendations are displayed for advisory reassessment only. Automatic assignment or state alteration will not occur.
            </p>
          </div>
        </div>
      )}

      {emergenciesError && (
        <div role="alert" className="rounded-xl border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
          <p className="text-xs leading-relaxed text-[var(--destructive)]">
            Failed to load emergency list: {emergenciesError instanceof Error ? emergenciesError.message : 'Unknown error'}
          </p>
        </div>
      )}
      {recsError && (
        <div role="alert" className="rounded-xl border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
          <p className="text-xs leading-relaxed text-[var(--destructive)]">
            Failed to load ambulance recommendations: {recsError instanceof Error ? recsError.message : 'Unknown error'}
          </p>
        </div>
      )}
      {hospitalRecsError && (
        <div role="alert" className="rounded-xl border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
          <p className="text-xs leading-relaxed text-[var(--destructive)]">
            Failed to load hospital recommendations: {hospitalRecsError instanceof Error ? hospitalRecsError.message : 'Unknown error'}
          </p>
        </div>
      )}
      {assignError && (
        <div role="alert" className="rounded-xl border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
          <p className="text-xs leading-relaxed text-[var(--destructive)]">{assignError}</p>
        </div>
      )}
      {(assignedTo || reservedHospitalId) && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-xl border border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] p-3.5">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 size={15} className="mt-0.5 flex-none text-[var(--success)]" />
            <p className="text-xs leading-relaxed text-[var(--success)]">
              {assignedTo && (
                <>
                  <span className="font-mono font-semibold">{assignedTo}</span> assigned to{' '}
                  <span className="font-mono font-semibold">{currentEmergencyId}</span> — status advanced to AMBULANCE_ASSIGNED.
                </>
              )}
              {assignedTo && reservedHospitalId && ' '}
              {reservedHospitalId && (
                <>
                  Hospital <span className="font-mono font-semibold">{reservedHospitalId}</span> reserved for{' '}
                  <span className="font-mono font-semibold">{currentEmergencyId}</span>.
                </>
              )}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="flex-none gap-1.5 text-[var(--success)] border-[color-mix(in_srgb,var(--success)_40%,var(--border))]"
            onClick={() => {
              if (typeof window !== 'undefined') window.location.href = '/tracking';
            }}
          >
            <ExternalLink size={12} />
            Track incident
          </Button>
        </div>
      )}
      {reserveError && (
        <div role="alert" className="rounded-xl border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
          <p className="text-xs leading-relaxed text-[var(--destructive)]">Hospital reservation failed: {reserveError}</p>
        </div>
      )}

      {!loadingEmergencies && sortedEmergencies.length === 0 ? (
        <EmptyState
          compact
          icon={<Radio size={20} />}
          title="No incidents available"
          description="There are currently no emergencies available in your authorized scope."
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Truck size={16} className="text-[var(--primary)]" />
                Ambulance recommendations
              </CardTitle>
              <p className="text-xs text-[var(--muted-foreground)]">Ordered by the dispatch endpoint's score.</p>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {loadingRecs || loadingEmergencies ? (
                Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)
              ) : !currentEmergencyId ? (
                <EmptyState compact icon={<Truck size={18} />} title="No incident selected" description="Select an incident above to review dispatch recommendations." />
              ) : (recommendations || []).length === 0 ? (
                <div className="space-y-3">
                  <EmptyState compact icon={<Truck size={18} />} title="No ambulance recommendations" description="The dispatch endpoint returned no candidates for this incident." />
                  {selectedEmergency && (
                    <div className="rounded-xl border border-[color-mix(in_srgb,var(--warning)_35%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-3.5 text-xs text-[var(--muted-foreground)]">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle size={15} className="mt-0.5 flex-none text-[var(--warning)]" />
                        <div className="space-y-1">
                          <p className="font-semibold text-[var(--foreground)]">
                            {(!selectedEmergency.location?.lat || !selectedEmergency.location?.lng)
                              ? 'Location coordinates missing'
                              : 'No eligible ambulances within response range (12 km)'}
                          </p>
                          <p className="leading-relaxed">
                            {(!selectedEmergency.location?.lat || !selectedEmergency.location?.lng)
                              ? 'This incident has no valid geographic coordinates. Proximity-based ambulance scoring requires verified latitude and longitude.'
                              : `Incident location (${selectedEmergency.location.address || `${selectedEmergency.location.lat.toFixed(4)}, ${selectedEmergency.location.lng.toFixed(4)}`}) is outside the 12 km response radius of active fleet units in the service network.`}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                (recommendations || []).map((rec: DispatchRecommendation, i: number) => (
                  <div
                    key={rec.ambulanceId}
                    className={
                      i === 0
                        ? 'rounded-xl border border-[color-mix(in_srgb,var(--primary)_40%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_6%,transparent)] p-3.5'
                        : 'rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] p-3.5'
                    }
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{rec.ambulanceId}</span>
                        {i === 0 && <Badge className="text-[9px]">Recommended</Badge>}
                      </div>
                      <div className="text-right">
                        <span className="operational-number text-lg font-semibold text-[var(--primary)]">{rec.score}</span>
                        <span className="ml-1 font-mono text-[8px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">score</span>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
                      <span className="flex items-center gap-1.5">
                        <Clock size={11} /> ETA {Math.floor(rec.eta / 60)}:{(rec.eta % 60).toString().padStart(2, '0')}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <MapPin size={11} /> {(rec.distance / 1000).toFixed(1)} km
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {rec.capabilities.map((cap) => (
                        <span key={cap} className="flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--success)_10%,transparent)] px-2 py-0.5 text-[10px] text-[var(--success)]">
                          <CheckCircle2 size={9} /> {cap}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2.5 border-t border-[var(--border)] pt-2">
                      <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Why this recommendation</p>
                      <ul className="space-y-0.5">
                        {rec.reasons.map((reason, j) => (
                          <li key={j} className="flex items-start gap-1.5 text-xs leading-relaxed text-[var(--muted-foreground)]">
                            <span className="text-[var(--primary)]">•</span>
                            {reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {canAssign && (
                      <Button
                        size="sm"
                        className="mt-3 w-full"
                        onClick={() => assignMutation.mutate(rec.ambulanceId)}
                        disabled={
                          assignMutation.isPending ||
                          assignedTo === rec.ambulanceId ||
                          (isAlreadyAssignedOrEnRoute && selectedEmergency?.assignedAmbulance === rec.ambulanceId)
                        }
                      >
                        <Zap size={12} />
                        {assignMutation.isPending && assignMutation.variables === rec.ambulanceId
                          ? 'Assigning…'
                          : assignedTo === rec.ambulanceId || selectedEmergency?.assignedAmbulance === rec.ambulanceId
                            ? `Assigned ${rec.ambulanceId}`
                            : `Assign ${rec.ambulanceId}`}
                      </Button>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Route size={16} className="text-[var(--info)]" />
                Hospital recommendations
              </CardTitle>
              <p className="text-xs text-[var(--muted-foreground)]">Capacity and capability context from the dispatch endpoint.</p>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {loadingHospitals || loadingEmergencies ? (
                Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)
              ) : !currentEmergencyId ? (
                <EmptyState compact icon={<MapPin size={18} />} title="No incident selected" description="Select an incident above to review destination candidates." />
              ) : (hospitalRecs || []).length === 0 ? (
                <div className="space-y-3">
                  <EmptyState compact icon={<MapPin size={18} />} title="No hospital recommendations" description="The dispatch endpoint returned no destination candidates." />
                  {selectedEmergency && (
                    <div className="rounded-xl border border-[color-mix(in_srgb,var(--warning)_35%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-3.5 text-xs text-[var(--muted-foreground)]">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle size={15} className="mt-0.5 flex-none text-[var(--warning)]" />
                        <div className="space-y-1">
                          <p className="font-semibold text-[var(--foreground)]">
                            {(!selectedEmergency.location?.lat || !selectedEmergency.location?.lng)
                              ? 'Location coordinates missing'
                              : 'No receiving hospitals within network range (15 km)'}
                          </p>
                          <p className="leading-relaxed">
                            {(!selectedEmergency.location?.lat || !selectedEmergency.location?.lng)
                              ? 'This incident has no valid geographic coordinates. Proximity-based hospital routing requires verified latitude and longitude.'
                              : `Incident location (${selectedEmergency.location.address || `${selectedEmergency.location.lat.toFixed(4)}, ${selectedEmergency.location.lng.toFixed(4)}`}) is outside the 15 km network boundary of participating receiving hospitals.`}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                (hospitalRecs || []).map((rec: HospitalRecommendation, i: number) => (
                  <div
                    key={rec.hospitalId}
                    className={
                      i === 0
                        ? 'rounded-xl border border-[color-mix(in_srgb,var(--primary)_40%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_6%,transparent)] p-3.5'
                        : 'rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] p-3.5'
                    }
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{rec.hospitalId}</span>
                        {i === 0 && <Badge className="text-[9px]">Recommended</Badge>}
                      </div>
                      <span className="operational-number text-lg font-semibold text-[var(--primary)]">{rec.score}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
                      <span className="flex items-center gap-1.5">
                        <Clock size={11} /> ETA {Math.floor(rec.eta / 60)}:{(rec.eta % 60).toString().padStart(2, '0')}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <MapPin size={11} /> {(rec.distance / 1000).toFixed(1)} km
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge variant={rec.traumaAvailable ? 'success' : 'destructive'} className="text-[9px]">
                        Trauma: {rec.traumaAvailable ? 'Yes' : 'No'}
                      </Badge>
                      <Badge variant={rec.emergencyCapacity === 'AVAILABLE' ? 'success' : 'warning'} className="text-[9px]">
                        ED: {rec.emergencyCapacity}
                      </Badge>
                      <Badge variant={rec.icuCapacity === 'AVAILABLE' ? 'success' : 'warning'} className="text-[9px]">
                        ICU: {rec.icuCapacity}
                      </Badge>
                    </div>
                    <div className="mt-2.5 border-t border-[var(--border)] pt-2">
                      <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Why this recommendation</p>
                      <ul className="space-y-0.5">
                        {rec.reasons.map((reason, j) => (
                          <li key={j} className="flex items-start gap-1.5 text-xs leading-relaxed text-[var(--muted-foreground)]">
                            <span className="text-[var(--info)]">•</span>
                            {reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {canAssign && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-3 w-full gap-1.5"
                        onClick={() => reserveMutation.mutate(rec.hospitalId)}
                        disabled={
                          reserveMutation.isPending ||
                          reservedHospitalId === rec.hospitalId ||
                          selectedEmergency?.destinationHospital === rec.hospitalId
                        }
                      >
                        <Building2 size={12} />
                        {reserveMutation.isPending && reserveMutation.variables === rec.hospitalId
                          ? 'Reserving…'
                          : reservedHospitalId === rec.hospitalId || selectedEmergency?.destinationHospital === rec.hospitalId
                            ? `Reserved at ${rec.hospitalId}`
                            : `Reserve at ${rec.hospitalId}`}
                      </Button>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
