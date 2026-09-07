import { delay } from '../lib/utils';
import { mockEmergencies, mockAmbulances, mockHospitals, mockDetections, mockNotifications, mockAuditEntries, mockSystemHealth, mockAnalytics, mockDispatchRecommendations, mockHospitalRecommendations, mockVoiceReport, mockGreenCorridor } from '../mocks/data';
import type { Emergency, Ambulance, Hospital, AIDetection, Notification, AuditEntry, SystemHealth, AnalyticsData, DispatchRecommendation, HospitalRecommendation, VoiceReport, GreenCorridorSimulation } from '../types';

const SIMULATED_LATENCY = 300;

async function simulate<T>(data: T): Promise<T> {
  await delay(SIMULATED_LATENCY);
  return data;
}

export const api = {
  emergencies: {
    list: async (): Promise<Emergency[]> => simulate([...mockEmergencies]),
    getById: async (id: string): Promise<Emergency> => {
      const emg = mockEmergencies.find(e => e.id === id);
      if (!emg) throw new Error(`Emergency ${id} not found`);
      return simulate(emg);
    },
    create: async (data: Partial<Emergency>): Promise<Emergency> => simulate({ ...mockEmergencies[0], ...data, id: `EMG-${Math.floor(20500 + Math.random() * 1000)}` }),
    updateStatus: async (id: string, status: Emergency['status']): Promise<Emergency> => {
      const emg = mockEmergencies.find(e => e.id === id);
      if (!emg) throw new Error(`Emergency ${id} not found`);
      return simulate({ ...emg, status, updatedAt: new Date().toISOString() });
    },
  },
  ambulances: {
    list: async (): Promise<Ambulance[]> => simulate([...mockAmbulances]),
    getById: async (id: string): Promise<Ambulance> => {
      const amb = mockAmbulances.find(a => a.id === id);
      if (!amb) throw new Error(`Ambulance ${id} not found`);
      return simulate(amb);
    },
  },
  hospitals: {
    list: async (): Promise<Hospital[]> => simulate([...mockHospitals]),
    getById: async (id: string): Promise<Hospital> => {
      const hosp = mockHospitals.find(h => h.id === id);
      if (!hosp) throw new Error(`Hospital ${id} not found`);
      return simulate(hosp);
    },
  },
  vision: {
    detections: async (): Promise<AIDetection[]> => simulate([...mockDetections]),
    review: async (id: string, status: AIDetection['status']): Promise<AIDetection> => {
      const det = mockDetections.find(d => d.id === id);
      if (!det) throw new Error(`Detection ${id} not found`);
      return simulate({ ...det, status });
    },
  },
  dispatch: {
    getRecommendations: async (emergencyId: string): Promise<DispatchRecommendation[]> => simulate([...mockDispatchRecommendations]),
    getHospitalRecommendations: async (emergencyId: string): Promise<HospitalRecommendation[]> => simulate([...mockHospitalRecommendations]),
    assign: async (emergencyId: string, ambulanceId: string): Promise<{ success: boolean }> => simulate({ success: true }),
  },
  notifications: {
    list: async (): Promise<Notification[]> => simulate([...mockNotifications]),
    markRead: async (id: string): Promise<void> => simulate(undefined),
  },
  audit: {
    list: async (): Promise<AuditEntry[]> => simulate([...mockAuditEntries]),
  },
  system: {
    health: async (): Promise<SystemHealth[]> => simulate([...mockSystemHealth]),
  },
  analytics: {
    getData: async (): Promise<AnalyticsData> => simulate({ ...mockAnalytics }),
  },
  voice: {
    getCurrentReport: async (): Promise<VoiceReport> => simulate({ ...mockVoiceReport }),
  },
  simulations: {
    getGreenCorridor: async (emergencyId: string): Promise<GreenCorridorSimulation> => simulate({ ...mockGreenCorridor, emergencyId }),
  },
};
