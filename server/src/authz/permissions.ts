/** Compatibility facade for the canonical action/scope policy. */
import { ALL_PERMISSIONS, LEGACY_PERMISSION_ALIASES, P as CANONICAL_P, ROLE_PERMISSIONS, type Permission as CanonicalPermission } from './policy.js';
import type { Role } from '../validation/constants.js';
import { RolePolicy } from '../models/index.js';
import { env } from '../config/env.js';

export const LEGACY_P = {
  COMMAND_CENTER_VIEW: 'command-center:view', EMERGENCY_VIEW: 'emergency:view', EMERGENCY_VIEW_OWN: 'emergency:view:own', AMBULANCE_VIEW: 'ambulance:view', AMBULANCE_VIEW_OWN: 'ambulance:view:own', AMBULANCE_DELETE: 'ambulance:delete', AMBULANCE_STATUS: 'ambulance:status', AMBULANCE_TELEMETRY: 'ambulance:telemetry', AMBULANCE_MAINTENANCE: 'ambulance:maintenance', HOSPITAL_VIEW: 'hospital:view', HOSPITAL_VIEW_OWN: 'hospital:view:own', HOSPITAL_REFERRAL: 'hospital:referral', TRACKING_VIEW: 'tracking:view', TRACKING_VIEW_OWN: 'tracking:view:own', AI_VIEW: 'ai-vision:view', AI_ANALYZE: 'ai-vision:analyze', AI_MANAGE: 'ai-vision:manage', DISPATCH_VIEW: 'dispatch-intel:view', DISPATCH_MANAGE: 'dispatch-intel:manage', DISPATCH_ANALYZE: 'dispatch-intel:analyze', VOICE_VIEW: 'voice:view', VOICE_CREATE: 'voice:create', VOICE_MANAGE: 'voice:manage', CORRIDOR_VIEW: 'green-corridor:view', CORRIDOR_CONTROL: 'green-corridor:control', CORRIDOR_RECEIVE: 'green-corridor:receive', CORRIDOR_PRIORITY: 'green-corridor:priority', CORRIDOR_ANALYZE: 'green-corridor:analyze', ALERT_VIEW: 'alert:view', ALERT_VIEW_OWN: 'alert:view:own', ALERT_MANAGE: 'alert:manage', AUDIT_VIEW: 'audit:view', AUDIT_VIEW_OWN: 'audit:view:own', AUDIT_MANAGE: 'audit:manage', SETTINGS_PERSONAL: 'settings:personal', SETTINGS_OPERATIONAL: 'settings:operational', SETTINGS_HOSPITAL: 'settings:hospital', SETTINGS_MANAGE: 'settings:manage', USER_VIEW: 'user:view', USER_MANAGE: 'user:manage', USER_ASSIGN_ROLE: 'user:assign-role', REPORT_VIEW: 'report:view', REPORT_VIEW_OWN: 'report:view:own', REPORT_ANALYZE: 'report:analyze', REPORT_EXPORT: 'report:export',
} as const;
export type LegacyPermission = (typeof LEGACY_P)[keyof typeof LEGACY_P];
export type Permission = CanonicalPermission | LegacyPermission;
export const P = { ...CANONICAL_P, ...LEGACY_P } as const;
export const PERMISSIONS = P;
export { ALL_PERMISSIONS, LEGACY_PERMISSION_ALIASES, ROLE_PERMISSIONS };

