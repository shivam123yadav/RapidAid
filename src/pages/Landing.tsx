import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Brain,
  Building2,
  CheckCircle2,
  Clock,
  ExternalLink,
  Eye,
  Globe,
  Heart,
  MapPin,
  Menu,
  Mic,
  Radio,
  Shield,
  ShieldCheck,
  Siren,
  TrafficCone,
  Truck,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { ThemeButton } from '../components/theme/ThemeButton';
import { Reveal, RevealGroup, RevealItem } from '../components/motion/Reveal';
import { EASE_OUT_EXPO } from '../lib/motion';
import { useAuthStore } from '../stores/auth';
import { useThemeStore } from '../stores/theme';
import { THEME_LIST } from '../theme';
import { ROLE_LABELS, canAccess, homeRouteFor } from '../lib/navigation';
import type { UserRole } from '../types';
import { cn } from '../lib/utils';

const NAV_LINKS = [
  { href: '#network', label: 'Network' },
  { href: '#capabilities', label: 'Capabilities' },
  { href: '#roles', label: 'Roles' },
  { href: '#security', label: 'Security' },
  { href: '#appearance', label: 'Appearance' },
  { href: '#developers', label: 'Developers' },
];

function GithubIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

function LinkedinIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
      <rect x="2" y="9" width="4" height="12" />
      <circle cx="4" cy="4" r="2" />
    </svg>
  );
}

interface DeveloperProfile {
  name: string;
  initials: string;
  role: string;
  leadTag: string;
  bio: string;
  focusAreas: string[];
  githubUrl?: string;
  linkedinUrl?: string;
}

const DEVELOPERS: DeveloperProfile[] = [
  {
    name: 'Shivam Yadav',
    initials: 'SY',
    role: 'Full-Stack Developer & Cloud Architect',
    leadTag: 'Backend & Infrastructure',
    bio: 'Architected RapidAid\'s core emergency backend services, transactional dispatch reconciliation, multilingual voice intake pipeline, and cloud deployment infrastructure.',
    focusAreas: ['Backend Architecture', 'Real-Time Dispatch', 'Voice Intelligence', 'Cloud Infrastructure'],
    githubUrl: 'https://github.com/shivam123yadav',
  },
  {
    name: 'Yash Jaiswal',
    initials: 'YJ',
    role: 'Full-Stack Developer & Systems Engineer',
    leadTag: 'Frontend & Integrations',
    bio: 'Engineered RapidAid\'s operational consoles, live telemetry map tracking, automated road routing coordination, and end-to-end emergency response user experience.',
    focusAreas: ['Operational UI/UX', 'Live GPS Tracking', 'Road Routing', 'Systems Integration'],
  },
];

const CAPABILITIES = [
  {
    icon: Siren,
    title: 'Incident intake',
    description: 'Structured SOS and incident reporting with priority, location and victim details.',
    path: '/emergencies',
    tag: 'Operations',
  },
  {
    icon: Eye,
    title: 'AI vision review',
    description: 'Camera detections arrive with confidence scores and a human confirm-or-reject step.',
    path: '/ai-vision',
    tag: 'Intelligence',
  },
  {
    icon: Radio,
    title: 'Dispatch intelligence',
    description: 'Ranked ambulance and hospital recommendations with explainable scoring.',
    path: '/dispatch',
    tag: 'Intelligence',
  },
  {
    icon: MapPin,
    title: 'Live tracking',
    description: 'Ambulance positions and incident locations on the existing operational map.',
    path: '/tracking',
    tag: 'Operations',
  },
  {
    icon: Building2,
    title: 'Hospital coordination',
    description: 'Capacity, trauma availability and incoming handoffs in one shared view.',
    path: '/hospitals',
    tag: 'Operations',
  },
  {
    icon: Mic,
    title: 'Voice-assisted reports',
    description: 'Record, review and transcribe an emergency report before it enters the workflow.',
    path: '/voice',
    tag: 'Intelligence',
  },
  {
    icon: TrafficCone,
    title: 'Green corridor',
    description: 'Traffic-signal coordination for an assigned emergency route.',
    path: '/green-corridor',
    tag: 'Analytics',
  },
  {
    icon: BarChart3,
    title: 'Operational analytics',
    description: 'Emergency volume, response times, fleet utilisation and hospital load.',
    path: '/analytics',
    tag: 'Analytics',
  },
  {
    icon: Shield,
    title: 'Audit trail',
    description: 'Permission-scoped access to the record of operational actions.',
    path: '/audit',
    tag: 'System',
  },
];

