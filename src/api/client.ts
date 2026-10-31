import type {
  Emergency,
  Ambulance,
  Hospital,
  AIDetection,
  Notification,
  AuditEntry,
  SystemHealth,
  AnalyticsData,
  DispatchRecommendation,
  HospitalRecommendation,
  VoiceReport,
  VoiceReportSummary,
  VoiceReportDetail,
  VoiceReportTranscript,
  VoiceAccessHistory,
  VoiceRecordingResult,
  VoiceHospitalSelection,
  VoiceLocation,
  VoiceExtractedInformation,
  GreenCorridorSimulation,
  UserRole,
  CreateEmergencyRequest,
  CreateAmbulanceRequest,
  UpdateAmbulanceRequest,
  CrewMemberInput,
  AmbulanceAvailability,
  Camera,
  Shift,
  ShiftStatus,
  MaintenanceRequest,
  MaintenanceSeverity,
  MaintenanceStatus,
  ReportRecord,
  CreateReportRequest,
  ReportExportResponse,
} from '../types';
import { session } from './session';

/**
 * HTTP client for the RapidAid API. The exported `api` object keeps the
 * exact shape the pages already consume (mocks were swapped 1:1), plus an
 * `auth` namespace used by the zustand auth store.
 *
 * Contract:
 *  - JSON in / JSON out, `credentials: 'include'` for the refresh cookie
 *  - Authorization: Bearer <accessToken> when present
 *  - one transparent 401 → refresh → retry (single-flight in session.ts)
 *  - failures throw ApiError carrying the server's { message, code, requestId }
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorEnvelope {
  error?: { message?: string; code?: string; requestId?: string; details?: unknown };
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  // FormData must NOT get an explicit Content-Type: the browser has to append
  // the multipart boundary itself, and hand-setting the header (the classic
  // `multipart/form-data` mistake) produces a body the server cannot parse.
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
  if (init.body && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');
  const token = session.getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${session.apiBase}${path}`, { ...init, headers, credentials: 'include' });
  } catch {
    throw new ApiError('Cannot reach the RapidAid API — is the server running?', 0, 'NETWORK');
  }

  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    const fresh = await session.refresh();
    if (fresh) return request<T>(path, init, false);
    session.setAccessToken(null);
    session.onSessionExpired();
    throw new ApiError('Your session has expired. Please sign in again.', 401, 'UNAUTHORIZED');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON response falls through to status handling */
    }
  }

  if (!res.ok) {
    const envelope = (body ?? {}) as ErrorEnvelope;
    const retryHeader = res.headers.get('retry-after');
    const headerRetryAfter = retryHeader ? parseInt(retryHeader, 10) : undefined;
    const details = envelope.error?.details ?? (headerRetryAfter ? { retryAfter: headerRetryAfter } : undefined);

    throw new ApiError(
      envelope.error?.message ?? `Request failed (${res.status})`,
      res.status,
      envelope.error?.code,
      envelope.error?.requestId ?? res.headers.get('x-request-id') ?? undefined,
      details,
    );
  }

  return body as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) });
const del = <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) });

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatar?: string;
  hospitalId?: string | null;
  ambulanceId?: string | null;
  organizationId?: string | null;
  /**
   * Whether the person has confirmed control of this mailbox. Emitted by
   * `toPublicUser` (server/src/services/tokenService.ts).
   *
   * Compared as `=== false` rather than truthiness by the reminder banner:
   * sessions persisted before this field existed deserialize with `undefined`,
   * and `!undefined` would otherwise nag every signed-in demo user.
   */
  emailVerified?: boolean;
  /**
   * Effective permission set for this role, emitted by the server from its RBAC
   * registry (`server/src/authz/permissions.ts`). The client renders navigation
   * and action buttons from this list instead of keeping a second copy of the
   * matrix, so the two cannot drift. The API still re-checks every rule.
   */
  permissions: string[];
}

