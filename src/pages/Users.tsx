import { useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Loader2,
  MailWarning,
  Search,
  ShieldCheck,
  UserCheck,
  UserPlus,
  Users as UsersIcon,
  UserX,
  X,
} from 'lucide-react';
import { api, type AdminUser } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { ROLE_LABELS } from '../lib/navigation';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Skeleton } from '../components/ui/skeleton';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { EmptyState } from '../components/ui/empty-state';
import { cn } from '../lib/utils';
import type { UserRole } from '../types';

const ROLES: UserRole[] = [
  'ADMIN', 'SUPERVISOR', 'DISPATCHER', 'AMBULANCE_CREW',
  'HOSPITAL_STAFF', 'ANALYST', 'AUDITOR', 'CITIZEN',
];

/**
 * Roles whose operational data is scoped to a specific facility or vehicle.
 * Creating one of these without the matching id would produce an account that
 * authenticates but can see nothing, so the field is required for them.
 */
const NEEDS_HOSPITAL: UserRole[] = ['HOSPITAL_STAFF'];
const NEEDS_AMBULANCE: UserRole[] = ['AMBULANCE_CREW'];

interface FormState {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  hospitalId: string;
  ambulanceId: string;
  organizationId: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  email: '',
  password: '',
  role: 'DISPATCHER',
  hospitalId: '',
  ambulanceId: '',
  organizationId: '',
};

