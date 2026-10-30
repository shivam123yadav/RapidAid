import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  Download,
  FileText,
  Plus,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can } from '../lib/permissions';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import type { ReportRecord, ReportType } from '../types';

const typeLabel: Record<ReportType, string> = {
  INCIDENT_SUMMARY: 'Incident summary',
  RESPONSE_PERFORMANCE: 'Response performance',
  FLEET_UTILIZATION: 'Fleet utilization',
  HOSPITAL_CAPACITY: 'Hospital capacity',
  MAINTENANCE: 'Maintenance',
  CUSTOM: 'Custom',
};

const statusVariant = (status: ReportRecord['status']) =>
  status === 'READY' ? 'success' : status === 'FAILED' ? 'destructive' : 'warning';

function download(name: string, body: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  const user = useAuthStore((state) => state.user);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = new Date();
  const [title, setTitle] = useState('Operational Report');
  const [reportType, setReportType] = useState<ReportType>('INCIDENT_SUMMARY');
  const [periodFrom, setPeriodFrom] = useState(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10));
  const [periodTo, setPeriodTo] = useState(now.toISOString().slice(0, 10));
  const held = user?.permissions;
  const canCreate = can(user?.role, 'report:create', held) || can(user?.role, 'report:generate', held);
  const canExport = can(user?.role, 'report:export', held);
  const canSensitive = canExport && can(user?.role, 'report:export:sensitive', held) && can(user?.role, 'patient:export', held);
  const { data: reports, isLoading } = useQuery({ queryKey: ['reports'], queryFn: api.reports.list });
  const createMutation = useMutation({
    mutationFn: () => api.reports.create({
      title: title.trim(),
      reportType,
      periodFrom: new Date(`${periodFrom}T00:00:00.000Z`).toISOString(),
      periodTo: new Date(`${periodTo}T23:59:59.999Z`).toISOString(),
    }),
    onSuccess: (created) => {
      setOpen(false);
      setError(null);
      setNotice(`Report ${created.id} queued for generation.`);
      void client.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Report generation failed'),
  });
  const exportReport = async (report: ReportRecord, sensitive = false) => {
    try {
      setError(null);
      download(
        `${report.id}-${sensitive ? 'sensitive' : 'sanitized'}.json`,
        sensitive ? await api.reports.exportSensitive(report.id) : await api.reports.export(report.id),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Report export failed');
    }
  };

  const all = reports ?? [];
  const ready = all.filter((report) => report.status === 'READY').length;
  const generating = all.filter((report) => report.status === 'GENERATING').length;
  const failed = all.filter((report) => report.status === 'FAILED').length;
  const typeCount = useMemo(() => new Set(all.map((report) => report.reportType)).size, [all]);

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
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-64 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations / reporting"
        title="Reports"
        description="Point-in-time operational summaries, aggregated only from records inside your resource scope."
        icon={<FileText size={21} />}
        status={<Badge variant="outline" className="gap-1.5"><ShieldCheck size={11} /> Export governed</Badge>}
        actions={
          canCreate ? (
            <Button onClick={() => setOpen(true)}>
              <Plus size={15} />
              Generate report
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Reports" value={all.length} icon={<FileText size={17} />} tone="primary" hint="Visible to this session" />
        <StatCard label="Ready" value={ready} icon={<CheckCircle2 size={17} />} tone="success" hint="Available to export" />
        <StatCard label="Generating" value={generating} icon={<CalendarRange size={17} />} tone="warning" hint="Still processing" />
        <StatCard label="Report types" value={typeCount} icon={<FileText size={17} />} tone={failed > 0 ? 'danger' : 'info'} hint={failed > 0 ? `${failed} failed` : 'Distinct types on record'} />
      </div>

      {notice && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-xl border border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] p-3.5">
          <p className="flex items-center gap-2 text-xs text-[var(--success)]">
            <CheckCircle2 size={14} className="flex-none" />
            {notice}
          </p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notification"
            className="rounded p-0.5 text-[var(--success)] transition-colors hover:bg-[var(--success)]/10"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
          <AlertTriangle size={15} className="mt-0.5 flex-none text-[var(--destructive)]" />
          <p className="text-xs leading-relaxed text-[var(--destructive)]">{error}</p>
        </div>
      )}

      <div className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] p-3.5">
        <ShieldAlert size={15} className="mt-0.5 flex-none text-[var(--warning)]" />
        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
          <span className="font-semibold text-[var(--foreground)]">Default exports contain aggregate counts only.</span>{' '}
          Sensitive emergency and patient-linked data requires all three export permissions and is audited.
        </p>
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<FileText size={20} />}
          title="No reports generated yet"
          description="Generate an operational summary to aggregate the emergency records in your scope for a chosen period."
          action={
            canCreate ? (
              <Button size="sm" onClick={() => setOpen(true)}>
                <Plus size={14} />
                Generate report
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {all.map((report) => (
            <Card key={report.id} variant="interactive" className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">{report.title}</CardTitle>
                    <p className="mt-1 font-mono text-[11px] text-[var(--muted-foreground)]">
                      {report.id} · {typeLabel[report.reportType]}
                    </p>
                  </div>
                  <Badge variant={statusVariant(report.status)} className="flex-none text-[9px]">{report.status}</Badge>
                </div>
                <CardDescription className="mt-2 flex items-center gap-1.5 text-[11px]">
                  <CalendarRange size={11} />
                  {new Date(report.periodFrom).toLocaleDateString()} – {new Date(report.periodTo).toLocaleDateString()}
                  <span className="text-[var(--muted-foreground)]">·</span>
                  created {formatDistanceToNow(new Date(report.createdAt), { addSuffix: true })}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    ['Incidents', report.summary.totalEmergencies],
                    ['Active', report.summary.activeEmergencies],
                    ['Critical', report.summary.criticalEmergencies],
                    ['Victims', report.summary.totalVictims],
                  ].map(([label, value]) => (
                    <div
                      key={String(label)}
                      className="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] px-2.5 py-2"
                    >
                      <p className="operational-number text-lg font-semibold leading-none">{value}</p>
                      <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">{label}</p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
                  {canExport && (
                    <Button size="sm" variant="outline" onClick={() => void exportReport(report)}>
                      <Download size={13} />
                      Sanitized export
                    </Button>
                  )}
                  {canSensitive && (
                    <Button size="sm" variant="destructive" onClick={() => void exportReport(report, true)}>
                      <ShieldAlert size={13} />
                      Sensitive export
                    </Button>
                  )}
                  {!canExport && (
                    <p className="text-[11px] text-[var(--muted-foreground)]">
                      Export requires the report export permission.
                    </p>
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
            <DialogTitle>Generate report</DialogTitle>
            <DialogDescription>
              Only emergency records within your resource scope are aggregated. The export permission
              set is checked separately when a file is downloaded.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="report-title">Title</Label>
              <Input id="report-title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="report-type">Report type</Label>
              <Select value={reportType} onValueChange={(value) => setReportType(value as ReportType)}>
                <SelectTrigger id="report-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(typeLabel) as ReportType[]).map((item) => (
                    <SelectItem key={item} value={item}>{typeLabel[item]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="report-from">From</Label>
                <Input id="report-from" type="date" value={periodFrom} onChange={(event) => setPeriodFrom(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="report-to">To</Label>
                <Input id="report-to" type="date" value={periodTo} onChange={(event) => setPeriodTo(event.target.value)} />
              </div>
            </div>
            {error && (
              <p role="alert" className="rounded-lg border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-2.5 text-xs text-[var(--destructive)]">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!title.trim() || !periodFrom || !periodTo || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Generating…' : 'Generate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
