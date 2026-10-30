import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Building2,
  Eye,
  Heart,
  Radio,
  Shield,
  ShieldCheck,
  Siren,
  Truck,
  Users,
} from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { ThemeButton } from '../components/theme/ThemeButton';
import { Reveal, RevealGroup, RevealItem } from '../components/motion/Reveal';
import { ROLE_LABELS, HOME_ROUTE } from '../lib/navigation';
import { DEMO_PASSWORD } from '../lib/demoCredentials';
import type { UserRole } from '../types';

interface DemoRole {
  role: UserRole;
  icon: typeof Siren;
  description: string;
  capabilities: string[];
}

/** Ordered to mirror the demo-persona list on the sign-in screen. */
const DEMO_ROLES: DemoRole[] = [
  {
    role: 'DISPATCHER',
    icon: Radio,
    description: 'Triage the queue, compare ranked recommendations and assign the right unit.',
    capabilities: ['Emergency queue', 'Dispatch recommendations', 'Assignment and override'],
  },
  {
    role: 'AMBULANCE_CREW',
    icon: Truck,
    description: 'See the assigned incident, route and handoff details from a touch-first shift workspace.',
    capabilities: ['Assigned incident', 'Shift and availability', 'Own-unit status'],
  },
  {
    role: 'HOSPITAL_STAFF',
    icon: Building2,
    description: 'Review incoming units and keep trauma, emergency-department and capacity information current.',
    capabilities: ['Incoming handoffs', 'Capacity updates', 'Trauma readiness'],
  },
  {
    role: 'ADMIN',
    icon: Users,
    description: 'Provision people, shape permissions and monitor the operational health of the system.',
    capabilities: ['User provisioning', 'Permission matrix', 'Fleet administration'],
  },
  {
    role: 'SUPERVISOR',
    icon: Shield,
    description: 'Oversee live operations, intervene deliberately and review the resulting record.',
    capabilities: ['Live command center', 'Escalation controls', 'Audit and reporting'],
  },
  {
    role: 'ANALYST',
    icon: BarChart3,
    description: 'Investigate operational trends using real API data and token-consistent charts.',
    capabilities: ['Operational analytics', 'Report generation', 'Real API metrics'],
  },
  {
    role: 'AUDITOR',
    icon: Eye,
    description: 'Read the traceable audit record without entering the operational workflow.',
    capabilities: ['Read-only audit trail', 'Actor and resource search', 'No operational writes'],
  },
  {
    role: 'CITIZEN',
    icon: Siren,
    description: 'Report an emergency and follow the response from a calm, personal workspace.',
    capabilities: ['Emergency reporting', 'Own incident tracking', 'Voice reports'],
  },
];

export function DemoRolesPage() {
  return (
    <div className="auth-canvas min-h-screen">
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

      <main className="relative z-10 mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6 sm:pt-14 lg:px-8">
        <Reveal>
          <div className="mx-auto max-w-3xl text-center">
            <Badge
              variant="outline"
              className="gap-2 border-[color-mix(in_srgb,var(--primary)_32%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_7%,transparent)] px-3 py-1 text-[10px] tracking-[0.1em] text-[var(--foreground)]"
            >
              <Users size={13} className="text-[var(--primary)]" />
              Demo personas
            </Badge>
            <h1 className="display-title mt-5 text-[clamp(2.6rem,6vw,4.5rem)] text-[var(--foreground)]">
              Step into the response loop.
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-[var(--muted-foreground)] sm:text-lg">
              Every persona below signs into a real role-scoped workspace. Choose one to prefill its
              demo credentials, then confirm the sign-in step.
            </p>
            <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_70%,transparent)] px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted-foreground)] backdrop-blur-sm">
              <ShieldCheck size={12} className="text-[var(--success)]" />
              Demo password
              <span className="text-[var(--foreground)]">{DEMO_PASSWORD}</span>
            </div>
          </div>
        </Reveal>

        <RevealGroup className="mt-12 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {DEMO_ROLES.map(({ role, icon: Icon, description, capabilities }) => (
            <RevealItem key={role}>
              <Link
                to={`/login?role=${role}&demo=1`}
                className="group flex h-full flex-col rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 transition-colors hover:border-[color-mix(in_srgb,var(--primary)_32%,var(--border))] focus-visible:border-[var(--primary)]"
                aria-label={`Open the ${ROLE_LABELS[role]} demo`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_8%,transparent)] text-[var(--primary)]">
                    <Icon size={18} />
                  </div>
                  <span className="font-mono text-[8px] uppercase tracking-[0.13em] text-[var(--muted-foreground)]">
                    {HOME_ROUTE[role]}
                  </span>
                </div>

                <h2 className="mt-4 font-display text-lg font-semibold tracking-[-0.025em]">
                  {ROLE_LABELS[role]}
                </h2>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-[var(--muted-foreground)]">
                  {description}
                </p>

                <ul className="mt-4 space-y-1.5 border-t border-[var(--border)] pt-4">
                  {capabilities.map((capability) => (
                    <li
                      key={capability}
                      className="flex items-start gap-2 text-[11px] leading-relaxed text-[var(--muted-foreground)]"
                    >
                      <span className="mt-1.5 h-1 w-1 flex-none rounded-full bg-[var(--primary)]" />
                      {capability}
                    </li>
                  ))}
                </ul>

                <span className="mt-5 inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--primary)]">
                  Open this demo
                  <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            </RevealItem>
          ))}
        </RevealGroup>

        <Reveal>
          <div className="mt-10 flex flex-col items-start justify-between gap-4 rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_70%,transparent)] px-5 py-4 backdrop-blur-sm sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]">
                <ShieldCheck size={16} />
              </div>
              <div>
                <p className="text-sm font-semibold">Role scope is enforced by the API</p>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--muted-foreground)]">
                  Demo data is shared, but every persona still sees only what its permissions allow.
                  These credentials exist for this demonstration environment only.
                </p>
              </div>
            </div>
            <Link to="/login">
              <Button variant="outline" size="sm" className="gap-1.5">
                Continue to sign in
                <ArrowRight size={13} />
              </Button>
            </Link>
          </div>
        </Reveal>

        <p className="mx-auto mt-6 max-w-xl text-center text-[10px] leading-relaxed text-[var(--muted-foreground)]">
          RapidAid is a demonstration environment and does not replace emergency services. In a real
          emergency, call your local emergency number.
        </p>
      </main>
    </div>
  );
}
