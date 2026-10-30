import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TrackingPage, isValidCoordinate, computeEmergencyDisplayPositions } from './Tracking';
import { useAuthStore } from '../stores/auth';
import { api } from '../api/client';
import type { Ambulance, Emergency } from '../types';

describe('Tracking coordinate validation and position computation', () => {
  it('identifies valid coordinates and rejects invalid or missing locations', () => {
    // Valid numbers in range
    expect(isValidCoordinate({ lat: 28.6139, lng: 77.209 })).toBe(true);
    expect(isValidCoordinate({ lat: -90, lng: 180 })).toBe(true);
    expect(isValidCoordinate({ lat: 0, lng: 0 })).toBe(true);
    // Valid numeric strings
    expect(isValidCoordinate({ lat: '28.6139', lng: '77.209' })).toBe(true);

    // Missing or invalid
    expect(isValidCoordinate(undefined)).toBe(false);
    expect(isValidCoordinate(null)).toBe(false);
    expect(isValidCoordinate({})).toBe(false);
    expect(isValidCoordinate({ lat: 28.6139 })).toBe(false);
    expect(isValidCoordinate({ lng: 77.209 })).toBe(false);
    expect(isValidCoordinate({ lat: NaN, lng: 77.209 })).toBe(false);
    expect(isValidCoordinate({ lat: 'invalid', lng: 77.209 })).toBe(false);
    expect(isValidCoordinate({ lat: 91, lng: 77.209 })).toBe(false);
    expect(isValidCoordinate({ lat: -91, lng: 77.209 })).toBe(false);
    expect(isValidCoordinate({ lat: 28.6139, lng: 181 })).toBe(false);
  });

  it('keeps isolated incidents at exact reported coordinates', () => {
    const emergencies: Emergency[] = [
      {
        id: 'EMG-20482',
        status: 'AT_SCENE',
        priority: 'HIGH',
        incidentType: 'RESPIRATORY_DISTRESS',
        location: { lat: 28.628, lng: 77.2198, address: 'Kashmere Gate' },
        source: 'CITIZEN_REPORT',
        description: 'Breathing difficulty',
        victimCount: 1,
        reportedAt: '2026-01-15T08:30:00.000Z',
        updatedAt: '2026-01-15T08:35:00.000Z',
        timeline: [],
      },
    ];

    const positions = computeEmergencyDisplayPositions(emergencies);
    expect(positions.get('EMG-20482')).toEqual([28.628, 77.2198]);
  });

  it('disperses co-located incidents (EMG-20485 and EMG-20481) into distinct display positions', () => {
    const emergencies: Emergency[] = [
      {
        id: 'EMG-20481',
        status: 'EN_ROUTE',
        priority: 'CRITICAL',
        incidentType: 'VEHICLE_COLLISION',
        location: { lat: 28.6139, lng: 77.209, address: 'Connaught Place' },
        source: 'AI_VISION',
        description: 'Multi-vehicle collision',
        victimCount: 3,
        reportedAt: '2026-01-15T08:23:14.000Z',
        updatedAt: '2026-01-15T08:31:00.000Z',
        timeline: [],
        assignedAmbulance: 'AMB-017',
      },
      {
        id: 'EMG-20485',
        status: 'AMBULANCE_ASSIGNED',
        priority: 'MEDIUM',
        incidentType: 'MEDICAL_EMERGENCY',
        location: { lat: 28.6139, lng: 77.209 },
        source: 'DISPATCHER',
        description: 'Chest discomfort',
        victimCount: 1,
        reportedAt: '2026-10-28T16:43:30.306Z',
        updatedAt: '2026-10-28T17:59:30.346Z',
        timeline: [],
        assignedAmbulance: 'AMB-031',
      },
    ];

    const positions = computeEmergencyDisplayPositions(emergencies);
    const pos81 = positions.get('EMG-20481');
    const pos85 = positions.get('EMG-20485');

    expect(pos81).toBeDefined();
    expect(pos85).toBeDefined();
    expect(pos81).not.toEqual(pos85);

    // Verify distance between the two markers is significant (~70m, distinct pixels)
    const latDiff = Math.abs(pos81![0] - pos85![0]);
    const lngDiff = Math.abs(pos81![1] - pos85![1]);
    expect(latDiff + lngDiff).toBeGreaterThan(0.0004);
  });
});

