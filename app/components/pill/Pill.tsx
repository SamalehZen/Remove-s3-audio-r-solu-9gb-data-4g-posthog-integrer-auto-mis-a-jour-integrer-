import React, { useState, useEffect, useRef } from 'react'
import { usePerformanceStore } from '../../store/usePerformanceStore'
import { Square, X } from '@mynaui/icons-react'
import { useSettingsStore } from '../../store/useSettingsStore'
import {
  useOnboardingStore,
  ONBOARDING_CATEGORIES,
} from '../../store/useOnboardingStore'
import { ProcessingStatusDisplay } from './contents/AudioBarsBase'
import { AudioWaveform } from './contents/AudioWaveform'
import { useAudioStore } from '@/app/store/useAudioStore'
import { analytics, ANALYTICS_EVENTS } from '../analytics'
import { ItoIcon } from '../icons/ItoIcon'
import { soundPlayer } from '@/app/utils/soundPlayer'
import { useKeyboardPredictiveStore } from '@/app/store/useKeyboardPredictiveStore'
import type {
  RecordingStatePayload,
  ProcessingStatePayload,
} from '@/lib/types/ipc'
import type { AppTarget } from '@/app/store/useAppStylingStore'
import { ItoMode } from '@/app/generated/ito_pb'

const MIN_PILL_WIDTH = 48
const MIN_PILL_HEIGHT = 6
const EXPANDED_PILL_WIDTH = 180
const EXPANDED_PILL_HEIGHT = 34

function getBarUpdateInterval(): number {
  const { activeTier } = usePerformanceStore.getState()
  if (activeTier === 'low') return 200
  if (activeTier === 'balanced') return 100
  return 64
}

