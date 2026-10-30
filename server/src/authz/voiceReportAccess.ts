/**
 * Voice-report resource authorization — the single place where
 * ROLE → PERMISSION → ACTION → SCOPE → RESOURCE OWNERSHIP is evaluated.
 *
 * Four resources are deliberately kept apart, because a caller who may *see* an
 * emergency does not automatically get to *hear* it:
 *
 *   read        metadata + AI extraction     (voice:read:<scope>)
 *   transcript  the spoken words, as text    (voice:transcript:view:<scope>)
 *   listen      the stored original audio    (voice:listen:<scope>)
 *   download    the audio bytes as a file    (voice:download:<scope>)
 *
 * Scopes are resolved from SERVER-SIDE relationships only — never from
 * anything the client supplies:
 *
 *   own        report.ownerId === caller                 (citizen / crew / hospital / dispatcher)
 *   assigned   the linked emergency is assigned to the caller's crew/unit
 *   hospital   the linked/routed emergency belongs to the caller's hospital
 *   active     the live review queue or a non-terminal emergency (dispatcher)
 *   historical the closed record (CONFIRMED/REJECTED or a terminal emergency)
 *   evidence   a confirmed record, i.e. auditable evidence (auditor)
 *   analytical confirmed records only, transcript-level by default (analyst)
 *
 * Denial semantics:
 *   out of scope            → 404 (a caller cannot probe for other people's reports)
 *   in scope, wrong action  → 403 (read yes, listen/download no)
 */
import { Ambulance, Emergency } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { recordAudit } from '../services/auditService.js';
import { VOICE_REPORT_STATUSES } from '../validation/constants.js';
import { hasPermission, isAssignedCrew, type AuthContext } from './access.js';

/** Emergency states that end the operational life of an incident. */
export const TERMINAL_EMERGENCY_STATUSES = ['COMPLETED', 'CANCELLED'] as const;
/** Voice-report states that still belong to the live review queue. */
export const OPERATIONAL_VOICE_STATUSES = ['RECORDING', 'PROCESSING', 'DRAFT', 'CONFIRMING', 'FAILED'] as const;
/** Voice-report states that are closed records (history / evidence). */
export const HISTORICAL_VOICE_STATUSES = ['CONFIRMED', 'REJECTED'] as const;

/** The projection every authorization decision reads. Nothing else is trusted. */
export interface VoiceReportScope {
  _id: string;
  ownerId?: string | null;
  hospitalId?: string | null;
  emergencyId?: string | null;
  status?: string | null;
  hospitalRouting?: { hospitalId?: string | null } | null;
  audio?: { storageKey?: string | null } | null;
}

interface EmergencyScopeRow {
  _id: string;
  status?: string | null;
  assignedDispatcher?: string | null;
  assignedCrewIds?: string[] | null;
  assignedAmbulance?: string | null;
  destinationHospital?: string | null;
}

export interface VoiceRelations {
  own: boolean;
  assigned: boolean;
  hospital: boolean;
  /** Live queue / non-terminal emergency / an emergency this caller handled. */
  active: boolean;
  /** Closed record: CONFIRMED, REJECTED or a terminal emergency. */
  historical: boolean;
  /** Confirmed record — the auditable evidence set. */
  evidence: boolean;
  /** Confirmed record — the analytical set. */
  analytical: boolean;
}

/** The subset of `audio` metadata that decides whether playback is possible. */
interface PlayableAudioMeta {
  storageKey?: string | null;
  status?: string | null;
}

/**
 * True when this report advertises a recording the audio endpoint can actually
 * serve.
 *
 * `canPlayRecording` used to be `Boolean(audio.storageKey)`, which advertised
 * "playable" for reports whose storage object no longer existed — the UI then
 * rendered a player that could only fail. A `LOST` marker (written by the
 * integrity sweep) makes the difference explicit.
 */
export function isPlayableAudio(audio: PlayableAudioMeta | null | undefined): boolean {
  if (!audio?.storageKey) return false;
  return audio.status !== 'LOST';
}

export interface VoiceCapabilities {
  read: boolean;
  listen: boolean;
  transcript: boolean;
  download: boolean;
  confirm: boolean;
  edit: boolean;
  reject: boolean;
  discard: boolean;
  accessHistory: boolean;
  evidence: boolean;
  /** True only when the caller may listen AND the recording is really servable. */
  canPlayRecording: boolean;
  /** Access context shown in the UI ("Assigned Emergency", "Audit Evidence"…). */
  accessLabel: string;
}

