import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { EmailVerificationBanner } from './AppShell';
import { useAuthStore } from '../../stores/auth';
import { api, ApiError } from '../../api/client';

describe('EmailVerificationBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
  });

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
});
