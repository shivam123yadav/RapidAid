import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowLeft, Building2, Heart, Lock, Radio, ShieldCheck, Siren } from 'lucide-react';
import { ThemeButton } from '../theme/ThemeButton';
import { cn } from '../../lib/utils';

interface AuthLayoutProps {
  children: ReactNode;
  /** Optional accessible label for the form card region. */
  label?: string;
  /** Width class for the form column. */
  widthClassName?: string;
}

/**
 * The shared sign-in canvas.
 *
 * Presentation only: authentication, validation, redirects and error copy all
 * remain in the page components. The left panel is static narrative content and
 * is removed from the accessibility tree on small screens (where it is hidden).
 */
export function AuthLayout({ children, label = 'Account access', widthClassName = 'max-w-md' }: AuthLayoutProps) {
  return (
    <div className="auth-canvas flex min-h-screen flex-col">
      <header className="relative z-10 flex items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <Link to="/" className="flex items-center gap-2.5" aria-label="RapidAid home">
          <div className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-[var(--primary)] shadow-[0_8px_24px_-10px_var(--primary)]">
            <Heart size={17} className="text-[var(--primary-foreground)]" />
            <span className="absolute inset-x-0 top-0 h-px bg-white/30" />
          </div>
          <span>
            <span className="block font-display text-[1.05rem] font-semibold leading-tight tracking-[-0.04em]">
              RapidAid
            </span>
            <span className="block font-mono text-[8px] uppercase tracking-[0.19em] text-[var(--muted-foreground)]">
              Response network
            </span>
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <Link
            to="/"
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] sm:flex"
          >
            <ArrowLeft size={13} />
            Back to overview
          </Link>
          <ThemeButton />
        </div>
      </header>

      <div className="relative z-10 mx-auto grid w-full max-w-7xl flex-1 items-center gap-10 px-4 pb-10 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:px-8">
        <section className="hidden lg:block" aria-hidden="true">
          <div className="relative max-w-lg">
            <div className="pointer-events-none absolute -inset-8 -z-10 rounded-[2rem] bg-[radial-gradient(ellipse_at_30%_20%,color-mix(in_srgb,var(--primary)_14%,transparent),transparent_70%)] blur-2xl" />
            <p className="eyebrow">Role-scoped emergency operations</p>
            <h2 className="display-title mt-4 text-[clamp(2.6rem,4.4vw,4.25rem)]">
              Every second
              <span className="block text-[var(--primary)]">matters.</span>
            </h2>
            <p className="mt-5 max-w-md text-pretty text-[15px] leading-relaxed text-[var(--muted-foreground)]">
              The same operating picture, shaped for each role. Reports, dispatch decisions, fleet
              positions, hospital capacity and the audit record stay connected end to end.
            </p>

            <div className="mt-9 grid gap-2.5">
              {[
                {
                  icon: Siren,
                  title: 'Incident intake to hospital handoff',
                  body: 'Context moves with the emergency instead of being retyped at each step.',
                },
                {
                  icon: ShieldCheck,
                  title: 'Permissions issued by the server',
                  body: 'The interface only offers what the authenticated role is allowed to open.',
                },
                {
                  icon: Lock,
                  title: 'No fabricated operational state',
                  body: 'Loading, empty, error and forbidden states surface honestly.',
                },
              ].map(({ icon: Icon, title, body }) => (
                <div
                  key={title}
                  className="flex items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--border)_80%,transparent)] bg-[color-mix(in_srgb,var(--card)_62%,transparent)] px-4 py-3 backdrop-blur-sm"
                >
                  <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-[var(--primary)]">
                    <Icon size={15} />
                  </div>
                  <div>
                    <p className="text-[13px] font-semibold">{title}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">{body}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-7 flex items-center gap-4 border-t border-[var(--border)] pt-5 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
              <span className="flex items-center gap-1.5"><Activity size={11} /> Live operational data</span>
              <span className="flex items-center gap-1.5"><Radio size={11} /> Dispatch</span>
              <span className="flex items-center gap-1.5"><Building2 size={11} /> Handoff</span>
            </div>

            <p className="mt-6 max-w-sm text-[10px] leading-relaxed text-[var(--muted-foreground)]">
              RapidAid is a demonstration environment. It does not replace emergency services. In a
              real emergency, call your local emergency number.
            </p>
          </div>
        </section>

        <section className={cn('mx-auto w-full', widthClassName)} aria-label={label}>
          {children}
        </section>
      </div>
    </div>
  );
}

/**
 * The inner form panel. Uses the elevated glass token so the card stays legible
 * on every palette, in both appearances.
 */
export function AuthPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'glass-elevated relative overflow-hidden rounded-2xl border border-[var(--border)] shadow-[var(--shadow-cinematic)]',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_srgb,var(--primary)_9%,transparent),transparent_75%)]"
      />
      <div className="relative">{children}</div>
    </div>
  );
}
