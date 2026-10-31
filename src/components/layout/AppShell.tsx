import React, { useEffect, useState } from 'react';
import { NavLink, useLocation, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  ChevronRight,
  Command,
  Heart,
  Loader2,
  LogOut,
  MailWarning,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldCheck,
  WifiOff,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useUIStore } from '../../stores/ui';
import { api } from '../../api/client';
import { Button, buttonVariants } from '../ui/button';
import { Badge } from '../ui/badge';
import { ThemeButton } from '../theme/ThemeButton';
import { useAuthStore } from '../../stores/auth';
import { ROLE_LABELS, navGroupsFor, normalizePath, pageTitleFor } from '../../lib/navigation';
import { PageTransition } from '../motion/PageTransition';

// Sidebar structure, page titles and per-role audiences live in
// src/lib/navigation.ts so the sidebar, the route guard and the command
// palette always agree on who may open what.

function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const initials = user?.name
    ? user.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : 'U';

  if (collapsed) {
    return (
      <div className="border-t border-[var(--border)] p-2">
        <div className="flex flex-col items-center gap-2">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--primary)_35%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-xs font-bold text-[var(--primary)]"
            title={user ? `${user.name} · ${ROLE_LABELS[user.role]}` : undefined}
          >
            {initials}
          </div>
          <Button variant="ghost" size="iconSm" onClick={handleLogout} title="Sign out" aria-label="Sign out">
            <LogOut size={15} />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--border)] p-3">
      <div className="mb-3 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] px-3 py-2.5">
        <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--muted-foreground)]">
          <ShieldCheck size={13} className="text-[var(--success)]" />
          Role-scoped workspace
        </div>
        <p className="mt-1 truncate text-xs font-semibold text-[var(--foreground)]">
          {user?.role ? ROLE_LABELS[user.role] : 'Not signed in'}
        </p>
      </div>
      <div className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[var(--muted)]">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--primary)_35%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-xs font-bold text-[var(--primary)]">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{user?.name || 'User'}</p>
          <p className="truncate text-xs text-[var(--muted-foreground)]">{user?.email || 'RapidAid network'}</p>
        </div>
        <Button variant="ghost" size="iconSm" onClick={handleLogout} title="Sign out" aria-label="Sign out">
          <LogOut size={15} />
        </Button>
      </div>
    </div>
  );
}

