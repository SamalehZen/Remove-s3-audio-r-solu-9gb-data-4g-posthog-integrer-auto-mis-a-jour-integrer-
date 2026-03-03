import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
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
import type {
  RecordingStatePayload,
  ProcessingStatePayload,
} from '@/lib/types/ipc'
import type { AppTarget } from '@/app/store/useAppStylingStore'
import { ItoMode } from '@/app/generated/ito_pb'

// Enhanced dimensions - slightly larger for better presence
const MIN_PILL_WIDTH = 52
const MIN_PILL_HEIGHT = 8
const EXPANDED_PILL_WIDTH = 200
const EXPANDED_PILL_HEIGHT = 42

function getBarUpdateInterval(): number {
  const { activeTier } = usePerformanceStore.getState()
  if (activeTier === 'low') return 200
  if (activeTier === 'balanced') return 100
  return 64
}

// Animation variants for Framer Motion
const pillVariants = {
  idle: {
    width: MIN_PILL_WIDTH,
    height: MIN_PILL_HEIGHT,
    borderRadius: 8,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 30,
      mass: 0.8,
    },
  },
  expanded: {
    width: EXPANDED_PILL_WIDTH,
    height: EXPANDED_PILL_HEIGHT,
    borderRadius: 20,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 25,
      mass: 0.8,
    },
  },
  recording: {
    width: EXPANDED_PILL_WIDTH,
    height: EXPANDED_PILL_HEIGHT,
    borderRadius: 20,
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 20,
      mass: 0.6,
    },
  },
}

const contentVariants = {
  hidden: {
    opacity: 0,
    scale: 0.8,
    y: 10,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 300,
      damping: 25,
      staggerChildren: 0.05,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.9,
    y: -5,
    transition: {
      duration: 0.15,
      ease: 'easeIn',
    },
  },
}

const labelVariants = {
  hidden: { opacity: 0, y: 8, scale: 0.9 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 25,
    },
  },
  exit: {
    opacity: 0,
    y: -4,
    transition: { duration: 0.1 },
  },
}

const cancelButtonVariants = {
  hidden: { opacity: 0, scale: 0, rotate: -90 },
  visible: {
    opacity: 1,
    scale: 1,
    rotate: 0,
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 20,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.5,
    rotate: 90,
    transition: { duration: 0.15 },
  },
}

