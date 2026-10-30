/**
 * Client-side authorization helpers.
 *
 * The permission strings themselves are NOT duplicated here: they arrive on
 * `PublicUser.permissions`, emitted by the server straight from its RBAC
 * registry (`server/src/authz/permissions.ts`). This module only provides
 * typed helpers over that list, so the two sides cannot drift.
 *
 * Every helper here is a UX affordance â€” it decides what is *rendered*. The
 * API independently re-checks each rule via `requirePermission(...)` and the
 * resource-ownership guards, so hiding a control is never mistaken for
 * enforcement.
 */
import type { UserRole } from '../types';

/**
 * Permission identifiers owned by the server registry. This is a literal union
 * â€” deliberately NOT `string` â€” so a typo (e.g. `ai:view` instead of
 * `ai-vision:view`) fails the build instead of silently hiding a page forever.
 * Keep in sync with `PERMISSIONS` in server/src/authz/permissions.ts.
 */
export type PermissionName =
  // Command center
  | 'command-center:view' | 'command-center:manage'
  // Emergencies
  | 'emergency:view' | 'emergency:view:own' | 'emergency:create' | 'emergency:update'
  // Ambulances
  | 'ambulance:view' | 'ambulance:view:own' | 'ambulance:create' | 'ambulance:update'
  | 'ambulance:delete' | 'ambulance:assign' | 'ambulance:assign-crew'
  | 'ambulance:status' | 'ambulance:telemetry' | 'ambulance:maintenance'
  // Hospitals
  | 'hospital:view' | 'hospital:view:own' | 'hospital:update' | 'hospital:referral'
  // Live tracking
  | 'tracking:view' | 'tracking:view:own' | 'tracking:analyze'
  // AI vision
  | 'ai-vision:view' | 'ai-vision:analyze' | 'ai-vision:manage'
  // Dispatch intelligence
  | 'dispatch-intel:view' | 'dispatch-intel:manage' | 'dispatch-intel:analyze'
  // Voice reports
  | 'voice:view' | 'voice:view:own' | 'voice:create' | 'voice:manage' | 'voice:read:all' | 'voice:read:own' | 'voice:read:assigned' | 'voice:read:hospital' | 'voice:read:relevant' | 'voice:read:historical' | 'voice:read:analytical'
  | 'voice:listen' | 'voice:listen:all' | 'voice:listen:own' | 'voice:listen:assigned' | 'voice:listen:hospital' | 'voice:listen:relevant' | 'voice:listen:historical' | 'voice:listen:analytical'
  | 'voice:transcript:view' | 'voice:transcript:view:all' | 'voice:transcript:view:own' | 'voice:transcript:view:assigned' | 'voice:transcript:view:hospital' | 'voice:transcript:view:relevant' | 'voice:transcript:view:historical' | 'voice:transcript:view:analytical'
  | 'voice:download' | 'voice:download:all' | 'voice:download:authorized' | 'voice:download:own'
  | 'voice:evidence:view' | 'voice:confirm' | 'voice:reject' | 'voice:edit' | 'voice:delete' | 'voice:delete:own' | 'voice:access-history:view' | 'voice:list'
  // Green corridor
  | 'green-corridor:view' | 'green-corridor:control' | 'green-corridor:receive'
  | 'green-corridor:priority' | 'green-corridor:analyze' | 'green-corridor:request'
  | 'green-corridor:activate' | 'green-corridor:history' | 'green-corridor:override'
  // Emergency scopes for the voice workflow
  | 'emergency:confirm' | 'emergency:reject' | 'emergency:history:view'
  | 'emergency:read:relevant' | 'emergency:read:historical' | 'emergency:update:assigned'
  // Alerts
  | 'alert:view' | 'alert:view:own' | 'alert:manage'
  // Audit
  | 'audit:view' | 'audit:view:own' | 'audit:manage'
  // Settings
  | 'settings:personal' | 'settings:operational' | 'settings:hospital' | 'settings:manage'
  // Users & roles
  | 'user:view' | 'user:manage' | 'user:assign-role'
  // Canonical permission-management, scope, and action permissions
  | 'permission:manage' | 'user:read' | 'user:create' | 'user:update' | 'user:deactivate' | 'user:assign-role'
  | 'emergency:override' | 'emergency:read:all' | 'emergency:read:own' | 'emergency:read:assigned' | 'emergency:read:relevant' | 'emergency:read:historical'
  | 'emergency:update' | 'emergency:update:assigned' | 'emergency:assign' | 'emergency:reassign' | 'emergency:escalate' | 'emergency:acknowledge' | 'emergency:close' | 'emergency:export' | 'emergency:confirm' | 'emergency:reject' | 'emergency:history:view'
  | 'ambulance:create' | 'ambulance:read:all' | 'ambulance:read:own' | 'ambulance:read:incoming' | 'ambulance:read:historical' | 'ambulance:update:all' | 'ambulance:update:own' | 'ambulance:update:operational' | 'ambulance:deactivate' | 'ambulance:assign:crew'
  | 'hospital:create' | 'hospital:read:all' | 'hospital:read:own' | 'hospital:read:relevant' | 'hospital:read:historical' | 'hospital:update:all' | 'hospital:update:own' | 'hospital:capacity:update:own' | 'hospital:deactivate' | 'hospital:assign' | 'hospital:configure' | 'hospital:approve'
  | 'tracking:read:all' | 'tracking:read:own' | 'tracking:analyze'
  | 'ai:view' | 'ai:analyze' | 'ai:review' | 'ai:confirm' | 'ai:reject' | 'ai:create-emergency' | 'ai:configure' | 'ai:export-evidence'
  | 'camera:create' | 'camera:update' | 'camera:delete' | 'camera:live-view' | 'camera:recording-view' | 'camera:evidence-view' | 'camera:evidence-export' | 'camera:configure'
  | 'dispatch:view' | 'dispatch:create' | 'dispatch:assign' | 'dispatch:reassign' | 'dispatch:cancel' | 'dispatch:escalate' | 'dispatch:override' | 'dispatch:close' | 'dispatch:analyze'
  | 'green-corridor:view' | 'green-corridor:request' | 'green-corridor:activate' | 'green-corridor:control' | 'green-corridor:override' | 'green-corridor:analyze' | 'green-corridor:history' | 'green-corridor:receive'
  | 'voice:create' | 'voice:read:all' | 'voice:read:own' | 'voice:confirm' | 'voice:delete:own'
  | 'alert:read:all' | 'alert:read:relevant' | 'alert:read:own' | 'alert:create' | 'alert:acknowledge' | 'alert:escalate' | 'alert:resolve' | 'alert:configure'
  | 'audit:read:all' | 'audit:read:own' | 'audit:export'
  | 'report:view' | 'report:view:own' | 'report:analyze' | 'report:export'
  | 'report:read:all' | 'report:read:own' | 'report:create' | 'report:generate' | 'report:export:sensitive'
  | 'patient:basic-read' | 'patient:medical-read' | 'patient:location-read' | 'patient:contact-read' | 'patient:update' | 'patient:export'
  | 'maintenance:create' | 'maintenance:read:all' | 'maintenance:read:own' | 'maintenance:update' | 'maintenance:approve' | 'maintenance:history'
  | 'shift:read:all' | 'shift:read:own' | 'shift:create' | 'shift:update' | 'shift:assign:crew' | 'shift:assign:ambulance' | 'shift:start' | 'shift:end' | 'shift:unavailable';


