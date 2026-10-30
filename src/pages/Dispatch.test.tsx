import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DispatchPage } from './Dispatch';
import { useAuthStore } from '../stores/auth';
import { api } from '../api/client';
import type { Emergency, DispatchRecommendation, HospitalRecommendation } from '../types';

describe('DispatchPage dynamic incident selection and recommendations', () => {
  let queryClient: QueryClient;

  const mockAssignedEnRouteEmergency: Emergency = {
    id: 'EMG-20481',
    status: 'EN_ROUTE',
    priority: 'CRITICAL',
    incidentType: 'CARDIAC_ARREST',
    location: { lat: 28.6139, lng: 77.209, address: 'Connaught Place, New Delhi' },
    source: 'CITIZEN_REPORT',
    description: 'Patient unresponsive',
    victimCount: 1,
    reportedAt: '2026-10-30T06:00:00.000Z',
    updatedAt: '2026-10-30T06:10:00.000Z',
    assignedAmbulance: 'AMB-017',
    assignedCrew: ['EMT Roy'],
    timeline: [
      { status: 'REPORTED', timestamp: '2026-10-30T06:00:00.000Z' },
      { status: 'EN_ROUTE', timestamp: '2026-10-30T06:05:00.000Z' },
    ],
  };

  const mockUnassignedEmergency1: Emergency = {
    id: 'EMG-20485',
    status: 'REPORTED',
    priority: 'HIGH',
    incidentType: 'VEHICLE_COLLISION',
    location: { lat: 28.62, lng: 77.214, address: 'Barakhamba Road' },
    source: 'CITIZEN_REPORT',
    description: 'Two cars collided',
    victimCount: 2,
    reportedAt: '2026-10-30T06:20:00.000Z',
    updatedAt: '2026-10-30T06:20:00.000Z',
    timeline: [{ status: 'REPORTED', timestamp: '2026-10-30T06:20:00.000Z' }],
  };

  const mockUnassignedEmergency2: Emergency = {
    id: 'EMG-20486',
    status: 'TRIAGED',
    priority: 'MEDIUM',
    incidentType: 'RESPIRATORY_DISTRESS',
    location: { lat: 28.63, lng: 77.22, address: 'Mandi House' },
    source: 'CITIZEN_REPORT',
    description: 'Asthma attack',
    victimCount: 1,
    reportedAt: '2026-10-30T06:15:00.000Z',
    updatedAt: '2026-10-30T06:18:00.000Z',
    timeline: [{ status: 'REPORTED', timestamp: '2026-10-30T06:15:00.000Z' }],
  };

  const mockCompletedEmergency: Emergency = {
    id: 'EMG-20480',
    status: 'COMPLETED',
    priority: 'LOW',
    incidentType: 'FALL_INJURY',
    location: { lat: 28.60, lng: 77.20, address: 'India Gate' },
    source: 'CITIZEN_REPORT',
    description: 'Minor fall',
    victimCount: 1,
    reportedAt: '2026-10-30T05:00:00.000Z',
    updatedAt: '2026-10-30T05:45:00.000Z',
    assignedAmbulance: 'AMB-010',
    timeline: [{ status: 'COMPLETED', timestamp: '2026-10-30T05:45:00.000Z' }],
  };

  const mockRecommendationsEMG20485: DispatchRecommendation[] = [
    {
      ambulanceId: 'AMB-031',
      score: 95,
      eta: 240,
      distance: 1800,
      capabilities: ['ALS', 'TRAUMA'],
      reasons: ['Closest available ALS unit', 'Optimal crew on duty'],
    },
    {
      ambulanceId: 'AMB-022',
      score: 82,
      eta: 420,
      distance: 3100,
      capabilities: ['BLS'],
      reasons: ['Secondary candidate'],
    },
  ];

  const mockHospitalRecommendations: HospitalRecommendation[] = [
    {
      hospitalId: 'HOSP-001',
      score: 92,
      eta: 360,
      distance: 2400,
      traumaAvailable: true,
      emergencyCapacity: 'AVAILABLE',
      icuCapacity: 'AVAILABLE',
      reasons: ['Level 1 trauma ready', 'High ED capacity'],
    },
  ];

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
        name: 'Lead Dispatcher',
        email: 'dispatcher@rapidaid.com',
        role: 'DISPATCHER',
        permissions: ['dispatch-intel:view', 'dispatch:assign', 'emergency:read:all'],
      },
    });
  });

  it('prefers unassigned active incidents eligible for dispatch without automatically mutating or assigning', async () => {
    const listSpy = vi.spyOn(api.emergencies, 'list').mockResolvedValue([
      mockCompletedEmergency,
      mockAssignedEnRouteEmergency,
      mockUnassignedEmergency1, // Newest unassigned: reported at 06:20
      mockUnassignedEmergency2, // Older unassigned: reported at 06:15
    ]);
    const recsSpy = vi.spyOn(api.dispatch, 'getRecommendations').mockResolvedValue(mockRecommendationsEMG20485);
    const hospSpy = vi.spyOn(api.dispatch, 'getHospitalRecommendations').mockResolvedValue(mockHospitalRecommendations);
    const assignSpy = vi.spyOn(api.dispatch, 'assign');

    render(
      <QueryClientProvider client={queryClient}>
        <DispatchPage />
      </QueryClientProvider>,
    );

    // Initial selected incident should automatically be the unassigned active incident EMG-20485
    await waitFor(() => {
      expect(screen.getByText('AMB-031')).toBeInTheDocument();
    });

    expect(listSpy).toHaveBeenCalledTimes(1);
    // Recommendations fetched for EMG-20485
    expect(recsSpy).toHaveBeenCalledWith('EMG-20485');
    expect(hospSpy).toHaveBeenCalledWith('EMG-20485');

    // Crucial requirement 3: Incident must NOT be automatically assigned or mutated
    expect(assignSpy).not.toHaveBeenCalled();

    // Incident details displayed with ID, status, and assignment state
    expect(screen.getAllByText(/EMG-20485/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/REPORTED/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Unassigned/).length).toBeGreaterThanOrEqual(1);

    // Dry-run / advisory disclaimer is preserved
    expect(screen.getByText(/Recommendation is not assignment/)).toBeInTheDocument();

    // Top recommended candidate displayed with score and details
    expect(screen.getByText('95')).toBeInTheDocument();
    expect(screen.getByText('Closest available ALS unit')).toBeInTheDocument();
    expect(screen.getByText('HOSP-001')).toBeInTheDocument();
  });

  it('clearly displays advisory state and empty recommendations when an EN_ROUTE / assigned incident is selected', async () => {
    vi.spyOn(api.emergencies, 'list').mockResolvedValue([mockAssignedEnRouteEmergency]);
    // For EMG-20481, empty recommendations are expected
    vi.spyOn(api.dispatch, 'getRecommendations').mockResolvedValue([]);
    vi.spyOn(api.dispatch, 'getHospitalRecommendations').mockResolvedValue(mockHospitalRecommendations);

    render(
      <QueryClientProvider client={queryClient}>
        <DispatchPage />
      </QueryClientProvider>,
    );

    // Wait for the incident to load
    await waitFor(() => {
      expect(screen.getAllByText(/EMG-20481/).length).toBeGreaterThanOrEqual(1);
    });

    // Advisory notice for incident already EN_ROUTE with AMB-017 assigned
    expect(screen.getByRole('status')).toHaveTextContent(/Incident EMG-20481 is already EN ROUTE with AMB-017 assigned/);
    expect(
      screen.getByText(/Recommendations are displayed for advisory reassessment only/),
    ).toBeInTheDocument();

    // Empty state description when recommendations resolve
    await waitFor(() => {
      expect(
        screen.getByText('The dispatch endpoint returned no candidates for this incident.'),
      ).toBeInTheDocument();
    });

    // Hospital recommendations remain available
    expect(screen.getByText('HOSP-001')).toBeInTheDocument();
  });

  it('allows selecting another incident and refreshes recommendations', async () => {
    vi.spyOn(api.emergencies, 'list').mockResolvedValue([
      mockUnassignedEmergency1,
      mockAssignedEnRouteEmergency,
    ]);

    const recsSpy = vi.spyOn(api.dispatch, 'getRecommendations').mockImplementation(async (id: string) => {
      if (id === 'EMG-20485') return mockRecommendationsEMG20485;
      if (id === 'EMG-20481') return [];
      return [];
    });

    const hospSpy = vi.spyOn(api.dispatch, 'getHospitalRecommendations').mockResolvedValue(mockHospitalRecommendations);

    render(
      <QueryClientProvider client={queryClient}>
        <DispatchPage />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('AMB-031')).toBeInTheDocument();
    });

    expect(recsSpy).toHaveBeenCalledWith('EMG-20485');

    // Open selector
    const trigger = screen.getByTestId('incident-selector');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    // Select EMG-20481
    const option = await screen.findByTestId('incident-option-EMG-20481');
    fireEvent.click(option);

    // Recommendations should refresh for EMG-20481
    await waitFor(() => {
      expect(recsSpy).toHaveBeenCalledWith('EMG-20481');
    });

    await waitFor(() => {
      expect(screen.getByText('No ambulance recommendations')).toBeInTheDocument();
    });

    // Advisory notice appears for EMG-20481
    expect(screen.getByRole('status')).toHaveTextContent(/Incident EMG-20481 is already EN ROUTE/);
  });

  it('refreshes recommendations when clicking the Refresh button', async () => {
    vi.spyOn(api.emergencies, 'list').mockResolvedValue([mockUnassignedEmergency1]);
    const recsSpy = vi.spyOn(api.dispatch, 'getRecommendations').mockResolvedValue(mockRecommendationsEMG20485);
    const hospSpy = vi.spyOn(api.dispatch, 'getHospitalRecommendations').mockResolvedValue(mockHospitalRecommendations);

    render(
      <QueryClientProvider client={queryClient}>
        <DispatchPage />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('AMB-031')).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole('button', { name: /Refresh recommendations/i });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(recsSpy).toHaveBeenCalledTimes(2);
      expect(hospSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('displays empty state when no emergencies exist in authorized scope', async () => {
    vi.spyOn(api.emergencies, 'list').mockResolvedValue([]);
    const recsSpy = vi.spyOn(api.dispatch, 'getRecommendations').mockResolvedValue([]);
    const hospSpy = vi.spyOn(api.dispatch, 'getHospitalRecommendations').mockResolvedValue([]);

    render(
      <QueryClientProvider client={queryClient}>
        <DispatchPage />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'No incidents available' })).toBeInTheDocument();
    });

    expect(recsSpy).not.toHaveBeenCalled();
    expect(hospSpy).not.toHaveBeenCalled();
  });

  it('allows explicit dispatch assignment when user has dispatch:assign permission', async () => {
    vi.spyOn(api.emergencies, 'list').mockResolvedValue([mockUnassignedEmergency1]);
    vi.spyOn(api.dispatch, 'getRecommendations').mockResolvedValue(mockRecommendationsEMG20485);
    vi.spyOn(api.dispatch, 'getHospitalRecommendations').mockResolvedValue(mockHospitalRecommendations);
    const assignSpy = vi.spyOn(api.dispatch, 'assign').mockResolvedValue({
      success: true,
      emergencyId: 'EMG-20485',
      ambulanceId: 'AMB-031',
      emergency: {
        ...mockUnassignedEmergency1,
        status: 'AMBULANCE_ASSIGNED',
        assignedAmbulance: 'AMB-031',
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <DispatchPage />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Assign AMB-031')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Assign AMB-031'));

    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledWith('EMG-20485', 'AMB-031');
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/AMB-031 assigned to EMG-20485/);
    });
  });

  it('hides assign button when user lacks dispatch:assign permission (RBAC enforcement)', async () => {
    useAuthStore.setState({
      isAuthenticated: true,
      user: {
        id: 'USR-002',
        name: 'Auditor View Only',
        email: 'auditor@rapidaid.com',
        role: 'AUDITOR',
        permissions: ['dispatch-intel:view', 'emergency:read:all'],
      },
    });

    vi.spyOn(api.emergencies, 'list').mockResolvedValue([mockUnassignedEmergency1]);
    vi.spyOn(api.dispatch, 'getRecommendations').mockResolvedValue(mockRecommendationsEMG20485);
    vi.spyOn(api.dispatch, 'getHospitalRecommendations').mockResolvedValue(mockHospitalRecommendations);

    render(
      <QueryClientProvider client={queryClient}>
        <DispatchPage />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('AMB-031')).toBeInTheDocument();
    });

    // Recommendations are visible, but Assign button is hidden due to RBAC
    expect(screen.queryByText('Assign AMB-031')).not.toBeInTheDocument();
  });
});
