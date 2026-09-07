export type UserRole = 'CITIZEN' | 'AMBULANCE_CREW' | 'DISPATCHER' | 'HOSPITAL_STAFF' | 'SUPERVISOR' | 'ANALYST' | 'AUDITOR' | 'ADMIN';

export type EmergencyStatus = 'REPORTED' | 'TRIAGED' | 'DISPATCHING' | 'AMBULANCE_ASSIGNED' | 'EN_ROUTE' | 'AT_SCENE' | 'PATIENT_ONBOARD' | 'EN_ROUTE_TO_HOSPITAL' | 'AT_HOSPITAL' | 'COMPLETED' | 'CANCELLED';

export type EmergencyPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type IncidentType = 'VEHICLE_COLLISION' | 'MEDICAL_EMERGENCY' | 'FALL_INJURY' | 'CARDIAC_ARREST' | 'BURN' | 'DROWNING' | 'FIRE' | 'STRUCTURAL_COLLAPSE' | 'OTHER';

export type AmbulanceStatus = 'AVAILABLE' | 'RESERVED' | 'ASSIGNED' | 'EN_ROUTE' | 'AT_SCENE' | 'TRANSPORTING' | 'AT_HOSPITAL' | 'MAINTENANCE' | 'OFFLINE';

export type HospitalStatus = 'OPERATIONAL' | 'DEGRADED' | 'OFFLINE';

export type CapacityStatus = 'AVAILABLE' | 'LIMITED' | 'FULL';

export type SystemStatus = 'OPERATIONAL' | 'DEGRADED' | 'OFFLINE';

export type NotificationCategory = 'CRITICAL' | 'WARNING' | 'INFO' | 'SUCCESS';

export type DetectionStatus = 'PENDING_REVIEW' | 'CONFIRMED' | 'REJECTED' | 'CONVERTED_TO_INCIDENT';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface GeoLocation {
  lat: number;
  lng: number;
  address?: string;
}

export interface Emergency {
  id: string;
  status: EmergencyStatus;
  priority: EmergencyPriority;
  incidentType: IncidentType;
  location: GeoLocation;
  source: 'CITIZEN_REPORT' | 'AI_VISION' | 'VOICE_REPORT' | 'DISPATCHER';
  description: string;
  victimCount: number;
  reportedAt: string;
  updatedAt: string;
  assignedAmbulance?: string;
  assignedCrew?: string[];
  destinationHospital?: string;
  eta?: number;
  timeline: TimelineEntry[];
  aiRecommendations?: AIRecommendation;
}

export interface TimelineEntry {
  status: EmergencyStatus;
  timestamp: string;
  note?: string;
}

export interface AIRecommendation {
  ambulanceId?: string;
  ambulanceScore?: number;
  hospitalId?: string;
  hospitalScore?: number;
  reasoning: string[];
}

export interface Ambulance {
  id: string;
  status: AmbulanceStatus;
  location: GeoLocation;
  speed: number;
  heading: number;
  crew: CrewMember[];
  capabilities: string[];
  equipment: string[];
  currentEmergency?: string;
  destinationHospital?: string;
  eta?: number;
  lastUpdated: string;
}

export interface CrewMember {
  id: string;
  name: string;
  role: string;
  certification: string[];
}

export interface Hospital {
  id: string;
  name: string;
  status: HospitalStatus;
  location: GeoLocation;
  emergencyCapacity: CapacityStatus;
  icuCapacity: CapacityStatus;
  traumaAvailable: boolean;
  capabilities: string[];
  incomingAmbulances: number;
  currentLoad: number;
  phone: string;
}

export interface AIDetection {
  id: string;
  cameraId: string;
  cameraLocation: GeoLocation;
  detectedEvent: string;
  confidence: number;
  status: DetectionStatus;
  timestamp: string;
  modelName: string;
  modelVersion: string;
  boundingBoxes: BoundingBox[];
  reviewedBy?: string;
}

export interface BoundingBox {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface DispatchRecommendation {
  ambulanceId: string;
  score: number;
  eta: number;
  distance: number;
  capabilities: string[];
  reasons: string[];
}

export interface HospitalRecommendation {
  hospitalId: string;
  score: number;
  eta: number;
  distance: number;
  emergencyCapacity: CapacityStatus;
  icuCapacity: CapacityStatus;
  traumaAvailable: boolean;
  reasons: string[];
}

export interface Notification {
  id: string;
  category: NotificationCategory;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  linkedEmergency?: string;
  linkedResource?: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  actorRole: UserRole;
  action: string;
  resource: string;
  resourceId: string;
  timestamp: string;
  requestId: string;
  details?: string;
}

export interface SystemHealth {
  service: string;
  status: SystemStatus;
  latency?: number;
  lastChecked: string;
  details?: string;
}

export interface AnalyticsData {
  emergencyVolume: { date: string; count: number }[];
  responseTimes: { date: string; median: number; p90: number }[];
  incidentTypes: { type: string; count: number }[];
  ambulanceUtilization: { date: string; utilization: number }[];
  hospitalLoad: { hospital: string; load: number }[];
}

export interface GreenCorridorSimulation {
  emergencyId: string;
  route: GeoLocation[];
  baselineETA: number;
  simulatedETA: number;
  timeSaved: number;
  signalsAffected: number;
  status: 'IDLE' | 'SIMULATING' | 'COMPLETE';
}

export interface VoiceReport {
  id: string;
  transcript: string;
  extractedData: {
    incidentType?: IncidentType;
    location?: string;
    victimCount?: number;
    description?: string;
  };
  confidence: number;
  status: 'RECORDING' | 'PROCESSING' | 'DRAFT' | 'CONFIRMED';
}
