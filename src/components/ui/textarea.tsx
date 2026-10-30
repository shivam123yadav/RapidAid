import * as React from 'react';
import { cn } from '../../lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[100px] w-full resize-y rounded-lg border border-[var(--input)] bg-[color-mix(in_srgb,var(--card)_72%,transparent)] px-3.5 py-2.5 text-sm text-[var(--foreground)] transition-[border-color,box-shadow,background-color] placeholder:text-[var(--muted-foreground)] hover:border-[color-mix(in_srgb,var(--primary)_28%,var(--border))] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--ring)_28%,transparent)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export { Textarea };
