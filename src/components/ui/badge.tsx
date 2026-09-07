import { cn } from '../../lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-[var(--primary)] text-[var(--primary-foreground)]',
        secondary: 'bg-[var(--secondary)] text-[var(--secondary-foreground)]',
        destructive: 'bg-[var(--destructive)] text-white',
        success: 'bg-[var(--success)] text-white',
        warning: 'bg-[var(--warning)] text-[var(--warning-foreground)]',
        info: 'bg-[var(--info)] text-[var(--info-foreground)]',
        outline: 'border border-[var(--border)] text-[var(--foreground)]',
        critical: 'bg-red-600 text-white animate-pulse',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
