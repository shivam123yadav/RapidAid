import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  User,
} from 'lucide-react';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { AuthLayout, AuthPanel } from '../components/layout/AuthLayout';
import { getLoginError, useAuthStore } from '../stores/auth';
import { homeRouteFor } from '../lib/navigation';
import { cn } from '../lib/utils';
import { api } from '../api/client';

const registerSchema = z
  .object({
    name: z.string().min(2, 'Name must be at least 2 characters').max(100),
    email: z.string().email('Please enter a valid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    confirm: z.string(),
  })
  .refine((data) => data.password === data.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });

type RegisterFormData = z.infer<typeof registerSchema>;

/**
 * Shared password field with a show/hide toggle, used by the two password rows.
 *
 * `registration` is the object returned by react-hook-form's `register()`. It is
 * typed as the public `UseFormRegisterReturn` alias rather than an inline
 * `ReturnType<…>` chain, so the props stay correct if the form schema changes.
 */
function PasswordField({ id, placeholder, autoComplete, visible, onToggle, error, registration }: {
  id: string;
  placeholder: string;
  autoComplete: string;
  visible: boolean;
  onToggle: () => void;
  error?: string;
  registration: UseFormRegisterReturn;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{id === 'password' ? 'Password' : 'Confirm password'}</Label>
      <div className="relative">
        <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          placeholder={placeholder}
          className="pl-10 pr-10"
          aria-invalid={Boolean(error)}
          {...registration}
        />
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error && <p className="text-xs text-[var(--destructive)]">{error}</p>}
    </div>
  );
}

/**
 * Citizen self-registration.
 *
 * There is deliberately no role field: the server pins public registration to
 * CITIZEN, and offering a picker would imply a capability the API refuses.
 * Operational accounts are provisioned by an Administrator, who vouches for
 * the person's identity — which is also why those accounts skip email
 * verification.
 */
