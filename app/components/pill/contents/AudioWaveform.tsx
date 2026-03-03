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
  { frequency: 0.65, multiplier: 1.5, phaseOffset: 0, opacity: 0.95 },
  { frequency: 0.85, multiplier: 1.2, phaseOffset: 0.7, opacity: 0.6 },
  { frequency: 1.1, multiplier: 0.85, phaseOffset: 1.5, opacity: 0.35 },
]

const LEVEL_SMOOTHING = 0.14
const TARGET_DECAY_PER_FRAME = 0.988
const PHASE_SPEED = 0.035

function createSmoothWavePath(
  width: number,
  baseline: number,
  amplitude: number,
  frequency: number,
  phase: number,
): string {
  const steps = Math.max(48, Math.round(width / 1.5))
  const points: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * width
    const t = (i / steps) * Math.PI * 2 * frequency + phase
    const envelope = Math.sin((i / steps) * Math.PI)
    const y = baseline + Math.sin(t) * amplitude * envelope
    points.push([x, y])
  }
  if (points.length < 2) return `M 0 ${baseline} L ${width} ${baseline}`
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`
  for (let i = 0; i < points.length - 1; i++) {
    const cx = (points[i][0] + points[i + 1][0]) / 2
    const cy = (points[i][1] + points[i + 1][1]) / 2
    d += ` Q ${points[i][0].toFixed(2)} ${points[i][1].toFixed(2)} ${cx.toFixed(2)} ${cy.toFixed(2)}`
  }
  const last = points[points.length - 1]
  d += ` L ${last[0].toFixed(2)} ${last[1].toFixed(2)}`
  return d
}

export const AudioWaveform: React.FC<AudioWaveformProps> = ({
  audioLevel,
  active,
  processing = false,
  width = 90,
  height = 34,
  strokeColor = 'rgba(255,255,255,0.9)',
  strokeWidth = 1.5,
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
    const boosted = Math.min(1, Math.sqrt(audioLevel) * 1.4)
    stateRef.current.targetLevel = Math.min(
      1,
      stateRef.current.targetLevel * 0.2 + boosted * 0.8,
    )
  }, [audioLevel, active])

  useEffect(() => {
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
      if (timestamp - lastRenderRef.current < 33) {
        animRef.current = requestAnimationFrame(animate)
        return
      }
      lastRenderRef.current = timestamp

      const s = stateRef.current
      const baseline = height / 2
      const maxAmplitude = baseline * 0.75

      if (processing && !active) {
        s.targetLevel = Math.max(s.targetLevel, 0.14)
      }

      s.targetLevel *= TARGET_DECAY_PER_FRAME
      s.currentLevel += (s.targetLevel - s.currentLevel) * LEVEL_SMOOTHING
      s.phase += PHASE_SPEED

      WAVE_CONFIG.forEach((wave, i) => {
        const el = pathRefs.current[i]
        if (!el) return
        const amp = s.currentLevel * maxAmplitude * wave.multiplier
        const d = createSmoothWavePath(
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
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}

export default AudioWaveform