describe('Live Tracking Page regression suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({
      isAuthenticated: true,
      user: {
        id: 'USR-001',
        name: 'Authorized Dispatcher',
        email: 'dispatcher@rapidaid.com',
        role: 'DISPATCHER',
        permissions: ['ambulance:read:all', 'emergency:read:all'],
      },
    });
  });

  it('renders newly created incident EMG-20485 as a distinct marker even when ambulance is assigned', async () => {
    const mockAmbulances: Ambulance[] = [
      {
        id: 'AMB-031',
        location: { lat: 28.64, lng: 77.23 },
        status: 'ASSIGNED',
        currentEmergency: 'EMG-20485',
        speed: 45,
        eta: 480,
        capabilities: ['Trauma', 'Basic'],
        crew: [],
        equipment: [],
        heading: 90,
        lastUpdated: new Date().toISOString(),
      },
      {
        id: 'AMB-017',
        location: { lat: 28.6155, lng: 77.212 },
        status: 'EN_ROUTE',
        currentEmergency: 'EMG-20481',
        speed: 55,
        eta: 420,
        capabilities: ['Trauma'],
        crew: [],
        equipment: [],
        heading: 180,
        lastUpdated: new Date().toISOString(),
      },
    ];

    const mockEmergencies: Emergency[] = [
      {
        id: 'EMG-20481',
        status: 'EN_ROUTE',
        priority: 'CRITICAL',
        incidentType: 'VEHICLE_COLLISION',
        location: { lat: 28.6139, lng: 77.209, address: 'Connaught Place' },
        source: 'AI_VISION',
        description: 'Multi-vehicle crash',
        victimCount: 2,
        reportedAt: '2026-01-15T08:23:14.000Z',
        updatedAt: '2026-01-15T08:31:00.000Z',
        timeline: [],
        assignedAmbulance: 'AMB-017',
      },
      {
        id: 'EMG-20485',
        status: 'AMBULANCE_ASSIGNED',
        priority: 'MEDIUM',
        incidentType: 'MEDICAL_EMERGENCY',
        location: { lat: 28.6139, lng: 77.209, address: 'Near Rajiv Chowk' },
        source: 'DISPATCHER',
        description: 'Cardiac emergency reported',
        victimCount: 1,
        reportedAt: '2026-10-28T16:43:30.306Z',
        updatedAt: '2026-10-28T17:59:30.346Z',
        timeline: [],
        assignedAmbulance: 'AMB-031',
      },
    ];

    vi.spyOn(api.ambulances, 'list').mockResolvedValue(mockAmbulances);
    vi.spyOn(api.emergencies, 'list').mockResolvedValue(mockEmergencies);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TrackingPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Live ambulance tracking')).toBeInTheDocument();
      expect(screen.getByText(/2 active units · 2 incidents/i)).toBeInTheDocument();
    });

    // Check that both emergency markers and ambulance markers exist in Leaflet container
    const markerIcons = container.querySelectorAll('.map-marker');
    expect(markerIcons.length).toBe(4); // 2 ambulances + 2 emergencies

    const ambulanceMarkers = container.querySelectorAll('.map-marker--ambulance');
    const emergencyMarkers = container.querySelectorAll('.map-marker--emergency');
    expect(ambulanceMarkers.length).toBe(2);
    expect(emergencyMarkers.length).toBe(2);

    // One emergency is critical (EMG-20481), one is standard emergency (EMG-20485)
    const criticalMarkers = container.querySelectorAll('.map-marker--critical');
    expect(criticalMarkers.length).toBe(1);

    // Verify popup contents exist in DOM when markers are clicked
    const markers = container.querySelectorAll('.leaflet-marker-icon');
    expect(markers.length).toBe(4);

    // Click EMG-20481 marker and verify popup
    fireEvent.click(markers[2]);
    expect(screen.getByText('EMG-20481')).toBeInTheDocument();
    expect(screen.getByText('VEHICLE COLLISION')).toBeInTheDocument();

    // Click EMG-20485 marker and verify its distinct popup opens
    fireEvent.click(markers[3]);
    expect(screen.getByText('EMG-20485')).toBeInTheDocument();
    expect(screen.getByText('MEDICAL EMERGENCY')).toBeInTheDocument();

    // Click AMB-031 marker and verify ambulance popup opens
    fireEvent.click(markers[0]);
    expect(screen.getByText('Speed: 45 km/h')).toBeInTheDocument();
    expect(screen.getAllByText('AMB-031').length).toBeGreaterThanOrEqual(1);
  });

  it('dynamically refreshes to include a newly created incident without a full-page reload', async () => {
    const mockAmbulances: Ambulance[] = [
      {
        id: 'AMB-031',
        location: { lat: 28.64, lng: 77.23 },
        status: 'AVAILABLE',
        speed: 0,
        capabilities: ['Basic'],
        crew: [],
        equipment: [],
        heading: 0,
        lastUpdated: new Date().toISOString(),
      },
    ];

    const initialEmergencies: Emergency[] = [];
    const updatedEmergencies: Emergency[] = [
      {
        id: 'EMG-20485',
        status: 'REPORTED',
        priority: 'MEDIUM',
        incidentType: 'MEDICAL_EMERGENCY',
        location: { lat: 28.6139, lng: 77.209 },
        source: 'DISPATCHER',
        description: 'New incident',
        victimCount: 1,
        reportedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeline: [],
      },
    ];

    let queryCount = 0;
    vi.spyOn(api.ambulances, 'list').mockResolvedValue(mockAmbulances);
    vi.spyOn(api.emergencies, 'list').mockImplementation(async () => {
      queryCount++;
      return queryCount === 1 ? initialEmergencies : updatedEmergencies;
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TrackingPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/0 incidents/i)).toBeInTheDocument();
    });

    // Simulate query refetch (such as interval poll or manual refresh button)
    const refreshButton = screen.getByRole('button', { name: /refresh map/i });
    await act(async () => {
      fireEvent.click(refreshButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/1 incident\b/i)).toBeInTheDocument();
    });

    // Verify EMG-20485 marker was rendered without full-page reload
    const emergencyMarkers = container.querySelectorAll('.map-marker--emergency');
    expect(emergencyMarkers.length).toBe(1);

    const marker = container.querySelector('.leaflet-marker-icon');
    if (marker) fireEvent.click(marker);
    expect(screen.getByText('EMG-20485')).toBeInTheDocument();
  });

  it('safely handles missing or invalid coordinates without crashing or fabricating locations', async () => {
    const mockEmergencies: unknown[] = [
      {
        id: 'EMG-INVALID-1',
        status: 'REPORTED',
        priority: 'LOW',
        incidentType: 'OTHER',
        // undefined location
        source: 'CITIZEN',
        description: 'Missing location',
        victimCount: 1,
        reportedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeline: [],
      },
      {
        id: 'EMG-INVALID-2',
        status: 'REPORTED',
        priority: 'MEDIUM',
        incidentType: 'MEDICAL_EMERGENCY',
        location: { lat: NaN, lng: 77.209 },
        source: 'DISPATCHER',
        description: 'NaN coordinate',
        victimCount: 1,
        reportedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeline: [],
      },
      {
        id: 'EMG-INVALID-3',
        status: 'REPORTED',
        priority: 'HIGH',
        incidentType: 'FIRE_EXPLOSION',
        location: { lat: 95, lng: 200 }, // Out of bounds
        source: 'CITIZEN',
        description: 'Out of bounds coordinate',
        victimCount: 1,
        reportedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeline: [],
      },
      {
        id: 'EMG-VALID',
        status: 'REPORTED',
        priority: 'MEDIUM',
        incidentType: 'MEDICAL_EMERGENCY',
        location: { lat: 28.6139, lng: 77.209, address: 'Connaught Place' },
        source: 'DISPATCHER',
        description: 'Valid location',
        victimCount: 1,
        reportedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeline: [],
      },
    ];

    vi.spyOn(api.ambulances, 'list').mockResolvedValue([]);
    vi.spyOn(api.emergencies, 'list').mockResolvedValue(mockEmergencies as Emergency[]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TrackingPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Live ambulance tracking')).toBeInTheDocument();
      expect(screen.getByText(/4 incidents/i)).toBeInTheDocument();
    });

    // Only the single valid emergency is plotted as a marker
    const emergencyMarkers = container.querySelectorAll('.map-marker--emergency');
    expect(emergencyMarkers.length).toBe(1);

    const marker = container.querySelector('.leaflet-marker-icon');
    if (marker) fireEvent.click(marker);
    expect(screen.getByText('EMG-VALID')).toBeInTheDocument();
    expect(screen.queryByText('EMG-INVALID-1')).not.toBeInTheDocument();
  });

  it('keeps ambulance markers and incident markers visually distinct', async () => {
    const mockAmbulances: Ambulance[] = [
      {
        id: 'AMB-031',
        location: { lat: 28.64, lng: 77.23 },
        status: 'ASSIGNED',
        currentEmergency: 'EMG-20485',
        speed: 30,
        capabilities: ['Trauma'],
        crew: [],
        equipment: [],
        heading: 0,
        lastUpdated: new Date().toISOString(),
      },
    ];

    const mockEmergencies: Emergency[] = [
      {
        id: 'EMG-20485',
        status: 'AMBULANCE_ASSIGNED',
        priority: 'MEDIUM',
        incidentType: 'MEDICAL_EMERGENCY',
        location: { lat: 28.6139, lng: 77.209 },
        source: 'DISPATCHER',
        description: 'Assigned emergency',
        victimCount: 1,
        reportedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeline: [],
        assignedAmbulance: 'AMB-031',
      },
    ];

    vi.spyOn(api.ambulances, 'list').mockResolvedValue(mockAmbulances);
    vi.spyOn(api.emergencies, 'list').mockResolvedValue(mockEmergencies);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TrackingPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Live ambulance tracking')).toBeInTheDocument();
    });

    const ambMarker = container.querySelector('.map-marker--ambulance');
    const emgMarker = container.querySelector('.map-marker--emergency');

    expect(ambMarker).toBeInTheDocument();
    expect(emgMarker).toBeInTheDocument();
    expect(ambMarker).not.toEqual(emgMarker);
  });

  it('renders road geometry and dynamic ETA metrics when activeRoute is present', async () => {
    const mockRoadCoordinates: [number, number][] = [
      [26.242, 78.22],
      [26.239, 78.218],
      [26.234, 78.215],
      [26.228854, 78.213198],
    ];

    const mockAmbulances: Ambulance[] = [
      {
        id: 'AMB-051',
        location: { lat: 26.242, lng: 78.22 },
        status: 'ASSIGNED',
        currentEmergency: 'EMG-20485',
        speed: 40,
        heading: 195,
        capabilities: ['Advanced Life Support'],
        crew: [],
        equipment: [],
        lastUpdated: new Date().toISOString(),
        isSimulated: true,
        telemetrySource: 'SIMULATED',
        eta: 245,
        activeRoute: {
          coordinates: mockRoadCoordinates,
          distanceMeters: 1750,
          durationSeconds: 245,
          calculatedAt: new Date().toISOString(),
          destinationType: 'INCIDENT',
          destinationId: 'EMG-20485',
          provider: 'osrm',
          status: 'SUCCESS',
          isStale: false,
          deviated: false,
        },
      },
    ];

    const mockEmergencies: Emergency[] = [
      {
        id: 'EMG-20485',
        status: 'AMBULANCE_ASSIGNED',
        priority: 'HIGH',
        incidentType: 'RESPIRATORY_DISTRESS',
        location: { lat: 26.228854, lng: 78.213198, address: 'College main gate, Gwalior' },
        source: 'VOICE_REPORT',
        description: 'Breathing emergency',
        victimCount: 1,
        reportedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeline: [],
        assignedAmbulance: 'AMB-051',
        eta: 245,
      },
    ];

    vi.spyOn(api.ambulances, 'list').mockResolvedValue(mockAmbulances);
    vi.spyOn(api.emergencies, 'list').mockResolvedValue(mockEmergencies);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TrackingPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Live ambulance tracking')).toBeInTheDocument();
      expect(screen.getByText(/AMB-051/)).toBeInTheDocument();
    });

    // Select AMB-051 to inspect context card
    const ambButton = screen.getByText('AMB-051').closest('button');
    if (ambButton) fireEvent.click(ambButton);

    await waitFor(() => {
      expect(screen.getByText('1.8 km road network')).toBeInTheDocument();
      expect(screen.getByText(/4:05 min/)).toBeInTheDocument();
      expect(screen.getByText('OSRM (driving)')).toBeInTheDocument();
    });
  });

  it('clearly indicates ETA unavailable when routing provider fails', async () => {
    const mockAmbulances: Ambulance[] = [
      {
        id: 'AMB-051',
        location: { lat: 26.242, lng: 78.22 },
        status: 'ASSIGNED',
        currentEmergency: 'EMG-20485',
        speed: 0,
        heading: 0,
        capabilities: ['Advanced Life Support'],
        crew: [],
        equipment: [],
        lastUpdated: new Date().toISOString(),
        isSimulated: true,
        telemetrySource: 'SIMULATED',
        // eta undefined due to provider outage
        activeRoute: {
          coordinates: [],
          distanceMeters: 0,
          durationSeconds: 0,
          calculatedAt: new Date().toISOString(),
          destinationType: 'INCIDENT',
          destinationId: 'EMG-20485',
          provider: 'osrm',
          status: 'FAILED',
          isStale: true,
          deviated: false,
        },
      },
    ];

    const mockEmergencies: Emergency[] = [
      {
        id: 'EMG-20485',
        status: 'AMBULANCE_ASSIGNED',
        priority: 'HIGH',
        incidentType: 'RESPIRATORY_DISTRESS',
        location: { lat: 26.228854, lng: 78.213198 },
        source: 'VOICE_REPORT',
        description: 'Breathing emergency',
        victimCount: 1,
        reportedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeline: [],
        assignedAmbulance: 'AMB-051',
        // eta unset
      },
    ];

    vi.spyOn(api.ambulances, 'list').mockResolvedValue(mockAmbulances);
    vi.spyOn(api.emergencies, 'list').mockResolvedValue(mockEmergencies);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TrackingPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Live ambulance tracking')).toBeInTheDocument();
    });

    const ambButton = screen.getByText('AMB-051').closest('button');
    if (ambButton) fireEvent.click(ambButton);

    await waitFor(() => {
      expect(screen.getByText('ETA unavailable')).toBeInTheDocument();
    });
  });
});