export function RegisterPage() {
  const navigate = useNavigate();
  const registerUser = useAuthStore((state) => state.register);
  const logout = useAuthStore((state) => state.logout);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendFeedback, setResendFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  /**
   * `/register` returns a token pair, so signing up flips `isAuthenticated`
   * immediately. The redirect effect below therefore used to fire on our own
   * registration and navigate away before "Check your email" could ever render.
   * This flag records that *we* are the ones who authenticated, so the effect
   * only bounces a visitor who already had a session when they arrived.
   */
  const registeredHere = useRef(false);

  useEffect(() => {
    if (registeredHere.current) return;
    if (isAuthenticated) navigate(homeRouteFor(user?.role), { replace: true });
  }, [isAuthenticated, navigate, user?.role]);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '', confirm: '' },
  });

  const password = watch('password');
  const strength = [
    { label: '8+ characters', met: password.length >= 8 },
    { label: 'Uppercase', met: password.length >= 8 && /[A-Z]/.test(password) },
    {
      label: 'Number · 10+',
      met: password.length >= 10 && /[A-Z]/.test(password) && /[0-9]/.test(password),
    },
  ];
  const metCount = strength.filter((item) => item.met).length;

  /** Drops the session created by registration and returns to the sign-in form. */
  const handleSignOutAndLeave = async () => {
    await logout();
    registeredHere.current = false;
    setSent(false);
    navigate('/login', { replace: true });
  };

  const handleResendVerification = async () => {
    if (resendLoading || resendCooldown > 0) return;
    setResendLoading(true);
    setResendFeedback(null);
    try {
      const res = await api.auth.resendVerification();
      setResendFeedback({ type: 'success', message: res.message || 'Verification email sent! Check your inbox.' });
      setResendCooldown(60);
    } catch (err: unknown) {
      const errMsg = (err as { message?: string })?.message || 'Failed to resend verification email';
      const match = errMsg.match(/(\d+)s/);
      if (match && match[1]) {
        setResendCooldown(parseInt(match[1], 10));
      }
      setResendFeedback({ type: 'error', message: errMsg });
    } finally {
      setResendLoading(false);
    }
  };

  const onSubmit = async (data: RegisterFormData) => {
    setError(null);
    const success = await registerUser(data.name.trim(), data.email, data.password);
    if (success) {
      // The session is live, but claim the redirect so the "Check your email"
      // screen survives instead of being navigated straight past.
      registeredHere.current = true;
      setSent(true);
    } else {
      setError(getLoginError() ?? 'Registration failed. Please try again.');
    }
  };

  if (sent) {
    return (
      <AuthLayout label="Verify your email" widthClassName="max-w-md">
        <AuthPanel>
          <div className="px-5 py-8 text-center sm:px-7">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--success)_30%,var(--border))] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <p className="eyebrow mt-5">Account created</p>
            <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">Check your email</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--muted-foreground)]">
              We sent a verification link to your address. Confirm it to fully activate your account.
              You can sign in now and verify later.
            </p>

            <div className="mt-5 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] p-3 text-left">
              <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                <span className="font-medium text-[var(--foreground)]">Signed in as {user?.email}.</span>{' '}
                The link expires in 24 hours. If it does not arrive, check spam, or request a new
                verification email below.
              </p>
              {resendFeedback && (
                <p
                  className={cn(
                    'mt-2 text-xs font-medium',
                    resendFeedback.type === 'success'
                      ? 'text-[var(--success,#10b981)]'
                      : 'text-[var(--destructive,#ef4444)]',
                  )}
                >
                  {resendFeedback.message}
                </p>
              )}
            </div>

            <Button className="mt-5 w-full" size="lg" onClick={() => navigate(homeRouteFor('CITIZEN'))}>
              Continue to report an emergency
              <ArrowRight size={16} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={resendLoading || resendCooldown > 0}
              onClick={handleResendVerification}
              className="mt-1.5 w-full"
            >
              {resendLoading ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Sending...
                </>
              ) : resendCooldown > 0 ? (
                `Resend in ${resendCooldown}s`
              ) : (
                'Resend verification email'
              )}
            </Button>
            <p className="mt-3 text-xs text-[var(--muted-foreground)]">
              Wrong account?{' '}
              <button
                type="button"
                onClick={handleSignOutAndLeave}
                className="font-semibold text-[var(--primary)] hover:underline"
              >
                Sign out
              </button>
            </p>
          </div>
        </AuthPanel>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout label="Create a RapidAid account" widthClassName="max-w-md">
      <AuthPanel>
        <div className="px-5 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="eyebrow">Citizen account</p>
              <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">
                Create your account
              </h1>
              <p className="mt-1 text-sm leading-relaxed text-[var(--muted-foreground)]">
                Report emergencies and follow the response.
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

            <div className="space-y-1.5">
              <Label htmlFor="name">Full name</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
                <Input
                  id="name"
                  autoComplete="name"
                  placeholder="Your name"
                  className="pl-10"
                  aria-invalid={Boolean(errors.name)}
                  {...register('name')}
                />
              </div>
              {errors.name && <p className="text-xs text-[var(--destructive)]">{errors.name.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  className="pl-10"
                  aria-invalid={Boolean(errors.email)}
                  {...register('email')}
                />
              </div>
              {errors.email && <p className="text-xs text-[var(--destructive)]">{errors.email.message}</p>}
            </div>

            <PasswordField
              id="password"
              placeholder="At least 8 characters"
              autoComplete="new-password"
              visible={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
              error={errors.password?.message}
              registration={register('password')}
            />

            {password && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1">
                  {[0, 1, 2].map((index) => (
                    <span
                      key={index}
                      className={cn(
                        'h-1 flex-1 rounded-full transition-colors',
                        index < metCount ? 'bg-[var(--success)]' : 'bg-[var(--muted)]',
                      )}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {strength.map((item) => (
                    <span
                      key={item.label}
                      className={cn(
                        'text-[10px]',
                        item.met ? 'text-[var(--success)]' : 'text-[var(--muted-foreground)]',
                      )}
                    >
                      {item.met ? '✓' : '·'} {item.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <PasswordField
              id="confirm"
              placeholder="Re-enter your password"
              autoComplete="new-password"
              visible={showConfirm}
              onToggle={() => setShowConfirm((v) => !v)}
              error={errors.confirm?.message}
              registration={register('confirm')}
            />

            <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {isSubmitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>

          <div className="mt-5 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_50%,transparent)] p-3">
            <p className="text-[11px] leading-relaxed text-[var(--muted-foreground)]">
              New accounts are for <span className="font-medium text-[var(--foreground)]">citizens</span>{' '}
              reporting emergencies. Operational accounts — Dispatcher, Crew, Hospital, Supervisor,
              Analyst, Auditor or Administrator — are provisioned by an Administrator.
            </p>
          </div>
        </div>
      </AuthPanel>

      <div className="mt-5 flex flex-col items-center gap-1.5 text-center">
        <p className="text-xs text-[var(--muted-foreground)]">
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-[var(--primary)] hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
