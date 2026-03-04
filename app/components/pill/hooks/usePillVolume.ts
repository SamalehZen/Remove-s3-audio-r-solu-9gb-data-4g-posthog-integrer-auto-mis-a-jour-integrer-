import { useEffect, useRef } from 'react'
import { usePerformanceStore } from '@/app/store/usePerformanceStore'

function getBarUpdateInterval(): number {
  const { activeTier } = usePerformanceStore.getState()
  if (activeTier === 'low') return 200
  if (activeTier === 'balanced') return 100
  return 64
}

export function usePillVolume(anyRecording: boolean): React.MutableRefObject<number> {
  const audioLevelRef = useRef(0)
  const lastUpdateRef = useRef(0)

  useEffect(() => {
    if (!anyRecording) {
      audioLevelRef.current = 0
    }
  }, [anyRecording])

  useEffect(() => {
    const unsub = window.api.on('volume-update', (vol: number) => {
      const now = Date.now()
      if (now - lastUpdateRef.current < getBarUpdateInterval()) return
      lastUpdateRef.current = now
      audioLevelRef.current = vol
    })
    return unsub
  }, [])

  return audioLevelRef
}
