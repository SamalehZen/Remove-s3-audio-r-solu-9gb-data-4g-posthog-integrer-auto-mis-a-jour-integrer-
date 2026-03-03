import React, { useState, useEffect } from 'react'
import { usePerformanceStore } from '@/app/store/usePerformanceStore'

export const BAR_COUNT = 15
export const BAR_WIDTH = 3
export const BAR_SPACING = 2
export const MIN_BAR_HEIGHT = 4
export const MAX_BAR_HEIGHT = 28

export const ProgressAnimation: React.FC<{ color: string; speed?: number }> = ({
  color,
  speed = 0.3,
}) => {
  const dotCount = 5
  const dotSize = 3
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    // Slower animation interval to save CPU
    const id = setInterval(() => {
      setCurrent(c => {
        const next = c + 1
        return next > dotCount + 1 ? 0 : next
      })
    }, speed * 1000)
    return () => clearInterval(id)
  }, [speed])

  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      {Array.from({ length: dotCount }).map((_, i) => (
        <div
          key={i}
          style={{
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: color,
            opacity: i <= current ? 0.85 : 0.25,
          }}
        />
      ))}
    </div>
  )
}

export const ProcessingStatusDisplay: React.FC<{
  color: string
  label?: string
}> = ({ color, label }) => {
  const { activeTier } = usePerformanceStore.getState()
  const isLowPerformance = activeTier === 'low'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        height: MAX_BAR_HEIGHT,
      }}
    >
      <span
        style={{ color, fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap' }}
      >
        {label || 'Transcribing'}
      </span>
      {/* Only animate dots for non-low performance tiers to save CPU */}
      {!isLowPerformance && <ProgressAnimation color={color} speed={0.3} />}
      {isLowPerformance && (
        <div style={{ width: 20, height: 3, borderRadius: 2, background: color, opacity: 0.5 }} />
      )}
    </div>
  )
}
