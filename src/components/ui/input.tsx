import * as React from 'react';
import { cn } from '../../lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-11 w-full rounded-lg border border-[var(--input)] bg-[color-mix(in_srgb,var(--card)_72%,transparent)] px-3.5 py-2 text-sm text-[var(--foreground)] shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] transition-[border-color,box-shadow,background-color] placeholder:text-[var(--muted-foreground)] hover:border-[color-mix(in_srgb,var(--primary)_28%,var(--border))] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--ring)_28%,transparent)] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 file:border-0 file:bg-transparent file:text-sm file:font-medium',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
