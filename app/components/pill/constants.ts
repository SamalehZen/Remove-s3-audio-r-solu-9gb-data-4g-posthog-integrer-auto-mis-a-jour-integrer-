import type { Variants } from 'framer-motion'

export const IDLE_WIDTH = 40
export const IDLE_HEIGHT = 8
export const RECORDING_WIDTH = 130
export const RECORDING_HEIGHT = 34
export const THINKING_WIDTH = 45
export const THINKING_HEIGHT = 34
export const HOVER_WIDTH = 110
export const HOVER_HEIGHT = 32

export const IOS_SPRING = {
  type: 'spring' as const,
  stiffness: 380,
  damping: 30,
  mass: 0.8,
}

export const IOS_SPRING_SNAPPY = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 26,
  mass: 0.7,
}

export const IOS_SPRING_HEIGHT = {
  type: 'spring' as const,
  stiffness: 440,
  damping: 28,
  mass: 0.65,
}

export const IOS_SPRING_WIDTH = {
  type: 'spring' as const,
  stiffness: 340,
  damping: 32,
  mass: 0.9,
}

export const CONTENT_ENTER = {
  type: 'spring' as const,
  stiffness: 400,
  damping: 28,
  mass: 0.7,
}

export const CONTENT_EXIT = {
  duration: 0.12,
  ease: [0.4, 0, 1, 1] as const,
}

export const pillContainerVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 16,
    scale: 0.92,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: IOS_SPRING,
  },
  exit: {
    opacity: 0,
    y: 12,
    scale: 0.95,
    transition: { duration: 0.18, ease: [0.4, 0, 1, 1] },
  },
}

export const cancelButtonVariants: Variants = {
  hidden: { scale: 0, opacity: 0 },
  visible: {
    scale: 1,
    opacity: 1,
    transition: IOS_SPRING_SNAPPY,
  },
  exit: {
    scale: 0,
    opacity: 0,
    transition: { duration: 0.12 },
  },
}

export const STAGED_TRANSITION = {
  width: IOS_SPRING_WIDTH,
  height: IOS_SPRING_HEIGHT,
  borderRadius: IOS_SPRING_HEIGHT,
  backgroundColor: { duration: 0.2, ease: 'easeOut' as const },
  boxShadow: { duration: 0.25, ease: 'easeOut' as const },
  borderColor: { duration: 0.2, ease: 'easeOut' as const },
}
