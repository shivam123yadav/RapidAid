import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmergencyDetailPage } from './Emergencies';
import { useAuthStore } from '../stores/auth';
import { api } from '../api/client';
import type { Emergency } from '../types';

describe('EmergencyDetailPage assignment data consistency', () => {
  let queryClient: QueryClient;

  const mockReportedEmergency: Emergency = {
    id: 'EMG-20485',
    status: 'REPORTED',
    priority: 'HIGH',
    incidentType: 'VEHICLE_COLLISION',
    location: { lat: 28.62, lng: 77.214, address: 'Test Location' },
    source: 'CITIZEN_REPORT',
    description: 'Car crash',
    victimCount: 1,
    reportedAt: '2026-01-15T08:00:00.000Z',
    updatedAt: '2026-01-15T08:00:00.000Z',
    timeline: [
      { status: 'REPORTED', timestamp: '2026-01-15T08:00:00.000Z', note: 'Reported' },
    ],
  };

  const mockAssignedEmergency: Emergency = {
    ...mockReportedEmergency,
    status: 'AMBULANCE_ASSIGNED',
    assignedAmbulance: 'AMB-031',
    assignedCrew: ['Dr. Nair', 'EMT Das'],
    updatedAt: '2026-01-15T08:05:00.000Z',
    timeline: [
      { status: 'REPORTED', timestamp: '2026-01-15T08:00:00.000Z', note: 'Reported' },
      { status: 'AMBULANCE_ASSIGNED', timestamp: '2026-01-15T08:05:00.000Z', note: 'AMB-031 assigned' },
    ],
  };

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    useAuthStore.setState({
      isAuthenticated: true,
      user: {
        id: 'USR-001',
        name: 'Authorized Dispatcher',
        email: 'dispatcher@rapidaid.com',
        role: 'DISPATCHER',
        permissions: ['emergency:read:all', 'emergency:override', 'dispatch:assign'],
      },
    });
  });

  it('renders updated status, assigned ambulance, crew, and timeline when assigned', async () => {
    vi.spyOn(api.emergencies, 'getById').mockResolvedValue(mockAssignedEmergency);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/emergencies/EMG-20485']}>
          <Routes>
            <Route path="/emergencies/:id" element={<EmergencyDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('EMG-20485')).toBeInTheDocument();
    });

    // Header & badge & timeline
    expect(screen.getAllByText('AMBULANCE ASSIGNED').length).toBeGreaterThanOrEqual(1);

    // Incident details ambulance field
    expect(screen.getByText('AMB-031')).toBeInTheDocument();

    // Assigned crew
    expect(screen.getByText('Dr. Nair')).toBeInTheDocument();
    expect(screen.getByText('EMT Das')).toBeInTheDocument();

    // Timeline milestone note
    expect(screen.getByText(/AMB-031 assigned/)).toBeInTheDocument();
  });

  it('synchronizes cache immediately after assignment and on refetch', async () => {
    const getByIdSpy = vi.spyOn(api.emergencies, 'getById').mockResolvedValue(mockReportedEmergency);

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/emergencies/EMG-20485']}>
          <Routes>
            <Route path="/emergencies/:id" element={<EmergencyDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('EMG-20485')).toBeInTheDocument();
    });
    expect(screen.getAllByText('REPORTED').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('No crew assigned yet.')).toBeInTheDocument();

    // Simulate assignment mutation completing and invalidating / updating cache
    getByIdSpy.mockResolvedValue(mockAssignedEmergency);
    queryClient.setQueryData(['emergency', 'EMG-20485'], mockAssignedEmergency);
    await queryClient.invalidateQueries({ queryKey: ['emergency', 'EMG-20485'] });

    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/emergencies/EMG-20485']}>
          <Routes>
            <Route path="/emergencies/:id" element={<EmergencyDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByText('AMBULANCE ASSIGNED').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText('AMB-031')).toBeInTheDocument();
    expect(screen.getByText('Dr. Nair')).toBeInTheDocument();
    expect(screen.getByText('EMT Das')).toBeInTheDocument();
  });
});
