import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import { ReportEmergencyDialog } from '../components/emergency/ReportEmergencyDialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { VoiceScopedDetail } from '../components/voice/VoiceScopedDetail';
import { useAuthStore } from '../stores/auth';
import { can } from '../lib/permissions';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock,
  Eye,
  MapPin,
  Mic,
  Radio,
  Search,
  ShieldAlert,
  Siren,
  Truck,
  X,
} from 'lucide-react';
import type { Emergency, EmergencyPriority, EmergencyVoiceReportRef } from '../types';

const PRIORITY_VARIANT: Record<EmergencyPriority, 'critical' | 'destructive' | 'warning' | 'info'> = {
  CRITICAL: 'critical',
  HIGH: 'destructive',
  MEDIUM: 'warning',
  LOW: 'info',
};

function isOpen(emergency: Emergency) {
  return emergency.status !== 'COMPLETED' && emergency.status !== 'CANCELLED';
}

/** Address when the report carried one, otherwise the real coordinates — never invented. */
function locationLabel(emergency: Emergency) {
  return emergency.location.address ?? `${emergency.location.lat.toFixed(4)}, ${emergency.location.lng.toFixed(4)}`;
}

export function EmergenciesPage() {
  const user = useAuthStore((state) => state.user);
  const canCreate = can(user?.role, 'emergency:create', user?.permissions);
  const { data: emergencies, isLoading, isError, refetch } = useQuery({
    queryKey: ['emergencies'],
    queryFn: api.emergencies.list,
  });
  const [reportOpen, setReportOpen] = useState(false);
  // Set after a successful POST /api/emergencies so the page confirms it.
  const [lastReported, setLastReported] = useState<Emergency | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'active' | 'all'>('active');

  const all = emergencies ?? [];
  const active = all.filter(isOpen);
  const critical = active.filter((emergency) => emergency.priority === 'CRITICAL');
  const resolved = all.filter((emergency) => !isOpen(emergency));

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const pool = scope === 'active' ? active : all;
    if (!term) return pool;
    return pool.filter(
      (emergency) =>
        emergency.id.toLowerCase().includes(term) ||
        emergency.incidentType.toLowerCase().includes(term) ||
        (emergency.location.address ?? '').toLowerCase().includes(term) ||
        emergency.status.toLowerCase().includes(term),
    );
  }, [active, all, query, scope]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-64" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations / incident queue"
        title={canCreate ? 'Emergencies' : 'Emergency queue'}
        description="Active and recent incidents, ordered by the server's queue. Priority, status and assignment are never inferred locally."
        icon={<Siren size={21} />}
        status={<Badge variant="outline">{active.length} active</Badge>}
        actions={
          canCreate ? (
            <Button variant="emergency" onClick={() => setReportOpen(true)}>
              <Siren size={16} />
              Report emergency
            </Button>
          ) : undefined
        }
      />

      {lastReported && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-xl border border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] p-3.5"
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--success)]">
            <CheckCircle2 size={14} className="flex-none" />
            <span className="font-mono font-semibold">{lastReported.id}</span>
            reported
            <Badge variant="outline" className="text-[9px]">{lastReported.status.replace(/_/g, ' ')}</Badge>
            <Link to={`/emergencies/${lastReported.id}`} className="font-semibold underline underline-offset-2">
              Open incident
            </Link>
          </div>
          <button
            type="button"
            onClick={() => setLastReported(null)}
            aria-label="Dismiss confirmation"
            className="rounded p-0.5 text-[var(--success)] transition-colors hover:bg-[var(--success)]/10"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Active incidents" value={active.length} icon={<Siren size={17} />} tone="danger" hint="Open across all priorities" />
        <StatCard label="Critical" value={critical.length} icon={<AlertTriangle size={17} />} tone="danger" hint="Highest triage priority" />
        <StatCard label="Resolved" value={resolved.length} icon={<CheckCircle2 size={17} />} tone="success" hint="Completed or cancelled" />
        <StatCard label="Total on record" value={all.length} icon={<Activity size={17} />} tone="info" hint="Visible to this session" />
      </div>

      {isError && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={16} className="mt-0.5 flex-none text-[var(--warning)]" />
            <div>
              <p className="text-sm font-medium">The incident queue could not be refreshed</p>
              <p className="text-xs text-[var(--muted-foreground)]">No incidents have been substituted locally.</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>Try again</Button>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1">
          {(['active', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setScope(value)}
              aria-pressed={scope === value}
              className={
                scope === value
                  ? 'rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-foreground)]'
                  : 'rounded-md px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
              }
            >
              {value === 'active' ? `Active (${active.length})` : `All (${all.length})`}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search id, type, location…"
            className="h-9 pl-9 text-xs"
            aria-label="Filter emergencies"
          />
        </div>
      </div>

      {(emergencies || []).length === 0 ? (
        <EmptyState
          icon={<Siren size={20} />}
          title="No emergencies on record yet"
          description="New reports appear here as soon as the API records them."
          action={
            canCreate ? (
              <Button variant="emergency" size="sm" onClick={() => setReportOpen(true)}>
                <Siren size={14} />
                Report emergency
              </Button>
            ) : undefined
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          compact
          icon={<Search size={18} />}
          title="No incidents match this view"
          description="Adjust the search text or switch to All to widen the queue."
        />
      ) : (
        <div className="space-y-2.5">
          {visible.map((emg: Emergency) => (
            <Card key={emg.id} variant={emg.priority === 'CRITICAL' ? 'critical' : 'interactive'} className="overflow-hidden">
              <CardContent className="p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      aria-hidden="true"
                      className={
                        emg.priority === 'CRITICAL'
                          ? 'mt-1.5 h-2.5 w-2.5 flex-none rounded-full bg-[var(--danger)]'
                          : emg.priority === 'HIGH'
                            ? 'mt-1.5 h-2.5 w-2.5 flex-none rounded-full bg-[var(--warning)]'
                            : emg.priority === 'MEDIUM'
                              ? 'mt-1.5 h-2.5 w-2.5 flex-none rounded-full bg-[var(--info)]'
                              : 'mt-1.5 h-2.5 w-2.5 flex-none rounded-full bg-[var(--muted-foreground)]'
                      }
                    />
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{emg.id}</span>
                        <Badge variant={PRIORITY_VARIANT[emg.priority]}>{emg.priority}</Badge>
                        <Badge variant="outline">{emg.status.replace(/_/g, ' ')}</Badge>
                      </div>
                      <p className="text-sm font-medium">{emg.incidentType.replace(/_/g, ' ')}</p>
                      <p className="line-clamp-2 max-w-3xl text-sm leading-relaxed text-[var(--muted-foreground)]">
                        {emg.description}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1 text-xs text-[var(--muted-foreground)]">
                        <span className="flex items-center gap-1.5"><MapPin size={12} />{locationLabel(emg)}</span>
                        <span className="flex items-center gap-1.5">
                          <Clock size={12} />
                          {formatDistanceToNow(new Date(emg.reportedAt), { addSuffix: true })}
                        </span>
                        <span>Victims: {emg.victimCount}</span>
                        <span>Source: {emg.source.replace(/_/g, ' ')}</span>
                        {emg.assignedAmbulance && (
                          <span className="flex items-center gap-1.5 font-mono"><Truck size={12} />{emg.assignedAmbulance}</span>
                        )}
                        {emg.destinationHospital && (
                          <span className="flex items-center gap-1.5 font-mono"><Building2 size={12} />{emg.destinationHospital}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <Link to={`/emergencies/${emg.id}`} className="flex-none">
                    <Button variant="outline" size="sm" className="gap-1.5">
                      <Eye size={14} />
                      Open incident
                      <ArrowRight size={12} />
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {canCreate && (
        <ReportEmergencyDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          onCreated={(emergency) => setLastReported(emergency)}
        />
      )}
    </div>
  );
}

/**
 * The voice report an emergency was raised from.
 *
 * The API attaches a `voiceReport` block only when *this* caller is in scope
 * for it, and that block carries server-derived `capabilities` — so the
 * transcript, the recording and the review actions offered here are exactly the
 * ones the voice workspace would offer to the same person.
 *
 * The full record is fetched through the voice route, which re-evaluates the
 * scope; a refused request renders nothing at all rather than an empty shell.
 * `onConfirm` / `onDiscard` are deliberately not wired: confirming a report
 * belongs to the review workflow in the voice workspace, not to a bystander
 * reading an incident page.
 */
function EmergencyVoiceReportCard({ voiceReport }: { voiceReport: EmergencyVoiceReportRef }) {
  const queryClient = useQueryClient();
  const { data: detail, isLoading } = useQuery({
    queryKey: ['voice-report-detail', voiceReport.id],
    queryFn: () => api.voice.getReport(voiceReport.id),
    retry: false,
  });

  if (isLoading) return <Skeleton className="h-24 rounded-xl" />;
  if (!detail) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Mic size={14} className="text-[var(--primary)]" /> Originating voice report
        </CardTitle>
      </CardHeader>
      <CardContent>
        <VoiceScopedDetail
          detail={detail}
          onUpdated={() => {
            void queryClient.invalidateQueries({ queryKey: ['voice-report-detail', voiceReport.id] });
            void queryClient.invalidateQueries({ queryKey: ['voice-reports'] });
            void queryClient.invalidateQueries({ queryKey: ['emergencies'] });
          }}
        />
      </CardContent>
    </Card>
  );
}

export function EmergencyDetailPage() {
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const [overrideOpen, setOverrideOpen] = useState(false);
  // The detail endpoint is the authoritative record for one incident, and the
  // only one that carries the per-caller `voiceReport` block — that block is
  // derived from *this* caller's scope at request time, so it cannot be taken
  // from a list built for a different set of rows.
  const { id: paramId } = useParams<{ id: string }>();
  const id = paramId ?? window.location.pathname.split('/').pop() ?? '';
  const { data: emergency, isLoading } = useQuery({
    queryKey: ['emergency', id],
    queryFn: () => api.emergencies.getById(id),
    enabled: Boolean(id),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }
  if (!emergency) {
    return (
      <EmptyState
        icon={<Siren size={20} />}
        title="Emergency not found"
        description="This incident is not available to the current session, or it no longer exists."
        action={
          <Link to="/emergencies">
            <Button variant="outline" size="sm" className="gap-1.5">
              <ArrowLeft size={13} />
              Back to queue
            </Button>
          </Link>
        }
      />
    );
  }

  const timelineStatuses = ['REPORTED', 'TRIAGED', 'DISPATCHING', 'AMBULANCE_ASSIGNED', 'EN_ROUTE', 'AT_SCENE', 'PATIENT_ONBOARD', 'EN_ROUTE_TO_HOSPITAL', 'AT_HOSPITAL', 'COMPLETED'];
  const canOverride = can(user?.role, 'emergency:override', user?.permissions);
  const canDispatch = can(user?.role, 'dispatch:assign', user?.permissions) || can(user?.role, 'dispatch-intel:view', user?.permissions);
  const canTrack = can(user?.role, 'tracking:read:all', user?.permissions) || can(user?.role, 'tracking:read:own', user?.permissions);
  const isDispatchable = !emergency.assignedAmbulance && emergency.status !== 'COMPLETED' && emergency.status !== 'CANCELLED';
  const currentIndex = timelineStatuses.indexOf(emergency.status);

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/emergencies"
          className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        >
          <ArrowLeft size={12} />
          Incident queue
        </Link>
        <PageHeader
          eyebrow={`Operations / incident / ${emergency.incidentType.replace(/_/g, ' ')}`}
          title={<span className="font-mono">{emergency.id}</span>}
          description={`${emergency.incidentType.replace(/_/g, ' ')} · reported ${formatDistanceToNow(new Date(emergency.reportedAt), { addSuffix: true })}`}
          icon={<Siren size={21} />}
          status={
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant={PRIORITY_VARIANT[emergency.priority]}>{emergency.priority}</Badge>
              <Badge variant="outline">{emergency.status.replace(/_/g, ' ')}</Badge>
            </span>
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {canDispatch && isDispatchable && (
                <Link to={`/dispatch?emergencyId=${emergency.id}`}>
                  <Button variant="default" size="sm" className="gap-1.5">
                    <Radio size={14} />
                    Dispatch unit
                  </Button>
                </Link>
              )}
              {canTrack && isOpen(emergency) && (
                <Link to="/tracking">
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <MapPin size={14} />
                    Live map
                  </Button>
                </Link>
              )}
              {canOverride && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 border-[var(--destructive)]/40 text-[var(--destructive)]"
                  onClick={() => setOverrideOpen(true)}
                >
                  <ShieldAlert size={14} />
                  Emergency override
                </Button>
              )}
            </div>
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Main Info */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Activity size={15} className="text-[var(--primary)]" />
                Incident details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  { label: 'Location', value: locationLabel(emergency) },
                  { label: 'Source', value: emergency.source.replace(/_/g, ' ') },
                  { label: 'Victims', value: String(emergency.victimCount) },
                  { label: 'Reported', value: new Date(emergency.reportedAt).toLocaleString() },
                  { label: 'Ambulance', value: emergency.assignedAmbulance || '—', mono: true },
                  { label: 'Hospital', value: emergency.destinationHospital || '—', mono: true },
                ].map((field) => (
                  <div key={field.label} className="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] px-3 py-2.5">
                    <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">{field.label}</p>
                    <p className={field.mono ? 'mt-1 font-mono text-xs font-medium' : 'mt-1 text-xs font-medium'}>
                      {field.value}
                    </p>
                  </div>
                ))}
              </div>
              <p className="border-t border-[var(--border)] pt-3 leading-relaxed">{emergency.description}</p>
              {emergency.attachments && emergency.attachments.length > 0 && (
                <div className="border-t border-[var(--border)] pt-3">
                  <p className="mb-2 text-xs font-medium text-[var(--muted-foreground)]">
                    Report photos ({emergency.attachments.length})
                  </p>
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {emergency.attachments.map((photo, index) => (
                      <li key={`${photo.name}-${index}`}>
                        <a
                          href={photo.dataUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="block overflow-hidden rounded-lg border border-[var(--border)]"
                        >
                          <img
                            src={photo.dataUrl}
                            alt={photo.name}
                            loading="lazy"
                            className="h-28 w-full object-cover transition hover:opacity-90"
                          />
                        </a>
                        <p className="mt-1 truncate text-[10px] text-[var(--muted-foreground)]">{photo.name}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          {emergency.voiceReport && <EmergencyVoiceReportCard voiceReport={emergency.voiceReport} />}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Clock size={15} className="text-[var(--primary)]" />
                Emergency timeline
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="relative">
                {timelineStatuses.map((status, i) => {
                  const isCompleted = i <= currentIndex;
                  const isCurrent = i === currentIndex;
                  const timelineEntry = emergency.timeline.find((t) => t.status === status);
                  return (
                    <div key={status} className="flex items-start gap-4 pb-5 last:pb-0">
                      <div className="flex flex-col items-center">
                        <div
                          className={
                            isCompleted
                              ? isCurrent
                                ? 'h-4 w-4 rounded-full border-2 border-[var(--primary)] bg-[var(--primary)] ring-4 ring-[color-mix(in_srgb,var(--primary)_16%,transparent)]'
                                : 'h-4 w-4 rounded-full border-2 border-[var(--primary)] bg-[var(--primary)]'
                              : 'h-4 w-4 rounded-full border-2 border-[var(--border)] bg-[var(--muted)]'
                          }
                        />
                        {i < timelineStatuses.length - 1 && (
                          <div className={`h-full min-h-[22px] w-px ${isCompleted ? 'bg-[var(--primary)]/45' : 'bg-[var(--border)]'}`} />
                        )}
                      </div>
                      <div className={`-mt-0.5 min-w-0 ${isCompleted ? '' : 'opacity-55'}`}>
                        <p className="text-sm font-medium">{status.replace(/_/g, ' ')}</p>
                        {timelineEntry && (
                          <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-foreground)]">
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
          {canDispatch && isDispatchable && (
            <Card className="border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_5%,transparent)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-1.5 text-[var(--primary)]">
                  <Radio size={14} />
                  Ambulance Dispatch Required
                </CardTitle>
                <p className="text-xs text-[var(--muted-foreground)]">
                  Incident is awaiting manual ambulance review and authorization.
                </p>
              </CardHeader>
              <CardContent className="pt-2">
                <Link to={`/dispatch?emergencyId=${emergency.id}`} className="block">
                  <Button size="sm" className="w-full gap-1.5">
                    <Radio size={13} />
                    View Dispatch Candidates
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {emergency.aiRecommendations && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Recommendation context</CardTitle>
                <p className="text-xs text-[var(--muted-foreground)]">Server-supplied scores; human decision remains required.</p>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--muted-foreground)]">Ambulance score</span>
                  <span className="font-mono font-semibold">{emergency.aiRecommendations.ambulanceScore}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--muted-foreground)]">Hospital score</span>
                  <span className="font-mono font-semibold">{emergency.aiRecommendations.hospitalScore}</span>
                </div>
                <div className="border-t border-[var(--border)] pt-2">
                  <p className="mb-1 text-xs text-[var(--muted-foreground)]">Reasoning</p>
                  <ul className="space-y-1">
                    {emergency.aiRecommendations.reasoning.map((reason, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs leading-relaxed">
                        <span className="text-[var(--primary)]">•</span>
                        {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Assigned crew</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {(emergency.assignedCrew || []).length === 0 ? (
                <p className="py-2 text-xs text-[var(--muted-foreground)]">No crew assigned yet.</p>
              ) : (
                (emergency.assignedCrew || []).map((crew, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--muted)] text-[10px] font-semibold">
                      {crew.split(' ').map((n) => n[0]).join('')}
                    </div>
                    <span>{crew}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <EmergencyOverrideDialog
        open={overrideOpen}
        emergency={emergency}
        onOpenChange={setOverrideOpen}
        onApplied={() => {
          void queryClient.invalidateQueries({ queryKey: ['emergencies'] });
          void queryClient.invalidateQueries({ queryKey: ['emergency', emergency.id] });
          setOverrideOpen(false);
        }}
      />
    </div>
  );
}

function EmergencyOverrideDialog({
  open,
  emergency,
  onOpenChange,
  onApplied,
}: {
  open: boolean;
  emergency: Emergency;
  onOpenChange: (open: boolean) => void;
  onApplied: () => void;
}) {
  const [action, setAction] = useState<NonNullable<Parameters<typeof api.emergencies.override>[1]>['action']>('ESCALATE');
  const [reason, setReason] = useState('');
  const [ambulanceId, setAmbulanceId] = useState('');
  const [hospitalId, setHospitalId] = useState(emergency.destinationHospital ?? '');
  const [priority, setPriority] = useState<Emergency['priority']>('CRITICAL');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => api.emergencies.override(emergency.id, { action, reason: reason.trim(), ...(action === 'REASSIGN_AMBULANCE' ? { ambulanceId: ambulanceId.trim() } : {}), ...(action === 'ROUTE_HOSPITAL' ? { hospitalId: hospitalId.trim() } : {}), ...(action === 'ESCALATE' ? { priority } : {}) }),
    onSuccess: () => { setError(null); onApplied(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Override failed'),
  });
  const submit = () => {
    setError(null);
    if (reason.trim().length < 10) { setError('A reason of at least 10 characters is required.'); return; }
    if (action === 'REASSIGN_AMBULANCE' && !ambulanceId.trim()) { setError('Enter the replacement ambulance ID.'); return; }
    if (action === 'ROUTE_HOSPITAL' && !hospitalId.trim()) { setError('Enter the destination hospital ID.'); return; }
    mutation.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert size={18} className="text-[var(--destructive)]" /> Emergency override
          </DialogTitle>
          <DialogDescription>
            Break-glass actions for {emergency.id}. The actor, reason, timestamp, previous state, and
            new state are written to the immutable audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm font-medium">
            Action
            <select
              className="mt-1 h-10 w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2 text-sm"
              value={action}
              onChange={(event) => setAction(event.target.value as typeof action)}
            >
              <option value="ESCALATE">Escalate priority</option>
              <option value="REASSIGN_AMBULANCE">Reassign ambulance</option>
              <option value="ROUTE_HOSPITAL">Override hospital routing</option>
              <option value="ACTIVATE_GREEN_CORRIDOR">Activate Green Corridor</option>
            </select>
          </label>
          {action === 'ESCALATE' && (
            <label className="block text-sm font-medium">
              Priority
              <select
                className="mt-1 h-10 w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2 text-sm"
                value={priority}
                onChange={(event) => setPriority(event.target.value as Emergency['priority'])}
              >
                {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
          )}
          {action === 'REASSIGN_AMBULANCE' && (
            <label className="block text-sm font-medium">
              Replacement ambulance ID
              <Input className="mt-1" value={ambulanceId} onChange={(event) => setAmbulanceId(event.target.value)} placeholder="AMB-005" />
            </label>
          )}
          {action === 'ROUTE_HOSPITAL' && (
            <label className="block text-sm font-medium">
              Destination hospital ID
              <Input className="mt-1" value={hospitalId} onChange={(event) => setHospitalId(event.target.value)} placeholder="HOSP-01" />
            </label>
          )}
          <label className="block text-sm font-medium">
            Reason (required)
            <Textarea className="mt-1" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the safety-critical reason for bypassing normal workflow." />
          </label>
          {error && <p role="alert" className="text-sm text-[var(--destructive)]">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? 'Applying…' : 'Confirm override'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