export function Sidebar() {
  const { sidebarCollapsed, sidebarMobileOpen, setSidebarMobileOpen, toggleSidebar } = useUIStore();
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  // Only the pages this role may enter are listed (see lib/navigation.ts).
  const groups = navGroupsFor(user?.role, user?.permissions);
  const activePath = normalizePath(location.pathname);

  return (
    <>
      {/* Mobile overlay */}
      {sidebarMobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-[var(--overlay)] backdrop-blur-[2px] lg:hidden"
          onClick={() => setSidebarMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          'surface-noise fixed left-0 top-0 z-50 flex h-full flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--sidebar)] transition-[width,transform] duration-300',
          sidebarCollapsed ? 'w-[4.75rem]' : 'w-[17.5rem]',
          sidebarMobileOpen ? 'translate-x-0' : '-translate-x-full',
          'lg:translate-x-0',
        )}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(120%_100%_at_20%_0%,color-mix(in_srgb,var(--primary)_14%,transparent),transparent_70%)]"
        />

        {/* Logo */}
        <div
          className={cn(
            'relative flex h-16 items-center border-b border-[var(--border)] px-3.5',
            sidebarCollapsed ? 'justify-center' : 'justify-between',
          )}
        >
          <Link
            to="/"
            className={cn('flex min-w-0 items-center gap-2.5', sidebarCollapsed && 'justify-center')}
            aria-label="RapidAid home"
          >
            <div className="relative flex h-9 w-9 flex-none items-center justify-center overflow-hidden rounded-xl bg-[var(--primary)] shadow-[0_8px_24px_-10px_var(--primary)]">
              <Heart size={17} className="text-[var(--primary-foreground)]" />
              <span className="absolute inset-x-0 top-0 h-px bg-white/30" />
            </div>
            {!sidebarCollapsed && (
              <span className="min-w-0">
                <span className="block truncate font-display text-[1.05rem] font-semibold tracking-[-0.04em] text-[var(--foreground)]">
                  RapidAid
                </span>
                <span className="block truncate font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
                  Response network
                </span>
              </span>
            )}
          </Link>

          <Button
            variant="ghost"
            size="iconSm"
            className={cn('hidden text-[var(--muted-foreground)] lg:flex', sidebarCollapsed && 'absolute -right-1 top-5')}
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </Button>
          <Button
            variant="ghost"
            size="iconSm"
            className="lg:hidden"
            onClick={() => setSidebarMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X size={16} />
          </Button>
        </div>

        {/* Navigation */}
        <nav className="relative flex-1 overflow-y-auto overflow-x-hidden px-2 py-4" aria-label="Primary">
          {groups.map((group) => (
            <div key={group.title} className="mb-5">
              {!sidebarCollapsed ? (
                <p className="mb-1.5 px-3 font-mono text-[9px] font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
                  {group.title}
                </p>
              ) : (
                <div className="mx-auto mb-2 h-px w-6 bg-[var(--border)]" aria-hidden="true" />
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const active = activePath === item.path || location.pathname.startsWith(item.path + '/');
                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      onClick={() => setSidebarMobileOpen(false)}
                      className={cn(
                        'group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors',
                        active
                          ? 'bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--foreground)]'
                          : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
                        sidebarCollapsed && 'justify-center px-2',
                      )}
                      title={sidebarCollapsed ? item.label : undefined}
                      aria-current={active ? 'page' : undefined}
                    >
                      {active && (
                        <span
                          aria-hidden="true"
                          className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-[var(--primary)]"
                        />
                      )}
                      <item.icon
                        size={17}
                        className={cn(
                          'flex-none transition-colors',
                          active ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]',
                        )}
                      />
                      {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                      {!sidebarCollapsed && active && (
                        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--primary)]" aria-hidden="true" />
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <SidebarFooter collapsed={sidebarCollapsed} />
      </aside>
    </>
  );
}

function ConnectivityBanner() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-lg border border-[var(--warning)]/45 bg-[var(--warning)]/10 px-3.5 py-3"
    >
      <WifiOff size={16} className="mt-0.5 flex-none text-[var(--warning)]" />
      <div>
        <p className="text-sm font-medium">You are offline</p>
        <p className="text-xs text-[var(--muted-foreground)]">
          Cached screens remain readable. Actions that need the server will fail safely and can be retried
          when the connection returns.
        </p>
      </div>
    </div>
  );
}

export function Header() {
  const { setSidebarMobileOpen, setCommandPaletteOpen, setNotificationDrawerOpen } = useUIStore();
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const initials = user?.name
    ? user.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : 'U';

  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: api.notifications.list,
    refetchInterval: 30_000,
    enabled: isAuthenticated,
  });
  const unreadCount = (notifications ?? []).filter((n) => !n.read).length;

  // Titles + audiences come from the shared navigation config, so a new page
  // only has to be declared once.
  const pageTitle = pageTitleFor(location.pathname);
  const groupTitle =
    navGroupsFor(user?.role, user?.permissions).find((group) =>
      group.items.some((item) => normalizePath(location.pathname) === item.path),
    )?.title ?? 'Workspace';

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[color-mix(in_srgb,var(--background)_82%,transparent)] px-3 backdrop-blur-xl sm:px-4 lg:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={() => setSidebarMobileOpen(true)}
          aria-label="Open navigation"
        >
          <Menu size={19} />
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--muted-foreground)]">
            <span>{groupTitle}</span>
            <ChevronRight size={10} aria-hidden="true" />
            <span className="truncate text-[color-mix(in_srgb,var(--foreground)_65%,var(--muted-foreground))]">
              {pageTitle}
            </span>
          </div>
          <p className="truncate font-display text-[15px] font-semibold tracking-[-0.03em] text-[var(--foreground)] sm:text-base">
            {pageTitle}
          </p>
        </div>
      </div>

      <div className="flex flex-none items-center gap-1 sm:gap-1.5">
        <button
          type="button"
          onClick={() => setCommandPaletteOpen(true)}
          className="hidden h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_60%,transparent)] px-3 text-xs text-[var(--muted-foreground)] transition-colors hover:border-[color-mix(in_srgb,var(--primary)_30%,var(--border))] hover:text-[var(--foreground)] md:flex"
          aria-label="Open command palette"
        >
          <Search size={14} />
          <span>Search workspace</span>
          <kbd className="ml-2 flex items-center gap-0.5 rounded border border-[var(--border)] bg-[var(--muted)] px-1 py-0.5 font-mono text-[9px]">
            <Command size={9} />K
          </kbd>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={() => setCommandPaletteOpen(true)}
          aria-label="Search workspace"
          title="Search workspace"
        >
          <Search size={18} />
        </Button>

        <div className="hidden items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] px-2.5 py-1 sm:flex">
          <span className="status-dot status-dot--live text-[var(--success)]" aria-hidden="true" />
          <span className="font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--success)]">
            Live data
          </span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => setNotificationDrawerOpen(true)}
          className="relative"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
          title="Notifications"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--destructive)] px-1 text-[9px] font-bold text-[var(--destructive-foreground)]">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>

        <ThemeButton />

        <div className="ml-1 hidden items-center gap-2 border-l border-[var(--border)] pl-2 md:flex">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--primary)_30%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[10px] font-bold text-[var(--primary)]"
            title={user ? `${user.name} · ${ROLE_LABELS[user.role]}` : undefined}
          >
            {initials}
          </div>
        </div>
      </div>
    </header>
  );
}