export interface PermissionMatrix {
  catalog: string[];
  roles: Record<UserRole, string[]>;
  revisions: Record<UserRole, number>;
}
export interface PermissionUpdateResponse {
  role: UserRole;
  permissions: string[];
  revision: number;
  updatedAt: string;
}
export interface AdminUser {
  /** Server id (USR-001), not the Mongoose `_id` — see adminUserView in admin.routes.ts. */
  id: string;
  name: string;
  email: string;
  role: UserRole;
  hospitalId?: string | null;
  ambulanceId?: string | null;
  organizationId?: string | null;
  active: boolean;
  /**
   * Admin-created accounts are verified at creation (the admin vouches for the
   * person), so this is effectively always true except for citizens who
   * self-registered and have not yet followed their link.
   */
  emailVerified?: boolean;
}


export interface PaginationParams {
  limit?: number;
  skip?: number;
}

function parsePaginationQuery(params?: PaginationParams | unknown): string {
  if (!params || typeof params !== 'object' || 'queryKey' in params) return '';
  const p = params as PaginationParams;
  const query = new URLSearchParams();
  if (p.limit !== undefined) query.set('limit', String(p.limit));
  if (p.skip !== undefined) query.set('skip', String(p.skip));
  return query.size ? `?${query.toString()}` : '';
}