/** Cache so a list of N reports costs one emergency query, not N. */
export interface VoiceScopeCache {
  emergencies: Map<string, EmergencyScopeRow | null>;
  crewAmbulances?: string[] | null;
}

export function createVoiceScopeCache(): VoiceScopeCache {
  return { emergencies: new Map() };
}

interface ScopeRule {
  permission: string;
  relation: keyof VoiceRelations;
  label: string;
}

const READ_RULES: readonly ScopeRule[] = [
  { permission: 'voice:read:own', relation: 'own', label: 'Own Report' },
  { permission: 'voice:read:assigned', relation: 'assigned', label: 'Assigned Emergency' },
  { permission: 'voice:read:hospital', relation: 'hospital', label: 'Hospital Emergency' },
  { permission: 'voice:read:relevant', relation: 'active', label: 'Active Report' },
  { permission: 'voice:read:historical', relation: 'historical', label: 'Historical Record' },
  { permission: 'voice:read:analytical', relation: 'analytical', label: 'Analytical Record' },
  { permission: 'voice:evidence:view', relation: 'evidence', label: 'Audit Evidence' },
];
const LISTEN_RULES: readonly ScopeRule[] = [
  { permission: 'voice:listen:own', relation: 'own', label: 'Own Report' },
  { permission: 'voice:listen:assigned', relation: 'assigned', label: 'Assigned Emergency' },
  { permission: 'voice:listen:hospital', relation: 'hospital', label: 'Hospital Emergency' },
  { permission: 'voice:listen:relevant', relation: 'active', label: 'Active Report' },
  { permission: 'voice:listen:historical', relation: 'historical', label: 'Historical Record' },
  { permission: 'voice:listen:analytical', relation: 'analytical', label: 'Analytical Record' },
];
const TRANSCRIPT_RULES: readonly ScopeRule[] = [
  { permission: 'voice:transcript:view:own', relation: 'own', label: 'Own Report' },
  { permission: 'voice:transcript:view:assigned', relation: 'assigned', label: 'Assigned Emergency' },
  { permission: 'voice:transcript:view:hospital', relation: 'hospital', label: 'Hospital Emergency' },
  { permission: 'voice:transcript:view:relevant', relation: 'active', label: 'Active Report' },
  { permission: 'voice:transcript:view:historical', relation: 'historical', label: 'Historical Record' },
  { permission: 'voice:transcript:view:analytical', relation: 'analytical', label: 'Analytical Record' },
];
const DOWNLOAD_RULES: readonly ScopeRule[] = [
  { permission: 'voice:download:own', relation: 'own', label: 'Own Report' },
];

/** Order used to pick the most specific access label for the UI. */
const LABEL_ORDER: readonly (keyof VoiceRelations)[] = [
  'own', 'assigned', 'hospital', 'evidence', 'analytical', 'historical', 'active',
];

function matchedRule(auth: AuthContext, relations: VoiceRelations, rules: readonly ScopeRule[]): ScopeRule | null {
  for (const rule of rules) if (relations[rule.relation] && hasPermission(auth, rule.permission)) return rule;
  return null;
}

function labelFor(auth: AuthContext, relations: VoiceRelations): string {
  // An administrator's access is global rather than derived from a
  // relationship, so say so rather than naming whichever relation happens to
  // match first.
  if (auth.role === 'ADMIN' && hasPermission(auth, 'voice:read:all')) return 'Administrator Access';
  const allRules = [...READ_RULES, ...LISTEN_RULES, ...TRANSCRIPT_RULES];
  for (const relation of LABEL_ORDER) {
    const match = allRules.find(
      (rule) => rule.relation === relation && relations[relation] && hasPermission(auth, rule.permission),
    );
    if (match) return match.label;
  }
  if (hasPermission(auth, 'voice:read:all')) return 'Full Operational Access';
  return 'Restricted';
}

// ── Relationship resolution (server-side truth only) ─────────────────────────

async function loadEmergency(
  emergencyId: string,
  cache: VoiceScopeCache,
): Promise<EmergencyScopeRow | null> {
  const cached = cache.emergencies.get(emergencyId);
  if (cached !== undefined) return cached;
  const row = await Emergency.findById(emergencyId)
    .select('_id status assignedDispatcher assignedCrewIds assignedAmbulance destinationHospital')
    .lean<EmergencyScopeRow>();
  const value = row ?? null;
  cache.emergencies.set(emergencyId, value);
  return value;
}

