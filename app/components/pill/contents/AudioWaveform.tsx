import React, { useEffect, useRef } from 'react'

export type AudioWaveformProps = {
  audioLevel: number
  active: boolean
  processing?: boolean
  width?: number
  height?: number
  strokeColor?: string
  strokeWidth?: number
}

const WAVE_CONFIG = [
  { frequency: 0.8, multiplier: 1.6, phaseOffset: 0, opacity: 1.0 },
  { frequency: 1.0, multiplier: 1.35, phaseOffset: 0.85, opacity: 0.78 },
  { frequency: 1.25, multiplier: 1.05, phaseOffset: 1.7, opacity: 0.56 },
]

const LEVEL_SMOOTHING = 0.18
const TARGET_DECAY_PER_FRAME = 0.985
const PHASE_SPEED = 0.045

function createWavePath(
  width: number,
  baseline: number,
  amplitude: number,
  frequency: number,
  phase: number,
): string {
  const steps = Math.max(40, Math.round(width / 2))
  const parts: string[] = []
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * width
    const t = (i / steps) * Math.PI * 2 * frequency + phase
    const y = baseline + Math.sin(t) * amplitude
    parts.push(
      i === 0
        ? `M ${x.toFixed(2)} ${y.toFixed(2)}`
        : `L ${x.toFixed(2)} ${y.toFixed(2)}`,
    )
  }
  return parts.join(' ')
}

export const AudioWaveform: React.FC<AudioWaveformProps> = ({
  audioLevel,
  active,
  processing = false,
  width = 110,
  height = 34,
  strokeColor = 'white',
  strokeWidth = 1.6,
}) => {
  const pathRefs = useRef<(SVGPathElement | null)[]>([])
  const animRef = useRef<number>(0)
  const stateRef = useRef({
    phase: 0,
    currentLevel: 0,
    targetLevel: 0,
  })
  const lastRenderRef = useRef(0)

  useEffect(() => {
    if (!active || audioLevel <= 0) return
    const boosted = Math.min(1, Math.sqrt(audioLevel) * 1.35)
    stateRef.current.targetLevel = Math.min(
      1,
      stateRef.current.targetLevel * 0.25 + boosted * 0.75,
    )
  }, [audioLevel, active])

  useEffect(() => {
    // STOP animation completely when not active - saves CPU
    if (!active && !processing) {
      cancelAnimationFrame(animRef.current)
      stateRef.current.currentLevel = 0
      stateRef.current.targetLevel = 0
      stateRef.current.phase = 0
      const baseline = height / 2
      pathRefs.current.forEach(el => {
        if (el) el.setAttribute('d', `M 0 ${baseline} L ${width} ${baseline}`)
      })
      return
    }

    const animate = (timestamp: number) => {
      // Throttle to 30fps max to save CPU when active
      if (timestamp - lastRenderRef.current < 33) {
        animRef.current = requestAnimationFrame(animate)
        return
      }
      lastRenderRef.current = timestamp

      const s = stateRef.current
      const baseline = height / 2
      const maxAmplitude = baseline * 0.8

      if (processing && !active) {
        s.targetLevel = Math.max(s.targetLevel, 0.16)
      }

      s.targetLevel *= TARGET_DECAY_PER_FRAME
      s.currentLevel += (s.targetLevel - s.currentLevel) * LEVEL_SMOOTHING
      s.phase += PHASE_SPEED

      WAVE_CONFIG.forEach((wave, i) => {
        const el = pathRefs.current[i]
        if (!el) return
        const amp = s.currentLevel * maxAmplitude * wave.multiplier
        const d = createWavePath(
          width,
          baseline,
          amp,
          wave.frequency,
          s.phase + wave.phaseOffset,
        )
        el.setAttribute('d', d)
      })

      animRef.current = requestAnimationFrame(animate)
    }

    animRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animRef.current)
  }, [active, processing, width, height])

  const baseline = height / 2

  return (
    <svg
      width={width}
      height={height}
      style={{ display: 'block', flexShrink: 0 }}
    >
      {WAVE_CONFIG.map((wave, i) => (
        <path
          key={i}
          ref={el => {
            pathRefs.current[i] = el
          }}
          d={`M 0 ${baseline} L ${width} ${baseline}`}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          opacity={wave.opacity}
          strokeLinecap="round"
        />
      ))}
    </svg>
  )
}

export default AudioWaveform
