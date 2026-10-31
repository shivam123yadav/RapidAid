import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell, EmailVerificationBanner, SidebarFooter } from './AppShell';
import { useAuthStore, _resetRefreshThrottleForTest } from '../../stores/auth';
import { useAuthSync } from '../../hooks/useAuthSync';
import { api, ApiError } from '../../api/client';

describe('EmailVerificationBanner and useAuthSync', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    _resetRefreshThrottleForTest();
    localStorage.clear();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    useAuthStore.setState({
      user: {
        id: 'u-123',
        name: 'Citizen Jane',
        email: 'jane@rapidaid.com',
        role: 'CITIZEN',
        emailVerified: false,
        permissions: [],
      },
      isAuthenticated: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    _resetRefreshThrottleForTest();
  });

  const renderShell = (children?: React.ReactNode) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AppShell>{children || <div data-testid="page-content">Dashboard Content</div>}</AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it('does not render if the user is already email verified', () => {
    useAuthStore.setState({
      user: {
        id: 'u-123',
        name: 'Citizen Jane',
        email: 'jane@rapidaid.com',
        role: 'CITIZEN',
        emailVerified: true,
        permissions: [],
      },
    });

    const { container } = render(<EmailVerificationBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders banner when emailVerified is false and button is initially enabled', () => {
    render(<EmailVerificationBanner />);
    expect(screen.getByText(/verify your email address/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /resend link/i });
    expect(button).toBeEnabled();
  });

  it('disables button during pending resend request and resets loading state in finally on success', async () => {
    let resolveResend!: (value: { success: boolean; message: string; delivered: boolean }) => void;
    const pendingPromise = new Promise<{ success: boolean; message: string; delivered: boolean }>((resolve) => {
      resolveResend = resolve;
    });

    vi.spyOn(api.auth, 'resendVerification').mockReturnValue(pendingPromise);

    render(<EmailVerificationBanner />);
    const button = screen.getByRole('button', { name: /resend link/i });

    // Click resend
    fireEvent.click(button);

    // Button should now show loading spinner and be disabled
    expect(button).toBeDisabled();
    expect(screen.getByText(/sending\.\.\./i)).toBeInTheDocument();

    // Resolving the request
    await act(async () => {
      resolveResend({ success: true, message: 'Verification link dispatched!', delivered: true });
    });

    // Success feedback is displayed, button is in countdown (60s cooldown)
    expect(screen.getByText(/verification link dispatched!/i)).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/resend in 60s/i);
  });

  it('resets loading state in finally on network error or timeout', async () => {
    vi.spyOn(api.auth, 'resendVerification').mockRejectedValue(new Error('Network error'));

    render(<EmailVerificationBanner />);
    const button = screen.getByRole('button', { name: /resend link/i });

    await act(async () => {
      fireEvent.click(button);
    });

    // Loading indicator is gone and error feedback is displayed
    expect(screen.queryByText(/sending\.\.\./i)).not.toBeInTheDocument();
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('parses structured retryAfter on HTTP 429 and shows countdown', async () => {
    const error429 = new ApiError(
      'Please wait before requesting another verification email',
      429,
      'RATE_LIMITED',
      undefined,
      { retryAfter: 25 },
    );
    vi.spyOn(api.auth, 'resendVerification').mockRejectedValue(error429);

    render(<EmailVerificationBanner />);
    const button = screen.getByRole('button', { name: /resend link/i });

    await act(async () => {
      fireEvent.click(button);
    });

    // Loading reset, button disabled with countdown
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Resend in 25s');
    expect(screen.getByText(/please wait before requesting another verification email/i)).toBeInTheDocument();

    // Advance 5 seconds
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(button).toHaveTextContent('Resend in 20s');

    // Advance remainder of timer
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Resend link');
  });

  it('falls back to 5-second countdown on 429 when retryAfter is missing', async () => {
    const error429NoDetails = new ApiError(
      'Too many requests',
      429,
      'RATE_LIMITED',
    );
    vi.spyOn(api.auth, 'resendVerification').mockRejectedValue(error429NoDetails);

    render(<EmailVerificationBanner />);
    const button = screen.getByRole('button', { name: /resend link/i });

    await act(async () => {
      fireEvent.click(button);
    });

    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Resend in 5s');

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Resend link');
  });

  it('prevents multiple simultaneous clicks while a request is in-flight', async () => {
    let resolveResend!: (value: { success: boolean; message: string; delivered: boolean }) => void;
    const pendingPromise = new Promise<{ success: boolean; message: string; delivered: boolean }>((resolve) => {
      resolveResend = resolve;
    });

    const resendSpy = vi.spyOn(api.auth, 'resendVerification').mockReturnValue(pendingPromise);

    render(<EmailVerificationBanner />);
    const button = screen.getByRole('button', { name: /resend link/i });

    // Rapid double click
    fireEvent.click(button);
    fireEvent.click(button);

    // Exactly 1 network request was initiated
    expect(resendSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveResend({ success: true, message: 'Sent', delivered: true });
    });
  });

  it('cleans up focus and visibilitychange event listeners when unmounted', () => {
    const addWinSpy = vi.spyOn(window, 'addEventListener');
    const remWinSpy = vi.spyOn(window, 'removeEventListener');
    const addDocSpy = vi.spyOn(document, 'addEventListener');
    const remDocSpy = vi.spyOn(document, 'removeEventListener');

    const { unmount } = renderHook(() => useAuthSync());

    expect(addWinSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(addDocSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    unmount();

    expect(remWinSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(remDocSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('disappears when account status is refreshed after verification on another device', async () => {
    vi.spyOn(api.auth, 'me').mockResolvedValue({
      id: 'u-123',
      name: 'Citizen Jane',
      email: 'jane@rapidaid.com',
      role: 'CITIZEN',
      emailVerified: true,
      permissions: [],
    });

    renderShell();
    expect(screen.getByText(/verify your email address/i)).toBeInTheDocument();

    // User verifies email on mobile and returns to desktop window (triggering focus)
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(screen.queryByText(/verify your email address/i)).not.toBeInTheDocument();
    });
    expect(useAuthStore.getState().user?.emailVerified).toBe(true);
  });

  it('triggers account-status synchronization on window focus via AppShell', async () => {
    const meSpy = vi.spyOn(api.auth, 'me').mockResolvedValue({
      id: 'u-123',
      name: 'Citizen Jane',
      email: 'jane@rapidaid.com',
      role: 'CITIZEN',
      emailVerified: true,
      permissions: [],
    });

    renderShell();
    expect(screen.getByText(/verify your email address/i)).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(meSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByText(/verify your email address/i)).not.toBeInTheDocument();
    });
  });

  it('triggers account-status synchronization on document visibility change when visible', async () => {
    const meSpy = vi.spyOn(api.auth, 'me').mockResolvedValue({
      id: 'u-123',
      name: 'Citizen Jane',
      email: 'jane@rapidaid.com',
      role: 'CITIZEN',
      emailVerified: true,
      permissions: [],
    });

    renderShell();

    // Switching back to tab (visibilityState becomes 'visible')
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(meSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByText(/verify your email address/i)).not.toBeInTheDocument();
    });
  });

  it('does NOT trigger account-status synchronization on visibility change when document is hidden', async () => {
    const meSpy = vi.spyOn(api.auth, 'me').mockResolvedValue({
      id: 'u-123',
      name: 'Citizen Jane',
      email: 'jane@rapidaid.com',
      role: 'CITIZEN',
      emailVerified: true,
      permissions: [],
    });

    renderShell();

    // Tab is hidden in background
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(meSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/verify your email address/i)).toBeInTheDocument();
  });

  it('preserves user state and does not falsely mark verified if profile refresh fails', async () => {
    const meSpy = vi.spyOn(api.auth, 'me').mockRejectedValue(new Error('Network error'));

    renderShell();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(meSpy).toHaveBeenCalled();
    // User remains unverified and still authenticated
    expect(useAuthStore.getState().user?.emailVerified).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    // Banner remains visible
    expect(screen.getByText(/verify your email address/i)).toBeInTheDocument();
  });

  it('updates the persisted Zustand state correctly when refreshUser succeeds', async () => {
    vi.spyOn(api.auth, 'me').mockResolvedValue({
      id: 'u-123',
      name: 'Citizen Jane Updated',
      email: 'jane@rapidaid.com',
      role: 'CITIZEN',
      emailVerified: true,
      permissions: ['read:profile'],
    });

    await act(async () => {
      await useAuthStore.getState().refreshUser();
    });

    const user = useAuthStore.getState().user;
    expect(user?.emailVerified).toBe(true);
    expect(user?.name).toBe('Citizen Jane Updated');

    // Confirm persisted state in localStorage matches ('rapidaid-auth')
    const stored = JSON.parse(localStorage.getItem('rapidaid-auth') || '{}');
    expect(stored.state?.user?.emailVerified).toBe(true);
    expect(stored.state?.user?.name).toBe('Citizen Jane Updated');
  });

  it('displays green verified indicator beside email in SidebarFooter when verified', () => {
    useAuthStore.setState({
      user: {
        id: 'u-123',
        name: 'Citizen Jane',
        email: 'jane@rapidaid.com',
        role: 'CITIZEN',
        emailVerified: true,
        permissions: [],
      },
      isAuthenticated: true,
    });

    render(
      <MemoryRouter>
        <SidebarFooter collapsed={false} />
      </MemoryRouter>,
    );

    const indicator = screen.getByTestId('email-verified-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent(/email verified/i);
    expect(screen.getByText('jane@rapidaid.com')).toBeInTheDocument();
  });

  it('does NOT display verified indicator in SidebarFooter when unverified', () => {
    render(
      <MemoryRouter>
        <SidebarFooter collapsed={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('email-verified-indicator')).not.toBeInTheDocument();
    expect(screen.queryByText(/email verified/i)).not.toBeInTheDocument();
    expect(screen.getByText('jane@rapidaid.com')).toBeInTheDocument();
  });

  it('verified status remains correct after navigating between dashboard pages', async () => {
    useAuthStore.setState({
      user: {
        id: 'u-123',
        name: 'Citizen Jane',
        email: 'jane@rapidaid.com',
        role: 'CITIZEN',
        emailVerified: true,
        permissions: [],
      },
      isAuthenticated: true,
    });

    // Mount on page A
    const { unmount } = renderShell(<div>Page A</div>);
    expect(screen.queryByText(/verify your email address/i)).not.toBeInTheDocument();
    unmount();

    // Navigate to page B
    renderShell(<div>Page B</div>);
    expect(screen.queryByText(/verify your email address/i)).not.toBeInTheDocument();
    expect(useAuthStore.getState().user?.emailVerified).toBe(true);
  });

  it('coalesces concurrent refreshUser calls and rapid focus/visibility events into a single API request', async () => {
    let resolveMe!: (val: any) => void;
    const mePromise = new Promise((resolve) => {
      resolveMe = resolve;
    });
    const meSpy = vi.spyOn(api.auth, 'me').mockReturnValue(mePromise as any);

    renderShell();

    // Fire focus, visibilitychange, and direct refreshUser simultaneously
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      useAuthStore.getState().refreshUser();
    });

    // Exactly 1 network request was initiated
    expect(meSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMe({
        id: 'u-123',
        name: 'Citizen Jane',
        email: 'jane@rapidaid.com',
        role: 'CITIZEN',
        emailVerified: true,
        permissions: [],
      });
    });

    await waitFor(() => {
      expect(screen.queryByText(/verify your email address/i)).not.toBeInTheDocument();
    });
  });
});