const Pill = () => {
  const initialShowItoBarAlways = useSettingsStore(
    state => state.showItoBarAlways,
  )
  const initialInteractionSounds = useSettingsStore(
    state => state.interactionSounds,
  )
  const initialOnboardingCategory = useOnboardingStore(
    state => state.onboardingCategory,
  )
  const initialOnboardingCompleted = useOnboardingStore(
    state => state.onboardingCompleted,
  )
  const { startRecording, stopRecording } = useAudioStore()
  const config = usePerformanceStore(s => s.config)

  const [isRecording, setIsRecording] = useState(false)
  const [isManualRecording, setIsManualRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isAgentMode, setIsAgentMode] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const isManualRecordingRef = useRef(false)
  const [interactionSounds, setInteractionSoundsLocal] = useState(
    initialInteractionSounds,
  )
  const interactionSoundsRef = useRef(initialInteractionSounds)
  const [showItoBarAlways, setShowItoBarAlways] = useState(
    initialShowItoBarAlways,
  )
  const [onboardingCategory, setOnboardingCategory] = useState(
    initialOnboardingCategory,
  )
  const [onboardingCompleted, setOnboardingCompleted] = useState(
    initialOnboardingCompleted,
  )
  const volumeHistoryRef = useRef<number[]>([])
  const lastVolumeUpdateRef = useRef(0)
  const [volumeHistory, setVolumeHistory] = useState<number[]>([])
  const [appTarget, setAppTarget] = useState<AppTarget | null>(null)
  const [contextSource, setContextSource] = useState<
    'screen' | 'selection' | null
  >(null)
  const [screenThumbnail, setScreenThumbnail] = useState<string | null>(null)
  const [currentMode, setCurrentMode] = useState<ItoMode | undefined>(undefined)
  const isRecordingRef = useRef(false)
  const hasBeenShownRef = useRef(false)
  const stylesInjectedRef = useRef(false)
  const [isKeyboardActive, setIsKeyboardActive] = useState(false)
  const keyboardModeRef = useRef<ItoMode | null>(null)

  // Ultra-fast animations for keyboard (80ms) vs hover (200ms)
  const isAnyActive = isRecording || isManualRecording || isProcessing || isKeyboardActive
  const animDuration = config.animationDurationMultiplier === 0
    ? '0s'
    : isAnyActive
      ? '0.08s' // Ultra-fast for keyboard
      : '0.2s'  // Normal for hover
  const blurValue = config.enableBackdropBlur ? 'blur(14px)' : 'none'
  // Ultra-fast content transition for keyboard (50ms) vs hover (150ms)
  const contentTransition = config.animationDurationMultiplier === 0
    ? '0s'
    : isAnyActive
      ? '0.05s' // Instant for keyboard
      : '0.15s' // Normal for hover
  const currentAudioLevel = volumeHistory[volumeHistory.length - 1] || 0

  // Pre-warmed flag to prevent first-touch lag
  const isPreWarmedRef = useRef(false)
  useEffect(() => {
    if (isPreWarmedRef.current) return
    isPreWarmedRef.current = true
    // Pre-warm by forcing a micro-transition on mount
    requestAnimationFrame(() => {
      // This triggers the GPU to prepare the blur shader
      document.body.style.setProperty('--pill-pre-warmed', 'true')
    })
  }, [])

  useEffect(() => {
    const idleId = requestIdleCallback(() => soundPlayer.init(), { timeout: 2000 })
    return () => {
      cancelIdleCallback(idleId)
      soundPlayer.dispose()
    }
  }, [])

  useEffect(() => {
    if (stylesInjectedRef.current) return
    stylesInjectedRef.current = true
    const style = document.createElement('style')
    style.textContent = `
      html, body, #app {
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent !important;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        pointer-events: none;
        font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
    `
    document.head.appendChild(style)
    if (document.fonts) {
      document.fonts.load('11px Inter').catch(() => {})
      document.fonts.load('10px Inter').catch(() => {})
    }
  }, [])

  useEffect(() => {
    interactionSoundsRef.current = interactionSounds
  }, [interactionSounds])

  // Listen for predictive keyboard events for instant UI feedback
  useEffect(() => {
    const unsubPredictive = window.api.on(
      'shortcut-predictive-activate',
      ({ mode, isAgent }: { mode: ItoMode; isAgent: boolean }) => {
        // IMMEDIATE: Show pill before recording actually starts
        setIsKeyboardActive(true)
        keyboardModeRef.current = mode
        setCurrentMode(mode)
        setIsAgentMode(isAgent)

        // Play sound immediately for instant feedback
        if (interactionSoundsRef.current) {
          soundPlayer.play('recording-start')
        }

        analytics.track(ANALYTICS_EVENTS.RECORDING_STARTED, {
          is_recording: true,
          mode,
          source: 'keyboard',
        })
      },
    )

    const unsubPredictiveStop = window.api.on(
      'shortcut-predictive-deactivate',
      () => {
        // IMMEDIATE: Start fade out before recording actually stops
        setIsKeyboardActive(false)
        keyboardModeRef.current = null
      },
    )

    return () => {
      unsubPredictive()
      unsubPredictiveStop()
    }
  }, [])

  useEffect(() => {
    const unsubRecording = window.api.on(
      'recording-state-update',
      (state: RecordingStatePayload) => {
        const wasRecording = isRecordingRef.current
        isRecordingRef.current = state.isRecording
        setIsRecording(state.isRecording)

        if (state.isRecording) {
          if (
            state.appTargetName !== undefined ||
            state.appTargetIconBase64 !== undefined
          ) {
            setAppTarget(prev => {
              const newName = state.appTargetName ?? prev?.name ?? 'Ito'
              const incomingIcon =
                state.appTargetIconBase64 !== undefined
                  ? (state.appTargetIconBase64 ?? null)
                  : (prev?.iconBase64 ?? null)

              const newIcon =
                !incomingIcon && prev?.iconBase64 && newName === prev.name
                  ? prev.iconBase64
                  : incomingIcon

              if (
                prev &&
                prev.name === newName &&
                prev.iconBase64 === newIcon
              ) {
                return prev
              }

              return { name: newName, iconBase64: newIcon } as AppTarget
            })
          } else if (!wasRecording) {
            setAppTarget(null)
          }
        }

        if (state.contextSource) {
          setContextSource(state.contextSource)
        }

        if (state.screenThumbnailBase64) {
          setScreenThumbnail(state.screenThumbnailBase64)
        }

        if (state.mode !== undefined) {
          setCurrentMode(state.mode)
        }

        // Sound and analytics are handled by predictive events for instant feedback
        // Only handle here for manual recording or if predictive missed it
        if (
          interactionSoundsRef.current &&
          wasRecording !== state.isRecording &&
          !isKeyboardActive // Avoid double sound for keyboard shortcuts
        ) {
          soundPlayer.play(
            state.isRecording ? 'recording-start' : 'recording-stop',
          )
        }

        if (
          !isManualRecordingRef.current &&
          wasRecording !== state.isRecording &&
          !isKeyboardActive // Analytics already tracked by predictive event
        ) {
          const analyticsEvent = state.isRecording
            ? ANALYTICS_EVENTS.RECORDING_STARTED
            : ANALYTICS_EVENTS.RECORDING_COMPLETED
          analytics.track(analyticsEvent, {
            is_recording: state.isRecording,
            mode: state.mode,
          })
        }

        if (!state.isRecording) {
          setIsManualRecording(false)
          isManualRecordingRef.current = false
          volumeHistoryRef.current = []
          setVolumeHistory([])
        }
      },
    )

    const unsubProcessing = window.api.on(
      'processing-state-update',
      (state: ProcessingStatePayload) => {
        setIsProcessing(state.isProcessing)
        if (state.isAgent !== undefined) {
          setIsAgentMode(state.isAgent)
        }
        if (!state.isProcessing) {
          setIsAgentMode(false)
        }
      },
    )

    const unsubVolume = window.api.on('volume-update', (vol: number) => {
      const now = Date.now()
      if (now - lastVolumeUpdateRef.current < getBarUpdateInterval()) {
        return
      }
      const newHistory = [...volumeHistoryRef.current, vol]
      if (newHistory.length > 42) {
        newHistory.shift()
      }
      volumeHistoryRef.current = newHistory
      lastVolumeUpdateRef.current = now
      setVolumeHistory(newHistory)
    })

    const unsubSettings = window.api.on('settings-update', (settings: any) => {
      setShowItoBarAlways(settings.showItoBarAlways)
      setInteractionSoundsLocal(settings.interactionSounds)
    })

    const unsubOnboarding = window.api.on(
      'onboarding-update',
      (onboarding: any) => {
        setOnboardingCategory(onboarding.onboardingCategory)
        setOnboardingCompleted(onboarding.onboardingCompleted)
      },
    )

    const unsubUserAuth = window.api.on('user-auth-update', (authUser: any) => {
      if (authUser) {
        analytics.identifyUser(
          authUser.id,
          {
            user_id: authUser.id,
            email: authUser.email,
            name: authUser.name,
            provider: authUser.provider,
          },
          authUser.provider,
        )
      } else {
        analytics.resetUser()
      }
    })

    return () => {
      unsubRecording()
      unsubProcessing()
      unsubVolume()
      unsubSettings()
      unsubOnboarding()
      unsubUserAuth()
    }
  }, [])

  useEffect(() => {
    if (!isRecording && !isManualRecording && !isProcessing && !isKeyboardActive) {
      setAppTarget(null)
      setContextSource(null)
      setScreenThumbnail(null)
      setCurrentMode(undefined)
    }
  }, [isRecording, isManualRecording, isProcessing, isKeyboardActive])

  const anyRecording = isRecording || isManualRecording || isKeyboardActive
  const isIdle = !anyRecording && !isProcessing
  const isExpanded = isHovered || anyRecording || isProcessing || isKeyboardActive

  const isActive = anyRecording || isProcessing || isKeyboardActive
  const shouldShow =
    (onboardingCategory === ONBOARDING_CATEGORIES.TRY_IT ||
      onboardingCompleted) &&
    (isActive || showItoBarAlways || isHovered || isKeyboardActive)

  if (shouldShow) {
    hasBeenShownRef.current = true
  }

  const handleMouseEnter = () => {
    setIsHovered(true)
    window.api?.send('pill-set-mouse-events', false)
  }

  const handleMouseLeave = () => {
    setIsHovered(false)
    window.api?.send('pill-set-mouse-events', true, { forward: true })
  }

  const handleClick = () => {
    if (isHovered && !anyRecording && !isProcessing) {
      setIsManualRecording(true)
      isManualRecordingRef.current = true
      startRecording()
      analytics.track(ANALYTICS_EVENTS.MANUAL_RECORDING_STARTED, {
        is_recording: true,
      })
    }
  }

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsManualRecording(false)
    stopRecording()
    analytics.track(ANALYTICS_EVENTS.MANUAL_RECORDING_ABANDONED, {
      is_recording: false,
    })
  }

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsManualRecording(false)
    stopRecording()
    analytics.track(ANALYTICS_EVENTS.MANUAL_RECORDING_COMPLETED, {
      is_recording: false,
    })
  }

  const processingLabel = isAgentMode
    ? 'Agent...'
    : currentMode === ItoMode.CONTEXT_AWARENESS
      ? 'Analyzing...'
      : 'Transcribing'

  const renderActiveContent = () => {
    if (isManualRecording) {
      return (
        <>
          <button
            onClick={handleCancel}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: 0.6,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
            }}
          >
            <X width={14} height={14} color="white" />
          </button>
          <AudioWaveform
            audioLevel={currentAudioLevel}
            active
            width={80}
            height={EXPANDED_PILL_HEIGHT}
          />
          <button
            onClick={handleStop}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: 0.8,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
            }}
          >
            <Square width={14} height={14} color="white" fill="currentColor" />
          </button>
        </>
      )
    }

    if (anyRecording) {
      return (
        <AudioWaveform
          audioLevel={currentAudioLevel}
          active
          width={100}
          height={EXPANDED_PILL_HEIGHT}
        />
      )
    }

    if (isProcessing) {
      return <ProcessingStatusDisplay color="white" label={processingLabel} />
    }

    return null
  }

  return (
    <>
      {/* GPU blur shader warm-up — off-screen, forces shader compilation on mount */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          top: -9999,
          left: -9999,
          width: 1,
          height: 1,
          backdropFilter: blurValue,
          WebkitBackdropFilter: blurValue,
          pointerEvents: 'none',
          opacity: 0.01,
          zIndex: -1,
        }}
      />
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-end',
          pointerEvents: 'none',
          zIndex: 50,
          contain: 'layout style',
        }}
      >
        <div
          style={{
            opacity: !hasBeenShownRef.current && !shouldShow ? 0 : undefined,
            animation:
              hasBeenShownRef.current || shouldShow
                ? shouldShow
                  ? `pill-fadeIn ${animDuration} ease-out forwards`
                  : `pill-fadeOut ${animDuration} ease-in forwards`
                : 'none',
            pointerEvents: shouldShow ? 'auto' : 'none',
          }}
        >
          <div
            style={{
              padding: 10,
              background: 'transparent',
              pointerEvents: 'auto',
              contain: 'style',
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <div
              style={{
                opacity: isHovered && isIdle ? 1 : 0,
                transform:
                  isHovered && isIdle ? 'translateY(0)' : 'translateY(4px)',
                transition: `opacity ${contentTransition} ease-out, transform ${contentTransition} ease-out`,
                pointerEvents: 'none',
                textAlign: 'center',
                marginBottom: 4,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  color: 'rgba(255,255,255,0.55)',
                  whiteSpace: 'nowrap',
                  userSelect: 'none',
                }}
              >
                Click to dictate
              </span>
            </div>

            <div style={{ position: 'relative', paddingBottom: 4 }}>
              <button
                onClick={handleCancel}
                style={{
                  position: 'absolute',
                  top: -8,
                  right: -8,
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  background: 'rgba(255,255,255,0.15)',
                  border: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  zIndex: 10,
                  opacity: !isIdle && isHovered ? 1 : 0,
                  transform: !isIdle && isHovered ? 'scale(1)' : 'scale(0)',
                  pointerEvents: !isIdle && isHovered ? 'auto' : 'none',
                  transition: `opacity ${animDuration} ease-out, transform ${animDuration} ease-out`,
                  padding: 0,
                }}
              >
                <X width={12} height={12} color="white" />
              </button>

              <div
                onClick={handleClick}
                data-keep-transform="true"
                style={{
                  width: isExpanded ? EXPANDED_PILL_WIDTH : MIN_PILL_WIDTH,
                  height: isExpanded ? EXPANDED_PILL_HEIGHT : MIN_PILL_HEIGHT,
                  borderRadius: isExpanded ? 16 : 6,
                  background: isExpanded
                    ? 'rgba(0,0,0,0.92)'
                    : 'rgba(0,0,0,0.6)',
                  border: '1px solid rgba(255,255,255,0.3)',
                  backdropFilter: blurValue,
                  WebkitBackdropFilter: blurValue,
                  transition: `width ${animDuration} ease-out, height ${animDuration} ease-out, border-radius ${animDuration} ease-out, background-color ${animDuration} ease-out, border-color ${animDuration} ease-out`,
                  cursor: 'pointer',
                  overflow: 'hidden',
                  contain: 'layout paint style',
                  willChange: 'transform, opacity, width, height',
                  transform: 'translateZ(0)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '0 10px',
                    width: '100%',
                    height: '100%',
                    opacity: isExpanded ? 1 : 0,
                    transition: `opacity ${contentTransition} ease-out`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      flexShrink: 0,
                    }}
                  >
                    {appTarget?.iconBase64 ? (
                      <img
                        draggable={false}
                        src={`data:image/png;base64,${appTarget.iconBase64}`}
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 3,
                          flexShrink: 0,
                        }}
                      />
                    ) : (
                      <ItoIcon width={18} height={18} className="text-white" />
                    )}
                    {contextSource === 'screen' && screenThumbnail && (
                      <img
                        draggable={false}
                        src={`data:image/png;base64,${screenThumbnail}`}
                        style={{
                          width: 24,
                          height: 14,
                          borderRadius: 2,
                          objectFit: 'cover',
                          border: '1px solid rgba(255,255,255,0.2)',
                          flexShrink: 0,
                        }}
                      />
                    )}
                    {contextSource === 'selection' && (
                      <span
                        style={{
                          fontSize: 10,
                          color: 'rgba(255,255,255,0.5)',
                        }}
                      >
                        📝
                      </span>
                    )}
                  </div>

                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: 0,
                      position: 'relative',
                    }}
                  >
                    {/* Always-rendered idle content — avoids first-mount layout shift */}
                    <span
                      style={{
                        fontSize: 11,
                        color: 'rgba(255,255,255,0.4)',
                        whiteSpace: 'nowrap',
                        position: 'absolute',
                        opacity: isHovered && isIdle ? 1 : 0,
                        transition: `opacity ${contentTransition} ease-out`,
                        pointerEvents: 'none',
                      }}
                    >
                      Click to dictate
                    </span>

                    {/* Dynamic active content layered on top */}
                    {!isIdle && renderActiveContent()}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default Pill
