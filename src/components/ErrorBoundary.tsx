import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex min-h-[420px] items-center justify-center p-6">
          <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 text-center shadow-[var(--shadow-pop)]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_srgb,var(--destructive)_10%,transparent),transparent_75%)]"
            />
            <div className="relative">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 text-[var(--destructive)]">
                <AlertTriangle size={21} />
              </div>
              <p className="eyebrow mt-4">Unexpected error</p>
              <h2 className="mt-1.5 font-display text-xl font-semibold tracking-[-0.03em]">
                This view could not be rendered
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-[var(--muted-foreground)]">
                The rest of the workspace is unaffected. Reload this view to try again; if the problem
                persists, contact an administrator with the details below.
              </p>
              {this.state.error?.message ? (
                <p className="mt-4 max-h-24 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-left font-mono text-[10px] leading-relaxed text-[var(--muted-foreground)]">
                  {this.state.error.message}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="pressable mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-4 text-sm font-semibold text-[var(--primary-foreground)]"
              >
                <RefreshCw size={14} />
                Reload view
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
