import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { Filter, Search, Shield, Users, Layers, FileClock } from 'lucide-react';
import type { AuditEntry } from '../types';

export function AuditPage() {
  const { data: entries, isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: api.audit.list,
  });
  const [action, setAction] = useState('ALL');
  const [query, setQuery] = useState('');

  const all = entries ?? [];
  const actions = useMemo(
    () => Array.from(new Set(all.map((entry) => entry.action))).sort(),
    [all],
  );
  const actors = useMemo(
    () => new Set(all.map((entry) => entry.actor)).size,
    [all],
  );
  const resources = useMemo(
    () => new Set(all.map((entry) => entry.resource)).size,
    [all],
  );

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return all.filter((entry) => {
      if (action !== 'ALL' && entry.action !== action) return false;
      if (!term) return true;
      return (
        entry.actor.toLowerCase().includes(term) ||
        entry.action.toLowerCase().includes(term) ||
        entry.resource.toLowerCase().includes(term) ||
        entry.resourceId.toLowerCase().includes(term) ||
        entry.requestId.toLowerCase().includes(term) ||
        (entry.details ?? '').toLowerCase().includes(term)
      );
    });
  }, [action, all, query]);

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
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Governance / audit trail"
        title="Audit log"
        description="Permission-scoped record of operational actions, with actor, resource and request identifiers."
        icon={<Shield size={21} />}
        status={<Badge variant="outline">Read-only</Badge>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Audit entries" value={all.length} icon={<FileClock size={17} />} tone="primary" hint="Visible to this session" />
        <StatCard label="Distinct actors" value={actors} icon={<Users size={17} />} tone="info" hint="Across the visible window" />
        <StatCard label="Distinct resources" value={resources} icon={<Layers size={17} />} tone="neutral" hint="Resource types touched" />
        <StatCard label="Action types" value={actions.length} icon={<Shield size={17} />} tone="success" hint="Unique recorded actions" />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Filter size={13} className="text-[var(--muted-foreground)]" />
          <select
            value={action}
            onChange={(event) => setAction(event.target.value)}
            aria-label="Filter audit entries by action"
            className="h-9 rounded-lg border border-[var(--input)] bg-[var(--card)] px-2.5 text-xs"
          >
            <option value="ALL">All actions ({all.length})</option>
            {actions.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actor, resource, request id…"
            className="h-9 pl-9 text-xs"
            aria-label="Search audit entries"
          />
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {visible.length === 0 ? (
            <EmptyState
              compact
              icon={<Shield size={18} />}
              title="No audit entries match"
              description={all.length === 0 ? 'No audit entries are visible to this session.' : 'Adjust the action filter or search text.'}
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left">
                    <th scope="col" className="whitespace-nowrap p-3 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Timestamp</th>
                    <th scope="col" className="p-3 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Actor</th>
                    <th scope="col" className="p-3 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Action</th>
                    <th scope="col" className="p-3 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Resource</th>
                    <th scope="col" className="p-3 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Request ID</th>
                    <th scope="col" className="p-3 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((entry: AuditEntry) => (
                    <tr key={entry.id} className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--muted)]/50">
                      <td className="whitespace-nowrap p-3 font-mono text-xs text-[var(--muted-foreground)]">
                        {new Date(entry.timestamp).toLocaleString()}
                      </td>
                      <td className="p-3">
                        <p className="text-xs font-medium">{entry.actor}</p>
                        <Badge variant="outline" className="mt-0.5 text-[9px]">{entry.actorRole}</Badge>
                      </td>
                      <td className="p-3 font-mono text-xs">{entry.action}</td>
                      <td className="p-3">
                        <span className="text-xs">{entry.resource}</span>
                        <span className="ml-1 font-mono text-[10px] text-[var(--muted-foreground)]">{entry.resourceId}</span>
                      </td>
                      <td className="p-3 font-mono text-[10px] text-[var(--muted-foreground)]">{entry.requestId}</td>
                      <td className="max-w-[220px] truncate p-3 text-xs text-[var(--muted-foreground)]">{entry.details || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
