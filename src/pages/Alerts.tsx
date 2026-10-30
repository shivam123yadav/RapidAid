import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import { AlertTriangle, Bell, CheckCircle2, CheckCheck, Info, ShieldAlert, Inbox, ExternalLink } from 'lucide-react';
import type { Notification, NotificationCategory } from '../types';

type CategoryFilter = 'ALL' | NotificationCategory;

export function AlertsPage() {
  const queryClient = useQueryClient();
  const { data: notifications, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: api.notifications.list,
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const [category, setCategory] = useState<CategoryFilter>('ALL');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const all = notifications ?? [];
  const unread = all.filter((notification) => !notification.read).length;
  const counts = useMemo(
    () => ({
      CRITICAL: all.filter((notification) => notification.category === 'CRITICAL').length,
      WARNING: all.filter((notification) => notification.category === 'WARNING').length,
      INFO: all.filter((notification) => notification.category === 'INFO').length,
      SUCCESS: all.filter((notification) => notification.category === 'SUCCESS').length,
    }),
    [all],
  );

  const visible = useMemo(
    () =>
      all.filter(
        (notification) =>
          (category === 'ALL' || notification.category === category) &&
          (!unreadOnly || !notification.read),
      ),
    [all, category, unreadOnly],
  );

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
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const categoryIcon = (cat: NotificationCategory) => {
    switch (cat) {
      case 'CRITICAL': return <AlertTriangle size={16} />;
      case 'WARNING': return <AlertTriangle size={16} />;
      case 'INFO': return <Info size={16} />;
      case 'SUCCESS': return <CheckCircle2 size={16} />;
    }
  };

  const categoryTone = (cat: NotificationCategory) => {
    const map: Record<NotificationCategory, string> = {
      CRITICAL: 'text-[var(--danger)]',
      WARNING: 'text-[var(--warning)]',
      INFO: 'text-[var(--info)]',
      SUCCESS: 'text-[var(--success)]',
    };
    return map[cat];
  };

  const categoryVariant = (cat: NotificationCategory) => {
    const map: Record<NotificationCategory, 'critical' | 'warning' | 'info' | 'success'> = {
      CRITICAL: 'critical', WARNING: 'warning', INFO: 'info', SUCCESS: 'success',
    };
    return map[cat];
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace / notifications"
        title="Alerts & notifications"
        description="System alerts, emergency notifications and status updates delivered to this session."
        icon={<Bell size={21} />}
        status={
          <Badge variant={unread > 0 ? 'warning' : 'outline'} className="gap-1.5">
            <span className={unread > 0 ? 'status-dot status-dot--live text-[var(--warning)]' : 'status-dot text-[var(--muted-foreground)]'} aria-hidden="true" />
            {unread > 0 ? `${unread} unread` : 'All read'}
          </Badge>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Critical" value={counts.CRITICAL} icon={<ShieldAlert size={17} />} tone="danger" hint="Requires immediate attention" />
        <StatCard label="Warning" value={counts.WARNING} icon={<AlertTriangle size={17} />} tone="warning" hint="Operational attention advised" />
        <StatCard label="Informational" value={counts.INFO} icon={<Info size={17} />} tone="info" hint="Context and status changes" />
        <StatCard label="Success" value={counts.SUCCESS} icon={<CheckCircle2 size={17} />} tone="success" hint="Completed actions" />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1">
          {(['ALL', 'CRITICAL', 'WARNING', 'INFO', 'SUCCESS'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setCategory(value)}
              aria-pressed={category === value}
              className={
                category === value
                  ? 'rounded-md bg-[var(--primary)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--primary-foreground)]'
                  : 'rounded-md px-2.5 py-1.5 text-[11px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
              }
            >
              {value === 'ALL' ? `All (${all.length})` : `${value.charAt(0)}${value.slice(1).toLowerCase()} (${counts[value]})`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {unread > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => markAllReadMutation.mutate()}
              disabled={markAllReadMutation.isPending}
              className="gap-1.5 text-xs h-7"
            >
              <CheckCheck size={14} />
              Mark all read
            </Button>
          )}
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--primary)]"
            />
            Unread only
          </label>
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<Inbox size={20} />}
          title="No notifications"
          description="Operational updates will appear here when the network sends them."
        />
      ) : visible.length === 0 ? (
        <EmptyState compact icon={<Inbox size={18} />} title="Nothing matches this filter" description="Switch category or turn off the unread filter." />
      ) : (
        <div className="space-y-2.5">
          {visible.map((notif: Notification) => (
            <Card
              key={notif.id}
              className={
                !notif.read
                  ? 'border-[color-mix(in_srgb,var(--primary)_32%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_4%,var(--card))]'
                  : ''
              }
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-[var(--muted)] ${categoryTone(notif.category)}`}>
                    {categoryIcon(notif.category)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{notif.title}</span>
                        <Badge variant={categoryVariant(notif.category)} className="text-[9px]">{notif.category}</Badge>
                        {!notif.read && (
                          <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--primary)]">
                            <span className="h-1.5 w-1.5 rounded-full bg-[var(--primary)]" aria-hidden="true" />
                            Unread
                          </span>
                        )}
                      </div>
                      {!notif.read && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => markReadMutation.mutate(notif.id)}
                          disabled={markReadMutation.isPending}
                          className="h-6 px-2 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        >
                          Mark read
                        </Button>
                      )}
                    </div>
                    <p className="text-sm leading-relaxed text-[var(--muted-foreground)]">{notif.message}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--muted-foreground)]">
                      <span>{formatDistanceToNow(new Date(notif.timestamp), { addSuffix: true })}</span>
                      {notif.linkedEmergency && (
                        <Link
                          to={`/emergencies/${notif.linkedEmergency}`}
                          className="font-mono text-[var(--primary)] hover:underline inline-flex items-center gap-1"
                        >
                          <span>Linked: {notif.linkedEmergency}</span>
                          <ExternalLink size={10} />
                        </Link>
                      )}
                      {notif.deliveryStatus && (
                        <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[9px]">
                          In-App
                          {notif.deliveryStatus.sms === 'MOCK_DELIVERED' && ' • SMS (Mock)'}
                          {notif.deliveryStatus.email === 'MOCK_DELIVERED' && ' • Email (Mock)'}
                          {notif.deliveryStatus.push === 'MOCK_DELIVERED' && ' • Push (Mock)'}
                        </span>
                      )}
                      <span className="font-mono opacity-70 ml-auto">{new Date(notif.timestamp).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
