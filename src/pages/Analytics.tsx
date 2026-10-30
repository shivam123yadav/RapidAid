import { useQuery } from '@tanstack/react-query';
import { useReducedMotion } from 'framer-motion';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import { BarChart3, TrendingUp, Clock, Truck, Activity, Building2, PieChart as PieIcon } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];

function formatResponse(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  return `${Math.floor(seconds / 60)}:${Math.round(seconds % 60).toString().padStart(2, '0')}`;
}

export function AnalyticsPage() {
  const reduce = useReducedMotion() ?? false;
  const { data: analytics, isLoading, isError, refetch } = useQuery({
    queryKey: ['analytics'],
    queryFn: api.analytics.getData,
  });

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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-80 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (isError || !analytics) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Analytics"
          title="Operational performance"
          description="Response, fleet and hospital metrics from the live API."
          icon={<BarChart3 size={21} />}
        />
        <EmptyState
          icon={<BarChart3 size={20} />}
          title="Analytics are unavailable"
          description="The API did not return analytics data. Nothing has been substituted."
          action={<button type="button" onClick={() => void refetch()} className="text-sm font-semibold text-[var(--primary)] hover:underline">Try again</button>}
        />
      </div>
    );
  }

  const data = analytics;
  const totalEmergencies = data.emergencyVolume.reduce((sum, d) => sum + d.count, 0);
  const avgResponse = data.responseTimes.length
    ? Math.round(data.responseTimes.reduce((sum, d) => sum + d.median, 0) / data.responseTimes.length)
    : 0;
  const avgUtilization = data.ambulanceUtilization.length
    ? Math.round(data.ambulanceUtilization.reduce((sum, d) => sum + d.utilization, 0) / data.ambulanceUtilization.length)
    : 0;
  const peakDay = data.emergencyVolume.reduce(
    (peak, day) => (day.count > peak.count ? day : peak),
    data.emergencyVolume[0] ?? { date: '', count: 0 },
  );

  const tooltipStyle = {
    backgroundColor: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    color: 'var(--foreground)',
    boxShadow: 'var(--shadow-pop)',
    fontSize: '12px',
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Analytics / last 7 days"
        title="Operational performance"
        description="Response, fleet and hospital metrics from the live API. Charts use the active theme's semantic token palette."
        icon={<BarChart3 size={21} />}
        actions={
          <span className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
            <span className="status-dot status-dot--live text-[var(--success)]" aria-hidden="true" />
            Live query
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Total emergencies"
          value={totalEmergencies}
          icon={<Activity size={17} />}
          tone="danger"
          hint="Incidents recorded across the 7-day window"
        />
        <StatCard
          label="Median response"
          value={formatResponse(avgResponse)}
          icon={<Clock size={17} />}
          tone="warning"
          hint="Mean of each day's median"
        />
        <StatCard
          label="Fleet utilisation"
          value={avgUtilization}
          suffix="%"
          icon={<Truck size={17} />}
          tone="info"
          hint="Average across the reporting window"
        />
        <StatCard
          label="Peak daily volume"
          value={peakDay.count}
          icon={<TrendingUp size={17} />}
          tone="success"
          hint={peakDay.date ? new Date(peakDay.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : 'No volume recorded'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2"><Activity size={16} className="text-[var(--danger)]" /> Emergency volume</CardTitle>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Incidents per day</p>
              </div>
              <TypographyStat value={totalEmergencies} label="total" />
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <ResponsiveContainer width="100%" height={248}>
              <AreaChart data={data.emergencyVolume} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="volume-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" tickFormatter={(v) => new Date(v).toLocaleDateString('en-US', { weekday: 'short' })} />
                <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="var(--primary)"
                  fill="url(#volume-fill)"
                  strokeWidth={2}
                  isAnimationActive={!reduce}
                  animationDuration={650}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2"><Clock size={16} className="text-[var(--warning)]" /> Response times</CardTitle>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Median and 90th percentile, in minutes</p>
              </div>
              <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">P50 / P90</span>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <ResponsiveContainer width="100%" height={248}>
              <AreaChart data={data.responseTimes} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" tickFormatter={(v) => new Date(v).toLocaleDateString('en-US', { weekday: 'short' })} />
                <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" tickFormatter={(v) => `${Math.floor(v / 60)}m`} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${Math.floor(v / 60)}m ${Math.round(v % 60)}s`} />
                <Area type="monotone" dataKey="p90" stroke="var(--warning)" fill="var(--warning)" fillOpacity={0.08} strokeWidth={2} name="P90" isAnimationActive={!reduce} animationDuration={650} />
                <Area type="monotone" dataKey="median" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.08} strokeWidth={2} name="Median" isAnimationActive={!reduce} animationDuration={650} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2"><PieIcon size={16} className="text-[var(--primary)]" /> Incident mix</CardTitle>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Share of incidents by type</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            {data.incidentTypes.length === 0 ? (
              <EmptyState compact title="No incident types yet" description="There is no data in this reporting window." />
            ) : (
              <ResponsiveContainer width="100%" height={248}>
                <PieChart>
                  <Pie
                    data={data.incidentTypes}
                    cx="50%"
                    cy="50%"
                    innerRadius={54}
                    outerRadius={88}
                    paddingAngle={2}
                    dataKey="count"
                    nameKey="type"
                    label={({ type, percent }) => `${type} (${(percent * 100).toFixed(0)}%)`}
                    labelLine={false}
                    isAnimationActive={!reduce}
                    animationDuration={650}
                  >
                    {data.incidentTypes.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="var(--card)" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2"><Building2 size={16} className="text-[var(--success)]" /> Hospital load</CardTitle>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Current load by facility</p>
              </div>
              <TypographyStat value={avgUtilization} suffix="%" label="fleet avg." />
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <ResponsiveContainer width="100%" height={248}>
              <BarChart data={data.hospitalLoad} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="hospital" tick={{ fontSize: 9 }} stroke="var(--muted-foreground)" interval={0} />
                <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${v}%`} />
                <Bar dataKey="load" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={38} isAnimationActive={!reduce} animationDuration={650} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <p className="flex items-center gap-2 text-[10px] text-[var(--muted-foreground)]">
        <span className="status-dot text-[var(--success)]" aria-hidden="true" />
        All values are computed from the authenticated analytics endpoint. No illustrative metrics are mixed in.
      </p>
    </div>
  );
}

function TypographyStat({ value, label, suffix = '' }: { value: number; label: string; suffix?: string }) {
  return (
    <div className="text-right">
      <p className="operational-number text-lg font-semibold leading-none">{value}{suffix}</p>
      <p className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">{label}</p>
    </div>
  );
}