/**
 * The signed-in user's permission list. The server sends this on
 * `PublicUser.permissions`; guests and signed-out users hold nothing, so every
 * helper below denies by default rather than granting on a missing argument.
 */
const LEGACY_TO_CANONICAL: Readonly<Record<string, string>> = {
  'command-center:view': 'command-center:read',
  'emergency:view': 'emergency:read:all', 'emergency:view:own': 'emergency:read:own',
  'ambulance:view': 'ambulance:read:all', 'ambulance:view:own': 'ambulance:read:own', 'ambulance:update': 'ambulance:update:all', 'ambulance:delete': 'ambulance:deactivate', 'ambulance:status': 'ambulance:update:operational', 'ambulance:telemetry': 'ambulance:update:own', 'ambulance:maintenance': 'maintenance:read:all',
  'hospital:view': 'hospital:read:all', 'hospital:view:own': 'hospital:read:own', 'hospital:update': 'hospital:update:all', 'hospital:referral': 'hospital:read:relevant',
  'tracking:view': 'tracking:read:all', 'tracking:view:own': 'tracking:read:own',
  'ai-vision:view': 'ai:view', 'ai-vision:analyze': 'ai:analyze', 'ai-vision:manage': 'ai:review',
  'dispatch-intel:view': 'dispatch:view', 'dispatch-intel:manage': 'dispatch:assign', 'dispatch-intel:analyze': 'dispatch:analyze',
  'green-corridor:view': 'green-corridor:view', 'green-corridor:control': 'green-corridor:control',
  'alert:view': 'alert:read:all', 'alert:view:own': 'alert:read:own', 'alert:manage': 'alert:acknowledge',
  'audit:view': 'audit:read:all', 'audit:view:own': 'audit:read:own',
  'voice:view': 'voice:read:all', 'voice:view:own': 'voice:read:own', 'voice:create': 'voice:create', 'voice:manage': 'voice:confirm',
  'user:view': 'user:read', 'user:manage': 'user:update',
  'report:view': 'report:read:all', 'report:view:own': 'report:read:own', 'report:analyze': 'report:generate', 'report:export': 'report:export',
};

