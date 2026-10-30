import { useEffect, useState } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, ShieldCheck } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { AuthLayout, AuthPanel } from '../components/layout/AuthLayout';
import { getLoginError, useAuthStore } from '../stores/auth';
import { cn } from '../lib/utils';
import { DEMO_CREDENTIALS, DEMO_PASSWORD } from '../lib/demoCredentials';
import { HOME_ROUTE, ROLE_LABELS, homeRouteFor } from '../lib/navigation';
import type { UserRole } from '../types';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.string().min(1, 'Please select your role'),
});

type LoginFormData = z.infer<typeof loginSchema>;

/** Dropdown / demo-button order: field + console personas first. */
const ROLE_ORDER: UserRole[] = [
  'DISPATCHER',
  'AMBULANCE_CREW',
  'HOSPITAL_STAFF',
  'ADMIN',
  'SUPERVISOR',
  'ANALYST',
  'AUDITOR',
  'CITIZEN',
];

function isDemoRole(value: string | null): value is UserRole {
  return value !== null && Object.prototype.hasOwnProperty.call(DEMO_CREDENTIALS, value);
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const login = useAuthStore((state) => state.login);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in (or just signed in) → skip the form and resume the
  // workspace that belongs to this role.
  useEffect(() => {
    if (isAuthenticated) navigate(homeRouteFor(user?.role), { replace: true });
  }, [isAuthenticated, navigate, user?.role]);

  // The demo-roles page links here with ?role=…&demo=1. Seed the form's
  // initial values so the chosen persona is selected and prefilled on mount.
  const requestedRole = searchParams.get('role');
  const prefillDemo = searchParams.get('demo') === '1';
  const demoRole = isDemoRole(requestedRole) ? requestedRole : null;

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: demoRole && prefillDemo ? DEMO_CREDENTIALS[demoRole] : '',
      password: demoRole && prefillDemo ? DEMO_PASSWORD : '',
      role: demoRole ?? 'DISPATCHER',
    },
  });

  const selectedRole = watch('role');

  const onSubmit = async (data: LoginFormData) => {
    setError(null);
    const success = await login(data.email, data.password, data.role as UserRole);

    if (success) {
      // Each role lands in its own workspace (see lib/navigation.ts).
      navigate(homeRouteFor(data.role as UserRole));
    } else {
      // Prefer the server's specific reason (role mismatch, bad password…).
      setError(getLoginError() ?? 'Invalid credentials. Please check your email, password, and role.');
    }
  };

  const fillDemoCredentials = (role: UserRole) => {
    setValue('email', DEMO_CREDENTIALS[role]);
    setValue('password', DEMO_PASSWORD);
    setValue('role', role);
  };

  return (
    <AuthLayout label="Sign in to RapidAid" widthClassName="max-w-md">
      <div className="mb-5 lg:hidden">
        <p className="eyebrow">Access</p>
        <h1 className="display-title mt-2 text-4xl">
          Every second <span className="text-[var(--primary)]">matters.</span>
        </h1>
      </div>

      <AuthPanel>
        <div className="px-5 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="eyebrow">Secure access</p>
              <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">Welcome back</h2>
              <p className="mt-1 text-sm leading-relaxed text-[var(--muted-foreground)]">
                Sign in to enter your role workspace.
              </p>
            </div>
            <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--primary)_26%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] text-[var(--primary)]">
              <ShieldCheck size={18} />
            </div>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 flex-none text-[var(--destructive)]" />
                <p className="text-xs leading-relaxed text-[var(--destructive)]">{error}</p>
              </div>
            )}

            {/* Role Selection */}
            <div className="space-y-1.5">
              <Label htmlFor="role">Role</Label>
              <Select
                value={selectedRole}
                onValueChange={(value: string) => setValue('role', value)}
              >
                <SelectTrigger
                  id="role"
                  className={cn(errors.role && 'border-[var(--destructive)]')}
                  aria-invalid={Boolean(errors.role)}
                >
                  <SelectValue placeholder="Select your role" />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_ORDER.map((role) => (
                    <SelectItem key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.role && (
                <p className="text-xs text-[var(--destructive)]">{errors.role.message}</p>
              )}
            </div>

            {/* Email */}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  className={cn('pl-10', errors.email && 'border-[var(--destructive)]')}
                  {...register('email')}
                  autoComplete="email"
                  aria-invalid={Boolean(errors.email)}
                />
              </div>
              {errors.email && (
                <p className="text-xs text-[var(--destructive)]">{errors.email.message}</p>
              )}
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="password">Password</Label>
                <Link
                  to="/forgot-password"
                  className="text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter your password"
                  className={cn('pl-10 pr-10', errors.password && 'border-[var(--destructive)]')}
                  {...register('password')}
                  autoComplete="current-password"
                  aria-invalid={Boolean(errors.password)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.password && (
                <p className="text-xs text-[var(--destructive)]">{errors.password.message}</p>
              )}
            </div>

            <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight size={16} />
                </>
              )}
            </Button>
          </form>

          <div className="mt-6 border-t border-[var(--border)] pt-5">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                Demo personas
              </p>
              <p className="text-[10px] text-[var(--muted-foreground)]">
                Password <span className="font-mono text-[var(--foreground)]">{DEMO_PASSWORD}</span>
              </p>
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-1.5">
              {ROLE_ORDER.map((role) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => fillDemoCredentials(role)}
                  className="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] px-2.5 py-2 text-left text-[11px] font-medium text-[var(--muted-foreground)] transition-colors hover:border-[color-mix(in_srgb,var(--primary)_30%,var(--border))] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                  title={`${DEMO_CREDENTIALS[role]} · opens ${HOME_ROUTE[role]}`}
                >
                  {ROLE_LABELS[role]}
                </button>
              ))}
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-[var(--muted-foreground)]">
              Dispatcher and Admin → Command Center · Crew → Shifts · Hospital → Hospitals · Analyst
              → Analytics · Auditor → Audit · Citizen → Emergencies.
            </p>
          </div>
        </div>
      </AuthPanel>

      <div className="mt-5 flex flex-col items-center gap-1.5 text-center">
        <p className="text-xs text-[var(--muted-foreground)]">
          Don&apos;t have an account?{' '}
          <Link to="/register" className="font-semibold text-[var(--primary)] hover:underline">
            Create account
          </Link>
        </p>
        <p className="text-[10px] text-[var(--muted-foreground)]">
          Accounts for operational roles are provisioned by an Administrator.
        </p>
      </div>
    </AuthLayout>
  );
}