const ROLE_META: Record<UserRole, { icon: typeof Siren; description: string }> = {
  CITIZEN: { icon: Siren, description: 'Report an emergency and follow the response from a clear, calm workspace.' },
  DISPATCHER: { icon: Radio, description: 'Triage the queue, compare recommendations and assign the right unit.' },
  AMBULANCE_CREW: { icon: Truck, description: 'See the assigned incident, route and handoff details on a touch-first screen.' },
  HOSPITAL_STAFF: { icon: Building2, description: 'Review incoming emergencies and keep capacity information current.' },
  SUPERVISOR: { icon: Shield, description: 'Oversee live operations, intervene deliberately and review outcomes.' },
  ANALYST: { icon: BarChart3, description: 'Investigate operational trends with token-consistent charts and filters.' },
  AUDITOR: { icon: Eye, description: 'Read the traceable record without entering the operational workflow.' },
  ADMIN: { icon: Users, description: 'Provision people, shape permissions and monitor system health.' },
};

const ROLE_ORDER: UserRole[] = [
  'CITIZEN',
  'DISPATCHER',
  'AMBULANCE_CREW',
  'HOSPITAL_STAFF',
  'SUPERVISOR',
  'ANALYST',
  'AUDITOR',
  'ADMIN',
];

export function LandingPage({ defaultHash }: { defaultHash?: string } = {}) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);
  const role = user?.role;
  const themeId = useThemeStore((state) => state.themeId);
  const setTheme = useThemeStore((state) => state.setTheme);
  const reduce = useReducedMotion() ?? false;
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const workspace = isAuthenticated ? homeRouteFor(role) : '/login';

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const hash = defaultHash || window.location.hash;
    if (hash) {
      const timer = setTimeout(() => {
        const el = document.querySelector(hash);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth' });
        }
      }, 70);
      return () => clearTimeout(timer);
    }
  }, [defaultHash]);

  const targetFor = (path: string) => {
    if (!isAuthenticated) return '/login';
    return canAccess(path, role, user?.permissions) ? path : workspace;
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-[var(--background)] text-[var(--foreground)]">
      <header
        className={cn(
          'fixed inset-x-0 top-0 z-50 border-b transition-colors',
          scrolled
            ? 'border-[var(--border)] bg-[color-mix(in_srgb,var(--background)_88%,transparent)] shadow-[0_12px_40px_-30px_rgba(2,6,23,0.55)] backdrop-blur-xl'
            : 'border-transparent bg-transparent',
        )}
      >
        <div className="mx-auto flex h-[4.5rem] max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex flex-none items-center gap-2.5" aria-label="RapidAid home">
            <div className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-[var(--primary)] shadow-[0_8px_24px_-10px_var(--primary)]">
              <Heart size={17} className="text-[var(--primary-foreground)]" />
              <span className="absolute inset-x-0 top-0 h-px bg-white/30" />
            </div>
            <span className="min-w-0">
              <span className="block font-display text-[1.05rem] font-semibold leading-tight tracking-[-0.04em]">RapidAid</span>
              <span className="hidden font-mono text-[8px] uppercase tracking-[0.19em] text-[var(--muted-foreground)] sm:block">
                Response network
              </span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1 lg:flex" aria-label="Landing navigation">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="rounded-lg px-3 py-2 text-[13px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="flex flex-none items-center gap-1.5 sm:gap-2">
            <ThemeButton />
            <Link to={workspace} className="hidden sm:block">
              <Button variant="ghost" size="sm">
                {isAuthenticated ? 'My workspace' : 'Sign in'}
              </Button>
            </Link>
            <Link to={workspace}>
              <Button size="sm" className="gap-1.5">
                <Siren size={14} />
                <span className="hidden xs:inline">Report emergency</span>
                <span className="xs:hidden">SOS</span>
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="iconSm"
              className="lg:hidden"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls="landing-mobile-nav"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            >
              {menuOpen ? <X size={18} /> : <Menu size={18} />}
            </Button>
          </div>
        </div>

        {menuOpen && (
          <nav
            id="landing-mobile-nav"
            className="border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--background)_96%,transparent)] px-4 py-3 backdrop-blur-xl lg:hidden"
            aria-label="Landing navigation"
          >
            <div className="mx-auto grid max-w-7xl gap-1 sm:grid-cols-2">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  {link.label}
                </a>
              ))}
              <Link
                to={workspace}
                onClick={() => setMenuOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--primary)]"
              >
                {isAuthenticated ? 'Open my workspace' : 'Sign in to RapidAid'}
              </Link>
            </div>
          </nav>
        )}
      </header>

      <main>
        {/* ---------------------------------------------------------------- */}
        {/* Hero                                                             */}
        {/* ---------------------------------------------------------------- */}
        <section className="relative overflow-hidden pb-16 pt-32 sm:pb-20 sm:pt-36 lg:pb-24 lg:pt-40">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="cinematic-grid absolute inset-0 opacity-60" />
            <div className="ambient-orb left-[-8rem] top-[10%] h-[30rem] w-[30rem] bg-[var(--primary)]/10" />
            <div className="ambient-orb right-[-10rem] top-[32%] h-[34rem] w-[34rem] bg-[var(--info)]/10" />
            <div className="absolute inset-x-0 top-0 h-[34rem] bg-[radial-gradient(ellipse_75%_60%_at_50%_0%,color-mix(in_srgb,var(--primary)_8%,transparent),transparent_75%)]" />
          </div>

          <div className="relative mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-3xl text-center">
              <Reveal immediate y={10}>
                <div className="mb-6 flex flex-wrap items-center justify-center gap-2">
                  <Badge variant="outline" className="gap-2 border-[color-mix(in_srgb,var(--primary)_32%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_7%,transparent)] px-3 py-1 text-[10px] tracking-[0.1em] text-[var(--foreground)]">
                    <span className="status-dot status-dot--live text-[var(--success)]" aria-hidden="true" />
                    Connected emergency response
                  </Badge>
                  <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--muted-foreground)]">
                    RapidAid / Network
                  </span>
                </div>
              </Reveal>

              <motion.h1
                className="display-title text-[clamp(3.4rem,8.2vw,7rem)] text-[var(--foreground)]"
                initial={reduce ? false : { opacity: 0, y: 26 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, ease: EASE_OUT_EXPO, delay: 0.06 }}
              >
                Every second
                <span className="block text-[var(--primary)]">matters.</span>
              </motion.h1>

              <Reveal immediate delay={0.16}>
                <p className="mx-auto mt-6 max-w-xl text-balance text-lg leading-relaxed text-[var(--muted-foreground)] sm:text-xl">
                  Connected emergency response. Intelligent coordination. Faster decisions when lives are at stake.
                </p>
              </Reveal>

              <Reveal immediate delay={0.24}>
                <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row sm:items-center">
                  <Link to={workspace}>
                    <Button size="lg" className="w-full gap-2 sm:w-auto">
                      <Activity size={18} />
                      {isAuthenticated ? 'Open my workspace' : 'Enter the network'}
                      <ArrowRight size={16} />
                    </Button>
                  </Link>
                  <a href="#capabilities">
                    <Button variant="outline" size="lg" className="w-full gap-2 sm:w-auto">
                      <Globe size={17} />
                      Explore the platform
                    </Button>
                  </a>
                </div>
              </Reveal>

              <Reveal immediate delay={0.3}>
                <p className="mx-auto mt-4 max-w-md text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                  RapidAid is a demonstration environment and does not replace emergency services. In a real
                  emergency, call your local emergency number.
                </p>
              </Reveal>

              <Reveal immediate delay={0.36}>
                <div className="mx-auto mt-10 grid max-w-2xl grid-cols-1 gap-4 border-y border-[var(--border)] py-4 text-left sm:grid-cols-3 sm:gap-3">
                  {[
                    { icon: Radio, label: 'One network', detail: 'Intake to handoff' },
                    { icon: ShieldCheck, label: 'Role-scoped', detail: 'Server-enforced' },
                    { icon: Eye, label: 'Human review', detail: 'AI stays assistive' },
                  ].map(({ icon: Icon, label, detail }) => (
                    <div key={label} className="flex items-start gap-2.5">
                      <Icon size={15} className="mt-0.5 flex-none text-[var(--primary)]" />
                      <div>
                        <p className="text-xs font-semibold">{label}</p>
                        <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">{detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Reveal>
            </div>
          </div>

          <a
            href="#network"
            className="relative mx-auto mt-14 flex w-fit items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--muted-foreground)] transition-colors hover:border-[var(--primary)]/40 hover:text-[var(--foreground)]"
          >
            <span className="h-1 w-1 rounded-full bg-[var(--primary)]" />
            Follow the response loop
            <ArrowRight size={11} className="rotate-90" />
          </a>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Network / workflow                                                */}
        {/* ---------------------------------------------------------------- */}
        <section id="network" className="relative border-y border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_42%,transparent)] py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="max-w-3xl">
                <p className="eyebrow">The response loop</p>
                <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.045em] sm:text-4xl lg:text-5xl">
                  One continuous thread from first signal to definitive care.
                </h2>
                <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-[var(--muted-foreground)]">
                  RapidAid connects the people, vehicles and hospitals already doing the work — so context
                  moves with the emergency instead of being retyped at every handoff.
                </p>
              </div>
            </Reveal>

            <div className="mt-14 grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
              <Reveal className="order-2 lg:order-1">
                <div className="lg:sticky lg:top-28">
                  <div className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-[var(--shadow-pop)]">
                    <div aria-hidden="true" className="cinematic-grid absolute inset-0 opacity-35" />
                    <div className="relative">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--muted-foreground)]">
                          Response thread
                        </span>
                        <Badge variant="outline" className="text-[9px]">Illustrative</Badge>
                      </div>
                      <div className="relative mt-8 space-y-0">
                        {[
                          { icon: Siren, label: 'Signal received', note: 'Citizen report, voice intake or reviewed detection', color: 'text-[var(--danger)]' },
                          { icon: Brain, label: 'Context assembled', note: 'Priority, location, victims and resource fit', color: 'text-[var(--warning)]' },
                          { icon: Truck, label: 'Response assigned', note: 'Ambulance and destination confirmed', color: 'text-[var(--primary)]' },
                          { icon: Building2, label: 'Care handoff', note: 'Hospital receives the incoming picture', color: 'text-[var(--success)]' },
                        ].map((step, index, all) => (
                          <div key={step.label} className="relative flex gap-4 pb-7 last:pb-0">
                            <div className="relative z-10 flex flex-col items-center">
                              <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--background)]', step.color)}>
                                <step.icon size={15} />
                              </div>
                              {index < all.length - 1 && (
                                <div className="absolute top-9 h-[calc(100%-1.75rem)] w-px bg-gradient-to-b from-[var(--primary)]/40 to-[var(--border)]" />
                              )}
                            </div>
                            <div className="pt-1">
                              <p className="text-sm font-semibold">{step.label}</p>
                              <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-foreground)]">{step.note}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[11px] text-[var(--muted-foreground)]">
                        <ShieldCheck size={13} className="flex-none text-[var(--success)]" />
                        Human judgement remains in the loop at every handoff.
                      </div>
                    </div>
                  </div>
                </div>
              </Reveal>

              <div className="order-1 space-y-10 lg:order-2">
                {[
                  {
                    number: '01',
                    eyebrow: 'Intake',
                    title: 'Capture the signal without adding friction.',
                    body: 'Citizen SOS, structured incident reports, voice-assisted intake and reviewed camera detections all enter the same workflow. Priority and location travel with the report.',
                    icon: Siren,
                    points: ['Structured fields and validation', 'Photo evidence where provided', 'Human review before a detection becomes an incident'],
                  },
                  {
                    number: '02',
                    eyebrow: 'Triage',
                    title: 'Turn a report into a shared operational picture.',
                    body: 'Incident detail, timeline and assignment state are visible to the roles that need them. The system does not decide alone — it gives dispatchers a legible basis for the decision.',
                    icon: Brain,
                    points: ['Priority and status hierarchy', 'Ambulance and hospital recommendations', 'Timeline of operational state changes'],
                  },
                  {
                    number: '03',
                    eyebrow: 'Response',
                    title: 'Move the right resource, then keep everyone aligned.',
                    body: 'Assignments, live tracking, green corridors and hospital capacity live alongside the incident rather than in separate tools.',
                    icon: Truck,
                    points: ['Live ambulance tracking on the map', 'Route and ETA context from existing data', 'Hospital capacity and handoff coordination'],
                  },
                  {
                    number: '04',
                    eyebrow: 'Oversight',
                    title: 'Leave a record that can be examined later.',
                    body: 'Role-scoped audit views and analytics make operational activity reviewable without exposing it to roles that do not hold the permission.',
                    icon: Shield,
                    points: ['Audit trail for operational actions', 'Analytics from real API data', 'Restricted views fail closed with an explanation'],
                  },
                ].map((step) => (
                  <Reveal key={step.number}>
                    <div className="grid gap-4 sm:grid-cols-[3.5rem_1fr]">
                      <div className="font-mono text-xs font-medium tracking-[0.16em] text-[var(--primary)]">{step.number}</div>
                      <div>
                        <p className="eyebrow">{step.eyebrow}</p>
                        <h3 className="mt-1.5 font-display text-xl font-semibold tracking-[-0.035em] sm:text-2xl">{step.title}</h3>
                        <p className="mt-2.5 text-sm leading-relaxed text-[var(--muted-foreground)]">{step.body}</p>
                        <ul className="mt-4 grid gap-2">
                          {step.points.map((point) => (
                            <li key={point} className="flex items-start gap-2 text-xs text-[var(--muted-foreground)]">
                              <CheckCircle2 size={13} className="mt-0.5 flex-none text-[var(--success)]" />
                              {point}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </Reveal>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Capabilities                                                      */}
        {/* ---------------------------------------------------------------- */}
        <section id="capabilities" className="relative py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                <div className="max-w-2xl">
                  <p className="eyebrow">Platform capabilities</p>
                  <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.045em] sm:text-4xl lg:text-5xl">
                    Every seat at the table gets a purpose-built surface.
                  </h2>
                </div>
                <p className="max-w-sm text-sm leading-relaxed text-[var(--muted-foreground)]">
                  These are existing modules in the RapidAid network, not concept screens. Access depends
                  on the role and permission issued by the server.
                </p>
              </div>
            </Reveal>

            <RevealGroup className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map((capability) => {
                const target = targetFor(capability.path);
                return (
                  <RevealItem key={capability.title}>
                    <Link to={target} className="group block h-full">
                      <Card variant="interactive" className="flex h-full flex-col overflow-hidden">
                        <CardContent className="flex flex-1 flex-col p-5 sm:p-6">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_8%,transparent)] text-[var(--primary)]">
                              <capability.icon size={18} />
                            </div>
                            <span className="font-mono text-[8px] uppercase tracking-[0.16em] text-[var(--muted-foreground)]">
                              {capability.tag}
                            </span>
                          </div>
                          <h3 className="mt-4 font-display text-base font-semibold tracking-[-0.025em]">{capability.title}</h3>
                          <p className="mt-2 flex-1 text-sm leading-relaxed text-[var(--muted-foreground)]">{capability.description}</p>
                          <span className="mt-5 inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--primary)]">
                            {isAuthenticated ? 'Open module' : 'Sign in to open'}
                            <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
                          </span>
                        </CardContent>
                      </Card>
                    </Link>
                  </RevealItem>
                );
              })}
            </RevealGroup>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Roles                                                             */}
        {/* ---------------------------------------------------------------- */}
        <section id="roles" className="border-y border-[var(--border)] bg-[var(--surface)]/45 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="max-w-2xl">
                <p className="eyebrow">Role-aware by design</p>
                <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.045em] sm:text-4xl lg:text-5xl">
                  A different workspace, the same source of truth.
                </h2>
                <p className="mt-4 text-pretty leading-relaxed text-[var(--muted-foreground)]">
                  Navigation, actions and data are scoped to the signed-in role. The interface and the API
                  guards read the same permission registry, so a hidden action is also a protected action.
                </p>
              </div>
            </Reveal>

            <RevealGroup className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {ROLE_ORDER.map((roleKey) => {
                const meta = ROLE_META[roleKey];
                const Icon = meta.icon;
                return (
                  <RevealItem key={roleKey}>
                    <div className="group h-full rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 transition-colors hover:border-[color-mix(in_srgb,var(--primary)_28%,var(--border))]">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--muted)] text-[var(--primary)]">
                          <Icon size={15} />
                        </div>
                        <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          {ROLE_LABELS[roleKey]}
                        </span>
                      </div>
                      <p className="mt-3 text-sm font-semibold">{ROLE_LABELS[roleKey]}</p>
                      <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted-foreground)]">{meta.description}</p>
                    </div>
                  </RevealItem>
                );
              })}
            </RevealGroup>

            <Reveal>
              <div className="mt-10 flex flex-col items-start justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--card)] px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-[var(--primary)]">
                    <Users size={16} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Try a role workspace</p>
                    <p className="text-xs text-[var(--muted-foreground)]">Compare role workspaces and prefill a demo persona.</p>
                  </div>
                </div>
                <Link to="/demo-roles">
                  <Button variant="outline" size="sm" className="gap-1.5">
                    View demo roles
                    <ArrowRight size={13} />
                  </Button>
                </Link>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Security                                                          */}
        {/* ---------------------------------------------------------------- */}
        <section id="security" className="relative overflow-hidden py-20 sm:py-24">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="absolute inset-0 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--card)_92%,black),color-mix(in_srgb,var(--background)_96%,black))]" />
            <div className="cinematic-grid absolute inset-0 opacity-30" />
            <div className="ambient-orb right-[8%] top-[-6rem] h-[22rem] w-[22rem] bg-[var(--primary)]/12" />
          </div>
          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
              <Reveal>
                <div>
                  <p className="eyebrow text-[var(--primary-soft)]">Trust boundaries</p>
                  <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.045em] sm:text-4xl lg:text-5xl">
                    The spectacle stops at the edge of the data.
                  </h2>
                  <p className="mt-4 max-w-lg leading-relaxed text-[var(--muted-foreground)]">
                    The cinematic layer is presentation only. Authentication, authorization, API contracts
                    and operational state keep the behaviour they already had.
                  </p>
                  <div className="mt-7 flex flex-wrap gap-2">
                    <Badge variant="outline" className="border-[var(--border)] bg-[var(--card)]/60">No mock success states</Badge>
                    <Badge variant="outline" className="border-[var(--border)] bg-[var(--card)]/60">No replacement APIs</Badge>
                    <Badge variant="outline" className="border-[var(--border)] bg-[var(--card)]/60">No fabricated telemetry</Badge>
                  </div>
                </div>
              </Reveal>

              <RevealGroup className="grid gap-3 sm:grid-cols-2">
                {[
                  { icon: ShieldCheck, title: 'Server-enforced roles', body: 'The sidebar, route guard and command palette read the permissions the server issued. Deep links outside a role receive an explanation, not a bypass.' },
                  { icon: Eye, title: 'Human-in-the-loop AI', body: 'Vision detections and recommendations support an operator decision. Review, confirmation and rejection remain explicit actions.' },
                  { icon: Clock, title: 'Honest loading and failure', body: 'Skeletons keep the layout stable; API errors surface as errors. A failed assignment is never painted as a success.' },
                  { icon: Zap, title: 'One token system', body: 'Every palette and appearance is expressed as semantic tokens, so a theme change cannot change a permission, a coordinate or a payload.' },
                ].map((item) => (
                  <RevealItem key={item.title}>
                    <div className="h-full rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_70%,transparent)] p-5 backdrop-blur-sm">
                      <item.icon size={18} className="text-[var(--primary)]" />
                      <h3 className="mt-3 text-sm font-semibold">{item.title}</h3>
                      <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted-foreground)]">{item.body}</p>
                    </div>
                  </RevealItem>
                ))}
              </RevealGroup>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Appearance                                                        */}
        {/* ---------------------------------------------------------------- */}
        <section id="appearance" className="border-y border-[var(--border)] py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                <div className="max-w-2xl">
                  <p className="eyebrow">Appearance</p>
                  <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.045em] sm:text-4xl lg:text-5xl">
                    A control room that adapts to the room.
                  </h2>
                  <p className="mt-4 max-w-xl leading-relaxed text-[var(--muted-foreground)]">
                    Five intentional palettes, each with a designed day and night appearance. Switch here,
                    then fine-tune day, night or system mode from the header.
                  </p>
                </div>
                <ThemeButton />
              </div>
            </Reveal>

            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {THEME_LIST.map((theme) => {
                const preview = theme.variants.day.preview;
                const selected = themeId === theme.id;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    onClick={() => setTheme(theme.id)}
                    aria-pressed={selected}
                    className={cn(
                      'group overflow-hidden rounded-xl border text-left transition-[border-color,transform,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]',
                      selected
                        ? 'border-[var(--primary)] shadow-[var(--shadow-pop)]'
                        : 'border-[var(--border)] hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--primary)_34%,var(--border))]',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="block h-24 border-b border-black/10 p-3"
                      style={{ backgroundColor: preview.background }}
                    >
                      <span className="flex h-full gap-1.5">
                        <span className="flex w-1/4 flex-col gap-1 rounded-md p-1" style={{ backgroundColor: preview.sidebar }}>
                          <span className="h-1 w-3 rounded-full" style={{ backgroundColor: preview.primary }} />
                          <span className="h-1 w-4 rounded-full" style={{ backgroundColor: preview.muted }} />
                          <span className="h-1 w-3 rounded-full" style={{ backgroundColor: preview.muted }} />
                        </span>
                        <span className="flex flex-1 flex-col gap-1.5">
                          <span className="flex gap-1">
                            <span className="h-5 flex-1 rounded-md" style={{ backgroundColor: preview.card }} />
                            <span className="h-5 flex-1 rounded-md" style={{ backgroundColor: preview.card }} />
                          </span>
                          <span className="h-1.5 w-2/3 rounded-full" style={{ backgroundColor: preview.primary }} />
                          <span className="h-1 w-full rounded-full" style={{ backgroundColor: preview.border }} />
                          <span className="h-1 w-3/4 rounded-full" style={{ backgroundColor: preview.border }} />
                        </span>
                      </span>
                    </span>
                    <span className="block bg-[var(--card)] p-3">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">{theme.name}</span>
                        {selected && <CheckCircle2 size={13} className="text-[var(--primary)]" />}
                      </span>
                      <span className="mt-1 block text-[10px] leading-snug text-[var(--muted-foreground)]">{theme.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Developers                                                        */}
        {/* ---------------------------------------------------------------- */}
        <section id="developers" className="relative border-b border-[var(--border)] py-20 sm:py-24">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="ambient-orb -right-24 top-1/2 h-80 w-80 -translate-y-1/2 bg-[var(--primary)]/10" />
          </div>
          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="flex flex-col gap-4 max-w-3xl">
                <p className="eyebrow text-[var(--primary)]">Engineering &amp; Architecture</p>
                <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.045em] sm:text-4xl lg:text-5xl">
                  Meet the Developers
                </h2>
                <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-[var(--muted-foreground)]">
                  The two developers designed and built the RapidAid platform, architecting an integrated emergency response network that pairs real-time dispatch with live telemetry and resilient coordination.
                </p>
              </div>
            </Reveal>

            <RevealGroup className="mt-12 grid gap-6 sm:grid-cols-2 max-w-5xl">
              {DEVELOPERS.map((dev) => (
                <RevealItem key={dev.name}>
                  <Card
                    variant="interactive"
                    className="group relative flex h-full flex-col overflow-hidden border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_70%,transparent)] p-6 sm:p-8 backdrop-blur-sm transition-all duration-300 hover:border-[color-mix(in_srgb,var(--primary)_40%,var(--border))] hover:shadow-[var(--shadow-pop)]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <Badge
                        variant="outline"
                        className="border-[var(--border)] bg-[var(--surface)] text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--muted-foreground)]"
                      >
                        {dev.leadTag}
                      </Badge>
                      <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--success)]">
                        <CheckCircle2 size={12} />
                        Core Developer
                      </span>
                    </div>

                    <div className="mt-5 flex items-start gap-4">
                      <div className="relative flex h-14 w-14 sm:h-16 sm:w-16 flex-none items-center justify-center overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--primary)_35%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] font-display text-lg sm:text-xl font-bold text-[var(--primary)] shadow-[0_8px_24px_-10px_var(--primary)] transition-transform duration-300 group-hover:scale-105">
                        <span>{dev.initials}</span>
                        <span className="absolute inset-x-0 top-0 h-px bg-white/30" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-display text-lg sm:text-xl font-semibold tracking-[-0.02em] text-[var(--foreground)]">
                          {dev.name}
                        </h3>
                        <p className="mt-1 text-xs sm:text-sm font-medium text-[var(--primary)]">
                          {dev.role}
                        </p>
                      </div>
                    </div>

                    <p className="mt-5 flex-1 text-xs sm:text-sm leading-relaxed text-[var(--muted-foreground)]">
                      {dev.bio}
                    </p>

                    <div className="mt-6 flex flex-wrap gap-1.5">
                      {dev.focusAreas.map((area) => (
                        <span
                          key={area}
                          className="rounded-md border border-[var(--border)] bg-[var(--surface)]/70 px-2.5 py-1 text-[11px] font-medium text-[var(--muted-foreground)]"
                        >
                          {area}
                        </span>
                      ))}
                    </div>

                    <div className="mt-6 border-t border-[var(--border)] pt-4 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {dev.githubUrl ? (
                          <a
                            href={dev.githubUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] transition-all hover:border-[var(--primary)] hover:bg-[var(--muted)] hover:text-[var(--primary)]"
                            aria-label={`${dev.name}'s GitHub Profile`}
                          >
                            <GithubIcon className="h-3.5 w-3.5" />
                            <span>GitHub</span>
                            <ExternalLink size={12} className="text-[var(--muted-foreground)]" />
                          </a>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
                            <Shield size={12} className="text-[var(--primary)]" />
                            RapidAid Core Team
                          </span>
                        )}
                        {dev.linkedinUrl && (
                          <a
                            href={dev.linkedinUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] transition-all hover:border-[var(--primary)] hover:bg-[var(--muted)] hover:text-[var(--primary)]"
                            aria-label={`${dev.name}'s LinkedIn Profile`}
                          >
                            <LinkedinIcon className="h-3.5 w-3.5" />
                            <span>LinkedIn</span>
                            <ExternalLink size={12} className="text-[var(--muted-foreground)]" />
                          </a>
                        )}
                      </div>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--muted-foreground)]">
                        Platform Co-Creator
                      </span>
                    </div>
                  </Card>
                </RevealItem>
              ))}
            </RevealGroup>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Final CTA                                                         */}
        {/* ---------------------------------------------------------------- */}
        <section className="relative overflow-hidden py-20 sm:py-28">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="cinematic-grid absolute inset-0 opacity-50" />
            <div className="ambient-orb left-1/2 top-1/2 h-[26rem] w-[26rem] -translate-x-1/2 -translate-y-1/2 bg-[var(--primary)]/12" />
          </div>
          <div className="relative mx-auto max-w-3xl px-4 text-center sm:px-6">
            <Reveal>
              <p className="eyebrow">Every second matters</p>
              <h2 className="mt-3 font-display text-4xl font-semibold tracking-[-0.05em] sm:text-5xl lg:text-6xl">
                Step into the response loop.
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-pretty leading-relaxed text-[var(--muted-foreground)]">
                Sign in with a demo role to explore the operational workspace. The data, permissions and
                failure states are the application&apos;s own.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Link to={workspace}>
                  <Button size="lg" className="gap-2">
                    <Activity size={17} />
                    {isAuthenticated ? 'Open my workspace' : 'Sign in to RapidAid'}
                    <ArrowRight size={15} />
                  </Button>
                </Link>
                <Link to="/demo-roles">
                  <Button variant="outline" size="lg" className="gap-2">
                    <Users size={16} />
                    View demo roles
                  </Button>
                </Link>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--border)] bg-[var(--surface)]/35">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.2fr_1fr_1fr] lg:px-8">
          <div>
            <Link to="/" className="flex w-fit items-center gap-2.5" aria-label="RapidAid home">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--primary)]">
                <Heart size={15} className="text-[var(--primary-foreground)]" />
              </div>
              <span className="font-display text-base font-semibold tracking-[-0.04em]">RapidAid</span>
            </Link>
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-[var(--muted-foreground)]">
              A connected emergency-response network for incident intake, dispatch, live tracking, hospital
              handoff and operational oversight.
            </p>
            <Badge variant="outline" className="mt-4 text-[9px]">Demo environment</Badge>
          </div>
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--muted-foreground)]">Explore</p>
            <div className="mt-3 grid gap-2">
              {NAV_LINKS.map((link) => (
                <a key={link.href} href={link.href} className="w-fit text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]">
                  {link.label}
                </a>
              ))}
            </div>
          </div>
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--muted-foreground)]">Access</p>
            <div className="mt-3 grid gap-2">
              <Link to="/login" className="w-fit text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]">Sign in</Link>
              <Link to="/demo-roles" className="w-fit text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]">Demo roles</Link>
              <Link to="/register" className="w-fit text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]">Create an account</Link>
              <Link to="/forgot-password" className="w-fit text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]">Recover access</Link>
            </div>
          </div>
        </div>
        <div className="border-t border-[var(--border)] px-4 py-5 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-7xl flex-col gap-2 text-[10px] text-[var(--muted-foreground)] sm:flex-row sm:items-center sm:justify-between">
            <p>© 2026 RapidAid. Demonstration environment — no real emergency service integration.</p>
            <p className="flex items-center gap-1.5">
              <MapPin size={10} />
              Operational data belongs to the active workspace.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
