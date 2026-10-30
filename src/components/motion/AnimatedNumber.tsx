import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

interface AnimatedNumberProps {
  value: number;
  /** Decimal places. Defaults to 0. */
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Duration in milliseconds. */
  duration?: number;
  className?: string;
}

/**
 * Animated metric value for genuine data changes.
 *
 * The first render is the real value; subsequent changes ease to the new
 * value. Reduced motion, a zero duration, or a background tab skips straight
 * to the destination. Values are never invented — callers pass API data.
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  duration = 650,
  className,
}: AnimatedNumberProps) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;

    if (reduce || duration <= 0 || from === value || document.hidden) {
      setDisplay(value);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      // easeOutCubic keeps the count readable while still feeling alive.
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (value - from) * eased);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [value, duration, reduce]);

  const formatted = Number.isFinite(display)
    ? display.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
    : '—';

  return (
    <span className={className} aria-label={`${prefix}${formatted}${suffix}`}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}
