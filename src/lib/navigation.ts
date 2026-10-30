import type { ComponentType } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Building2,
  CalendarDays,
  Eye,
  FileText,
  Globe,
  LayoutDashboard,
  MapPin,
  Mic,
  Radio,
  Settings,
  Shield,
  SlidersHorizontal,
  Siren,
  TrafficCone,
  Truck,
  Users,
  Video,
  Wrench,
} from 'lucide-react';
import type { UserRole } from '../types';
import { can, type PermissionName } from './permissions';

/** Structural icon type — avoids depending on lucide's exported React types. */
export type NavIcon = ComponentType<{ size?: number | string; className?: string }>;

export interface NavItem {
  label: string;
  path: string;
  icon: NavIcon;
  /**
   * Permissions that admit a role to this page. Holding ANY is enough. These
   * strings are the same identifiers the API guards on, so the sidebar and the
   * server can never disagree about who reaches a module.
   */
  permissions: PermissionName[];
  /** Longer name for the page header when it differs from the sidebar label. */
  pageTitle?: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const ROLE_LABELS: Record<UserRole, string> = {
  CITIZEN: 'Citizen',
  AMBULANCE_CREW: 'Ambulance Crew',
  DISPATCHER: 'Dispatcher',
  HOSPITAL_STAFF: 'Hospital Staff',
  SUPERVISOR: 'Supervisor',
  ANALYST: 'Analyst',
  AUDITOR: 'Auditor',
  ADMIN: 'Administrator',
};

// ── Audience bundles (keep the matrix below readable) ────────────────────
// These are PERMISSION lists, not role lists. They are written with the same
// identifiers the API guards on (server/src/authz/permissions.ts), so a page
// can never appear in the sidebar for a role the server would reject — and a
// new role is served correctly by its own permission list, with no nav edits.
/** Command center / dispatch console. */
const COMMAND_CENTER: PermissionName[] = ['command-center:view'];
/** Anyone who can see the emergency list in any form. */
const EMERGENCY_READ: PermissionName[] = ['emergency:read:all', 'emergency:read:own', 'emergency:read:assigned', 'emergency:read:relevant', 'emergency:read:historical'];
/** Anyone who may open the voice workspace in any form (create, or any read scope). */
const VOICE_READ: PermissionName[] = [
  'voice:create', 'voice:list',
  'voice:read:all', 'voice:read:own', 'voice:read:assigned', 'voice:read:hospital',
  'voice:read:relevant', 'voice:read:historical', 'voice:read:analytical',
  'voice:view', 'voice:view:own',
];
/** Fleet read, including a crew member's own unit. */
const FLEET_READ: PermissionName[] = ['ambulance:read:all', 'ambulance:read:own', 'ambulance:read:incoming', 'ambulance:read:historical'];
/** Hospital directory (all roles that may read hospital records). */
const HOSPITAL_READ: PermissionName[] = ['hospital:read:all', 'hospital:read:own', 'hospital:read:relevant', 'hospital:read:historical'];
/** Live map, scoped or global. */
const TRACKING_READ: PermissionName[] = ['tracking:read:all', 'tracking:read:own'];
/** Anything that may open settings (everyone except Auditor). */
const SETTINGS_ANY: PermissionName[] = [
  'settings:personal',
  'settings:operational',
  'settings:hospital',
  'settings:manage',
];
/**
 * Sidebar structure + required permissions.
 *
 * Each page names the permissions that admit it. Filtering happens against
 * `user.permissions` as issued by the server, so the sidebar reflects the same
 * registry the API enforces. Unknown paths are left visible (the API remains
 * the real authority); known pages are guarded.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Operations',
    items: [
      { label: 'Command Center', path: '/command-center', icon: LayoutDashboard, permissions: COMMAND_CENTER },
      { label: 'Emergencies', path: '/emergencies', icon: Siren, permissions: EMERGENCY_READ },
      { label: 'Ambulances', path: '/ambulances', icon: Truck, permissions: FLEET_READ },
      { label: 'Hospitals', path: '/hospitals', icon: Building2, permissions: HOSPITAL_READ },
      { label: 'Live Tracking', path: '/tracking', icon: MapPin, permissions: TRACKING_READ },
      { label: 'Shifts', path: '/shifts', icon: CalendarDays, permissions: ['shift:read:all', 'shift:read:own'] },
      { label: 'Maintenance', path: '/maintenance', icon: Wrench, permissions: ['maintenance:read:all', 'maintenance:read:own', 'maintenance:history'] },
    ],
  },
  {
    title: 'Intelligence',
    items: [
      { label: 'AI Vision', path: '/ai-vision', icon: Eye, permissions: ['ai-vision:view'] },
      { label: 'Dispatch Intel', path: '/dispatch', icon: Radio, permissions: ['dispatch-intel:view'], pageTitle: 'Dispatch Intelligence' },
      { label: 'Voice Reports', path: '/voice', icon: Mic, permissions: VOICE_READ },
      { label: 'Cameras', path: '/cameras', icon: Video, permissions: ['camera:live-view', 'camera:recording-view', 'camera:evidence-view'] },
    ],
  },
  {
    title: 'Analytics',
    items: [
      { label: 'Analytics', path: '/analytics', icon: BarChart3, permissions: ['report:read:all', 'report:generate'] },
      { label: 'Reports', path: '/reports', icon: FileText, permissions: ['report:read:all', 'report:read:own'] },
      { label: 'Green Corridor', path: '/green-corridor', icon: TrafficCone, permissions: ['green-corridor:view'] },
      // Scenarios/what-if planning is a Full-or-Analyze capability. Dispatcher
      // holds green-corridor:control (operational control of live corridors) but
      // the spec's dispatcher sidebar lists Green Corridor, not Simulations.
      { label: 'Simulations', path: '/simulations', icon: Globe, permissions: ['green-corridor:analyze'] },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Alerts', path: '/alerts', icon: AlertTriangle, permissions: ['alert:read:all', 'alert:read:relevant', 'alert:read:own'] },
      // The /audit page is the full log browser, so it admits only unscoped
      // `audit:view`. Crew and hospital staff hold `audit:view:own` (their own
      // activity) and the API scopes that correctly, but that does not justify
      // putting a fleet-wide log browser in their sidebar.
      { label: 'Audit', path: '/audit', icon: Shield, permissions: ['audit:view'], pageTitle: 'Audit Logs' },
      { label: 'Settings', path: '/settings', icon: Settings, permissions: SETTINGS_ANY },
      // User administration is how operational roles get provisioned: public
      // /register is citizen-only, so an ADMIN must mint Crew/Hospital/etc.
      // Gated on user:read; the create form additionally checks user:create.
      { label: 'Users', path: '/admin/users', icon: Users, permissions: ['user:read'], pageTitle: 'User Management' },
      { label: 'Permission Matrix', path: '/admin/permissions', icon: SlidersHorizontal, permissions: ['permission:manage'], pageTitle: 'Permission Management' },
    ],
  },
];

const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/**
 * Where each role lands after signing in — its primary workspace.
 * Every role can reach `/emergencies` and `/alerts`, so those are the safe
 * fallbacks for personas without a dedicated console.
 */
export const HOME_ROUTE: Record<UserRole, string> = {
  CITIZEN: '/emergencies',
  AMBULANCE_CREW: '/shifts',
  DISPATCHER: '/command-center',
  HOSPITAL_STAFF: '/hospitals',
  SUPERVISOR: '/command-center',
  ANALYST: '/analytics',
  AUDITOR: '/audit',
  ADMIN: '/command-center',
};

const FALLBACK_HOME = '/emergencies';

/**
 * Resolves a concrete URL to the nav entry that owns it, so deep links such as
 * `/emergencies/EMG-20481` inherit the permissions of `/emergencies`.
 */
export function normalizePath(pathname: string): string {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const owner = ALL_NAV_ITEMS.find((item) => clean === item.path || clean.startsWith(`${item.path}/`));
  return owner ? owner.path : clean;
}

/**
 * Does the signed-in user hold any of the page's admitting permissions?
 * `granted` is the server-issued `user.permissions` list; with no list (guest
 * or pre-hydration) nothing is admitted, so the UI fails closed.
 */
function admits(item: NavItem, role: UserRole | undefined, granted: readonly string[] | undefined): boolean {
  if (!granted || !role) return false;
  return item.permissions.some((permission) => can(role, permission, granted));
}

/** Sidebar groups for the signed-in user (empty groups are dropped). */
export function navGroupsFor(role: UserRole | undefined, granted?: readonly string[]): NavGroup[] {
  if (!role) return NAV_GROUPS;
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => admits(item, role, granted)),
  })).filter((group) => group.items.length > 0);
}

/** Flat, permission-filtered page list (used by the command palette). */
export function navItemsFor(role: UserRole | undefined, granted?: readonly string[]): NavItem[] {
  return navGroupsFor(role, granted).flatMap((group) => group.items);
}

/**
 * Route guard run before an app page renders. Unknown paths are allowed
 * through (the API stays the real authority); known pages are checked against
 * the permission list the server issued for this user.
 */
export function canAccess(
  pathname: string,
  role: UserRole | undefined,
  granted?: readonly string[],
): boolean {
  if (!role) return true;
  const item = ALL_NAV_ITEMS.find((navItem) => navItem.path === normalizePath(pathname));
  // An unmapped path is not our call to block — the API decides.
  return item ? admits(item, role, granted) : true;
}

/** Landing route for a role (falls back to the page every role can open). */
export function homeRouteFor(role?: UserRole): string {
  return role ? HOME_ROUTE[role] ?? FALLBACK_HOME : FALLBACK_HOME;
}

/** Header title for the current URL. */
export function pageTitleFor(pathname: string): string {
  const item = ALL_NAV_ITEMS.find((navItem) => navItem.path === normalizePath(pathname));
  return item?.pageTitle ?? item?.label ?? 'RapidAid';
}


