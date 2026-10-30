import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { motion, useReducedMotion } from 'framer-motion';
import { useUIStore } from '../../stores/ui';
import { Button } from '../ui/button';
import {
  ArrowRight,
  Bell,
  CheckCheck,
  Command,
  Inbox,
  Palette,
  Search,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { THEME_LIST } from '../../theme';
import type { ThemeId } from '../../theme';
import { useThemeStore } from '../../stores/theme';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { navItemsFor } from '../../lib/navigation';
import { cn } from '../../lib/utils';
import { EASE_OUT_EXPO } from '../../lib/motion';

interface PaletteAction {
  /** Stable key — page path or action name. */
  id: string;
  label: string;
  icon: ReactNode;
  category: string;
  /** Navigation target, when the entry moves the user somewhere. */
  path?: string;
  /** Appearance action: switch to this theme. */
  action?: 'set-theme';
  themeId?: ThemeId;
}

export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen } = useUIStore();
  const navigate = useNavigate();
  const themeId = useThemeStore((s) => s.themeId);
  const user = useAuthStore((state) => state.user);
  const reduce = useReducedMotion();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Same permission list as the sidebar and the route guard: the palette never
  // offers a page the current user cannot open. Themes are pure appearance, so
  // they are available to every role.
  const actions = useMemo<PaletteAction[]>(
    () => [
      ...navItemsFor(user?.role, user?.permissions).map((item) => ({
        id: item.path,
        label: item.pageTitle ?? item.label,
        icon: <item.icon size={16} />,
        category: 'Navigation',
        path: item.path,
      })),
      ...THEME_LIST.map((t) => ({
        id: `theme-${t.id}`,
        label: t.id === themeId ? `Appearance: ${t.name} (current)` : `Appearance: ${t.name}`,
        icon: <Palette size={16} />,
        category: 'Appearance',
        action: 'set-theme' as const,
        themeId: t.id,
      })),
    ],
    [user?.role, user?.permissions, themeId],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return actions;
    return actions.filter(
      (action) =>
        action.label.toLowerCase().includes(term) ||
        action.category.toLowerCase().includes(term),
    );
  }, [actions, query]);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    setQuery('');
    setActiveIndex(0);
  }, [commandPaletteOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
      if (e.key === 'Escape') {
        setCommandPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  if (!commandPaletteOpen) return null;

  const handleAction = (action: PaletteAction) => {
    if (action.action === 'set-theme' && action.themeId) {
      // Presentation only: swaps CSS tokens on <html>. No navigation, no
      // reload, no state reset.
      useThemeStore.getState().setTheme(action.themeId);
    } else if (action.path) {
      navigate(action.path);
    }
    setCommandPaletteOpen(false);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && filtered[activeIndex]) {
      event.preventDefault();
      handleAction(filtered[activeIndex]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[14vh] sm:pt-[20vh]"
      onClick={() => setCommandPaletteOpen(false)}
    >
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-[var(--overlay)] backdrop-blur-[3px]"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="glass-elevated relative w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--border)] shadow-[var(--shadow-cinematic)]"
        initial={reduce ? false : { opacity: 0, y: -10, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.24, ease: EASE_OUT_EXPO }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3.5">
          <Search size={18} className="flex-none text-[var(--muted-foreground)]" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search pages, commands, appearance…"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
            autoFocus
            aria-label="Search commands"
            aria-controls="command-palette-results"
            aria-activedescendant={filtered[activeIndex] ? `command-${filtered[activeIndex].id}` : undefined}
          />
          <kbd className="hidden h-6 items-center gap-1 rounded border border-[var(--border)] px-1.5 font-mono text-[10px] font-medium text-[var(--muted-foreground)] sm:inline-flex">
            <Command size={10} /> K
          </kbd>
        </div>
        <div
          id="command-palette-results"
          ref={listRef}
          className="max-h-[min(24rem,55vh)] overflow-y-auto p-2"
          role="listbox"
          aria-label="Commands"
        >
          {filtered.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Inbox size={24} className="mx-auto text-[var(--muted-foreground)]" />
              <p className="mt-2 text-sm font-medium">No matching commands</p>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                Try a page name or an appearance theme.
              </p>
            </div>
          ) : (
            filtered.map((action, index) => (
              <button
                key={action.id}
                id={`command-${action.id}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onClick={() => handleAction(action)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
                  index === activeIndex
                    ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                    : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
                )}
              >
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_70%,transparent)] text-[var(--muted-foreground)]">
                  {action.icon}
                </span>
                <span className="flex-1 truncate text-left">{action.label}</span>
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
                  {action.category}
                </span>
                <ArrowRight
                  size={13}
                  className={cn(
                    'flex-none transition-opacity',
                    index === activeIndex ? 'opacity-70' : 'opacity-0',
                  )}
                />
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-2 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
          <span>↑ ↓ navigate · ↵ open · esc close</span>
          <span>{filtered.length} result{filtered.length === 1 ? '' : 's'}</span>
        </div>
      </motion.div>
    </div>
  );
}

export function NotificationDrawer() {
  const { notificationDrawerOpen, setNotificationDrawerOpen } = useUIStore();
  const queryClient = useQueryClient();
  const reduce = useReducedMotion();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');

  // Live notifications from the API (polls every 30s while drawer state exists).
  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: api.notifications.list,
    refetchInterval: 30_000,
    enabled: notificationDrawerOpen,
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!notificationDrawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNotificationDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [notificationDrawerOpen, setNotificationDrawerOpen]);

  if (!notificationDrawerOpen) return null;

  const categoryColors: Record<string, string> = {
    CRITICAL: 'bg-[var(--danger)]',
    WARNING: 'bg-[var(--warning)]',
    INFO: 'bg-[var(--info)]',
    SUCCESS: 'bg-[var(--success)]',
  };
  const unread = notifications.filter((n) => !n.read).length;
  const displayed = filter === 'unread' ? notifications.filter((n) => !n.read) : notifications;

  return (
    <div
      className="fixed inset-0 z-[100] flex justify-end"
      onClick={() => setNotificationDrawerOpen(false)}
    >
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-[var(--overlay)] backdrop-blur-[2px]"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        className="glass-elevated relative flex h-full w-full max-w-sm flex-col border-l border-[var(--border)] shadow-[var(--shadow-cinematic)]"
        initial={reduce ? false : { x: 32, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.26, ease: EASE_OUT_EXPO }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-4">
          <div>
            <div className="flex items-center gap-2">
              <Bell size={16} className="text-[var(--primary)]" />
              <h2 className="font-display text-lg font-semibold tracking-[-0.03em]">Notifications</h2>
            </div>
            <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
              {unread > 0 ? `${unread} unread` : 'Everything is read'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {unread > 0 && (
              <Button
                variant="ghost"
                size="iconSm"
                onClick={() => markAllReadMutation.mutate()}
                disabled={markAllReadMutation.isPending}
                title="Mark all as read"
                aria-label="Mark all notifications as read"
              >
                <CheckCheck size={16} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="iconSm"
              onClick={() => setNotificationDrawerOpen(false)}
              aria-label="Close notifications"
            >
              <X size={17} />
            </Button>
          </div>
        </div>

        <div className="flex border-b border-[var(--border)] px-3 py-1.5 gap-1 bg-[var(--card)]">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              filter === 'all'
                ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
            )}
          >
            All ({notifications.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter('unread')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              filter === 'unread'
                ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
            )}
          >
            Unread ({unread})
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {displayed.length === 0 && (
            <div className="px-4 py-16 text-center">
              <Inbox size={28} className="mx-auto text-[var(--muted-foreground)]" />
              <p className="mt-3 text-sm font-medium">No notifications</p>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                {filter === 'unread' ? 'All notifications have been read.' : 'Operational updates will appear here.'}
              </p>
            </div>
          )}
          {displayed.map((n) => (
            <button
              key={n.id}
              type="button"
              className={cn(
                'w-full rounded-lg border border-[var(--border)] p-3 text-left transition-colors cursor-pointer',
                !n.read
                  ? 'bg-[var(--surface)] hover:bg-[var(--muted)]'
                  : 'bg-[color-mix(in_srgb,var(--card)_55%,transparent)] hover:bg-[var(--muted)] opacity-85',
              )}
              onClick={() => {
                if (!n.read) markReadMutation.mutate(n.id);
                if (n.linkedEmergency) {
                  setNotificationDrawerOpen(false);
                  navigate(`/emergencies/${n.linkedEmergency}`);
                }
              }}
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    'mt-1.5 h-2 w-2 flex-none rounded-full',
                    categoryColors[n.category] ?? 'bg-[var(--muted-foreground)]',
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium leading-snug">{n.title}</p>
                    {!n.read && (
                      <span
                        className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-[var(--primary)]"
                        aria-label="Unread"
                      />
                    )}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-foreground)]">{n.message}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] text-[var(--muted-foreground)]">
                      {formatDistanceToNow(new Date(n.timestamp), { addSuffix: true })}
                    </span>
                    {n.linkedEmergency && (
                      <span className="rounded bg-[var(--primary)]/10 px-1 py-0.5 font-mono text-[9px] text-[var(--primary)]">
                        {n.linkedEmergency}
                      </span>
                    )}
                    {n.deliveryStatus && (
                      <span className="text-[9px] text-[var(--muted-foreground)]">
                        In-App
                        {n.deliveryStatus.sms === 'MOCK_DELIVERED' && ' • SMS (Mock)'}
                        {n.deliveryStatus.email === 'MOCK_DELIVERED' && ' • Email (Mock)'}
                        {n.deliveryStatus.push === 'MOCK_DELIVERED' && ' • Push (Mock)'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
