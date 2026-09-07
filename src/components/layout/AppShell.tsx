import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '../../lib/utils';
import { useUIStore } from '../../stores/ui';
import {
  AlertTriangle, Truck, BarChart3, Building2,
  Eye, Globe, Heart, LayoutDashboard, MapPin, Menu, Mic,
  Radio, Settings, Shield, Siren, TrafficCone, X, Bell, Search,
  ChevronDown, ChevronRight, Sun, Moon, Monitor, LogOut
} from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { useTheme } from '../../stores/theme';
import { useAuthStore } from '../../stores/auth';
import { useNavigate } from 'react-router-dom';

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    title: 'Operations',
    items: [
      { label: 'Command Center', path: '/command-center', icon: <LayoutDashboard size={18} /> },
      { label: 'Emergencies', path: '/emergencies', icon: <Siren size={18} /> },
      { label: 'Ambulances', path: '/ambulances', icon: <Truck size={18} /> },
      { label: 'Hospitals', path: '/hospitals', icon: <Building2 size={18} /> },
      { label: 'Live Tracking', path: '/tracking', icon: <MapPin size={18} /> },
    ],
  },
  {
    title: 'Intelligence',
    items: [
      { label: 'AI Vision', path: '/ai-vision', icon: <Eye size={18} /> },
      { label: 'Dispatch Intel', path: '/dispatch', icon: <Radio size={18} /> },
      { label: 'Voice Reports', path: '/voice', icon: <Mic size={18} /> },
    ],
  },
  {
    title: 'Analytics',
    items: [
      { label: 'Analytics', path: '/analytics', icon: <BarChart3 size={18} /> },
      { label: 'Green Corridor', path: '/green-corridor', icon: <TrafficCone size={18} /> },
      { label: 'Simulations', path: '/simulations', icon: <Globe size={18} /> },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Alerts', path: '/alerts', icon: <AlertTriangle size={18} /> },
      { label: 'Audit', path: '/audit', icon: <Shield size={18} /> },
      { label: 'Settings', path: '/settings', icon: <Settings size={18} /> },
    ],
  },
];

function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const initials = user?.name
    ? user.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : 'U';

  return (
    <div className={cn('border-t border-[var(--border)] p-3', collapsed && 'px-2')}>
      {!collapsed ? (
        <div className="flex items-center gap-3 rounded-lg p-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)] text-xs font-bold text-white">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{user?.name || 'User'}</p>
            <p className="text-xs text-[var(--muted-foreground)]">{user?.role || 'USER'}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={handleLogout} title="Logout">
            <LogOut size={16} />
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)] text-xs font-bold text-white">
            {initials}
          </div>
          <Button variant="ghost" size="icon" onClick={handleLogout} title="Logout">
            <LogOut size={16} />
          </Button>
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { sidebarCollapsed, sidebarMobileOpen, setSidebarMobileOpen, toggleSidebar } = useUIStore();
  const location = useLocation();

  return (
    <>
      {/* Mobile overlay */}
      {sidebarMobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setSidebarMobileOpen(false)} />
      )}

      <aside className={cn(
        'fixed top-0 left-0 z-50 flex h-full flex-col border-r border-[var(--border)] bg-[var(--card)] transition-all duration-300',
        sidebarCollapsed ? 'w-16' : 'w-64',
        sidebarMobileOpen ? 'translate-x-0' : '-translate-x-full',
        'lg:translate-x-0'
      )}>
        {/* Logo */}
        <div className="flex h-16 items-center justify-between border-b border-[var(--border)] px-4">
          <div className={cn('flex items-center gap-2', sidebarCollapsed && 'justify-center w-full')}>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--primary)]">
              <Heart size={16} className="text-white" />
            </div>
            {!sidebarCollapsed && (
              <span className="text-lg font-bold tracking-tight">RapidAid</span>
            )}
          </div>
          <Button variant="ghost" size="icon" className="hidden lg:flex" onClick={toggleSidebar}>
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} className="rotate-90" />}
          </Button>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setSidebarMobileOpen(false)}>
            <X size={16} />
          </Button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-2">
          {navGroups.map((group) => (
            <div key={group.title} className="mb-4">
              {!sidebarCollapsed && (
                <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                  {group.title}
                </p>
              )}
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  onClick={() => setSidebarMobileOpen(false)}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    location.pathname === item.path || location.pathname.startsWith(item.path + '/')
                      ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                      : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
                    sidebarCollapsed && 'justify-center px-2'
                  )}
                  title={sidebarCollapsed ? item.label : undefined}
                >
                  {item.icon}
                  {!sidebarCollapsed && <span>{item.label}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <SidebarFooter collapsed={sidebarCollapsed} />
      </aside>
    </>
  );
}

