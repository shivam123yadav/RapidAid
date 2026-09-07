import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, lazy, Suspense } from 'react';
import { AppShell } from './components/layout/AppShell';
import { CommandPalette, NotificationDrawer } from './components/layout/Overlays';
import { useThemeStore } from './stores/theme';
import { LandingPage } from './pages/Landing';
import { LoginPage } from './pages/Login';
import { Skeleton } from './components/ui/skeleton';
import { ErrorBoundary } from './components/ErrorBoundary';

const CommandCenterPage = lazy(() => import('./pages/CommandCenter').then(m => ({ default: m.CommandCenterPage })));
const EmergenciesPage = lazy(() => import('./pages/Emergencies').then(m => ({ default: m.EmergenciesPage })));
const EmergencyDetailPage = lazy(() => import('./pages/Emergencies').then(m => ({ default: m.EmergencyDetailPage })));
const AmbulancesPage = lazy(() => import('./pages/Ambulances').then(m => ({ default: m.AmbulancesPage })));
const HospitalsPage = lazy(() => import('./pages/Hospitals').then(m => ({ default: m.HospitalsPage })));
const AIVisionPage = lazy(() => import('./pages/AIVision').then(m => ({ default: m.AIVisionPage })));
const DispatchPage = lazy(() => import('./pages/Dispatch').then(m => ({ default: m.DispatchPage })));
const VoicePage = lazy(() => import('./pages/Voice').then(m => ({ default: m.VoicePage })));
const AnalyticsPage = lazy(() => import('./pages/Analytics').then(m => ({ default: m.AnalyticsPage })));
const GreenCorridorPage = lazy(() => import('./pages/GreenCorridor').then(m => ({ default: m.GreenCorridorPage })));
const TrackingPage = lazy(() => import('./pages/Tracking').then(m => ({ default: m.TrackingPage })));
const AlertsPage = lazy(() => import('./pages/Alerts').then(m => ({ default: m.AlertsPage })));
const AuditPage = lazy(() => import('./pages/Audit').then(m => ({ default: m.AuditPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then(m => ({ default: m.SettingsPage })));
const SimulationsPage = lazy(() => import('./pages/Simulations').then(m => ({ default: m.SimulationsPage })));
const LoginPageLazy = lazy(() => import('./pages/Login').then(m => ({ default: m.LoginPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

function PageLoader() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
      </div>
    </div>
  );
}

function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          {children}
        </Suspense>
      </ErrorBoundary>
      <CommandPalette />
      <NotificationDrawer />
    </AppShell>
  );
}

function ThemeInitializer() {
  useEffect(() => {
    // Initialize theme on mount
    useThemeStore.getState().initTheme();
    
    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const mode = useThemeStore.getState().mode;
      if (mode === 'system') {
        useThemeStore.getState().initTheme();
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return null;
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ThemeInitializer />
        <Routes>
          {/* Public */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<Suspense fallback={<PageLoader />}><LoginPageLazy /></Suspense>} />
          
          {/* App Routes */}            <Route path="/command-center" element={<AppLayout><CommandCenterPage /></AppLayout>} />
            <Route path="/emergencies" element={<AppLayout><EmergenciesPage /></AppLayout>} />
            <Route path="/emergencies/:id" element={<AppLayout><EmergencyDetailPage /></AppLayout>} />
            <Route path="/ambulances" element={<AppLayout><AmbulancesPage /></AppLayout>} />
            <Route path="/hospitals" element={<AppLayout><HospitalsPage /></AppLayout>} />
            <Route path="/tracking" element={<AppLayout><TrackingPage /></AppLayout>} />
            <Route path="/ai-vision" element={<AppLayout><AIVisionPage /></AppLayout>} />
            <Route path="/dispatch" element={<AppLayout><DispatchPage /></AppLayout>} />
            <Route path="/voice" element={<AppLayout><VoicePage /></AppLayout>} />
            <Route path="/analytics" element={<AppLayout><AnalyticsPage /></AppLayout>} />
            <Route path="/green-corridor" element={<AppLayout><GreenCorridorPage /></AppLayout>} />
            <Route path="/simulations" element={<AppLayout><SimulationsPage /></AppLayout>} />
            <Route path="/alerts" element={<AppLayout><AlertsPage /></AppLayout>} />
            <Route path="/audit" element={<AppLayout><AuditPage /></AppLayout>} />
            <Route path="/settings" element={<AppLayout><SettingsPage /></AppLayout>} />
            
            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
