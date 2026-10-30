import type { ReactNode } from 'react';
import { Card } from './card';
import { Skeleton } from './skeleton';
import { AnimatedNumber } from '../motion/AnimatedNumber';
import { cn } from '../../lib/utils';

type StatTone = 'primary' | 'danger' | 'success' | 'warning' | 'info' | 'neutral';

const toneClasses: Record<StatTone, string> = {
  primary: 'bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-[var(--primary)]',
  danger: 'bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)]',
  success: 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]',
  warning: 'bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)]',
  info: 'bg-[color-mix(in_srgb,var(--info)_10%,transparent)] text-[var(--info)]',
  neutral: 'bg-[var(--muted)] text-[var(--muted-foreground)]',
};

interface StatCardProps {
  label: string;
  value: number | string;
  icon?: ReactNode;
  tone?: StatTone;
  hint?: ReactNode;
  detail?: ReactNode;
  /** Decimal places for animated numeric values. */
  decimals?: number;
  prefix?: string;
  suffix?: string;
  loading?: boolean;
  className?: string;
}

/**
 * A live metric tile. Numeric values animate to their real API value; the
 * label and detail are always available as text, so the tile remains fully
 * readable with reduced motion or a screen reader.
 */
export function StatCard({
  label,
  value,
  icon,
  tone = 'neutral',
  hint,
  detail,
  decimals = 0,
  prefix,
  suffix,
  loading = false,
  className,
}: StatCardProps) {
  if (loading) {
    return (
      <Card className={cn('p-4', className)}>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-16" />
          </div>
          <Skeleton className="h-9 w-9 rounded-lg" />
        </div>
      </Card>
    );
  }

  return (
    <Card className={cn('group p-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase leading-snug tracking-[0.12em] text-[var(--muted-foreground)]">
            {label}
          </p>
          <p className="operational-number mt-1.5 text-[1.65rem] font-semibold leading-none text-[var(--foreground)]">
            {typeof value === 'number' ? (
              <AnimatedNumber value={value} decimals={decimals} prefix={prefix} suffix={suffix} />
            ) : (
              value
            )}
          </p>
          {hint ? <p className="mt-1.5 text-xs leading-snug text-[var(--muted-foreground)]">{hint}</p> : null}
        </div>
        {icon ? (
          <div className={cn('flex h-9 w-9 flex-none items-center justify-center rounded-lg', toneClasses[tone])}>
            {icon}
          </div>
        ) : null}
      </div>
      {detail ? <div className="mt-3 border-t border-[var(--border)] pt-3 text-xs">{detail}</div> : null}
    </Card>
  );
}
