import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { AlertTriangle, Bell, CheckCircle, Info } from 'lucide-react';
import type { Notification, NotificationCategory } from '../types';

export function AlertsPage() {
  const { data: notifications, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: api.notifications.list,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
      </div>
    );
  }

  const categoryIcon = (cat: NotificationCategory) => {
    switch (cat) {
      case 'CRITICAL': return <AlertTriangle size={16} className="text-red-500" />;
      case 'WARNING': return <AlertTriangle size={16} className="text-amber-500" />;
      case 'INFO': return <Info size={16} className="text-blue-500" />;
      case 'SUCCESS': return <CheckCircle size={16} className="text-green-500" />;
    }
  };

  const categoryVariant = (cat: NotificationCategory) => {
    const map: Record<NotificationCategory, 'critical' | 'warning' | 'info' | 'success'> = {
      CRITICAL: 'critical', WARNING: 'warning', INFO: 'info', SUCCESS: 'success'
    };
    return map[cat];
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Bell size={24} className="text-[var(--primary)]" />
          Alerts & Notifications
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">System alerts, emergency notifications, and status updates</p>
      </div>

      <div className="flex gap-2">
        <Badge variant="outline" className="gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> Critical: {(notifications || []).filter((n: Notification) => n.category === 'CRITICAL').length}</Badge>
        <Badge variant="outline" className="gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> Warning: {(notifications || []).filter((n: Notification) => n.category === 'WARNING').length}</Badge>
        <Badge variant="outline" className="gap-1"><span className="h-2 w-2 rounded-full bg-blue-500" /> Info: {(notifications || []).filter((n: Notification) => n.category === 'INFO').length}</Badge>
      </div>

      <div className="space-y-3">
        {(notifications || []).map((notif: Notification) => (
          <Card key={notif.id} className={!notif.read ? 'border-[var(--primary)]/30' : ''}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                {categoryIcon(notif.category)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">{notif.title}</span>
                    <Badge variant={categoryVariant(notif.category)} className="text-[10px]">{notif.category}</Badge>
                    {!notif.read && <span className="h-2 w-2 rounded-full bg-[var(--primary)]" />}
                  </div>
                  <p className="text-sm text-[var(--muted-foreground)]">{notif.message}</p>
                  <p className="text-xs text-[var(--muted-foreground)] mt-1">
                    {new Date(notif.timestamp).toLocaleString()}
                    {notif.linkedEmergency && ` • Linked: ${notif.linkedEmergency}`}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