async function crewAmbulances(auth: AuthContext, cache: VoiceScopeCache): Promise<string[]> {
  if (cache.crewAmbulances) return cache.crewAmbulances;
  if (auth.role !== 'AMBULANCE_CREW') {
    cache.crewAmbulances = [];
    return cache.crewAmbulances;
  }
  const units = await Ambulance.find({ 'crew.userId': auth.userId, active: { $ne: false } })
    .select('_id')
    .lean();
  cache.crewAmbulances = units.map((unit) => unit._id);
  return cache.crewAmbulances;
}

/**
 * A crew member is "assigned" when the report's emergency names them in
 * `assignedCrewIds`, or when it names an ambulance they are rostered on. The
 * roster is read from the database, never from the request.
 */
async function isAssignedToEmergency(
  auth: AuthContext,
  emergency: EmergencyScopeRow,
  cache: VoiceScopeCache,
): Promise<boolean> {
  if (emergency.assignedCrewIds?.includes(auth.userId)) return true;
  const ambulanceId = emergency.assignedAmbulance;
  if (!ambulanceId) return false;
  if (auth.ambulanceId && auth.ambulanceId === ambulanceId) return true;
  if ((await crewAmbulances(auth, cache)).includes(ambulanceId)) return true;
  return isAssignedCrew(auth.userId, ambulanceId);
}

export async function relationsFor(
  auth: AuthContext,
  report: VoiceReportScope,
  cache: VoiceScopeCache = createVoiceScopeCache(),
): Promise<VoiceRelations> {
  const emergency = report.emergencyId ? await loadEmergency(report.emergencyId, cache) : null;
  const status = report.status ?? 'DRAFT';

  const own = Boolean(report.ownerId && report.ownerId === auth.userId);
  const assigned = Boolean(emergency && (await isAssignedToEmergency(auth, emergency, cache)));
  const hospital = Boolean(
    auth.hospitalId &&
      (report.hospitalId === auth.hospitalId ||
        report.hospitalRouting?.hospitalId === auth.hospitalId ||
        emergency?.destinationHospital === auth.hospitalId),
  );

  const operationalStatus = (OPERATIONAL_VOICE_STATUSES as readonly string[]).includes(status);
  const closedStatus = (HISTORICAL_VOICE_STATUSES as readonly string[]).includes(status);
  const terminalEmergency = Boolean(
    emergency && (TERMINAL_EMERGENCY_STATUSES as readonly string[]).includes(emergency.status ?? ''),
  );
  const handled = Boolean(emergency && auth.userId && emergency.assignedDispatcher === auth.userId);

  return {
    own,
    assigned,
    hospital,
    // The live queue, an emergency still running, or one this caller handled.
    active: operationalStatus || handled || Boolean(emergency && !terminalEmergency),
    historical: !operationalStatus && (closedStatus || terminalEmergency),
    evidence: closedStatus && status === 'CONFIRMED',
    analytical: status === 'CONFIRMED',
  };
}

