/** Canonical RapidAid permission catalog: resource → action → optional scope. */
export const PERMISSIONS = {
  COMMAND_CENTER_READ: 'command-center:read', COMMAND_CENTER_MANAGE: 'command-center:manage',
  EMERGENCY_CREATE: 'emergency:create', EMERGENCY_READ_ALL: 'emergency:read:all', EMERGENCY_READ_OWN: 'emergency:read:own',
  EMERGENCY_READ_ASSIGNED: 'emergency:read:assigned', EMERGENCY_READ_RELEVANT: 'emergency:read:relevant', EMERGENCY_READ_HISTORICAL: 'emergency:read:historical',
  EMERGENCY_UPDATE: 'emergency:update', EMERGENCY_UPDATE_ASSIGNED: 'emergency:update:assigned', EMERGENCY_ASSIGN: 'emergency:assign',
  EMERGENCY_REASSIGN: 'emergency:reassign', EMERGENCY_ESCALATE: 'emergency:escalate', EMERGENCY_ACKNOWLEDGE: 'emergency:acknowledge',
  EMERGENCY_CLOSE: 'emergency:close', EMERGENCY_OVERRIDE: 'emergency:override', EMERGENCY_EXPORT: 'emergency:export',
  EMERGENCY_CONFIRM: 'emergency:confirm', EMERGENCY_REJECT: 'emergency:reject', EMERGENCY_HISTORY_VIEW: 'emergency:history:view',
  AMBULANCE_CREATE: 'ambulance:create', AMBULANCE_READ_ALL: 'ambulance:read:all', AMBULANCE_READ_OWN: 'ambulance:read:own',
  AMBULANCE_READ_INCOMING: 'ambulance:read:incoming', AMBULANCE_READ_HISTORICAL: 'ambulance:read:historical', AMBULANCE_UPDATE: 'ambulance:update:all',
  AMBULANCE_UPDATE_OWN: 'ambulance:update:own', AMBULANCE_UPDATE_OPERATIONAL: 'ambulance:update:operational', AMBULANCE_ASSIGN: 'ambulance:assign',
  AMBULANCE_REASSIGN: 'ambulance:reassign', AMBULANCE_DEACTIVATE: 'ambulance:deactivate', AMBULANCE_ASSIGN_CREW: 'ambulance:assign:crew',
  HOSPITAL_CREATE: 'hospital:create', HOSPITAL_READ_ALL: 'hospital:read:all', HOSPITAL_READ_OWN: 'hospital:read:own',
  HOSPITAL_READ_RELEVANT: 'hospital:read:relevant', HOSPITAL_READ_HISTORICAL: 'hospital:read:historical', HOSPITAL_UPDATE: 'hospital:update:all',
  HOSPITAL_UPDATE_OWN: 'hospital:update:own', HOSPITAL_UPDATE_OPERATIONAL: 'hospital:update:operational', HOSPITAL_DEACTIVATE: 'hospital:deactivate',
  HOSPITAL_ACTIVATE: 'hospital:activate', HOSPITAL_ASSIGN_STAFF: 'hospital:assign', HOSPITAL_STAFF_MANAGE: 'hospital:staff:manage',
  HOSPITAL_CONFIGURE: 'hospital:configure', HOSPITAL_APPROVE: 'hospital:approve', HOSPITAL_CAPACITY_READ: 'hospital:capacity:read',
  HOSPITAL_CAPACITY_UPDATE: 'hospital:capacity:update', HOSPITAL_CAPACITY_UPDATE_OWN: 'hospital:capacity:update:own',
  HOSPITAL_REPORT_VIEW: 'hospital:report:view', HOSPITAL_REPORT_EXPORT: 'hospital:report:export', HOSPITAL_HISTORY_VIEW: 'hospital:history:view',
  TRACKING_READ_ALL: 'tracking:read:all', TRACKING_READ_OWN: 'tracking:read:own', TRACKING_ANALYZE: 'tracking:analyze',
  AI_VIEW: 'ai:view', AI_ANALYZE: 'ai:analyze', AI_REVIEW: 'ai:review', AI_CONFIRM: 'ai:confirm', AI_REJECT: 'ai:reject',
  AI_CREATE_EMERGENCY: 'ai:create-emergency', AI_CONFIGURE: 'ai:configure', AI_EXPORT_EVIDENCE: 'ai:export-evidence',
  CAMERA_CREATE: 'camera:create', CAMERA_UPDATE: 'camera:update', CAMERA_DELETE: 'camera:delete', CAMERA_LIVE_VIEW: 'camera:live-view',
  CAMERA_RECORDING_VIEW: 'camera:recording-view', CAMERA_EVIDENCE_VIEW: 'camera:evidence-view', CAMERA_EVIDENCE_EXPORT: 'camera:evidence-export', CAMERA_CONFIGURE: 'camera:configure',
  DISPATCH_VIEW: 'dispatch:view', DISPATCH_CREATE: 'dispatch:create', DISPATCH_ASSIGN: 'dispatch:assign', DISPATCH_REASSIGN: 'dispatch:reassign',
  DISPATCH_CANCEL: 'dispatch:cancel', DISPATCH_ESCALATE: 'dispatch:escalate', DISPATCH_OVERRIDE: 'dispatch:override', DISPATCH_CLOSE: 'dispatch:close', DISPATCH_ANALYZE: 'dispatch:analyze',
  GREEN_CORRIDOR_VIEW: 'green-corridor:view', GREEN_CORRIDOR_REQUEST: 'green-corridor:request', GREEN_CORRIDOR_ACTIVATE: 'green-corridor:activate',
  GREEN_CORRIDOR_CONTROL: 'green-corridor:control', GREEN_CORRIDOR_OVERRIDE: 'green-corridor:override', GREEN_CORRIDOR_ANALYZE: 'green-corridor:analyze',
  GREEN_CORRIDOR_HISTORY: 'green-corridor:history', GREEN_CORRIDOR_RECEIVE: 'green-corridor:receive',
  SHIFT_READ_ALL: 'shift:read:all', SHIFT_READ_OWN: 'shift:read:own', SHIFT_CREATE: 'shift:create', SHIFT_UPDATE: 'shift:update',
  SHIFT_ASSIGN_CREW: 'shift:assign:crew', SHIFT_ASSIGN_AMBULANCE: 'shift:assign:ambulance', SHIFT_START: 'shift:start', SHIFT_END: 'shift:end', SHIFT_UNAVAILABLE: 'shift:unavailable',
  MAINTENANCE_CREATE: 'maintenance:create', MAINTENANCE_READ_ALL: 'maintenance:read:all', MAINTENANCE_READ_OWN: 'maintenance:read:own', MAINTENANCE_UPDATE: 'maintenance:update', MAINTENANCE_APPROVE: 'maintenance:approve', MAINTENANCE_HISTORY: 'maintenance:history',
  /**
   * Voice reports. Deliberately fine-grained: *seeing* an emergency, *reading*
   * its transcript, *listening* to the original recording and *downloading*
   * those bytes are four different resources with four different scopes.
   * A role that may read an emergency (e.g. Analyst) does not thereby gain
   * access to the raw audio.
   */
  VOICE_CREATE: 'voice:create', VOICE_LIST: 'voice:list',
  VOICE_READ_ALL: 'voice:read:all', VOICE_READ_OWN: 'voice:read:own', VOICE_READ_ASSIGNED: 'voice:read:assigned',
  VOICE_READ_HOSPITAL: 'voice:read:hospital', VOICE_READ_RELEVANT: 'voice:read:relevant', VOICE_READ_HISTORICAL: 'voice:read:historical',
  VOICE_READ_ANALYTICAL: 'voice:read:analytical',
  VOICE_LISTEN: 'voice:listen', VOICE_LISTEN_ALL: 'voice:listen:all', VOICE_LISTEN_OWN: 'voice:listen:own',
  VOICE_LISTEN_ASSIGNED: 'voice:listen:assigned', VOICE_LISTEN_HOSPITAL: 'voice:listen:hospital',
  VOICE_LISTEN_RELEVANT: 'voice:listen:relevant', VOICE_LISTEN_HISTORICAL: 'voice:listen:historical',
  /** Explicit grant required before an Analyst may hear raw audio. Never implicit. */
  VOICE_LISTEN_ANALYTICAL: 'voice:listen:analytical',
  VOICE_TRANSCRIPT_VIEW: 'voice:transcript:view', VOICE_TRANSCRIPT_VIEW_ALL: 'voice:transcript:view:all',
  VOICE_TRANSCRIPT_VIEW_OWN: 'voice:transcript:view:own', VOICE_TRANSCRIPT_VIEW_ASSIGNED: 'voice:transcript:view:assigned',
  VOICE_TRANSCRIPT_VIEW_HOSPITAL: 'voice:transcript:view:hospital', VOICE_TRANSCRIPT_VIEW_RELEVANT: 'voice:transcript:view:relevant',
  VOICE_TRANSCRIPT_VIEW_HISTORICAL: 'voice:transcript:view:historical', VOICE_TRANSCRIPT_VIEW_ANALYTICAL: 'voice:transcript:view:analytical',
  VOICE_EVIDENCE_VIEW: 'voice:evidence:view',
  VOICE_DOWNLOAD: 'voice:download', VOICE_DOWNLOAD_ALL: 'voice:download:all',
  VOICE_DOWNLOAD_AUTHORIZED: 'voice:download:authorized', VOICE_DOWNLOAD_OWN: 'voice:download:own',
  VOICE_CONFIRM: 'voice:confirm', VOICE_EDIT: 'voice:edit', VOICE_REJECT: 'voice:reject',
  VOICE_DELETE: 'voice:delete', VOICE_DELETE_OWN: 'voice:delete:own', VOICE_ACCESS_HISTORY_VIEW: 'voice:access-history:view',
  REPORT_READ_ALL: 'report:read:all', REPORT_READ_OWN: 'report:read:own', REPORT_CREATE: 'report:create', REPORT_GENERATE: 'report:generate', REPORT_EXPORT: 'report:export', REPORT_EXPORT_SENSITIVE: 'report:export:sensitive',
  PATIENT_BASIC_READ: 'patient:basic-read', PATIENT_MEDICAL_READ: 'patient:medical-read', PATIENT_LOCATION_READ: 'patient:location-read', PATIENT_CONTACT_READ: 'patient:contact-read', PATIENT_UPDATE: 'patient:update', PATIENT_EXPORT: 'patient:export',
  ALERT_CREATE: 'alert:create', ALERT_READ_ALL: 'alert:read:all', ALERT_READ_RELEVANT: 'alert:read:relevant', ALERT_READ_OWN: 'alert:read:own', ALERT_ACKNOWLEDGE: 'alert:acknowledge', ALERT_ESCALATE: 'alert:escalate', ALERT_RESOLVE: 'alert:resolve', ALERT_CONFIGURE: 'alert:configure',
  AUDIT_READ_ALL: 'audit:read:all', AUDIT_READ_OWN: 'audit:read:own', AUDIT_EXPORT: 'audit:export',
  SETTINGS_PERSONAL: 'settings:personal', SETTINGS_OPERATIONAL: 'settings:operational', SETTINGS_HOSPITAL: 'settings:hospital', SETTINGS_MANAGE: 'settings:manage', SYSTEM_READ: 'system:read',
  USER_READ: 'user:read', USER_CREATE: 'user:create', USER_UPDATE: 'user:update', USER_DEACTIVATE: 'user:deactivate', USER_ASSIGN_ROLE: 'user:assign-role', PERMISSION_MANAGE: 'permission:manage',
} as const;
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const P = PERMISSIONS;
export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as readonly Permission[];
export const LEGACY_PERMISSION_ALIASES: Readonly<Record<string, Permission>> = {
  'command-center:view': P.COMMAND_CENTER_READ, 'emergency:view': P.EMERGENCY_READ_ALL, 'emergency:view:own': P.EMERGENCY_READ_OWN,
  'ambulance:view': P.AMBULANCE_READ_ALL, 'ambulance:view:own': P.AMBULANCE_READ_OWN, 'hospital:view': P.HOSPITAL_READ_ALL,
  'hospital:view:own': P.HOSPITAL_READ_OWN, 'tracking:view': P.TRACKING_READ_ALL, 'tracking:view:own': P.TRACKING_READ_OWN,
  'ai-vision:view': P.AI_VIEW, 'ai-vision:analyze': P.AI_ANALYZE, 'ai-vision:manage': P.AI_REVIEW,
  'dispatch-intel:view': P.DISPATCH_VIEW, 'dispatch-intel:manage': P.DISPATCH_ASSIGN, 'dispatch-intel:analyze': P.DISPATCH_ANALYZE,
  'voice:view': P.VOICE_READ_ALL, 'voice:view:own': P.VOICE_READ_OWN, 'voice:create': P.VOICE_CREATE, 'voice:manage': P.VOICE_CONFIRM,
  'green-corridor:view': P.GREEN_CORRIDOR_VIEW, 'green-corridor:control': P.GREEN_CORRIDOR_CONTROL,
  'alert:view': P.ALERT_READ_ALL, 'alert:view:own': P.ALERT_READ_OWN, 'audit:view': P.AUDIT_READ_ALL,
  'audit:view:own': P.AUDIT_READ_OWN, 'report:view': P.REPORT_READ_ALL, 'report:view:own': P.REPORT_READ_OWN,
  'report:analyze': P.REPORT_GENERATE, 'report:export': P.REPORT_EXPORT,
};

