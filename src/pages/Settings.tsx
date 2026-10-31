import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { PageHeader } from '../components/ui/page-header';
import { useAuthStore } from '../stores/auth';
import { ROLE_LABELS } from '../lib/navigation';
import { ThemeSelector } from '../components/theme/ThemeSelector';
import {
  Bell,
  CheckCircle2,
  Monitor,
  Settings as SettingsIcon,
  Shield,
  User,
} from 'lucide-react';

const NOTIFICATION_ROUTES = [
  {
    title: 'Critical alerts',
    description: 'Emergency and system-critical notifications',
    active: true,
  },
  {
    title: 'Dispatch updates',
    description: 'Ambulance assignment and status changes',
    active: true,
  },
  {
    title: 'AI detection alerts',
    description: 'New vision detections requiring human review',
    active: true,
  },
  {
    title: 'System updates',
    description: 'Maintenance and release information',
    active: false,
  },
];

export function SettingsPage() {
  const user = useAuthStore((state) => state.user);

  return (
    <div className="space-y-6">
      <PageHeader
          eyebrow="Workspace / preferences"
          title="Settings"
          description="Appearance, account context and the security boundary your session operates inside."
          icon={<SettingsIcon size={21} />}
          status={<Badge variant="outline">Personal workspace</Badge>}
        />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Monitor size={16} className="text-[var(--primary)]" />
              Appearance
            </CardTitle>
            <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
              Five palettes with an intentional day and night appearance. Changes apply instantly and
              never reset a route, form or permission.
            </p>
          </CardHeader>
          <CardContent>
            <ThemeSelector />
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Bell size={16} className="text-[var(--info)]" />
                Notification routing
              </CardTitle>
              <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                The categories the network can deliver. Delivery rules are controlled by the network,
                not by a local switch.
              </p>
            </CardHeader>
            <CardContent className="space-y-1">
              {NOTIFICATION_ROUTES.map((item) => (
                <div
                  key={item.title}
                  className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-[var(--muted)]"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-foreground)]">
                      {item.description}
                    </p>
                  </div>
                  <Badge variant={item.active ? 'success' : 'outline'} className="flex-none text-[9px]">
                    {item.active ? 'Delivered' : 'Inactive'}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <User size={16} className="text-[var(--primary)]" />
                Account
              </CardTitle>
              <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                Identity as issued by the authenticated session.
              </p>
            </CardHeader>
            <CardContent className="space-y-0.5 text-sm">
              <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-2.5">
                <span className="text-[var(--muted-foreground)]">Name</span>
                <span className="text-right font-medium">{user?.name ?? 'RapidAid user'}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-2.5">
                <span className="text-[var(--muted-foreground)]">Role</span>
                <Badge variant="outline">{user?.role ? ROLE_LABELS[user.role] : '—'}</Badge>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-2.5">
                <span className="text-[var(--muted-foreground)]">Email</span>
                <div className="flex items-center gap-2">
                  <span className="max-w-[60%] truncate text-right font-medium">{user?.email ?? '—'}</span>
                  {user?.emailVerified === true && (
                    <span
                      data-testid="settings-email-verified-badge"
                      className="inline-flex items-center gap-1 text-xs font-medium text-[var(--success,#10b981)]"
                      title="Email verified"
                    >
                      <CheckCircle2 size={13} className="shrink-0 text-[var(--success,#10b981)]" />
                      <span>Email verified</span>
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 py-2.5">
                <span className="text-[var(--muted-foreground)]">Organization</span>
                <span className="max-w-[60%] truncate text-right font-medium">
                  {user?.organizationId ?? user?.hospitalId ?? 'RapidAid Network'}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Shield size={16} className="text-[var(--success)]" />
                Security boundary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  {
                    label: 'Authorization',
                    value: 'Server-enforced RBAC',
                    note: 'Every route and API call is checked against your issued permissions.',
                  },
                  {
                    label: 'Session',
                    value: 'Authenticated',
                    note: 'Refreshed through the existing session flow; no client-side escalation.',
                  },
                  {
                    label: 'Granted permissions',
                    value: `${user?.permissions.length ?? 0}`,
                    note: 'Effective permissions carried by the current session.',
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] p-3.5"
                  >
                    <p className="font-mono text-[9px] uppercase tracking-[0.13em] text-[var(--muted-foreground)]">
                      {item.label}
                    </p>
                    <p className="mt-1.5 font-display text-base font-semibold tracking-[-0.025em]">
                      {item.value}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                      {item.note}
                    </p>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-[11px] text-[var(--muted-foreground)]">
                <CheckCircle2 size={13} className="flex-none text-[var(--success)]" />
                Appearance changes are presentation only; they cannot change a permission, a request
                or an operational state.
              </div>
            </CardContent>
          </Card>
        </div>
    </div>
  );
}
