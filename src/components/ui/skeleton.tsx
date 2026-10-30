import { cn } from '../../lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'skeleton-shimmer animate-pulse rounded-lg border border-[color-mix(in_srgb,var(--border)_55%,transparent)] bg-[var(--muted)]',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
