import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Layers,
  LockKeyhole,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { api, ApiError, type PermissionMatrix } from '../api/client';
import { ROLE_LABELS } from '../lib/navigation';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import { useAuthStore } from '../stores/auth';
import { cn } from '../lib/utils';
import type { UserRole } from '../types';

const ROLES: UserRole[] = ['ADMIN', 'SUPERVISOR', 'DISPATCHER', 'AMBULANCE_CREW', 'HOSPITAL_STAFF', 'ANALYST', 'AUDITOR', 'CITIZEN'];
const MODULES = ['Emergencies', 'Ambulances', 'Hospitals', 'Live Tracking', 'AI Vision', 'Dispatch Intelligence', 'Voice Reports', 'Green Corridor', 'Alerts', 'Audit', 'Reports', 'Users', 'Settings', 'Cameras', 'Maintenance', 'Shifts', 'Patient Data'] as const;
const ACTIONS = ['View', 'Create', 'Edit', 'Delete', 'Assign', 'Approve', 'Override', 'Export'] as const;
type Module = (typeof MODULES)[number];
type Action = (typeof ACTIONS)[number];
const PREFIX: Record<Module, string[]> = {
  Emergencies: ['emergency'], Ambulances: ['ambulance'], Hospitals: ['hospital'], 'Live Tracking': ['tracking'], 'AI Vision': ['ai', 'camera'], 'Dispatch Intelligence': ['dispatch'], 'Voice Reports': ['voice', 'report'], 'Green Corridor': ['green-corridor'], Alerts: ['alert'], Audit: ['audit'], Reports: ['report'], Users: ['user', 'permission'], Settings: ['settings', 'system'], Cameras: ['camera'], Maintenance: ['maintenance'], Shifts: ['shift'], 'Patient Data': ['patient'],
};
const VERBS: Record<Action, string[]> = { View: ['read', 'view'], Create: ['create'], Edit: ['update', 'configure', 'manage'], Delete: ['delete', 'deactivate'], Assign: ['assign', 'reassign'], Approve: ['approve', 'acknowledge', 'escalate'], Override: ['override'], Export: ['export'] };
const cell = (catalog: string[], module: Module, action: Action) => catalog.filter((permission) => {
  const [resource, ...parts] = permission.split(':');
  if (!PREFIX[module].includes(resource)) return false;
  return VERBS[action].some((verb) => parts.includes(verb));
});

