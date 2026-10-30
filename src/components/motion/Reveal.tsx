import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { EASE_OUT_EXPO, DURATION } from '../../lib/motion';
import { cn } from '../../lib/utils';

interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Seconds to wait before this element begins. */
  delay?: number;
  /** Vertical travel in pixels. Use 0 for a pure fade. */
  y?: number;
  /** Animate immediately instead of on scroll (hero / above-the-fold). */
  immediate?: boolean;
  once?: boolean;
}

/**
 * Scroll reveal with a reduced-motion path that renders the final state
 * immediately. No content is hidden when motion is disabled and no element
 * depends on being scrolled into view for meaning.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 16,
  immediate = false,
  once = true,
}: RevealProps) {
  const reduce = useReducedMotion();

  if (reduce) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={cn(className)}
      initial={{ opacity: 0, y }}
      {...(immediate
        ? { animate: { opacity: 1, y: 0 } }
        : { whileInView: { opacity: 1, y: 0 }, viewport: { once, amount: 0.2 } })}
      transition={{ duration: DURATION.slow, delay, ease: EASE_OUT_EXPO }}
    >
      {children}
    </motion.div>
  );
}

export function RevealGroup({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.15 }}
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.075, delayChildren: delay } },
      }}
    >
      {children}
    </motion.div>
  );
}

export function RevealItem({
  children,
  className,
  y = 14,
}: {
  children: ReactNode;
  className?: string;
  y?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y },
        visible: { opacity: 1, y: 0, transition: { duration: DURATION.slow, ease: EASE_OUT_EXPO } },
      }}
    >
      {children}
    </motion.div>
  );
}