const LEGACY_COMPATIBILITY: Readonly<Record<string, string>> = {
  'command-center:view': 'command-center:read', 'emergency:view': 'emergency:read:all', 'emergency:view:own': 'emergency:read:assigned',
  'ambulance:view': 'ambulance:read:all', 'ambulance:view:own': 'ambulance:read:own', 'ambulance:delete': 'ambulance:deactivate', 'hospital:view': 'hospital:read:all', 'hospital:view:own': 'hospital:read:own',
  'tracking:view': 'tracking:read:all', 'tracking:view:own': 'tracking:read:own', 'ai-vision:view': 'ai:view', 'ai-vision:analyze': 'ai:analyze', 'ai-vision:manage': 'ai:review',
  'dispatch-intel:view': 'dispatch:view', 'dispatch-intel:manage': 'dispatch:assign', 'dispatch-intel:analyze': 'dispatch:analyze', 'alert:view': 'alert:read:all', 'alert:view:own': 'alert:read:own',
  'audit:view': 'audit:read:all', 'audit:view:own': 'audit:read:own', 'hospital:referral': 'hospital:read:relevant', 'voice:view': 'voice:read:all', 'voice:view:own': 'voice:read:own', 'voice:create': 'voice:create', 'voice:manage': 'voice:confirm', 'ambulance:maintenance': 'maintenance:read:all', 'alert:manage': 'alert:acknowledge', 'report:view': 'report:read:all', 'report:view:own': 'report:read:own', 'report:analyze': 'report:generate', 'report:export': 'report:export',
};
function legacyFor(canonical: readonly CanonicalPermission[]): LegacyPermission[] {
  return Object.entries(LEGACY_COMPATIBILITY)
    .filter(([, target]) => canonical.includes(target as CanonicalPermission))
    .map(([legacy]) => legacy as LegacyPermission);
}

export function permissionsFor(role: Role | undefined): readonly Permission[] {
  const canonical = role ? ROLE_PERMISSIONS[role] ?? [] : [];
  const legacy = legacyFor(canonical);
  if (canonical.includes('emergency:read:own' as CanonicalPermission) || canonical.includes('emergency:read:assigned' as CanonicalPermission)) legacy.push('emergency:view:own');
  return [...new Set<Permission>([...canonical, ...legacy])];
}
export function can(role: Role | undefined, permission: Permission | string): boolean {
  const normalized = normalizePermission(permission);
  return permissionsFor(role).includes(normalized as Permission);
}
export function canReadScoped(role: Role | undefined, unscoped: Permission, own: Permission): boolean { return can(role, unscoped) || can(role, own); }

const CACHE_TTL_MS = env.PERMISSION_CACHE_TTL_MS;
type PolicyCacheEntry = { permissions: readonly string[]; expiresAt: number };
const policyCache = new Map<Role, PolicyCacheEntry>();
function isPermission(value: string): boolean { return (ALL_PERMISSIONS as readonly string[]).includes(value); }
export function defaultPermissionsFor(role: Role | undefined): readonly string[] { return role ? ROLE_PERMISSIONS[role] ?? [] : []; }
export async function effectivePermissionsFor(role: Role | undefined): Promise<readonly string[]> {
  if (!role) return [];
  // With the cache disabled (the default, TTL 0) every request reads RolePolicy,
  // so a permission revoked through the admin API takes effect immediately on
  // *all* instances. A positive TTL is only safe single-instance.
  if (CACHE_TTL_MS > 0) {
    const cached = policyCache.get(role);
    if (cached && cached.expiresAt > Date.now()) return cached.permissions;
  }
  const stored = await RolePolicy.findOne({ role }).lean();
  const permissions = stored ? stored.permissions.filter(isPermission) : defaultPermissionsFor(role);
  const result = [...new Set([...permissions, ...legacyFor(permissions as CanonicalPermission[])])];
  if (CACHE_TTL_MS > 0) policyCache.set(role, { permissions: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
export function invalidatePolicyCache(role?: Role): void { if (role) policyCache.delete(role); else policyCache.clear(); }
export function normalizePermission(permission: string): string {
  const local: Record<string, string> = {
    ...Object.fromEntries(Object.entries(LEGACY_PERMISSION_ALIASES).map(([legacy, target]) => [legacy, target])),
    'ambulance:delete': P.AMBULANCE_DEACTIVATE,
    'ambulance:status': P.AMBULANCE_UPDATE_OPERATIONAL,
    'ambulance:telemetry': P.AMBULANCE_UPDATE_OWN,
    'hospital:referral': P.HOSPITAL_READ_RELEVANT,
    'voice:view': P.VOICE_READ_ALL,
    'voice:view:own': P.VOICE_READ_OWN,
    'voice:create': P.VOICE_CREATE,
    'voice:manage': P.VOICE_CONFIRM,
    'user:view': P.USER_READ,
    'user:manage': P.USER_UPDATE,
  };
  return local[permission] ?? permission;
}
export function canIn(permissions: readonly string[], permission: string): boolean { const normalized = normalizePermission(permission); return permissions.includes(normalized) || permissions.includes(permission); }








