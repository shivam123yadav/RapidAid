import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, lazy, Suspense } from 'react';
import { useAuthStore } from './stores/auth';
import { session } from './api/session';
import { AppShell } from './components/layout/AppShell';
import { AccessDenied } from './components/layout/AccessDenied';
import { canAccess } from './lib/navigation';
import { CommandPalette, NotificationDrawer } from './components/layout/Overlays';
import { useThemeStore } from './stores/theme';
import { watchSystemAppearance } from './theme';
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
const PermissionMatrixPage = lazy(() => import('./pages/PermissionMatrix').then(m => ({ default: m.PermissionMatrixPage })));
const UsersPage = lazy(() => import('./pages/Users').then(m => ({ default: m.UsersPage })));
const SimulationsPage = lazy(() => import('./pages/Simulations').then(m => ({ default: m.SimulationsPage })));
const ShiftsPage = lazy(() => import('./pages/Shifts').then(m => ({ default: m.ShiftsPage })));
const MaintenancePage = lazy(() => import('./pages/Maintenance').then(m => ({ default: m.MaintenancePage })));
const CamerasPage = lazy(() => import('./pages/Cameras').then(m => ({ default: m.CamerasPage })));
const ReportsPage = lazy(() => import('./pages/Reports').then(m => ({ default: m.ReportsPage })));
const LoginPageLazy = lazy(() => import('./pages/Login').then(m => ({ default: m.LoginPage })));
const DemoRolesPageLazy = lazy(() => import('./pages/DemoRoles').then(m => ({ default: m.DemoRolesPage })));
const RegisterPageLazy = lazy(() => import('./pages/Register').then(m => ({ default: m.RegisterPage })));
const VerifyEmailPageLazy = lazy(() => import('./pages/VerifyEmail').then(m => ({ default: m.VerifyEmailPage })));
const ForgotPasswordPageLazy = lazy(() => import('./pages/ForgotPassword').then(m => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPageLazy = lazy(() => import('./pages/ResetPassword').then(m => ({ default: m.ResetPasswordPage })));

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

/**
 * Guards every /app route: unauthenticated visitors go to /login. On first
 * mount with a persisted identity but no in-memory access token (page
 * reload), it silently re-establishes the session via the httpOnly refresh
 * cookie before rendering — so deep links survive reloads.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [checking, setChecking] = useState(!session.getAccessToken());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (useAuthStore.getState().isAuthenticated && !session.getAccessToken()) {
        const token = await session.refresh();
        if (!token) session.onSessionExpired(); // clears the store → redirect below
      }
      if (!cancelled) setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (checking) return <PageLoader />;
  return <>{children}</>;
}

function AppLayout({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const { pathname } = useLocation();
  // Role gate: the sidebar only lists pages a role may enter, so a stale
  // bookmark or hand-typed URL shows an explanatory notice instead of a
  // screen the API would answer with 403.
  const allowed = canAccess(pathname, user?.role, user?.permissions);

  return (
    <RequireAuth>
      <AppShell>
        <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
            {allowed ? children : <AccessDenied />}
          </Suspense>
        </ErrorBoundary>
        <CommandPalette />
        <NotificationDrawer />
      </AppShell>
    </RequireAuth>
  );
}

function ThemeInitializer() {
  useEffect(() => {
    // Initialize theme on mount
    // (index.html's guard has already applied the restored pair pre-bundle.)
    useThemeStore.getState().initTheme();
    
    // Listen for system theme changes
    // Listen for OS appearance changes. When the user chose `system`, the
    // resolved tokens follow the OS live — no reload, no logout, no state loss
    // — and the saved selection itself is never rewritten. An explicit
    // Day/Night choice ignores these events entirely.
    return watchSystemAppearance(() => useThemeStore.getState().syncSystemAppearance());
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
          {/* Demo persona gallery. Separate from /login so "View demo roles" never
              lands on the sign-in form itself. Each card returns to /login with
              the chosen persona prefilled. */}
          <Route path="/demo-roles" element={<Suspense fallback={<PageLoader />}><DemoRolesPageLazy /></Suspense>} />
          {/* Public self-service signup. Before this route existed, /register fell
              through to the catch-all below and silently redirected to "/". */}
          <Route path="/register" element={<Suspense fallback={<PageLoader />}><RegisterPageLazy /></Suspense>} />

          {/* Email-link landing pages. These exact paths are the contract with
              server/src/services/email/emailService.ts, which builds
              `${PUBLIC_URL}/verify-email?token=…` and `…/reset-password?token=…`.
              Renaming them here breaks every link already in someone's inbox. */}
          <Route path="/verify-email" element={<Suspense fallback={<PageLoader />}><VerifyEmailPageLazy /></Suspense>} />
          <Route path="/forgot-password" element={<Suspense fallback={<PageLoader />}><ForgotPasswordPageLazy /></Suspense>} />
          <Route path="/reset-password" element={<Suspense fallback={<PageLoader />}><ResetPasswordPageLazy /></Suspense>} />
          
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
            <Route path="/shifts" element={<AppLayout><ShiftsPage /></AppLayout>} />
            <Route path="/maintenance" element={<AppLayout><MaintenancePage /></AppLayout>} />
            <Route path="/cameras" element={<AppLayout><CamerasPage /></AppLayout>} />
            <Route path="/reports" element={<AppLayout><ReportsPage /></AppLayout>} />
            <Route path="/alerts" element={<AppLayout><AlertsPage /></AppLayout>} />
            <Route path="/audit" element={<AppLayout><AuditPage /></AppLayout>} />
            <Route path="/settings" element={<AppLayout><SettingsPage /></AppLayout>} />
            <Route path="/admin/users" element={<AppLayout><UsersPage /></AppLayout>} />
            <Route path="/admin/permissions" element={<AppLayout><PermissionMatrixPage /></AppLayout>} />
            
            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