/**
 * Reminder to confirm the mailbox, shown only while `emailVerified === false`.
 *
 * Unverified users keep full access on purpose — blocking sign-in would strand
 * anyone who cannot receive mail behind a wall. The explicit `=== false` test
 * matters: sessions persisted before the field existed deserialize with
 * `undefined`, and a truthiness check would nag every existing demo user.
 */
function EmailVerificationBanner() {
  const user = useAuthStore((s) => s.user);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  if (user?.emailVerified !== false) return null;

  const handleResend = async () => {
    if (loading || cooldown > 0) return;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await api.auth.resendVerification();
      setFeedback({ type: 'success', message: res.message || 'Verification link sent! Check your inbox.' });
      setCooldown(60);
    } catch (err: unknown) {
      const errMsg = (err as { message?: string })?.message || 'Failed to resend verification email';
      const match = errMsg.match(/(\d+)s/);
      if (match && match[1]) {
        setCooldown(parseInt(match[1], 10));
      }
      setFeedback({ type: 'error', message: errMsg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        <MailWarning className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
        <div>
          <p className="text-sm font-medium">Verify your email address</p>
          <p className="text-xs text-[var(--muted-foreground)]">
            Your account works, but confirming {user.email} secures it and enables recovery.
          </p>
          {feedback && (
            <p
              className={cn(
                'mt-1 text-xs font-medium',
                feedback.type === 'success' ? 'text-[var(--success,#10b981)]' : 'text-[var(--destructive,#ef4444)]',
              )}
            >
              {feedback.message}
            </p>
          )}
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={loading || cooldown > 0}
        onClick={handleResend}
        className="shrink-0 sm:w-auto"
      >
        {loading ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Sending...
          </>
        ) : cooldown > 0 ? (
          `Resend in ${cooldown}s`
        ) : (
          'Resend link'
        )}
      </Button>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { sidebarCollapsed } = useUIStore();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[120] -translate-y-24 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-[var(--primary-foreground)] transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>
      <Sidebar />
      <div
        className={cn(
          'relative min-h-screen transition-[margin] duration-300',
          sidebarCollapsed ? 'lg:ml-[4.75rem]' : 'lg:ml-[17.5rem]',
        )}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        >
          <div className="absolute -left-40 top-[-10%] h-[32rem] w-[32rem] rounded-full bg-[color-mix(in_srgb,var(--primary)_6%,transparent)] blur-3xl" />
          <div className="absolute right-[-10%] top-[28%] h-[28rem] w-[28rem] rounded-full bg-[color-mix(in_srgb,var(--info)_5%,transparent)] blur-3xl" />
          <div className="cinematic-grid absolute inset-0 opacity-[0.28]" />
        </div>

        <Header />
        <main
          id="main-content"
          className="relative z-10 mx-auto w-full max-w-[1680px] px-4 py-5 sm:px-5 lg:px-8 lg:py-7"
        >
          <ConnectivityBanner />
          <EmailVerificationBanner />
          <PageTransition key={location.pathname}>{children}</PageTransition>
        </main>
      </div>
    </div>
  );
}