export function UsersPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'ALL' | UserRole>('ALL');

  // The server enforces this on POST /admin/users; mirroring it here only
  // avoids showing a form that cannot succeed.
  const canCreate = user?.permissions?.includes('user:create') ?? false;
  const canUpdate = user?.permissions?.includes('user:update') ?? false;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-users'],
    queryFn: api.admin.users,
  });

  const create = useMutation({
    mutationFn: api.admin.createUser,
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setForm(EMPTY_FORM);
      setShowForm(false);
      setFormError(null);
      setNotice(`Created ${created.name} as ${ROLE_LABELS[created.role]}.`);
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.admin.updateUser(id, { active }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setNotice(`${updated.name} is now ${updated.active ? 'active' : 'deactivated'}.`);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    create.mutate({
      name: form.name.trim(),
      email: form.email.trim().toLowerCase(),
      password: form.password,
      role: form.role,
      // Only send the scoping ids the chosen role actually uses, so an admin
      // provisioning a Dispatcher does not accidentally bind them to a hospital.
      ...(form.hospitalId.trim() ? { hospitalId: form.hospitalId.trim() } : {}),
      ...(form.ambulanceId.trim() ? { ambulanceId: form.ambulanceId.trim() } : {}),
      ...(form.organizationId.trim() ? { organizationId: form.organizationId.trim() } : {}),
    });
  };

  const missingScope =
    (NEEDS_HOSPITAL.includes(form.role) && !form.hospitalId.trim()) ||
    (NEEDS_AMBULANCE.includes(form.role) && !form.ambulanceId.trim());

  const all = data ?? [];
  const active = all.filter((row) => row.active).length;
  const deactivated = all.length - active;
  const unverified = all.filter((row) => row.emailVerified === false).length;

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return all.filter((row) => {
      if (roleFilter !== 'ALL' && row.role !== roleFilter) return false;
      if (!term) return true;
      return (
        row.name.toLowerCase().includes(term) ||
        row.email.toLowerCase().includes(term) ||
        row.id.toLowerCase().includes(term) ||
        (row.hospitalId ?? '').toLowerCase().includes(term) ||
        (row.ambulanceId ?? '').toLowerCase().includes(term) ||
        (row.organizationId ?? '').toLowerCase().includes(term)
      );
    });
  }, [all, query, roleFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration / identities"
        title="User management"
        description="Provision operational accounts and control who can sign in. Public self-registration is citizen-only, so every other role is created here and recorded in the audit trail."
        icon={<UsersIcon size={21} />}
        status={<Badge variant="outline" className="gap-1.5"><ShieldCheck size={11} /> Administrator only</Badge>}
        actions={
          canCreate ? (
            <Button variant={showForm ? 'outline' : 'default'} onClick={() => setShowForm((value) => !value)}>
              {showForm ? <X size={15} /> : <UserPlus size={15} />}
              {showForm ? 'Cancel' : 'Add user'}
            </Button>
          ) : undefined
        }
      />

      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-xl border border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] p-3.5"
        >
          <p className="flex items-center gap-2 text-xs leading-relaxed text-[var(--success)]">
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Accounts" value={all.length} icon={<UsersIcon size={17} />} tone="primary" hint="Visible to this session" />
        <StatCard label="Active" value={active} icon={<UserCheck size={17} />} tone="success" hint="Able to sign in" />
        <StatCard label="Deactivated" value={deactivated} icon={<UserX size={17} />} tone="neutral" hint="Sign-in blocked by the server" />
        <StatCard label="Unverified" value={unverified} icon={<MailWarning size={17} />} tone={unverified > 0 ? 'warning' : 'success'} hint="Email confirmation pending" />
      </div>

      {showForm && canCreate && (
        <CreateUserForm
          form={form}
          setForm={setForm}
          onSubmit={submit}
          error={formError}
          pending={create.isPending}
          missingScope={missingScope}
        />
      )}

      <Card className="overflow-hidden">
        <CardHeader className="gap-3 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Accounts</CardTitle>
              <CardDescription className="mt-1">
                {data ? `${data.length} account${data.length === 1 ? '' : 's'}` : 'Loading directory…'}
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <select
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value as 'ALL' | UserRole)}
                aria-label="Filter accounts by role"
                className="h-9 rounded-lg border border-[var(--input)] bg-[var(--card)] px-2.5 text-xs"
              >
                <option value="ALL">All roles</option>
                {ROLES.map((role) => (
                  <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                ))}
              </select>
              <div className="relative w-full sm:w-64">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search name, email, scope…"
                  className="h-9 pl-9 text-xs"
                  aria-label="Search accounts"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-11 rounded-lg" />
              ))}
            </div>
          ) : isError || !data ? (
            <div className="p-4">
              <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3.5">
                <AlertTriangle size={15} className="mt-0.5 flex-none text-[var(--destructive)]" />
                <div>
                  <p className="text-xs font-semibold text-[var(--destructive)]">The account directory could not be loaded</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                    No placeholder accounts have been substituted. Try again once the admin API is reachable.
                  </p>
                </div>
              </div>
            </div>
          ) : all.length === 0 ? (
            <EmptyState
              compact
              icon={<UsersIcon size={18} />}
              title="No accounts yet"
              description="Create the first operational account to populate the directory."
              className="border-0 bg-transparent"
            />
          ) : visible.length === 0 ? (
            <EmptyState
              compact
              icon={<Search size={18} />}
              title="No accounts match this view"
              description="Adjust the role filter or search text to widen the directory."
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--muted)]/35">
                    {['ID', 'Name', 'Email', 'Role', 'Scope', 'Status', ''].map((heading) => (
                      <th
                        key={heading}
                        scope="col"
                        className="px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <UserRow
                      key={row.id}
                      row={row}
                      canUpdate={canUpdate}
                      isSelf={row.id === user?.id}
                      pending={setActive.isPending}
                      onToggle={() => setActive.mutate({ id: row.id, active: !row.active })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-[var(--muted-foreground)]">
        <ShieldCheck size={13} className="mt-0.5 flex-none" />
        The server re-checks every permission on each request; this screen is the auditable control
        surface for the same policy. Accounts created here start verified — you are vouching for the
        person&apos;s identity.
      </p>
    </div>
  );
}

function CreateUserForm({
  form,
  setForm,
  onSubmit,
  error,
  pending,
  missingScope,
}: {
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  onSubmit: (event: FormEvent) => void;
  error: string | null;
  pending: boolean;
  missingScope: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <UserPlus size={15} className="text-[var(--primary)]" />
          New account
        </CardTitle>
        <CardDescription>
          Accounts created here start verified and skip the emailed confirmation. They can reset
          their own password from the sign-in page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="u-name">Full name</Label>
              <Input
                id="u-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Priya Nair"
                autoComplete="off"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-email">Email address</Label>
              <Input
                id="u-email"
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                placeholder="priya@rapidaid.com"
                autoComplete="off"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-password">Temporary password</Label>
              <Input
                id="u-password"
                type="text"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                placeholder="At least 8 characters"
                minLength={8}
                autoComplete="new-password"
                required
              />
              <p className="text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                Share it over a secure channel; the user should change it after signing in.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-role">Role</Label>
              <select
                id="u-role"
                className="h-10 w-full rounded-lg border border-[var(--input)] bg-[var(--background)] px-2.5 text-sm"
                value={form.role}
                onChange={(event) => setForm({ ...form, role: event.target.value as UserRole })}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                ))}
              </select>
            </div>

            {NEEDS_HOSPITAL.includes(form.role) && (
              <div className="space-y-1.5">
                <Label htmlFor="u-hospital">Hospital ID</Label>
                <Input
                  id="u-hospital"
                  value={form.hospitalId}
                  onChange={(event) => setForm({ ...form, hospitalId: event.target.value })}
                  placeholder="HOSP-001"
                  required
                />
                <p className="text-[11px] text-[var(--muted-foreground)]">Scopes this account to one facility.</p>
              </div>
            )}

            {NEEDS_AMBULANCE.includes(form.role) && (
              <div className="space-y-1.5">
                <Label htmlFor="u-ambulance">Ambulance ID</Label>
                <Input
                  id="u-ambulance"
                  value={form.ambulanceId}
                  onChange={(event) => setForm({ ...form, ambulanceId: event.target.value })}
                  placeholder="AMB-001"
                  required
                />
                <p className="text-[11px] text-[var(--muted-foreground)]">Scopes this account to one vehicle.</p>
              </div>
            )}
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-2.5">
              <AlertTriangle size={14} className="mt-0.5 flex-none text-[var(--destructive)]" />
              <p className="text-xs leading-relaxed text-[var(--destructive)]">{error}</p>
            </div>
          )}
          {missingScope && (
            <p className="text-xs text-[var(--destructive)]" role="alert">
              {ROLE_LABELS[form.role]} accounts need their facility or vehicle id, otherwise they would see no data.
            </p>
          )}

          <Button
            type="submit"
            disabled={pending || missingScope || !form.name || !form.email || form.password.length < 8}
          >
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <UserPlus size={15} />
                Create account
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function UserRow({
  row,
  canUpdate,
  isSelf,
  pending,
  onToggle,
}: {
  row: AdminUser;
  canUpdate: boolean;
  isSelf: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  const scope = row.hospitalId || row.ambulanceId || row.organizationId;
  return (
    <tr className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--muted)]/35">
      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-[var(--muted-foreground)]">{row.id}</td>
      <td className="px-4 py-3">
        <span className="text-sm font-medium">{row.name}</span>
        {isSelf && (
          <span className="ml-2 rounded-full border border-[var(--border)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
            you
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-[var(--muted-foreground)]">{row.email}</td>
      <td className="px-4 py-3">
        <Badge variant="outline" className="text-[10px]">{ROLE_LABELS[row.role]}</Badge>
      </td>
      <td className="px-4 py-3 font-mono text-[11px] text-[var(--muted-foreground)]">{scope ?? '—'}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
              row.active
                ? 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]'
                : 'bg-[var(--muted)] text-[var(--muted-foreground)]',
            )}
          >
            <span className={row.active ? 'status-dot status-dot--live' : 'status-dot'} aria-hidden="true" />
            {row.active ? 'Active' : 'Deactivated'}
          </span>
          {row.emailVerified === false && (
            <span className="rounded-full bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-2 py-0.5 text-[10px] font-medium text-[var(--warning)]">
              Unverified
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-right">
        {canUpdate && (
          <Button
            variant="ghost"
            size="iconSm"
            onClick={onToggle}
            disabled={pending || isSelf}
            title={isSelf ? 'You cannot deactivate your own account' : row.active ? 'Deactivate account' : 'Reactivate account'}
            aria-label={isSelf ? 'You cannot deactivate your own account' : row.active ? `Deactivate ${row.name}` : `Reactivate ${row.name}`}
          >
            {row.active ? <X size={14} /> : <Check size={14} />}
          </Button>
        )}
      </td>
    </tr>
  );
}
