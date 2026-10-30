import { useRef, type KeyboardEvent } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { APPEARANCE_OPTIONS, appearanceLabel } from '../../theme';
import type { AppearanceMode } from '../../theme';
import { useTheme } from '../../stores/theme';
import { cn } from '../../lib/utils';

const MODE_ICONS = { day: Sun, night: Moon, system: Monitor } as const;

/**
 * Appearance mode: Day / Night / System.
 *
 * Two presentations of the same radio group:
 *   `cards`    — the Settings control (icon, label, explanation)
 *   `segments` — the compact segmented control inside the header popover
 *
 * Accessibility (both variants): `role="radiogroup"` + `role="radio"` with
 * `aria-checked`, a roving tabindex, Arrow/Home/End keys that move *and*
 * select, and a checkmark plus "Active" text, so the selection never depends
 * on colour alone.
 *
 * Selecting a mode never reloads, navigates or resets anything: it calls
 * `setAppearance`, which re-points CSS variables on <html>.
 */
export function AppearanceModeSelector({
  variant = 'cards',
  onSelect,
}: {
  variant?: 'cards' | 'segments';
  /** Called after a mode is applied — the header uses it to refresh itself. */
  onSelect?: (mode: AppearanceMode) => void;
}) {
  const { appearance, resolvedMode, setAppearance, isSystem } = useTheme();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (mode: AppearanceMode) => {
    setAppearance(mode);
    onSelect?.(mode);
  };

  const move = (from: number, delta: number, absolute?: number) => {
    const total = APPEARANCE_OPTIONS.length;
    const next = absolute !== undefined ? absolute : (from + delta + total) % total;
    const target = APPEARANCE_OPTIONS[next];
    if (!target) return;
    select(target.id);
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
        move(index, 0, APPEARANCE_OPTIONS.length - 1);
        break;
      default:
        break;
    }
  };

  if (variant === 'segments') {
    return (
      <div
        role="radiogroup"
        aria-label="Appearance mode"
        className="grid grid-cols-3 gap-1 rounded-lg border border-[var(--border)] bg-[var(--muted)] p-1"
      >
        {APPEARANCE_OPTIONS.map((option, index) => {
          const Icon = MODE_ICONS[option.id];
          const selected = option.id === appearance;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${option.label} — ${option.description}`}
              tabIndex={selected ? 0 : -1}
              ref={(el) => {
                refs.current[option.id] = el;
              }}
              onClick={() => select(option.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={cn(
                'focus-glow flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none',
                selected
                  ? 'bg-[var(--card)] text-[var(--foreground)] ring-1 ring-[var(--primary)]'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
              )}
            >
              <Icon size={14} aria-hidden="true" />
              <span className="flex items-center gap-1">
                {option.label}
                {selected && <Check size={11} aria-hidden="true" />}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Sun size={16} className="text-[var(--primary)]" />
          Appearance mode
        </h3>
        <p className="text-sm text-[var(--muted-foreground)]">
          Every theme ships an intentional Day and Night look. System follows your device and
          updates the moment your operating system changes.
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label="Appearance mode"
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        {APPEARANCE_OPTIONS.map((option, index) => {
          const Icon = MODE_ICONS[option.id];
          const selected = option.id === appearance;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${option.label} — ${option.description}${selected ? ' (active)' : ''}`}
              tabIndex={selected ? 0 : -1}
              ref={(el) => {
                refs.current[option.id] = el;
              }}
              onClick={() => select(option.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={cn(
                'focus-glow flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors',
                selected
                  ? 'border-[var(--primary)] bg-[var(--primary)]/5 shadow-[0_0_0_1px_var(--primary)]'
                  : 'border-[var(--border)] bg-[var(--card)] hover:bg-[var(--muted)]',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                  <Icon size={16} className="text-[var(--primary)]" aria-hidden="true" />
                  {option.label}
                </span>
                {selected && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--primary)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--primary-foreground)]">
                    <Check size={11} aria-hidden="true" />
                    Active
                  </span>
                )}
              </span>
              <span className="text-xs text-[var(--muted-foreground)]">{option.description}</span>
              {/* System is never faked: show what the OS preference resolves to now. */}
              {option.id === 'system' && isSystem && (
                <span className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  Currently showing {appearanceLabel(resolvedMode)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

