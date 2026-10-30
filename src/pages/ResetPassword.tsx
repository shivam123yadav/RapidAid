import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, CheckCircle2, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { AuthLayout, AuthPanel } from '../components/layout/AuthLayout';
import { api } from '../api/client';
import { cn } from '../lib/utils';

const schema = z
  .object({
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    confirm: z.string(),
  })
  .refine((data) => data.password === data.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });
type FormData = z.infer<typeof schema>;

/**
 * Consumes an emailed reset link and sets a new password.
 *
 * Path is fixed by `server/src/services/email/emailService.ts` (`/reset-password?token=…`).
 *
 * On success the server revokes every active refresh session, so anyone holding
 * a copy of the old session is locked out. We therefore route to /login rather
 * than pretending the current session still works.
 */
export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema), defaultValues: { password: '', confirm: '' } });

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      await api.auth.resetPassword(token, data.password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This reset link is invalid or has expired.');
    }
  };

  return (
    <AuthLayout label="Choose a new password" widthClassName="max-w-md">
      <AuthPanel>
        <div className="px-5 py-7 sm:px-7">
          {done ? (
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--success)_30%,var(--border))] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]">
                <CheckCircle2 className="h-7 w-7" />
              </div>
              <p className="eyebrow mt-5">Security complete</p>
              <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">Password updated</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--muted-foreground)]">
                Your new password is active. For your protection, every other session was signed out
                — you&apos;ll need to sign in again.
              </p>
              <Link to="/login" className={cn(buttonVariants(), 'mt-5 w-full')}>
                Sign in with new password
              </Link>
            </div>
          ) : !token ? (
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 text-[var(--destructive)]">
                <AlertCircle className="h-7 w-7" />
              </div>
              <p className="eyebrow mt-5">Invalid link</p>
              <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">Link not valid</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--muted-foreground)]">
                This link is missing its reset token. Open the most recent email from RapidAid, or
                request a new link.
              </p>
              <Link to="/forgot-password" className={cn(buttonVariants(), 'mt-5 w-full')}>
                Request a new link
              </Link>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="eyebrow">Account recovery</p>
                  <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">
                    Choose a new password
                  </h1>
                  <p className="mt-1 text-sm leading-relaxed text-[var(--muted-foreground)]">
                    Pick something you don&apos;t use elsewhere. All other sessions will be signed out.
                  </p>
                </div>
                <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--primary)_26%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] text-[var(--primary)]">
                  <ShieldCheck size={18} />
                </div>
              </div>

              <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="password">New password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
                    <Input
                      id="password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                      className="pl-10"
                      aria-invalid={Boolean(errors.password)}
                      {...register('password')}
                    />
                  </div>
                  {errors.password && <p className="text-xs text-[var(--destructive)]">{errors.password.message}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="confirm">Confirm new password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
                    <Input
                      id="confirm"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Re-enter your new password"
                      className="pl-10"
                      aria-invalid={Boolean(errors.confirm)}
                      {...register('confirm')}
                    />
                  </div>
                  {errors.confirm && <p className="text-xs text-[var(--destructive)]">{errors.confirm.message}</p>}
                </div>

                {error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 rounded-lg border border-[var(--destructive)]/35 bg-[var(--destructive)]/10 p-3"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 flex-none text-[var(--destructive)]" />
                    <p className="text-xs leading-relaxed text-[var(--destructive)]">{error}</p>
                  </div>
                )}

                <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Updating…
                    </>
                  ) : (
                    'Update password'
                  )}
                </Button>
              </form>
            </>
          )}
        </div>
      </AuthPanel>
    </AuthLayout>
  );
}
