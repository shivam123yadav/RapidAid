import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  className?: string;
}

/**
 * The operational page header. It keeps the page title as the single <h1>
 * (the shell header shows breadcrumb context instead) and gives every route
 * the same hierarchy without forcing each page into a card grid.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  icon,
  actions,
  status,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="flex min-w-0 items-start gap-3.5">
        {icon ? (
          <div className="mt-0.5 flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--primary)_24%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-[var(--primary)] shadow-[0_10px_28px_-18px_var(--primary)]">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0">
          {eyebrow ? <p className="eyebrow mb-1.5">{eyebrow}</p> : null}
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="truncate font-display text-2xl font-semibold tracking-[-0.035em] sm:text-[1.75rem]">
              {title}
            </h1>
            {status}
          </div>
          {description ? (
            <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-[var(--muted-foreground)]">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
    </header>
  );
}