export function Header() {
  const { setSidebarMobileOpen, setCommandPaletteOpen, setNotificationDrawerOpen } = useUIStore();
  const { mode, setMode } = useTheme();
  const location = useLocation();

  const getPageTitle = () => {
    const path = location.pathname;
    if (path === '/command-center') return 'Command Center';
    if (path.startsWith('/emergencies')) return 'Emergencies';
    if (path.startsWith('/ambulances')) return 'Ambulances';
    if (path.startsWith('/hospitals')) return 'Hospitals';
    if (path === '/tracking') return 'Live Tracking';
    if (path === '/ai-vision') return 'AI Vision';
    if (path === '/dispatch') return 'Dispatch Intelligence';
    if (path === '/voice') return 'Voice Reports';
    if (path === '/analytics') return 'Analytics';
    if (path === '/green-corridor') return 'Green Corridor';
    if (path === '/alerts') return 'Alerts';
    if (path === '/audit') return 'Audit Logs';
    if (path === '/settings') return 'Settings';
    return 'RapidAid';
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-[var(--border)] bg-[var(--background)]/80 backdrop-blur-sm px-4 lg:px-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setSidebarMobileOpen(true)}>
          <Menu size={20} />
        </Button>
        <h1 className="text-lg font-semibold">{getPageTitle()}</h1>
        <Badge variant="outline" className="hidden sm:inline-flex">
          <span className="mr-1 h-2 w-2 rounded-full bg-green-500 animate-pulse" />
          LIVE
        </Badge>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => setCommandPaletteOpen(true)} title="Command Palette (Ctrl+K)">
          <Search size={18} />
        </Button>

        <Button variant="ghost" size="icon" onClick={() => setNotificationDrawerOpen(true)} className="relative">
          <Bell size={18} />
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--destructive)] text-[10px] font-bold text-white">
            3
          </span>
        </Button>

        <div className="hidden sm:flex items-center gap-1 border border-[var(--border)] rounded-lg p-1">
          <button
            onClick={() => setMode('light')}
            className={cn(
              'rounded-md p-1.5 transition-colors',
              mode === 'light' ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            )}
            title="Light Mode"
          >
            <Sun size={14} />
          </button>
          <button
            onClick={() => setMode('dark')}
            className={cn(
              'rounded-md p-1.5 transition-colors',
              mode === 'dark' ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            )}
            title="Dark Mode"
          >
            <Moon size={14} />
          </button>
          <button
            onClick={() => setMode('system')}
            className={cn(
              'rounded-md p-1.5 transition-colors',
              mode === 'system' ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            )}
            title="System Theme"
          >
            <Monitor size={14} />
          </button>
        </div>

        <div className="hidden md:flex items-center gap-2 ml-2 pl-2 border-l border-[var(--border)]">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)] text-xs font-bold text-white">
            DK
          </div>
        </div>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { sidebarCollapsed } = useUIStore();

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <Sidebar />
      <div className={cn(
        'transition-all duration-300',
        sidebarCollapsed ? 'lg:ml-16' : 'lg:ml-64'
      )}>
        <Header />
        <main className="p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
