import { useRef, type KeyboardEvent } from 'react';
import { Check, Moon, Palette, Sun } from 'lucide-react';
import { useTheme } from '../../stores/theme';
import { appearanceLabel } from '../../theme';
import type { ThemeVariant } from '../../theme';
import { cn } from '../../lib/utils';
import { ThemePreview } from './ThemePreview';
import { AppearanceModeSelector } from './AppearanceModeSelector';

/**
 * One appearance of a palette: a small label, that appearance's primary /
 * success / danger swatches, and the mini mockup. Shown twice per theme card so
 * it is obvious that every palette has an intentional Day *and* Night look.
 */
function AppearancePreviewColumn({ label, variant }: { label: string; variant: ThemeVariant }) {
  const Icon = label === 'Night' ? Moon : Sun;
  const p = variant.preview;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          <Icon size={11} aria-hidden="true" />
          {label}
        </span>
        <span className="flex items-center gap-1" aria-hidden="true">
          <span
            className="h-2.5 w-2.5 rounded-full border border-[var(--border)]"
            style={{ backgroundColor: p.primary }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full border border-[var(--border)]"
            style={{ backgroundColor: p.success }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full border border-[var(--border)]"
            style={{ backgroundColor: p.danger }}
          />
        </span>
      </div>
      <ThemePreview variant={variant} className="h-20" />
    </div>
  );
}

/**
 * Settings -> Appearance.
 *
 * Theme cards — each showing the Day AND Night preview of the same palette —
 * followed by the Day / Night / System selector. Selecting anything applies it
 * *immediately*: there is no Save button, persistence is handled by the store,
 * and nothing reloads, navigates or resets.
 *
 * Accessibility:
 *   - `role="radiogroup"` / `role="radio"` with `aria-checked`
 *   - roving tabindex: exactly one card is tabbable
 *   - Arrow keys / Home / End move *and* select (native radio behaviour)
 *   - Enter and Space select the focused card (native button behaviour)
 *   - selection is shown with a checkmark + "Active" text, never colour alone
 *   - each option's `aria-label` combines name and description
 */
export function ThemeSelector() {
  const { themeId, themes, setTheme, resolvedMode } = useTheme();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const move = (from: number, delta: number, absolute?: number) => {
    const total = themes.length;
    const next = absolute !== undefined ? absolute : (from + delta + total) % total;
    const target = themes[next];
    if (!target) return;
    setTheme(target.id);
    refs.current[target.id]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index, -1);
        break;
      case 'Home':
        event.preventDefault();
        move(index, 0, 0);
        break;
      case 'End':
        event.preventDefault();
        move(index, 0, themes.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Palette size={16} className="text-[var(--primary)]" />
            Theme
          </h3>
          <p className="text-sm text-[var(--muted-foreground)]">
            Choose the RapidAid palette. Every theme is shown in both appearances — the change is
            instant and remembered automatically, with no Save.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="RapidAid theme"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          {themes.map((t, index) => {
            const selected = t.id === themeId;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${t.name} — ${t.description}${selected ? ' (active)' : ` (shows ${appearanceLabel(resolvedMode)})`}`}
                tabIndex={selected ? 0 : -1}
                ref={(el) => {
                  refs.current[t.id] = el;
                }}
                onClick={() => setTheme(t.id)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                className={cn(
                  'focus-glow flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors',
                  selected
                    ? 'border-[var(--primary)] bg-[var(--primary)]/5 shadow-[0_0_0_1px_var(--primary)]'
                    : 'border-[var(--border)] bg-[var(--card)] hover:bg-[var(--muted)]',
                )}
              >
                {/* Header: name, description, selected state */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[var(--foreground)]">
                      {t.name}
                    </p>
                    <p className="line-clamp-2 min-h-8 text-xs leading-4 text-[var(--muted-foreground)]">
                      {t.description}
                    </p>
                  </div>

                  {/* Visible selection marker — text + icon, never colour alone */}
                  {selected && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--primary)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--primary-foreground)]">
                      <Check size={11} aria-hidden="true" />
                      Active
                    </span>
                  )}
                </div>

                {/* Both appearances of this palette */}
                <div className="grid grid-cols-2 gap-2">
                  <AppearancePreviewColumn label="Day" variant={t.variants.day} />
                  <AppearancePreviewColumn label="Night" variant={t.variants.night} />
                </div>
              </button>
            );
          })}
        </div>

        <p className="text-[11px] leading-4 text-[var(--muted-foreground)]">
          The three dots on each appearance show its primary, success and danger colours. Status
          meanings never change with a theme: emergency stays danger, available stays success,
          pending stays warning.
        </p>
      </div>

      <div className="border-t border-[var(--border)] pt-6">
        <AppearanceModeSelector />
      </div>
    </div>
  );
}