export function PermissionMatrixPage() {
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const [role, setRole] = useState<UserRole>('DISPATCHER');
  const [draft, setDraft] = useState<Partial<Record<UserRole, string[]>>>({});
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const { data, isLoading, isError } = useQuery({ queryKey: ['admin-permissions'], queryFn: api.admin.permissions });
  const effective = data?.roles[role] ?? [];
  const permissions = draft[role] ?? effective;
  const dirty = useMemo(() => JSON.stringify([...permissions].sort()) !== JSON.stringify([...effective].sort()), [effective, permissions]);
  const save = useMutation({
    mutationFn: () => api.admin.updatePermissions(role, permissions, data?.revisions[role] || undefined, reason.trim() || undefined),
    onSuccess: (updated) => {
      queryClient.setQueryData<PermissionMatrix>(['admin-permissions'], (current) => current ? { ...current, roles: { ...current.roles, [updated.role]: updated.permissions }, revisions: { ...current.revisions, [updated.role]: updated.revision } } : current);
      setDraft((current) => { const next = { ...current }; delete next[role]; return next; });
      setReason(''); setError(''); setNotice(`Policy saved for ${ROLE_LABELS[role]}.`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save policy'),
  });
  if (isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-96 rounded-xl" /></div>;
  if (isError || !data) return <Card><CardContent className="p-6 text-sm text-[var(--destructive)]">Permission matrix could not be loaded.</CardContent></Card>;
  const toggle = (cells: string[]) => setDraft((current) => { const next = new Set(current[role] ?? effective); const all = cells.every((permission) => next.has(permission)); cells.forEach((permission) => all ? next.delete(permission) : next.add(permission)); return { ...current, [role]: [...next] }; });
  const reset = () => setDraft((current) => { const next = { ...current }; delete next[role]; return next; });
  return (
    <PermissionMatrixView
      role={role}
      setRole={setRole}
      data={data}
      permissions={permissions}
      toggle={toggle}
      reset={reset}
      dirty={dirty}
      reason={reason}
      setReason={setReason}
      save={save}
      notice={notice}
      error={error}
      userName={user?.name}
    />
  );
}

function PermissionMatrixView({
  role,
  setRole,
  data,
  permissions,
  toggle,
  reset,
  dirty,
  reason,
  setReason,
  save,
  notice,
  error,
  userName,
}: {
  role: UserRole;
  setRole: (role: UserRole) => void;
  data: PermissionMatrix;
  permissions: string[];
  toggle: (cells: string[]) => void;
  reset: () => void;
  dirty: boolean;
  reason: string;
  setReason: (reason: string) => void;
  save: { mutate: () => void; isPending: boolean };
  notice: string;
  error: string;
  userName?: string;
}) {
  const granted = useMemo(() => new Set(permissions), [permissions]);
  const modulesCovered = MODULES.filter((module) =>
    data.catalog.some((permission) => granted.has(permission) && PREFIX[module].includes(permission.split(':')[0])),
  ).length;
  const percent = data.catalog.length === 0 ? 0 : Math.round((permissions.length / data.catalog.length) * 100);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration / policy"
        title="Permission management"
        description="Role → module → action → scope. Toggling a cell grants or revokes every permission in that cell; scope suffixes remain explicit."
        icon={<ShieldCheck size={21} />}
        status={<Badge variant="outline" className="gap-1.5"><LockKeyhole size={11} /> Administrator only</Badge>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Catalog size" value={data.catalog.length} icon={<Layers size={17} />} tone="info" hint="Permission strings known to the API" />
        <StatCard label={`${ROLE_LABELS[role]} grants`} value={permissions.length} icon={<ShieldCheck size={17} />} tone="primary" hint={`${percent}% of the catalog`} />
        <StatCard label="Modules covered" value={modulesCovered} icon={<SlidersHorizontal size={17} />} tone="neutral" hint={`${MODULES.length} modules in the matrix`} />
        <StatCard label="Policy revision" value={data.revisions[role] ?? 0} icon={<RotateCcw size={17} />} tone="success" hint="Server revision for this role" />
      </div>

      <Card>
        <CardHeader className="gap-4 pb-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle>Effective role policy</CardTitle>
              <CardDescription className="mt-1">
                Scope suffixes remain explicit (for example <code className="font-mono text-[11px]">:all</code>,{' '}
                <code className="font-mono text-[11px]">:own</code>,{' '}
                <code className="font-mono text-[11px]">:assigned</code>). Every saved change is audited.
              </CardDescription>
            </div>
            <div className="w-full sm:w-56">
              <Label htmlFor="role">Role</Label>
              <select
                id="role"
                className="mt-1 h-10 w-full rounded-lg border border-[var(--input)] bg-[var(--background)] px-2.5 text-sm"
                value={role}
                onChange={(event) => setRole(event.target.value as UserRole)}
              >
                {ROLES.map((item) => <option key={item} value={item}>{ROLE_LABELS[item]}</option>)}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Label htmlFor="policy-reason">Change reason</Label>
              <Input
                id="policy-reason"
                className="mt-1"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Approved operational change"
              />
              <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                At least 3 characters. Stored with the policy revision in the audit trail.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={reset} disabled={!dirty || save.isPending}>
                Reset
              </Button>
              <Button
                onClick={() => save.mutate()}
                disabled={!dirty || save.isPending || reason.trim().length < 3}
              >
                <Save size={15} />
                {save.isPending ? 'Saving…' : 'Save policy'}
              </Button>
            </div>
          </div>

          {notice && (
            <p role="status" className="flex items-center gap-1.5 text-xs text-[var(--success)]">
              <CheckCircle2 size={13} />
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-xs text-[var(--destructive)]">
              <AlertTriangle size={13} className="mt-0.5 flex-none" />
              {error}
            </p>
          )}
          {dirty && (
            <p className="flex items-center gap-1.5 rounded-lg border border-[var(--warning)]/35 bg-[color-mix(in_srgb,var(--warning)_7%,transparent)] px-3 py-2 text-[11px] text-[var(--warning)]">
              <AlertTriangle size={13} className="flex-none" />
              Unsaved changes for {ROLE_LABELS[role]}. Saving requires a reason and writes a new revision.
            </p>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <caption className="sr-only">
              Permission matrix for {ROLE_LABELS[role]}: modules as rows, actions as columns. Each cell
              grants or revokes all matching permission strings.
            </caption>
            <thead>
              <tr className="border-y border-[var(--border)] bg-[var(--muted)]/35">
                <th scope="col" className="sticky left-0 z-10 bg-[var(--card)] px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                  Module
                </th>
                {ACTIONS.map((action) => (
                  <th key={action} scope="col" className="px-3 py-2.5 text-center font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                    {action}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MODULES.map((module) => (
                <tr key={module} className="border-b border-[var(--border)] last:border-0">
                  <th scope="row" className="sticky left-0 z-10 bg-[var(--card)] px-4 py-2.5 text-left text-xs font-medium">
                    {module}
                  </th>
                  {ACTIONS.map((action) => {
                    const cells = cell(data.catalog, module, action);
                    const anyGranted = cells.some((permission) => granted.has(permission));
                    const allGranted = cells.length > 0 && cells.every((permission) => granted.has(permission));
                    return (
                      <td key={action} className="px-3 py-2.5 text-center">
                        {cells.length === 0 ? (
                          <span className="text-[var(--muted-foreground)]" aria-label={`No ${action} permissions apply to ${module}`}>—</span>
                        ) : (
                          <button
                            type="button"
                            aria-pressed={allGranted}
                            aria-label={`${action} ${module}: ${cells.length} matching permission${cells.length === 1 ? '' : 's'}, ${allGranted ? 'all granted' : anyGranted ? 'partially granted' : 'none granted'}`}
                            title={cells.join('\n')}
                            className={cn(
                              'inline-flex min-w-[44px] items-center justify-center gap-1 rounded-md border px-1.5 py-1.5 transition-colors',
                              allGranted
                                ? 'border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]'
                                : anyGranted
                                  ? 'border-[color-mix(in_srgb,var(--warning)_35%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)]'
                                  : 'border-transparent text-[var(--muted-foreground)] hover:border-[var(--border)] hover:bg-[var(--muted)]',
                            )}
                            onClick={() => toggle(cells)}
                          >
                            {anyGranted ? <Check size={15} /> : <X size={15} />}
                            {cells.length > 1 && (
                              <span className="font-mono text-[9px]">
                                {cells.filter((permission) => granted.has(permission)).length}/{cells.length}
                              </span>
                            )}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck size={15} className="text-[var(--primary)]" />
            Effective permission strings
          </CardTitle>
          <CardDescription>
            The exact strings carried by {ROLE_LABELS[role]}. The server re-checks them on every request.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {permissions.length === 0 ? (
            <EmptyState
              compact
              icon={<LockKeyhole size={18} />}
              title="No permissions granted"
              description="This role has no effective permissions in the current policy."
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {[...permissions].sort().map((permission) => (
                <span
                  key={permission}
                  className="rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] px-2 py-1 font-mono text-[10px] text-[var(--muted-foreground)]"
                >
                  {permission}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
        Signed in as {userName}. The server remains the enforcement authority; this is the auditable
        control surface for the same policy.
      </p>
    </div>
  );
}
