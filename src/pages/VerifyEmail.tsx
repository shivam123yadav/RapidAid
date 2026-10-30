import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Loader2, Mail } from 'lucide-react';
import { buttonVariants } from '../components/ui/button';
import { AuthLayout, AuthPanel } from '../components/layout/AuthLayout';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { cn } from '../lib/utils';

type Phase = 'verifying' | 'success' | 'error';

/**
 * Landing page for the emailed confirmation link.
 *
 * The token arrives as `?token=…` and is consumed on mount — the route path is
 * fixed by `server/src/services/email/emailService.ts`, so links already sitting
 * in inboxes stay valid.
 *
 * The endpoint is deliberately indistinguishable for a malformed, expired, and
 * already-used token, so this screen must not claim to know which one occurred.
 */
export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [phase, setPhase] = useState<Phase>('verifying');
  const [message, setMessage] = useState<string | null>(null);
  // Guards against a second POST under React 18 StrictMode double-effects and
  // against tokens that are single-use: a replay would be rejected anyway.
  const attempted = useRef(false);

  // Keep the store in sync so the reminder banner disappears once confirmed.
  const setUser = useAuthStore((state) => state.setUser);
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    if (!token) {
      setPhase('error');
      setMessage('This link is missing its verification token.');
      return;
    }

    api.auth
      .verifyEmail(token)
      .then((res) => {
        if (res.emailVerified && user) {
          setUser({ ...user, emailVerified: true });
        }
        setPhase('success');
      })
      .catch((err: unknown) => {
        setPhase('error');
        setMessage(
          err instanceof Error
            ? err.message
            : 'This verification link is invalid or has expired.',
        );
      });
  }, [token, user, setUser]);

  return (
    <AuthLayout label="Email verification" widthClassName="max-w-md">
      <AuthPanel>
        <div className="px-5 py-9 text-center sm:px-7">
          {phase === 'verifying' && (
            <>
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--primary)_26%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] text-[var(--primary)]">
                <Loader2 className="h-7 w-7 animate-spin" />
              </div>
              <p className="eyebrow mt-5">Secure link</p>
              <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">
                Confirming your email
              </h1>
              <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                One moment while we check your link…
              </p>
            </>
          )}

          {phase === 'success' && (
            <>
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--success)_30%,var(--border))] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]">
                <CheckCircle2 className="h-7 w-7" />
              </div>
              <p className="eyebrow mt-5">Confirmed</p>
              <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">Email verified</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--muted-foreground)]">
                Your address is confirmed and your account is fully active.
              </p>
              <Link to="/" className={cn(buttonVariants(), 'mt-5 w-full')}>
                Continue to RapidAid
              </Link>
            </>
          )}

          {phase === 'error' && (
            <>
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 text-[var(--destructive)]">
                <AlertCircle className="h-7 w-7" />
              </div>
              <p className="eyebrow mt-5">Verification</p>
              <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">Link not valid</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--muted-foreground)]">
                {message ?? 'This verification link is invalid or has expired.'}
              </p>
              <p className="mx-auto mt-3 max-w-xs text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                Links can only be used once and expire after 24 hours. Requesting a new one does not
                sign anything out — your existing session keeps working.
              </p>
              <Link
                to="/forgot-password"
                className={cn(buttonVariants({ variant: 'outline' }), 'mt-5 w-full gap-2')}
              >
                <Mail size={14} />
                Send me a new link
              </Link>
              <Link to="/login" className={cn(buttonVariants({ variant: 'ghost' }), 'mt-1.5 w-full')}>
                Back to sign in
              </Link>
            </>
          )}
        </div>
      </AuthPanel>
    </AuthLayout>
  );
}
