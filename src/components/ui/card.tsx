import React from 'react';
import { cn } from '../../lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const cardVariants = cva(
  'relative rounded-xl border text-[var(--card-foreground)] transition-colors',
  {
    variants: {
      variant: {
        default:
          'border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]',
        elevated:
          'border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-pop)]',
        interactive:
          'card-lift border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)] hover:bg-[color-mix(in_srgb,var(--card)_94%,var(--foreground))]',
        glass:
          'glass-elevated border-[color-mix(in_srgb,var(--border)_75%,transparent)] shadow-[var(--shadow-pop)]',
        critical:
          'border-[color-mix(in_srgb,var(--destructive)_40%,var(--border))] bg-[var(--card)] shadow-[var(--shadow-card)] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:rounded-l-xl before:bg-[var(--destructive)]',
        quiet:
          'border-transparent bg-[color-mix(in_srgb,var(--card)_55%,transparent)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={cn(cardVariants({ variant }), className)} {...props} />
  ),
);
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-5 sm:p-6', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('text-base font-semibold leading-tight tracking-[-0.015em]', className)}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-sm leading-relaxed text-[var(--muted-foreground)]', className)} {...props} />
  ),
);
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-5 pt-0 sm:p-6 sm:pt-0', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-center gap-2 border-t border-[var(--border)] px-5 py-4 sm:px-6', className)}
      {...props}
    />
  ),
);
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
