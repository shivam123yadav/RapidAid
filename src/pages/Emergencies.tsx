import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Button } from '../components/ui/button';
import { Link } from 'react-router-dom';
import { formatTime } from '../lib/utils';
import { Siren, Eye, Clock, MapPin } from 'lucide-react';
import type { Emergency, EmergencyPriority } from '../types';

export function EmergenciesPage() {
  const { data: emergencies, isLoading } = useQuery({
    queryKey: ['emergencies'],
    queryFn: api.emergencies.list,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
    );
  }

  const priorityVariant = (p: EmergencyPriority) => {
    const map: Record<EmergencyPriority, 'critical' | 'destructive' | 'warning' | 'info'> = {
      CRITICAL: 'critical', HIGH: 'destructive', MEDIUM: 'warning', LOW: 'info'
    };
    return map[p];
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Emergencies</h2>
          <p className="text-sm text-[var(--muted-foreground)]">Active and recent emergency incidents</p>
        </div>
        <Button variant="emergency">
          <Siren size={16} className="mr-2" />
          Report Emergency
        </Button>
      </div>

      <div className="space-y-3">
        {(emergencies || []).map((emg: Emergency) => (
          <Card key={emg.id} className="hover:shadow-md transition-shadow">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className={`mt-1 h-3 w-3 rounded-full ${emg.priority === 'CRITICAL' ? 'bg-red-500 animate-pulse' : emg.priority === 'HIGH' ? 'bg-orange-500' : emg.priority === 'MEDIUM' ? 'bg-amber-500' : 'bg-blue-500'}`} />
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold">{emg.id}</span>
                      <Badge variant={priorityVariant(emg.priority)}>{emg.priority}</Badge>
                      <Badge variant="outline">{emg.status.replace(/_/g, ' ')}</Badge>
                    </div>
                    <p className="text-sm text-[var(--muted-foreground)]">{emg.incidentType.replace(/_/g, ' ')}</p>
                    <p className="text-sm">{emg.description}</p>
                    <div className="flex items-center gap-4 text-xs text-[var(--muted-foreground)]">
                      <span className="flex items-center gap-1"><MapPin size={12} />{emg.location.address}</span>
                      <span className="flex items-center gap-1"><Clock size={12} />{formatTime(0)} ago</span>
                      <span>Victims: {emg.victimCount}</span>
                      <span>Source: {emg.source.replace(/_/g, ' ')}</span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  {emg.assignedAmbulance && (
                    <span className="text-xs font-mono text-[var(--muted-foreground)]">{emg.assignedAmbulance}</span>
                  )}
                  <Link to={`/emergencies/${emg.id}`}>
                    <Button variant="outline" size="sm">
                      <Eye size={14} className="mr-1" />
                      Details
                    </Button>
                  </Link>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function EmergencyDetailPage() {
  const { data: emergencies, isLoading } = useQuery({
    queryKey: ['emergencies'],
    queryFn: api.emergencies.list,
  });

  const id = window.location.pathname.split('/').pop();
  const emergency = (emergencies || []).find((e: Emergency) => e.id === id);

  if (isLoading) return <Skeleton className="h-96 rounded-xl" />;
  if (!emergency) return <div className="text-center py-12 text-[var(--muted-foreground)]">Emergency not found</div>;

  const timelineStatuses = ['REPORTED', 'TRIAGED', 'DISPATCHING', 'AMBULANCE_ASSIGNED', 'EN_ROUTE', 'AT_SCENE', 'PATIENT_ONBOARD', 'EN_ROUTE_TO_HOSPITAL', 'AT_HOSPITAL', 'COMPLETED'];
  const currentIndex = timelineStatuses.indexOf(emergency.status);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            {emergency.id}
            <Badge variant={emergency.priority === 'CRITICAL' ? 'critical' : emergency.priority === 'HIGH' ? 'destructive' : 'warning'}>
              {emergency.priority}
            </Badge>
          </h2>
          <p className="text-sm text-[var(--muted-foreground)]">{emergency.incidentType.replace(/_/g, ' ')}</p>
        </div>
        <Badge variant="outline" className="text-sm">{emergency.status.replace(/_/g, ' ')}</Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Info */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader><CardTitle>Incident Details</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><span className="text-[var(--muted-foreground)]">Location:</span> <span className="font-medium">{emergency.location.address}</span></div>
                <div><span className="text-[var(--muted-foreground)]">Source:</span> <span className="font-medium">{emergency.source.replace(/_/g, ' ')}</span></div>
                <div><span className="text-[var(--muted-foreground)]">Victims:</span> <span className="font-medium">{emergency.victimCount}</span></div>
                <div><span className="text-[var(--muted-foreground)]">Reported:</span> <span className="font-medium">{new Date(emergency.reportedAt).toLocaleString()}</span></div>
                <div><span className="text-[var(--muted-foreground)]">Ambulance:</span> <span className="font-mono font-medium">{emergency.assignedAmbulance || '—'}</span></div>
                <div><span className="text-[var(--muted-foreground)]">Hospital:</span> <span className="font-medium">{emergency.destinationHospital || '—'}</span></div>
              </div>
              <p className="pt-2 border-t border-[var(--border)]">{emergency.description}</p>
            </CardContent>
          </Card>

          {/* Timeline */}
          <Card>
            <CardHeader><CardTitle>Emergency Timeline</CardTitle></CardHeader>
            <CardContent>
              <div className="relative">
                {timelineStatuses.map((status, i) => {
                  const isCompleted = i <= currentIndex;
                  const isCurrent = i === currentIndex;
                  const timelineEntry = emergency.timeline.find(t => t.status === status);
                  return (
                    <div key={status} className="flex items-start gap-4 pb-6 last:pb-0">
                      <div className="flex flex-col items-center">
                        <div className={`h-4 w-4 rounded-full border-2 ${isCompleted ? 'bg-[var(--primary)] border-[var(--primary)]' : 'border-[var(--border)] bg-[var(--muted)]'} ${isCurrent ? 'ring-4 ring-[var(--primary)]/20' : ''}`} />
                        {i < timelineStatuses.length - 1 && (
                          <div className={`w-0.5 h-full min-h-[24px] ${isCompleted ? 'bg-[var(--primary)]' : 'bg-[var(--border)]'}`} />
                        )}
                      </div>
                      <div className={`-mt-0.5 ${isCompleted ? '' : 'opacity-50'}`}>
                        <p className="text-sm font-medium">{status.replace(/_/g, ' ')}</p>
                        {timelineEntry && (
                          <p className="text-xs text-[var(--muted-foreground)]">
                            {new Date(timelineEntry.timestamp).toLocaleTimeString()}
                            {timelineEntry.note && ` — ${timelineEntry.note}`}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {emergency.aiRecommendations && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">AI Recommendations</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-[var(--muted-foreground)]">Ambulance Score</span>
                  <span className="font-mono font-bold">{emergency.aiRecommendations.ambulanceScore}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--muted-foreground)]">Hospital Score</span>
                  <span className="font-mono font-bold">{emergency.aiRecommendations.hospitalScore}</span>
                </div>
                <div className="pt-2 border-t border-[var(--border)]">
                  <p className="text-xs text-[var(--muted-foreground)] mb-1">Reasoning:</p>
                  <ul className="space-y-1">
                    {emergency.aiRecommendations.reasoning.map((r, i) => (
                      <li key={i} className="text-xs flex items-start gap-1.5">
                        <span className="text-[var(--primary)]">•</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Assigned Crew</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {(emergency.assignedCrew || []).map((crew, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <div className="h-7 w-7 rounded-full bg-[var(--muted)] flex items-center justify-center text-xs font-medium">
                    {crew.split(' ').map(n => n[0]).join('')}
                  </div>
                  <span>{crew}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