export async function relationsForMany(
  auth: AuthContext,
  reports: readonly VoiceReportScope[],
  cache: VoiceScopeCache = createVoiceScopeCache(),
): Promise<Map<string, VoiceRelations>> {
  const result = new Map<string, VoiceRelations>();
  for (const report of reports) result.set(report._id, await relationsFor(auth, report, cache));
  return result;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

/**
 * Derives every action a caller may take on one report. `listen`, `transcript`
 * and `download` all require `read` (you cannot hear what you cannot open), and
 * listening a recording implies reading its transcript — never the reverse.
 */
export function capabilitiesFor(
  auth: AuthContext,
  relations: VoiceRelations,
  report: VoiceReportScope,
): VoiceCapabilities {
  const readAny = hasPermission(auth, 'voice:read:all');
  const listenAny = hasPermission(auth, 'voice:listen:all') || hasPermission(auth, 'voice:listen');
  const transcriptAny =
    hasPermission(auth, 'voice:transcript:view:all') || hasPermission(auth, 'voice:transcript:view');
  const downloadAny =
    hasPermission(auth, 'voice:download:all') || hasPermission(auth, 'voice:download:authorized');

  const readRule = matchedRule(auth, relations, READ_RULES);
  const listenRule = matchedRule(auth, relations, LISTEN_RULES);
  const transcriptRule = matchedRule(auth, relations, TRANSCRIPT_RULES);
  const downloadRule = matchedRule(auth, relations, DOWNLOAD_RULES);

  // Any scoped grant is only about *this* report's relationship; a listener is
  // by definition also a reader of the record it may play.
  const read = Boolean(readAny || readRule || listenRule || transcriptRule || downloadRule);
  const listen = read && Boolean(listenAny || listenRule);
  const transcript = read && Boolean(transcriptAny || transcriptRule || listen);
  const download = read && Boolean(downloadAny || downloadRule);
  const status = report.status ?? 'DRAFT';

  return {
    read,
    listen,
    transcript,
    download,
    confirm: read && (hasPermission(auth, 'voice:confirm') || hasPermission(auth, 'emergency:confirm')),
    reject: read && (hasPermission(auth, 'voice:reject') || hasPermission(auth, 'emergency:reject')),
    edit: read && hasPermission(auth, 'voice:edit'),
    discard:
      read &&
      status !== 'CONFIRMED' &&
      (hasPermission(auth, 'voice:delete') || (relations.own && hasPermission(auth, 'voice:delete:own'))),
    accessHistory: read && hasPermission(auth, 'voice:access-history:view'),
    evidence: relations.evidence && read,
    canPlayRecording: listen && isPlayableAudio(report.audio),
    accessLabel: labelFor(auth, relations),
  };
}

export async function voiceCapabilities(
  auth: AuthContext,
  report: VoiceReportScope,
  cache: VoiceScopeCache = createVoiceScopeCache(),
): Promise<VoiceCapabilities> {
  return capabilitiesFor(auth, await relationsFor(auth, report, cache), report);
}

export type VoiceAction = 'read' | 'listen' | 'transcript' | 'download';

export interface VoiceAuditContext {
  requestId?: string;
  ip?: string;
}

const ACTION_MESSAGE: Record<Exclude<VoiceAction, 'read'>, string> = {
  listen: 'You may view this report but you are not authorized to listen to the original recording',
  transcript: 'You may view this report but you are not authorized to read its transcript',
  download: 'You may view this report but you are not authorized to download its recording',
};

/**
 * Authorizes one action on one report and audits every refusal.
 *
 *   read       — metadata / AI extraction
 *   listen     — the stored original audio
 *   transcript — the spoken words as text
 *   download   — the audio bytes as an attachment
 *
 * Out-of-scope callers get 404 (never 403) so nobody can probe for the
 * existence of another citizen's, hospital's or crew's recording; callers who
 * are inside the scope but hold no grant for the action get 403.
 */
export async function assertVoiceAccess(
  auth: AuthContext,
  report: VoiceReportScope,
  action: VoiceAction,
  context: VoiceAuditContext = {},
  cache: VoiceScopeCache = createVoiceScopeCache(),
): Promise<VoiceCapabilities> {
  const capabilities = await voiceCapabilities(auth, report, cache);
  const missing =
    action === 'listen' ? !capabilities.listen : action === 'transcript' ? !capabilities.transcript : action === 'download' ? !capabilities.download : false;

  if (action === 'read' ? capabilities.read : capabilities.read && !missing) return capabilities;

  const outOfScope = !capabilities.read;
  const reason = outOfScope ? 'OUT_OF_SCOPE' : `${action.toUpperCase()}_NOT_PERMITTED`;

  await recordAudit({
    actor: auth.name,
    actorId: auth.userId,
    actorRole: auth.role,
    action: 'voice.report_access_denied',
    resource: 'VoiceReport',
    resourceId: report._id,
    requestId: context.requestId ?? 'n/a',
    ip: context.ip,
    result: 'FAILURE',
    reason,
    details: `role=${auth.role} action=${action} emergency=${report.emergencyId ?? 'none'}`,
  });

  if (outOfScope) throw ApiError.notFound(`Voice report ${report._id} not found`);
  throw ApiError.forbidden(ACTION_MESSAGE[action as Exclude<VoiceAction, 'read'>]);
}

// ── Query scoping (a list never fetches what the caller may not see) ─────────

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function emergencyIds(filter: Record<string, unknown>): Promise<string[]> {
  const rows = await Emergency.find(filter).select('_id').lean();
  return rows.map((row) => row._id);
}

/**
 * Mongo filter for "every voice report this caller is allowed to know exists".
 * A role holding no read scope gets a sentinel that matches nothing, so the
 * filter can be composed without a second authorization branch in the route.
 */
export async function voiceReportScopeFilter(auth: AuthContext): Promise<Record<string, unknown>> {
  if (hasPermission(auth, 'voice:read:all')) return {};
  const clauses: Record<string, unknown>[] = [];

  if (hasPermission(auth, 'voice:read:own')) clauses.push({ ownerId: auth.userId });

  if (hasPermission(auth, 'voice:read:assigned')) {
    const ambulances = await crewAmbulances(auth, createVoiceScopeCache());
    const units = auth.ambulanceId ? [...new Set([...ambulances, auth.ambulanceId])] : ambulances;
    const assigned = await emergencyIds({
      $or: [{ assignedCrewIds: auth.userId }, { assignedAmbulance: { $in: units } }],
    });
    clauses.push({ emergencyId: { $in: assigned } });
  }

  if (hasPermission(auth, 'voice:read:hospital') && auth.hospitalId) {
    const incoming = await emergencyIds({ destinationHospital: auth.hospitalId });
    clauses.push(
      { hospitalId: auth.hospitalId },
      { 'hospitalRouting.hospitalId': auth.hospitalId },
      { emergencyId: { $in: incoming } },
    );
  }

  if (hasPermission(auth, 'voice:read:relevant')) {
    const live = await emergencyIds({ status: { $nin: [...TERMINAL_EMERGENCY_STATUSES] } });
    const handled = await emergencyIds({ assignedDispatcher: auth.userId });
    clauses.push(
      { status: { $in: [...OPERATIONAL_VOICE_STATUSES] } },
      { emergencyId: { $in: [...new Set([...live, ...handled])] } },
    );
  }

  if (hasPermission(auth, 'voice:read:historical')) {
    const closed = await emergencyIds({ status: { $in: [...TERMINAL_EMERGENCY_STATUSES] } });
    clauses.push(
      { status: { $in: [...HISTORICAL_VOICE_STATUSES] } },
      { emergencyId: { $in: closed } },
    );
  }

  // Analyst/auditor record access is limited to closed, confirmed records.
  if (hasPermission(auth, 'voice:read:analytical')) clauses.push({ status: 'CONFIRMED' });
  if (hasPermission(auth, 'voice:evidence:view')) clauses.push({ status: 'CONFIRMED' });

  return clauses.length ? { $or: clauses } : { _id: '__no_access__' };
}

export type VoiceListScope =
  | 'all' | 'active' | 'historical' | 'confirmed' | 'rejected' | 'own' | 'assigned' | 'hospital' | 'analytical' | 'evidence';

export interface VoiceListOptions {
  /** UI tab: narrows the caller's own scope — it can never widen it. */
  scope?: string;
  status?: string;
  emergencyId?: string;
  search?: string;
}

/** Scope filter + optional tab/status/emergency narrowing, ANDed together. */
export async function voiceReportListFilter(
  auth: AuthContext,
  options: VoiceListOptions = {},
): Promise<Record<string, unknown>> {
  const clauses: Record<string, unknown>[] = [await voiceReportScopeFilter(auth)];

  let narrowing: Record<string, unknown> | null = null;
  if (options.scope === 'active') {
    // "Active" means the live operation — open review queue *plus* confirmed
    // reports whose emergency is still running (non-terminal). A CONFIRMED
    // report tied to an ACKNOWLEDGED/DISPATCHED emergency is still
    // operational, not history.
    const live = await Emergency.distinct('_id', {
      status: { $nin: [...TERMINAL_EMERGENCY_STATUSES] },
    });
    narrowing = {
      $or: [
        { status: { $in: [...OPERATIONAL_VOICE_STATUSES] } },
        { emergencyId: { $in: live } },
      ],
    };
  } else if (options.scope === 'historical' || options.scope === 'history') {
    const closed = await Emergency.distinct('_id', {
      status: { $in: [...TERMINAL_EMERGENCY_STATUSES] },
    });
    narrowing = {
      $or: [
        { status: { $in: [...HISTORICAL_VOICE_STATUSES] } },
        { emergencyId: { $in: closed } },
      ],
    };
  } else if (options.scope === 'confirmed') {
    narrowing = { status: 'CONFIRMED' };
  } else if (options.scope === 'rejected') {
    narrowing = { status: 'REJECTED' };
  } else if (options.scope === 'own') {
    narrowing = { ownerId: auth.userId };
  } else if (options.scope === 'analytical' || options.scope === 'evidence') {
    narrowing = { status: 'CONFIRMED' };
  }
  if (narrowing) clauses.push(narrowing);

  if (options.status && (VOICE_REPORT_STATUSES as readonly string[]).includes(options.status)) {
    clauses.push({ status: options.status });
  }
  if (options.emergencyId) clauses.push({ emergencyId: options.emergencyId });
  if (options.search) clauses.push({ _id: new RegExp(`^${escapeRegExp(options.search)}`, 'i') });

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}




