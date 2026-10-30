import type { Transition, Variants } from 'framer-motion';

/**
 * Shared motion language.
 *
 * The values are intentionally restrained. Emergency software must never make
 * an operator wait for choreography, so every preset is short, interruptible
 * and disabled by the caller when `prefers-reduced-motion` is set.
 */
export const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];
export const EASE_SOFT: [number, number, number, number] = [0.65, 0, 0.35, 1];

export const DURATION = {
  instant: 0.12,
  fast: 0.18,
  base: 0.28,
  slow: 0.45,
  cinematic: 0.9,
} as const;

export const STAGGER = {
  tight: 0.045,
  base: 0.075,
  relaxed: 0.12,
} as const;

export const transitionBase: Transition = {
  duration: DURATION.base,
  ease: EASE_OUT_EXPO,
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: DURATION.base, ease: EASE_OUT_EXPO } },
};

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: DURATION.slow, ease: EASE_OUT_EXPO } },
};

export const fadeUpSmall: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE_OUT_EXPO } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.97 },
  visible: { opacity: 1, scale: 1, transition: { duration: DURATION.base, ease: EASE_OUT_EXPO } },
};

export const drawerIn: Variants = {
  hidden: { opacity: 0, x: 32 },
  visible: { opacity: 1, x: 0, transition: { duration: DURATION.base, ease: EASE_OUT_EXPO } },
  exit: { opacity: 0, x: 24, transition: { duration: DURATION.fast, ease: EASE_SOFT } },
};

export function staggerContainer(stagger: number = STAGGER.base, delayChildren = 0): Variants {
  return {
    hidden: {},
    visible: {
      transition: {
        staggerChildren: stagger,
        delayChildren,
      },
    },
  };
}

/** Framer variants for an element that should not animate at all. */
export const staticVariants: Variants = {
  hidden: { opacity: 1 },
  visible: { opacity: 1 },
};