const glowVariants = {
  idle: {
    boxShadow: '0 0 0px rgba(255,255,255,0)',
  },
  hover: {
    boxShadow: '0 0 20px rgba(255,255,255,0.15), 0 4px 20px rgba(0,0,0,0.3)',
    transition: {
      duration: 0.3,
      ease: 'easeOut',
    },
  },
  recording: {
    boxShadow: '0 0 30px rgba(59,130,246,0.4), 0 0 60px rgba(59,130,246,0.2)',
    transition: {
      duration: 0.3,
      ease: 'easeOut',
    },
  },
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
  const stylesInjectedRef = useRef(false)
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const controls = useAnimation()

  const blurValue = config.enableBackdropBlur ? 'blur(16px)' : 'none'
  const currentAudioLevel = volumeHistory[volumeHistory.length - 1] || 0

  // Determine pill state
  const anyRecording = isRecording || isManualRecording
  const isIdle = !anyRecording && !isProcessing
  const isExpanded = isHovered || anyRecording || isProcessing
  const isActive = anyRecording || isProcessing

  const shouldShow =
    (onboardingCategory === ONBOARDING_CATEGORIES.TRY_IT ||
      onboardingCompleted) &&
    (isActive || showItoBarAlways || isHovered)

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
      document.fonts.load('13px Inter').catch(() => {})
      document.fonts.load('11px Inter').catch(() => {})
    }
  }, [])

  useEffect(() => {
    interactionSoundsRef.current = interactionSounds
  }, [interactionSounds])

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

        if (
          interactionSoundsRef.current &&
          wasRecording !== state.isRecording
        ) {
          soundPlayer.play(
            state.isRecording ? 'recording-start' : 'recording-stop',
          )
        }

        if (
          !isManualRecordingRef.current &&
          wasRecording !== state.isRecording
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
    if (!isRecording && !isManualRecording && !isProcessing) {
      setAppTarget(null)
      setContextSource(null)
      setScreenThumbnail(null)
      setCurrentMode(undefined)
    }
  }, [isRecording, isManualRecording, isProcessing])

  // Precise hover handling with instant leave
  const handleMouseEnter = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
      hoverTimeoutRef.current = null
    }
    setIsHovered(true)
    window.api?.send('pill-set-mouse-events', false)
  }, [])

  const handleMouseLeave = useCallback(() => {
    // INSTANT close - no delay
    setIsHovered(false)
    window.api?.send('pill-set-mouse-events', true, { forward: true })
  }, [])

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

  // Get current variant based on state
  const getPillVariant = () => {
    if (anyRecording || isProcessing) return 'recording'
    if (isExpanded) return 'expanded'
    return 'idle'
  }

  const getGlowVariant = () => {
    if (anyRecording || isProcessing) return 'recording'
    if (isHovered) return 'hover'
    return 'idle'
  }

  // Gradient background instead of pure black
  const getBackground = () => {
    if (isExpanded) {
      return 'linear-gradient(145deg, rgba(30,30,35,0.95) 0%, rgba(20,20,25,0.92) 50%, rgba(15,15,20,0.95) 100%)'
    }
    return 'linear-gradient(145deg, rgba(40,40,45,0.7) 0%, rgba(30,30,35,0.6) 100%)'
  }

  return (
    <>
      {/* GPU blur warm-up */}
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
      
      <AnimatePresence>
        {shouldShow && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 15, scale: 0.95 }}
            transition={{
              type: 'spring',
              stiffness: 400,
              damping: 30,
              mass: 0.8,
            }}
            style={{
              position: 'fixed',
              bottom: 20,
              left: '50%',
              x: '-50%',
              zIndex: 50,
              pointerEvents: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {/* Label above pill */}
            <AnimatePresence mode="wait">
              {isHovered && isIdle && (
                <motion.div
                  variants={labelVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  style={{
                    pointerEvents: 'none',
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.6)',
                      whiteSpace: 'nowrap',
                      userSelect: 'none',
                      letterSpacing: '0.3px',
                      textShadow: '0 1px 2px rgba(0,0,0,0.3)',
                    }}
                  >
                    Click to dictate
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Pill container with precise hitbox */}
            <div
              style={{
                position: 'relative',
                // Precise hitbox - only the pill area
                padding: 0,
                margin: 0,
              }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              {/* Cancel button - only visible during manual recording */}
              <AnimatePresence>
                {isManualRecording && isHovered && (
                  <motion.button
                    variants={cancelButtonVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    onClick={handleCancel}
                    style={{
                      position: 'absolute',
                      top: -10,
                      right: -10,
                      width: 24,
                      height: 24,
                      borderRadius: 12,
                      background: 'linear-gradient(135deg, rgba(239,68,68,0.9) 0%, rgba(220,38,38,0.9) 100%)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      zIndex: 20,
                      padding: 0,
                      boxShadow: '0 2px 8px rgba(239,68,68,0.4)',
                    }}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.95 }}
                  >
                    <X width={14} height={14} color="white" strokeWidth={2.5} />
                  </motion.button>
                )}
              </AnimatePresence>

              {/* Main Pill */}
              <motion.div
                variants={pillVariants}
                initial="idle"
                animate={getPillVariant()}
                style={{
                  background: getBackground(),
                  border: '1px solid rgba(255,255,255,0.12)',
                  backdropFilter: blurValue,
                  WebkitBackdropFilter: blurValue,
                  cursor: isIdle ? 'pointer' : 'default',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                }}
                animate={{
                  ...pillVariants[getPillVariant()],
                  boxShadow: glowVariants[getGlowVariant()].boxShadow,
                }}
                transition={pillVariants[getPillVariant()].transition}
                onClick={handleClick}
              >
                {/* Inner glow effect */}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: 'inherit',
                    background: isExpanded
                      ? 'linear-gradient(145deg, rgba(255,255,255,0.08) 0%, transparent 50%, rgba(255,255,255,0.03) 100%)'
                      : 'linear-gradient(145deg, rgba(255,255,255,0.05) 0%, transparent 60%)',
                    pointerEvents: 'none',
                  }}
                />

                {/* Content */}
                <AnimatePresence mode="wait">
                  {isExpanded ? (
                    <motion.div
                      key="expanded"
                      variants={contentVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '0 16px',
                        width: '100%',
                        height: '100%',
                      }}
                    >
                      {/* Left: App icon + context */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          flexShrink: 0,
                        }}
                      >
                        {appTarget?.iconBase64 ? (
                          <motion.img
                            initial={{ scale: 0, rotate: -10 }}
                            animate={{ scale: 1, rotate: 0 }}
                            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                            draggable={false}
                            src={`data:image/png;base64,${appTarget.iconBase64}`}
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: 5,
                              flexShrink: 0,
                              boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                            }}
                          />
                        ) : (
                          <motion.div
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                          >
                            <ItoIcon width={22} height={22} className="text-white" />
                          </motion.div>
                        )}
                        
                        {contextSource === 'screen' && screenThumbnail && (
                          <motion.img
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ delay: 0.1, type: 'spring', stiffness: 400 }}
                            draggable={false}
                            src={`data:image/png;base64,${screenThumbnail}`}
                            style={{
                              width: 32,
                              height: 20,
                              borderRadius: 3,
                              objectFit: 'cover',
                              border: '1px solid rgba(255,255,255,0.25)',
                              flexShrink: 0,
                            }}
                          />
                        )}
                        
                        {contextSource === 'selection' && (
                          <motion.span
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: 'spring', stiffness: 400 }}
                            style={{
                              fontSize: 14,
                            }}
                          >
                            📝
                          </motion.span>
                        )}
                      </div>

                      {/* Center: Content */}
                      <div
                        style={{
                          flex: 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minWidth: 0,
                        }}
                      >
                        <AnimatePresence mode="wait">
                          {isIdle ? (
                            <motion.span
                              key="idle-text"
                              initial={{ opacity: 0, y: 5 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -5 }}
                              transition={{ duration: 0.15 }}
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: 'rgba(255,255,255,0.5)',
                                whiteSpace: 'nowrap',
                                letterSpacing: '0.2px',
                              }}
                            >
                              Click to dictate
                            </motion.span>
                          ) : (
                            <motion.div
                              key="active-content"
                              initial={{ opacity: 0, scale: 0.9 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.9 }}
                              transition={{ duration: 0.2 }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                              }}
                            >
                              {isManualRecording ? (
                                <>
                                  <AudioWaveform
                                    audioLevel={currentAudioLevel}
                                    active
                                    width={90}
                                    height={EXPANDED_PILL_HEIGHT}
                                  />
                                  <motion.button
                                    onClick={handleStop}
                                    whileHover={{ scale: 1.15 }}
                                    whileTap={{ scale: 0.9 }}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      background: 'rgba(255,255,255,0.15)',
                                      border: '1px solid rgba(255,255,255,0.2)',
                                      borderRadius: 8,
                                      padding: '6px',
                                      cursor: 'pointer',
                                    }}
                                  >
                                    <Square width={16} height={16} color="white" fill="currentColor" />
                                  </motion.button>
                                </>
                              ) : anyRecording ? (
                                <AudioWaveform
                                  audioLevel={currentAudioLevel}
                                  active
                                  width={120}
                                  height={EXPANDED_PILL_HEIGHT}
                                />
                              ) : isProcessing ? (
                                <ProcessingStatusDisplay color="white" label={processingLabel} />
                              ) : null}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </motion.div>
                  ) : (
                    /* Collapsed state - just a line */
                    <motion.div
                      key="collapsed"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      style={{
                        width: '60%',
                        height: 3,
                        borderRadius: 2,
                        background: 'linear-gradient(90deg, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0.6) 50%, rgba(255,255,255,0.4) 100%)',
                        boxShadow: '0 0 8px rgba(255,255,255,0.3)',
                      }}
                    />
                  )}
                </AnimatePresence>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

export default Pill
