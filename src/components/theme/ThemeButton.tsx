import { useRef, useState, type KeyboardEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, Palette } from 'lucide-react';
import { Button } from '../ui/button';
import { useTheme } from '../../stores/theme';
import { APPEARANCE_OPTIONS, appearanceLabel } from '../../theme';
import { cn } from '../../lib/utils';
import { AppearanceModeSelector } from './AppearanceModeSelector';

/**
 * Compact appearance control for the main header.
 *
 * Deliberately small and quiet (a single ghost icon button) so it never
 * competes with search, notifications or the profile menu, and it lives
 * alongside them in the existing header rather than a new bar.
 *
 * The popover shows BOTH halves of the pair in one panel, without duplicating
 * the full Settings UI:
 *
 *   Current: Command Pulse · System · Night
 *   MODE    [ Day | Night | System ]      <- segmented radiogroup
 *   THEMES  ( ) Command Pulse ( ) Northstar OS …
 *
 * Radix Popover supplies focus management, Escape-to-close and outside-click.
 * Picking a theme closes the panel (the choice is complete); picking a mode
 * keeps it open, because the user usually wants to set the mode *and* the
 * palette before dismissing it. Neither action navigates, reloads or resets
 * anything.
 */
export function ThemeButton() {
  const { themeId, themes, setTheme, theme, appearance, resolvedMode, isSystem } = useTheme();
  const [open, setOpen] = useState(false);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const modeLabel = APPEARANCE_OPTIONS.find((o) => o.id === appearance)?.label ?? 'System';
  // System is shown as "System · Night" so the real OS resolution is visible.
  const summary = isSystem ? `${modeLabel} · ${appearanceLabel(resolvedMode)}` : modeLabel;

  const select = (id: string) => {
    setTheme(id);
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const total = themes.length;
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = total - 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % total;
    else next = (index - 1 + total) % total;
    refs.current[themes[next].id]?.focus();
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="focus-glow"
          title="Appearance"
          aria-label={`Appearance: ${theme.name}, ${summary}. Change theme or mode`}
          data-testid="theme-button"
        >
          <Palette size={18} />
        </Button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Appearance"
          className={cn(
            'glass-elevated z-[110] w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-[var(--border)] p-2',
            'shadow-[var(--shadow-pop)] outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
            'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
          )}
        >
          <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            Appearance
          </p>
          <p className="px-2 pb-3 text-xs text-[var(--muted-foreground)]">
            Current:{' '}
            <span className="font-medium text-[var(--foreground)]">
              {theme.name} · {summary}
            </span>
          </p>

          <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            Mode
          </p>
          <div className="px-1 pb-3">
            <AppearanceModeSelector variant="segments" />
          </div>

          <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            Themes
          </p>
          <div role="radiogroup" aria-label="Quick theme switcher" className="space-y-0.5">
            {themes.map((t, index) => {
              const selected = t.id === themeId;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`${t.name} — ${t.description}`}
                  ref={(el) => {
                    refs.current[t.id] = el;
                  }}
                  onClick={() => select(t.id)}
                  onKeyDown={(e) => handleKeyDown(e, index)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors',
                    'focus-glow focus-visible:outline-none',
                    selected
                      ? 'bg-[var(--primary)]/10 font-medium text-[var(--foreground)]'
                      : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
                  )}
                >
                  {/* Accent preview for the appearance you are currently in, so the
                      dot matches the colour you would actually get. */}
                  <span
                    className="h-3 w-3 shrink-0 rounded-full ring-1 ring-[var(--border)]"
                    style={{ backgroundColor: t.variants[resolvedMode].preview.primary }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  {selected && (
                    <Check size={14} className="shrink-0 text-[var(--primary)]" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
