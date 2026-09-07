import { useEffect } from 'react';
import { useUIStore } from '../../stores/ui';
import { Button } from '../ui/button';
import { X, Search, Command, LayoutDashboard, Siren, Eye, Radio, BarChart3, AlertTriangle, Settings, Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../../stores/theme';

const actions = [
  { label: 'Open Command Center', path: '/command-center', icon: <LayoutDashboard size={16} />, category: 'Navigation' },
  { label: 'View Emergencies', path: '/emergencies', icon: <Siren size={16} />, category: 'Navigation' },
  { label: 'AI Vision Workspace', path: '/ai-vision', icon: <Eye size={16} />, category: 'Navigation' },
  { label: 'Dispatch Intelligence', path: '/dispatch', icon: <Radio size={16} />, category: 'Navigation' },
  { label: 'Analytics Dashboard', path: '/analytics', icon: <BarChart3 size={16} />, category: 'Navigation' },
  { label: 'View Alerts', path: '/alerts', icon: <AlertTriangle size={16} />, category: 'Navigation' },
  { label: 'Settings', path: '/settings', icon: <Settings size={16} />, category: 'Navigation' },
  { label: 'Toggle Dark Mode', action: 'toggle-dark', icon: <Bell size={16} />, category: 'Actions' },
];

export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen } = useUIStore();
  const navigate = useNavigate();
  const { mode, setMode, resolved } = useTheme();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
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

  const handleAction = (action: typeof actions[0]) => {
    if (action.action === 'toggle-dark') {
      setMode(resolved === 'dark' ? 'light' : 'dark');
    } else if (action.path) {
      navigate(action.path);
    }
    setCommandPaletteOpen(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[20vh]" onClick={() => setCommandPaletteOpen(false)}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          <Search size={18} className="text-[var(--muted-foreground)]" />
          <input
            type="text"
            placeholder="Search commands, pages, emergencies..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--muted-foreground)]"
            autoFocus
          />
          <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border border-[var(--border)] px-1.5 text-[10px] font-medium text-[var(--muted-foreground)]">
            <Command size={10} /> K
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {actions.map((action, i) => (
            <button
              key={i}
              onClick={() => handleAction(action)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-[var(--muted)]"
            >
              <span className="text-[var(--muted-foreground)]">{action.icon}</span>
              <span className="flex-1 text-left">{action.label}</span>
              <span className="text-xs text-[var(--muted-foreground)]">{action.category}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function NotificationDrawer() {
  const { notificationDrawerOpen, setNotificationDrawerOpen } = useUIStore();

  if (!notificationDrawerOpen) return null;

  const notifications = [
    { id: '1', category: 'CRITICAL' as const, title: 'Critical Emergency', message: 'EMG-20481: Multi-vehicle collision', time: '2m ago', read: false },
    { id: '2', category: 'WARNING' as const, title: 'Hospital Capacity', message: 'HOSP-08 ICU at LIMITED', time: '25m ago', read: false },
    { id: '3', category: 'WARNING' as const, title: 'AI Detection Review', message: 'DET-003 awaiting review', time: '10m ago', read: false },
    { id: '4', category: 'SUCCESS' as const, title: 'Emergency Completed', message: 'EMG-20484 resolved', time: '1h ago', read: true },
    { id: '5', category: 'INFO' as const, title: 'System Update', message: 'RapidVision v3.2.1 deployed', time: '5h ago', read: true },
  ];

  const categoryColors = {
    CRITICAL: 'bg-red-500',
    WARNING: 'bg-amber-500',
    INFO: 'bg-blue-500',
    SUCCESS: 'bg-green-500',
  };

  return (
    <div className="fixed inset-0 z-[100] flex justify-end" onClick={() => setNotificationDrawerOpen(false)}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative w-full max-w-sm h-full border-l border-[var(--border)] bg-[var(--card)] shadow-xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-[var(--border)] bg-[var(--card)] px-4 py-4">
          <h2 className="text-lg font-semibold">Notifications</h2>
          <Button variant="ghost" size="icon" onClick={() => setNotificationDrawerOpen(false)}>
            <X size={18} />
          </Button>
        </div>
        <div className="p-4 space-y-3">
          {notifications.map((n) => (
            <div
              key={n.id}
              className={`rounded-lg border border-[var(--border)] p-3 ${!n.read ? 'bg-[var(--surface)]' : ''}`}
            >
              <div className="flex items-start gap-3">
                <span className={`mt-1 h-2 w-2 rounded-full ${categoryColors[n.category]}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs text-[var(--muted-foreground)] mt-0.5">{n.message}</p>
                  <p className="text-xs text-[var(--muted-foreground)] mt-1">{n.time}</p>
                </div>
                {!n.read && <span className="h-2 w-2 rounded-full bg-[var(--primary)] flex-shrink-0 mt-1.5" />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
