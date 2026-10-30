import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { EASE_OUT_EXPO } from '../../lib/motion';

/**
 * A very short route entrance. It never gates focus, data fetching or the
 * first paint: the content is present immediately and only its opacity and
 * a 6px offset are animated.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();

  if (reduce) return <>{children}</>;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
    >
      {children}
    </motion.div>
  );
}
