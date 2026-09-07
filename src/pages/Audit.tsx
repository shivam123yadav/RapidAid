import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Shield, Filter } from 'lucide-react';
import type { AuditEntry } from '../types';

export function AuditPage() {
  const { data: entries, isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: api.audit.list,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Shield size={24} className="text-[var(--primary)]" />
          Audit Logs
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">System activity and action history</p>
      </div>

      <div className="flex items-center gap-2">
        <Badge variant="outline" className="gap-1"><Filter size={12} /> Filters</Badge>
        <Badge variant="outline">All Actions</Badge>
        <Badge variant="outline">All Resources</Badge>
        <Badge variant="outline">Last 24h</Badge>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left p-3 font-medium text-[var(--muted-foreground)]">Timestamp</th>
                  <th className="text-left p-3 font-medium text-[var(--muted-foreground)]">Actor</th>
                  <th className="text-left p-3 font-medium text-[var(--muted-foreground)]">Action</th>
                  <th className="text-left p-3 font-medium text-[var(--muted-foreground)]">Resource</th>
                  <th className="text-left p-3 font-medium text-[var(--muted-foreground)]">Request ID</th>
                  <th className="text-left p-3 font-medium text-[var(--muted-foreground)]">Details</th>
                </tr>
              </thead>
              <tbody>
                {(entries || []).map((entry: AuditEntry) => (
                  <tr key={entry.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]/50">
                    <td className="p-3 text-xs font-mono text-[var(--muted-foreground)]">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="p-3">
                      <div>
                        <p className="font-medium text-xs">{entry.actor}</p>
                        <Badge variant="outline" className="text-[10px] mt-0.5">{entry.actorRole}</Badge>
                      </div>
                    </td>
                    <td className="p-3 font-mono text-xs">{entry.action}</td>
                    <td className="p-3">
                      <span className="text-xs">{entry.resource}</span>
                      <span className="text-xs text-[var(--muted-foreground)] ml-1 font-mono">{entry.resourceId}</span>
                    </td>
                    <td className="p-3 font-mono text-xs text-[var(--muted-foreground)]">{entry.requestId}</td>
                    <td className="p-3 text-xs text-[var(--muted-foreground)] max-w-[200px] truncate">{entry.details || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
