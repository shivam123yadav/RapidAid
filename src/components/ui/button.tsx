import React from 'react';
import { cn } from '../../lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const buttonVariants = cva(
  'pressable inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold tracking-[-0.01em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--primary)] text-[var(--primary-foreground)] shadow-[0_1px_0_rgba(255,255,255,0.14)_inset,0_10px_28px_-14px_var(--primary)] hover:bg-[var(--primary-hover)] hover:shadow-[0_1px_0_rgba(255,255,255,0.18)_inset,0_16px_34px_-14px_var(--primary)]',
        destructive:
          'bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:bg-[var(--destructive-hover)] shadow-[0_10px_28px_-14px_var(--destructive)]',
        outline:
          'border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] text-[var(--foreground)] hover:border-[color-mix(in_srgb,var(--primary)_38%,var(--border))] hover:bg-[var(--muted)]',
        secondary:
          'bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[color-mix(in_srgb,var(--secondary)_82%,var(--foreground))]',
        ghost:
          'text-[var(--foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
        link: 'text-[var(--primary)] underline-offset-4 hover:underline',
        emergency:
          'bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:bg-[var(--destructive-hover)] shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_14px_36px_-14px_var(--destructive)]',
        success:
          'bg-[var(--success)] text-[var(--success-foreground)] hover:opacity-90 shadow-[0_10px_28px_-16px_var(--success)]',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-12 rounded-xl px-6 text-[0.9375rem]',
        xl: 'h-14 rounded-xl px-8 text-base',
        icon: 'h-10 w-10',
        iconSm: 'h-8 w-8 rounded-md',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button, buttonVariants };