export const api = {
  auth: {
    login: (email: string, password: string, role: UserRole) =>
      post<{ user: PublicUser; accessToken: string }>('/auth/login', { email, password, role }),
    register: (data: { name: string; email: string; password: string; role: UserRole }) =>
      post<{ user: PublicUser; accessToken: string; emailDelivery?: 'sent' | 'failed' }>('/auth/register', data),
    verifyEmail: (token: string) =>
      post<{ success: boolean; emailVerified: boolean }>('/auth/verify-email', { token }),
    resendVerification: () =>
      post<{ success: boolean; message: string; delivered?: boolean }>('/auth/resend-verification'),
    forgotPassword: (email: string) =>
      post<{ success: boolean; message: string }>('/auth/forgot-password', { email }),
    resetPassword: (token: string, password: string) =>
      post<{ success: boolean }>('/auth/reset-password', { token, password }),
    me: () => get<PublicUser>('/auth/me'),
    logout: () => post<{ success: boolean }>('/auth/logout'),
  },
  emergencies: {
    list: (): Promise<Emergency[]> => get<Emergency[]>('/emergencies'),
    getById: (id: string): Promise<Emergency> => get<Emergency>(`/emergencies/${id}`),
    create: (data: CreateEmergencyRequest, idempotencyKey?: string): Promise<Emergency> =>
      post<Emergency>(
        '/emergencies',
        data,
        idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      ),
    updateStatus: (id: string, status: Emergency['status'], note?: string): Promise<Emergency> =>
      patch<Emergency>(`/emergencies/${id}/status`, { status, note }),
    override: (id: string, data: { action: 'REASSIGN_AMBULANCE' | 'ESCALATE' | 'ROUTE_HOSPITAL' | 'ACTIVATE_GREEN_CORRIDOR'; reason: string; ambulanceId?: string; hospitalId?: string; priority?: Emergency['priority'] }): Promise<{ success: boolean; emergency: Emergency; resourceId: string }> =>
      post(`/emergencies/${id}/override`, data),
  },
  ambulances: {
    list: (params?: PaginationParams | unknown): Promise<Ambulance[]> =>
      get<Ambulance[]>(`/ambulances${parsePaginationQuery(params)}`),
    getById: (id: string): Promise<Ambulance> => get<Ambulance>(`/ambulances/${id}`),
    getRoute: (
      id: string,
    ): Promise<{ ambulanceId: string; activeRoute: import('../types').ActiveRoute | null; eta: number | null; lastUpdated?: string }> =>
      get(`/ambulances/${id}/route`),

    updateTelemetry: (
      id: string,
      data: {
        status?: Ambulance['status'];
        location?: { lat: number; lng: number };
        speed?: number;
        heading?: number;
        eta?: number;
      },
    ): Promise<Ambulance> => patch<Ambulance>(`/ambulances/${id}/telemetry`, data),
    /** ADMIN / SUPERVISOR only. */
    create: (data: CreateAmbulanceRequest): Promise<Ambulance> => post<Ambulance>('/ambulances', data),
    /** ADMIN / SUPERVISOR only. */
    update: (id: string, data: UpdateAmbulanceRequest): Promise<Ambulance> =>
      patch<Ambulance>(`/ambulances/${id}`, data),
    /** ADMIN / SUPERVISOR only — binding a seat to a login grants unit access. */
    assignCrew: (id: string, crew: CrewMemberInput[]): Promise<Ambulance> =>
      patch<Ambulance>(`/ambulances/${id}/crew`, { crew }),
    /** ADMIN / SUPERVISOR / DISPATCHER — availability tracking only. */
    setAvailability: (id: string, status: AmbulanceAvailability): Promise<Ambulance> =>
      patch<Ambulance>(`/ambulances/${id}/status`, { status }),
    /**
     * ADMIN only — retire a unit from the fleet. Soft-deletes by default
     * (`active: false`), because emergency timelines and audit records still
     * reference the id; `purge` hard-deletes records created in error.
     */
    deactivate: (id: string, purge = false): Promise<{ success: boolean; id: string; active: false }> =>
      del(`/ambulances/${id}${purge ? '?purge=true' : ''}`),
  },
  hospitals: {
    list: (params?: PaginationParams | unknown): Promise<Hospital[]> =>
      get<Hospital[]>(`/hospitals${parsePaginationQuery(params)}`),
    getById: (id: string): Promise<Hospital> => get<Hospital>(`/hospitals/${id}`),
    create: (data: Record<string, unknown>): Promise<Hospital> => post<Hospital>('/hospitals', data),
    update: (id: string, data: Record<string, unknown>): Promise<Hospital> => patch<Hospital>(`/hospitals/${id}`, data),
    updateCapacity: (id: string, data: Record<string, unknown>): Promise<Hospital> => patch<Hospital>(`/hospitals/${id}/capacity`, data),
    deactivate: (id: string, reason: string): Promise<{ success: boolean; id: string; active: false }> => del(`/hospitals/${id}`, { reason }),
    reserve: (
      hospitalId: string,
      emergencyId: string,
      resourceType: 'EMERGENCY_ACCEPTANCE' | 'ICU_BED' | 'GENERAL_BED' | 'TRAUMA_BAY' = 'EMERGENCY_ACCEPTANCE',
      notes?: string,
    ): Promise<{ success: boolean; reservation: unknown }> =>
      post<{ success: boolean; reservation: unknown }>(`/hospitals/${hospitalId}/reserve`, {
        emergencyId,
        resourceType,
        notes,
      }),
  },
  vision: {
    detections: (params?: PaginationParams | unknown): Promise<AIDetection[]> =>
      get<AIDetection[]>(`/vision/detections${parsePaginationQuery(params)}`),
    review: (id: string, status: AIDetection['status']): Promise<AIDetection> =>
      patch<AIDetection>(`/vision/detections/${id}/status`, { status }),
  },
  dispatch: {
    getRecommendations: (emergencyId: string): Promise<DispatchRecommendation[]> =>
      get<DispatchRecommendation[]>(`/dispatch/recommendations/${emergencyId}`),
    getHospitalRecommendations: (emergencyId: string): Promise<HospitalRecommendation[]> =>
      get<HospitalRecommendation[]>(`/dispatch/hospital-recommendations/${emergencyId}`),
    assign: (emergencyId: string, ambulanceId: string) =>
      post<{ success: boolean; emergencyId: string; ambulanceId: string; emergency: Emergency }>(
        '/dispatch/assign',
        { emergencyId, ambulanceId },
      ),
    reserveHospital: (
      hospitalId: string,
      emergencyId: string,
      resourceType: 'EMERGENCY_ACCEPTANCE' | 'ICU_BED' | 'GENERAL_BED' | 'TRAUMA_BAY' = 'EMERGENCY_ACCEPTANCE',
      notes?: string,
    ) =>
      post<{ success: boolean; reservation: unknown }>(`/hospitals/${hospitalId}/reserve`, {
        emergencyId,
        resourceType,
        notes,
      }),
    dryRun: (emergencyId: string) =>
      post<any>(`/dispatch/dry-run/${emergencyId}`),
  },
  notifications: {
    list: (params?: PaginationParams | unknown): Promise<Notification[]> =>
      get<Notification[]>(`/notifications${parsePaginationQuery(params)}`),
    getUnreadCount: (): Promise<{ unreadCount: number }> =>
      get<{ unreadCount: number }>('/notifications/unread-count'),
    markRead: (id: string): Promise<Notification> => patch<Notification>(`/notifications/${id}/read`),
    markAllRead: (): Promise<{ success: boolean; modified: number }> =>
      patch<{ success: boolean; modified: number }>('/notifications/read-all'),
  },
  audit: {
    list: (): Promise<AuditEntry[]> => get<AuditEntry[]>('/audit'),
  },
  system: {
    health: (): Promise<SystemHealth[]> => get<SystemHealth[]>('/system/health'),
  },
  analytics: {
    getData: (): Promise<AnalyticsData> => get<AnalyticsData>('/analytics'),
  },
  voice: {
    getCurrentReport: (): Promise<VoiceReport> => get<VoiceReport>('/voice/reports/current'),
    /** Scoped workspace list: metadata-only rows with server capabilities. */
    listReports: (params?: { scope?: string; status?: string; emergencyId?: string; search?: string; limit?: number }): Promise<{ reports: VoiceReportSummary[]; count: number }> => {
      const query = new URLSearchParams();
      if (params?.scope) query.set('scope', params.scope);
      if (params?.status) query.set('status', params.status);
      if (params?.emergencyId) query.set('emergencyId', params.emergencyId);
      if (params?.search) query.set('search', params.search);
      if (params?.limit) query.set('limit', String(params.limit));
      const suffix = query.size ? `?${query.toString()}` : '';
      return get<{ reports: VoiceReportSummary[]; count: number }>(`/voice/reports${suffix}`);
    },
    getReport: (id: string): Promise<VoiceReportDetail> => get<VoiceReportDetail>(`/voice/reports/${id}`),
    getTranscript: (id: string): Promise<VoiceReportTranscript> =>
      get<VoiceReportTranscript>(`/voice/reports/${id}/transcript`),
    getAccessHistory: (id: string): Promise<VoiceAccessHistory> =>
      get<VoiceAccessHistory>(`/voice/reports/${id}/access-history`),
    downloadRecording: async (id: string, filename?: string): Promise<void> => {
      const token = session.getAccessToken();
      const res = await fetch(`${session.apiBase}/voice/reports/${id}/audio/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: 'include',
      });
      if (!res.ok) {
        let message = `Download failed (${res.status})`;
        try {
          const envelope = (await res.json()) as ErrorEnvelope;
          if (envelope.error?.message) message = envelope.error.message;
        } catch { /* keep the status fallback */ }
        throw new ApiError(message, res.status);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename ?? `voice-report-${id}.webm`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    submitTranscript: (transcript: string): Promise<VoiceReport> =>
      post<VoiceReport>('/voice/reports', { transcript }),
    /**
     * Uploads a recorded voice emergency and runs the whole pipeline:
     * store audio → transcribe → extract → geocode → nearest hospital →
     * create emergency → notify. `body` must be a `FormData` so the browser
     * sets the multipart boundary.
     */
    submitRecording: (body: FormData, idempotencyKey?: string): Promise<VoiceRecordingResult> =>
      request<VoiceRecordingResult>('/voice/reports/recording', {
        method: 'POST',
        body,
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      }),
    /** URL of the stored original recording (owner/voice:read:all only). */
    recordingAudioUrl: (reportId: string): string =>
      `${session.apiBase}/voice/reports/${reportId}/audio`,
    confirmReport: (id: string): Promise<{ report: VoiceReport; emergency: Emergency }> =>
      post<{ report: VoiceReport; emergency: Emergency }>(`/voice/reports/${id}/confirm`, {}),
    discardReport: (id: string): Promise<{ success: boolean }> =>
      del<{ success: boolean }>(`/voice/reports/${id}`),
    /** Rejects a draft; the report is retained as REJECTED evidence. */
    rejectReport: (id: string, reason: string): Promise<VoiceReportDetail> =>
      post<VoiceReportDetail>(`/voice/reports/${id}/reject`, { reason }),
    updateReport: (
      id: string,
      data: {
        transcript?: string;
        extractedData?: Partial<VoiceReport['extractedData']>;
      },
    ): Promise<VoiceReportDetail> =>
      patch<VoiceReportDetail>(`/voice/reports/${id}`, data),
  },
  simulations: {
    getGreenCorridor: (emergencyId: string): Promise<GreenCorridorSimulation> =>
      get<GreenCorridorSimulation>(`/simulations/green-corridor/${emergencyId}`),
    runGreenCorridor: (emergencyId: string): Promise<GreenCorridorSimulation> =>
      post<GreenCorridorSimulation>(`/simulations/green-corridor/${emergencyId}/run`),
  },
  cameras: {
    list: (): Promise<Camera[]> => get<Camera[]>('/cameras'),
    create: (data: { name: string; zone: string; location: { lat: number; lng: number; address?: string }; liveEnabled: boolean; recordingEnabled: boolean; retentionDays: number }): Promise<Camera> =>
      post<Camera>('/cameras', data),
    update: (id: string, data: Partial<Pick<Camera, 'name' | 'zone' | 'location' | 'status' | 'liveEnabled' | 'recordingEnabled' | 'retentionDays'>>): Promise<Camera> =>
      patch<Camera>(`/cameras/${id}`, data),
    exportEvidence: (id: string): Promise<{ camera: Camera; exportedAt: string; exportedBy: string }> =>
      get(`/cameras/${id}/evidence-export`),
  },
  shifts: {
    list: (): Promise<Shift[]> => get<Shift[]>('/shifts'),
    create: (data: { title: string; startsAt: string; endsAt: string; crewIds: string[]; ambulanceId?: string; notes?: string }): Promise<Shift> =>
      post<Shift>('/shifts', data),
    setStatus: (id: string, status: Extract<ShiftStatus, 'ACTIVE' | 'COMPLETED' | 'CANCELLED'>, note?: string): Promise<Shift> =>
      patch<Shift>(`/shifts/${id}/status`, { status, note }),
    reportUnavailable: (id: string, note: string): Promise<Shift> =>
      patch<Shift>(`/shifts/${id}/unavailable`, { note }),
  },
  maintenance: {
    list: (): Promise<MaintenanceRequest[]> => get<MaintenanceRequest[]>('/maintenance'),
    create: (data: { ambulanceId: string; title: string; description: string; severity: MaintenanceSeverity }): Promise<MaintenanceRequest> =>
      post<MaintenanceRequest>('/maintenance', data),
    update: (id: string, data: { status?: MaintenanceStatus; assignedTo?: string | null; resolution?: string }): Promise<MaintenanceRequest> =>
      patch<MaintenanceRequest>(`/maintenance/${id}`, data),
  },
  reports: {
    list: (): Promise<ReportRecord[]> => get<ReportRecord[]>('/reports'),
    create: (data: CreateReportRequest): Promise<ReportRecord> => post<ReportRecord>('/reports', data),
    export: (id: string): Promise<ReportExportResponse> => get<ReportExportResponse>(`/reports/${id}/export`),
    exportSensitive: (id: string): Promise<ReportExportResponse> => get<ReportExportResponse>(`/reports/${id}/sensitive-export`),
  },
  admin: {
    permissions: () => get<PermissionMatrix>('/admin/permissions'),
    updatePermissions: (role: UserRole, permissions: string[], revision?: number, reason?: string) =>
      request<PermissionUpdateResponse>(`/admin/permissions/${role}`, { method: 'PUT', body: JSON.stringify({ permissions, revision, reason }) }),
    users: () => get<AdminUser[]>('/admin/users'),
    createUser: (data: { name: string; email: string; password: string; role: UserRole; hospitalId?: string; ambulanceId?: string; organizationId?: string }) =>
      post<AdminUser>('/admin/users', data),
    updateUser: (id: string, data: { name?: string; role?: UserRole; active?: boolean; hospitalId?: string | null; ambulanceId?: string | null; organizationId?: string | null }) =>
      patch<AdminUser>(`/admin/users/${id}`, data),
  },
};

