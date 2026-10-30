import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, Mail, Send } from 'lucide-react';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { AuthLayout, AuthPanel } from '../components/layout/AuthLayout';
import { api } from '../api/client';
import { cn } from '../lib/utils';

const schema = z.object({ email: z.string().email('Please enter a valid email address') });
type FormData = z.infer<typeof schema>;

/**
 * Requests a password-reset (or re-verification) link.
 *
 * The server answers 200 with an identical body whether or not the address has
 * an account, so that this page cannot be used to enumerate who is registered.
 * That is why the confirmation below quotes the server's neutral message and
 * never claims an account was found. This wording is load-bearing, not filler.
 */
export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [neutralMessage, setNeutralMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema), defaultValues: { email: '' } });

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      const res = await api.auth.forgotPassword(data.email.trim());
      setNeutralMessage(res.message);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the email. Please try again.');
    }
  };

  return (
    <AuthLayout label="Recover your account" widthClassName="max-w-md">
      <AuthPanel>
        <div className="px-5 py-7 sm:px-7">
          {sent ? (
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--success)_30%,var(--border))] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]">
                <CheckCircle2 className="h-7 w-7" />
              </div>
              <p className="eyebrow mt-5">Request received</p>
              <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">Check your email</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--muted-foreground)]">
                {neutralMessage ?? 'If an account exists for that address, a reset link is on its way.'}
              </p>
              <div className="mt-5 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] p-3 text-left">
                <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                  The link expires in 24 hours and can be used once. If it does not arrive, check your
                  spam folder before requesting another.
                </p>
              </div>
              <Link to="/login" className={cn(buttonVariants(), 'mt-5 w-full')}>
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="eyebrow">Account recovery</p>
                  <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">
                    Reset your password
                  </h1>
                  <p className="mt-1 text-sm leading-relaxed text-[var(--muted-foreground)]">
                    Enter the email on your account and we&apos;ll send a reset link. If the address
                    isn&apos;t confirmed yet, the same link verifies it.
                  </p>
                </div>
                <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--primary)_26%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] text-[var(--primary)]">
                  <Mail size={18} />
                </div>
              </div>

              <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
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
                      Sending…
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4" />
                      Send reset link
                    </>
                  )}
                </Button>
              </form>
            </>
          )}
        </div>
      </AuthPanel>

      <div className="mt-5 flex items-center justify-center gap-1.5 text-xs">
        <Link
          to="/login"
          className="inline-flex items-center gap-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        >
          <ArrowRight size={12} className="rotate-180" />
          Back to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
