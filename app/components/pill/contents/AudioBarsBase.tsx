import React from 'react'
import { motion } from 'framer-motion'

export const BAR_COUNT = 15
export const BAR_WIDTH = 3
export const BAR_SPACING = 2
export const MIN_BAR_HEIGHT = 4
export const MAX_BAR_HEIGHT = 28

const DOT_SIZE = 5
const DOT_GAP = 6

const dotTransition = (delay: number) => ({
  duration: 0.9,
  repeat: Infinity,
  repeatType: 'loop' as const,
  repeatDelay: 0,
  delay,
  ease: [0.4, 0, 0.2, 1] as const,
})

export const ProgressAnimation: React.FC<{ color: string; speed?: number }> = ({
  color,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        gap: DOT_GAP,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {[0, 1, 2].map(i => (
        <motion.div
          key={i}
          style={{
            width: DOT_SIZE,
            height: DOT_SIZE,
            borderRadius: '50%',
            backgroundColor: color,
            willChange: 'transform, opacity',
          }}
          animate={{
            y: [0, -5, 0],
            opacity: [0.35, 1, 0.35],
            scale: [0.85, 1.1, 0.85],
          }}
          transition={dotTransition(i * 0.13)}
        />
      ))}
    </div>
  )
}

export const ProcessingStatusDisplay: React.FC<{
  color: string
  label?: string
}> = ({ color }) => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
      }}
    >
      <ProgressAnimation color={color} />
    </div>
  )
}
