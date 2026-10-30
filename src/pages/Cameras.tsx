import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Download,
  MapPin,
  Plus,
  Power,
  Radio,
  Search,
  Settings2,
  ShieldCheck,
  Video,
  VideoOff,
  X,
} from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can } from '../lib/permissions';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import type { Camera as CameraRecord, CameraStatus } from '../types';

const variant = (value: CameraStatus) =>
  value === 'ONLINE' ? 'success' : value === 'DEGRADED' ? 'warning' : value === 'OFFLINE' ? 'destructive' : 'outline';

function download(name: string, body: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function CamerasPage() {
  const user = useAuthStore((state) => state.user);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [zone, setZone] = useState('');
  const [lat, setLat] = useState('28.6139');
  const [lng, setLng] = useState('77.209');
  const [retentionDays, setRetentionDays] = useState('30');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | CameraStatus>('ALL');
  const held = user?.permissions;
  const canCreate = can(user?.role, 'camera:create', held) && can(user?.role, 'camera:configure', held);
  const canConfigure = can(user?.role, 'camera:configure', held);
  const canExport = can(user?.role, 'camera:evidence-export', held);
  const { data: cameras, isLoading } = useQuery({ queryKey: ['cameras'], queryFn: api.cameras.list });
  const refresh = () => client.invalidateQueries({ queryKey: ['cameras'] });
  const createMutation = useMutation({
    mutationFn: () => api.cameras.create({
      name: name.trim(),
      zone: zone.trim(),
      location: { lat: Number(lat), lng: Number(lng) },
      liveEnabled: true,
      recordingEnabled: true,
      retentionDays: Number(retentionDays),
    }),
    onSuccess: () => { setOpen(false); setError(null); void refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Camera creation failed'),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.cameras.update>[1] }) => api.cameras.update(id, data),
    onSuccess: () => { setError(null); void refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Camera update failed'),
  });
  const exportEvidence = async (id: string) => {
    try {
      setError(null);
      download(`${id}-evidence.json`, await api.cameras.exportEvidence(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Evidence export failed');
    }
  };

  const all = cameras ?? [];
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return all.filter((camera) => {
      if (statusFilter !== 'ALL' && camera.status !== statusFilter) return false;
      if (!term) return true;
      return (
        camera.name.toLowerCase().includes(term) ||
        camera.zone.toLowerCase().includes(term) ||
        camera.id.toLowerCase().includes(term) ||
        (camera.location.address ?? '').toLowerCase().includes(term)
      );
    });
  }, [all, query, statusFilter]);
  const online = all.filter((camera) => camera.status === 'ONLINE').length;
  const degraded = all.filter((camera) => camera.status === 'DEGRADED').length;
  const offline = all.filter((camera) => camera.status === 'OFFLINE').length;
  const recording = all.filter((camera) => camera.recordingEnabled).length;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-64" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-xl" />)}
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-64 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Intelligence / sensors"
        title="Camera network"
        description="Live availability, recording policy and controlled evidence export. Configuration changes require camera:configure and are audited."
        icon={<Camera size={21} />}
        status={<Badge variant="outline" className="gap-1.5"><ShieldCheck size={11} /> Evidence governed</Badge>}
        actions={
          canCreate ? (
            <Button onClick={() => setOpen(true)}>
              <Plus size={15} />
              Add camera
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Online" value={online} icon={<CheckCircle2 size={17} />} tone="success" hint="Reporting normally" />
        <StatCard label="Degraded" value={degraded} icon={<AlertTriangle size={17} />} tone="warning" hint="Partial availability" />
        <StatCard label="Offline" value={offline} icon={<VideoOff size={17} />} tone="danger" hint="Not reporting" />
        <StatCard label="Recording" value={recording} icon={<Video size={17} />} tone="info" hint="Retention policy active" />
      </div>

      {error && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-[var(--destructive)]">
            <AlertTriangle size={14} className="mt-0.5 flex-none" />
            {error}
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="rounded p-0.5 text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/10"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 w-fit">
          {(['ALL', 'ONLINE', 'DEGRADED', 'OFFLINE'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatusFilter(value)}
              aria-pressed={statusFilter === value}
              className={
                statusFilter === value
                  ? 'rounded-md bg-[var(--primary)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--primary-foreground)]'
                  : 'rounded-md px-2.5 py-1.5 text-[11px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
              }
            >
              {value === 'ALL' ? `All (${all.length})` : `${value.charAt(0)}${value.slice(1).toLowerCase()}`}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search camera, zone, address…"
            className="h-9 pl-9 text-xs"
            aria-label="Search cameras"
          />
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<Camera size={20} />}
          title="No cameras registered"
          description="Cameras appear here once the sensor directory is populated by the API."
          action={
            canCreate ? (
              <Button size="sm" onClick={() => setOpen(true)}>
                <Plus size={14} />
                Add camera
              </Button>
            ) : undefined
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState compact icon={<Search size={18} />} title="No cameras match" description="Adjust the status filter or search text." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((camera: CameraRecord) => (
            <Card key={camera.id} variant="interactive" className="flex flex-col">
              <div className="relative h-28 overflow-hidden border-b border-[var(--border)] bg-[#071019]">
                <div
                  aria-hidden="true"
                  className="absolute inset-0 opacity-40"
                  style={{
                    backgroundImage:
                      'linear-gradient(to right, rgba(103,232,249,0.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(103,232,249,0.12) 1px, transparent 1px)',
                    backgroundSize: '28px 28px',
                  }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-[#4b6178]">
                  {camera.liveEnabled && camera.status !== 'OFFLINE' ? <Video size={24} /> : <VideoOff size={24} />}
                  <span className="font-mono text-[8px] uppercase tracking-[0.14em]">
                    {camera.liveEnabled && camera.status !== 'OFFLINE' ? 'Live metadata only' : 'Feed not live'}
                  </span>
                </div>
                <div className="absolute inset-x-0 top-0 flex items-center justify-between px-2.5 py-2">
                  <span className="rounded-full border border-white/10 bg-black/35 px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.12em] text-white/60 backdrop-blur-sm">
                    {camera.id}
                  </span>
                  <Badge variant={variant(camera.status)} className="text-[9px]">{camera.status}</Badge>
                </div>
              </div>
              <CardHeader className="pb-2 pt-3.5">
                <CardTitle className="truncate text-sm">{camera.name}</CardTitle>
                <p className="text-[11px] text-[var(--muted-foreground)]">{camera.zone}</p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-2.5 text-xs">
                <p className="flex items-start gap-1.5 text-[var(--muted-foreground)]">
                  <MapPin size={12} className="mt-0.5 flex-none" />
                  <span className="min-w-0 truncate">
                    {camera.location.address ?? `${camera.location.lat.toFixed(4)}, ${camera.location.lng.toFixed(4)}`}
                  </span>
                </p>
                <p className="flex items-center gap-1.5 text-[var(--muted-foreground)]">
                  <Radio size={12} className="flex-none" />
                  Live {camera.liveEnabled ? 'enabled' : 'disabled'}
                  {camera.lastHeartbeatAt && (
                    <span className="truncate">· heartbeat {formatDistanceToNow(new Date(camera.lastHeartbeatAt), { addSuffix: true })}</span>
                  )}
                </p>
                {camera.recordingEnabled !== undefined && (
                  <p className="flex items-center gap-1.5 text-[var(--muted-foreground)]">
                    <Settings2 size={12} className="flex-none" />
                    Recording {camera.recordingEnabled ? 'enabled' : 'disabled'} · {camera.retentionDays} days
                  </p>
                )}
                <div className="mt-auto flex flex-wrap gap-2 border-t border-[var(--border)] pt-2.5">
                  {canConfigure && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updateMutation.isPending}
                        onClick={() => updateMutation.mutate({ id: camera.id, data: { status: camera.status === 'OFFLINE' ? 'ONLINE' : 'OFFLINE' } })}
                      >
                        <Power size={12} />
                        {camera.status === 'OFFLINE' ? 'Bring online' : 'Take offline'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updateMutation.isPending}
                        onClick={() => updateMutation.mutate({ id: camera.id, data: { recordingEnabled: !(camera.recordingEnabled ?? false) } })}
                      >
                        {camera.recordingEnabled ? <VideoOff size={12} /> : <Video size={12} />}
                        {camera.recordingEnabled ? 'Stop recording' : 'Start recording'}
                      </Button>
                    </>
                  )}
                  {canExport && (
                    <Button size="sm" variant="ghost" onClick={() => void exportEvidence(camera.id)}>
                      <Download size={12} />
                      Export record
                    </Button>
                  )}
                  {!canConfigure && !canExport && (
                    <p className="text-[11px] text-[var(--muted-foreground)]">View-only camera record.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add camera</DialogTitle>
            <DialogDescription>Configuration changes require camera:configure and are audited.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="camera-name">Name</Label>
              <Input id="camera-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="camera-zone">Zone</Label>
              <Input id="camera-zone" value={zone} onChange={(event) => setZone(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="camera-lat">Latitude</Label>
              <Input id="camera-lat" value={lat} onChange={(event) => setLat(event.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="camera-lng">Longitude</Label>
              <Input id="camera-lng" value={lng} onChange={(event) => setLng(event.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="camera-retention">Retention days</Label>
              <Input id="camera-retention" type="number" min={1} max={365} value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} />
            </div>
          </div>
          {error && (
            <p role="alert" className="rounded-lg border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-2.5 text-xs text-[var(--destructive)]">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!name.trim() || !zone.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Creating…' : 'Create camera'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