function normalizeClientPermission(permission: string): string {
  return LEGACY_TO_CANONICAL[permission] ?? permission;
}

function currentPermissions(granted?: readonly string[]): readonly string[] {
  return granted ?? [];
}

export function hasPermission(granted: readonly string[] | undefined, permission: PermissionName): boolean {
  const normalized = normalizeClientPermission(permission);
  return Boolean(granted?.includes(normalized) || granted?.includes(permission));
}

/** True when the signed-in role holds `permission`. */
export function can(role: UserRole | undefined, permission: PermissionName, granted?: readonly string[]): boolean {
  if (!role) return false;
  return hasPermission(granted, permission);
}

/** True when the role holds the unscoped permission or its `:own` variant. */
export function canReadScoped(
  role: UserRole | undefined,
  unscoped: PermissionName,
  own: PermissionName,
  granted?: readonly string[],
): boolean {
  return can(role, unscoped, granted) || can(role, own, granted);
}

/**
 * Coarse capability bundle for the fleet UI. Derived from the server-issued
 * permission list rather than a local role table, so a matrix change on the
 * server flows straight through to the buttons rendered here.
 */
export interface FleetPermissions {
  /** May add ambulances. */
  canCreate: boolean;
  /** May edit fleet-wide ambulance attributes. */
  canEditFleet: boolean;
  /** May bind roster seats to login accounts. */
  canAssignCrew: boolean;
  /** Backwards-compatible aggregate used for read-only messaging. */
  canManageFleet: boolean;
  /** May mark a unit AVAILABLE / OFFLINE / MAINTENANCE (availability board). */
  canSetAvailability: boolean;
  /** May assign an available ambulance to an emergency. */
  canAssignToEmergency: boolean;
  /** May push telemetry, but only for the crew member's own unit. */
  canUpdateOwnTelemetry: boolean;
  /** May push telemetry for any unit. */
  canUpdateAnyTelemetry: boolean;
  /** May deactivate / delete a unit (administrator only). */
  canDeactivate: boolean;
  /** May view maintenance information (administrator only). */
  canViewMaintenance: boolean;
  /** Read-only fleet access (analyst / auditor / hospital). */
  readOnly: boolean;
  /** Crew sign-in: the list is scoped to their own ambulance. */
  ownUnitOnly: boolean;
}

const NONE: FleetPermissions = {
  canCreate: false,
  canEditFleet: false,
  canAssignCrew: false,
  canManageFleet: false,
  canSetAvailability: false,
  canAssignToEmergency: false,
  canUpdateOwnTelemetry: false,
  canUpdateAnyTelemetry: false,
  canDeactivate: false,
  canViewMaintenance: false,
  readOnly: true,
  ownUnitOnly: false,
};

/** Maps a server-issued permission list onto the fleet UI's capability flags. */
export function fleetPermissions(
  role: UserRole | undefined,
  granted?: readonly string[],
): FleetPermissions {
  if (!role) return NONE;
  const held = currentPermissions(granted);
  const has = (p: PermissionName) => hasPermission(held, p);

  const canCreate = has('ambulance:create');
  const canEditFleet = has('ambulance:update:all');
  const canAssignCrew = has('ambulance:assign:crew');
  const canManageFleet = canCreate || canEditFleet || canAssignCrew;
  return {
    canCreate,
    canEditFleet,
    canAssignCrew,
    canManageFleet,
    canSetAvailability: has('ambulance:update:operational'),
    canAssignToEmergency: has('dispatch:assign'),
    canUpdateOwnTelemetry: has('ambulance:update:own'),
    canUpdateAnyTelemetry: (has('ambulance:update:all') || has('ambulance:update:operational')) && role !== 'AMBULANCE_CREW',
    canDeactivate: has('ambulance:deactivate'),
    canViewMaintenance: has('maintenance:read:all') || has('maintenance:read:own'),
    readOnly: !canManageFleet && !has('ambulance:assign') && !has('ambulance:update:operational') && !has('ambulance:update:own'),
    // "Own unit only" describes the server's effective scope. Roles such as
    // ADMIN hold both read:own and read:all, but still see the whole fleet.
    ownUnitOnly: has('ambulance:read:own') && !has('ambulance:read:all'),
  };
}

