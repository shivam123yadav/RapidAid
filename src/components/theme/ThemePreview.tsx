import type { ThemeVariant } from '../../theme';
import { cn } from '../../lib/utils';

/**
 * Miniature rendering of ONE palette × appearance (Day or Night), drawn from
 * that variant's own tokens — not the active theme's — so every preview stays
 * truthful no matter which combination is currently applied.
 *
 * It shows background, card, primary accent, body text and status indicators,
 * not just a colour circle, which is why the theme cards can show a Day and a
 * Night preview of the same palette side by side.
 */
export function ThemePreview({
  variant,
  className,
}: {
  variant: ThemeVariant;
  className?: string;
}) {
  const p = variant.preview;

  return (
    <div
      /* Purely decorative: the name, description and "Active" state around it
         carry the meaning for screen readers. */
      aria-hidden="true"
      className={cn('flex h-24 w-full gap-2 overflow-hidden rounded-lg border p-2', className)}
      style={{ backgroundColor: p.background, borderColor: p.border }}
    >
      {/* Mini sidebar */}
      <div
        className="flex w-7 shrink-0 flex-col gap-1.5 rounded-md border p-1.5"
        style={{ backgroundColor: p.sidebar, borderColor: p.border }}
      >
        <span className="h-2.5 w-2.5 rounded" style={{ backgroundColor: p.primary }} />
        <span
          className="h-1.5 w-4 rounded-full"
          style={{ backgroundColor: p.muted }}
        />
        <span
          className="h-1.5 w-3 rounded-full opacity-70"
          style={{ backgroundColor: p.muted }}
        />
      </div>

      {/* Mini card */}
      <div
        className="flex min-w-0 flex-1 flex-col rounded-md border p-2"
        style={{ backgroundColor: p.card, borderColor: p.border }}
      >
        {/* Primary accent line */}
        <span
          className="h-2 w-3/5 rounded-full"
          style={{ backgroundColor: p.primary }}
        />
        {/* Text lines (body + secondary) */}
        <span
          className="mt-2 h-1.5 w-full rounded-full"
          style={{ backgroundColor: p.text, opacity: 0.75 }}
        />
        <span
          className="mt-1.5 h-1.5 w-4/5 rounded-full"
          style={{ backgroundColor: p.muted }}
        />
        {/* Status indicators: success / warning / danger */}
        <span className="mt-auto flex gap-1.5 pt-2">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.success }} />
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.warning }} />
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.danger }} />
        </span>
      </div>
    </div>
  );
}
