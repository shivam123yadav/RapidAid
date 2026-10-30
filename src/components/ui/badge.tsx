import { cn } from '../../lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-[var(--primary)] text-[var(--primary-foreground)]',
        secondary: 'border-transparent bg-[var(--secondary)] text-[var(--secondary-foreground)]',
        destructive: 'border-transparent bg-[var(--destructive)] text-[var(--destructive-foreground)]',
        success: 'border-transparent bg-[var(--success)] text-[var(--success-foreground)]',
        warning: 'border-transparent bg-[var(--warning)] text-[var(--warning-foreground)]',
        info: 'border-transparent bg-[var(--info)] text-[var(--info-foreground)]',
        outline: 'border-[var(--border)] bg-transparent text-[var(--foreground)]',
        critical:
          'border border-[color-mix(in_srgb,var(--danger)_55%,transparent)] bg-[var(--danger)] text-[var(--danger-foreground)] shadow-[var(--shadow-glow-danger)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
