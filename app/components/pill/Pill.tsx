import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePerformanceStore } from '../../store/usePerformanceStore'
import { Square, X } from '@mynaui/icons-react'
import { useSettingsStore } from '../../store/useSettingsStore'
import {
  useOnboardingStore,
  ONBOARDING_CATEGORIES,
} from '../../store/useOnboardingStore'
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

const IDLE_PILL_WIDTH = 40
const IDLE_PILL_HEIGHT = 8
const EXPANDED_PILL_WIDTH = 130
const EXPANDED_PILL_HEIGHT = 34
const THINKING_PILL_WIDTH = 45
const THINKING_PILL_HEIGHT = 34
const SILVER = 'rgba(200, 200, 210, 0.9)'

function getBarUpdateInterval(): number {
  const { activeTier } = usePerformanceStore.getState()
  if (activeTier === 'low') return 200
  if (activeTier === 'balanced') return 100
  return 64
}

// Animation variants - sans animations infinies pour économiser CPU
const pillContainerVariants = {
  hidden: {
    opacity: 0,
    y: 20,
    scale: 0.9,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 25,
      mass: 0.8,
    },
  },
  exit: {
    opacity: 0,
    y: 15,
    scale: 0.95,
    transition: {
      duration: 0.2,
    },
  },
}

const idleLineVariants = {
  initial: {
    width: IDLE_PILL_WIDTH,
    height: IDLE_PILL_HEIGHT,
    borderRadius: 4,
    transition: {
      type: 'spring',
      stiffness: 600,
      damping: 15,
      mass: 0.4,
    },
  },
  hover: {
    width: EXPANDED_PILL_WIDTH,
    height: EXPANDED_PILL_HEIGHT,
    borderRadius: 17,
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
    borderRadius: 17,
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 20,
      mass: 0.6,
    },
  },
  thinking: {
    width: THINKING_PILL_WIDTH,
    height: THINKING_PILL_HEIGHT,
    borderRadius: 17,
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 20,
      mass: 0.5,
    },
  },
}

const ThinkingDots = () => (
  <div style={{ display: 'flex', gap: 5, alignItems: 'center', justifyContent: 'center' }}>
    {[0, 1, 2].map(i => (
      <motion.div
        key={i}
        animate={{
          y: [0, -5, 0],
          opacity: [0.35, 1, 0.35],
        }}
        transition={{
          duration: 0.8,
          repeat: Infinity,
          delay: i * 0.2,
          ease: 'easeInOut',
        }}
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: SILVER,
        }}
      />
    ))}
  </div>
)

const contentRevealVariants = {
  hidden: {
    opacity: 0,
    scale: 0.9,
    y: 10,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 25,
      mass: 0.8,
      staggerChildren: 0.05,
      delayChildren: 0.02,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: -5,
    transition: {
      duration: 0.12,
    },
  },
}

const iconPopVariants = {
  hidden: { scale: 0.8, opacity: 0 },
  visible: {
    scale: 1,
    opacity: 1,
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 15,
      mass: 0.6,
    },
  },
}

const labelFloatVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 20,
    },
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: { duration: 0.1 },
  },
}

const cancelButtonVariants = {
  hidden: { scale: 0, opacity: 0 },
  visible: {
    scale: 1,
    opacity: 1,
    transition: {
      type: 'spring',
      stiffness: 600,
      damping: 15,
    },
  },
  exit: {
    scale: 0,
    opacity: 0,
    transition: { duration: 0.12 },
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

  const blurValue = config.enableBackdropBlur ? 'blur(16px)' : 'none'
  const currentAudioLevel = volumeHistory[volumeHistory.length - 1] || 0

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
      document.fonts.load('12px Inter').catch(() => {})
      document.fonts.load('10px Inter').catch(() => {})
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

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true)
    window.api?.send('pill-set-mouse-events', false)
  }, [])

  const handleMouseLeave = useCallback(() => {
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

  const getLineVariant = () => {
    if (anyRecording) return 'recording'
    if (isProcessing) return 'thinking'
    if (isHovered) return 'hover'
    return 'initial'
  }

  // Couleurs neutres - pas de glow
  const getBackground = () => {
    if (anyRecording) {
      // Gris neutre pendant recording
      return 'linear-gradient(135deg, rgba(55,55,65,0.95) 0%, rgba(45,45,55,0.92) 100%)'
    }
    if (isProcessing) {
      // Gris neutre pendant processing
      return 'linear-gradient(135deg, rgba(55,55,65,0.95) 0%, rgba(45,45,55,0.92) 100%)'
    }
    if (isHovered) {
      // Gris foncé au hover
      return 'linear-gradient(135deg, rgba(45,45,55,0.95) 0%, rgba(35,35,45,0.92) 100%)'
    }
    // Gris très foncé en idle
    return 'linear-gradient(135deg, rgba(60,60,70,0.7) 0%, rgba(50,50,60,0.6) 100%)'
  }

  return (
    <>
      <AnimatePresence mode="wait">
        {shouldShow && (
          <motion.div
            variants={pillContainerVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
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
                  variants={labelFloatVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  style={{ pointerEvents: 'none' }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.6)',
                      whiteSpace: 'nowrap',
                      userSelect: 'none',
                      letterSpacing: '0.3px',
                    }}
                  >
                    Click to dictate
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Pill wrapper - precise hitbox */}
            <div
              style={{ position: 'relative' }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              {/* Cancel button - red */}
              <AnimatePresence>
                {isManualRecording && (
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
                      background: '#ef4444',
                      border: '2px solid rgba(255,255,255,0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      zIndex: 30,
                      padding: 0,
                    }}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                  >
                    <X width={14} height={14} color="white" strokeWidth={2.5} />
                  </motion.button>
                )}
              </AnimatePresence>

              {/* Main Pill - sans glow */}
              <motion.div
                variants={idleLineVariants}
                initial="initial"
                animate={getLineVariant()}
                style={{
                  background: getBackground(),
                  border: '1px solid rgba(255,255,255,0.15)',
                  backdropFilter: blurValue,
                  WebkitBackdropFilter: blurValue,
                  cursor: isIdle ? 'pointer' : 'default',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.3)', // Ombre simple, pas de glow
                }}
                onClick={handleClick}
              >
                {!isExpanded && (
                  <div
                    style={{
                      width: '60%',
                      height: 2,
                      borderRadius: 1,
                      background: 'rgba(255,255,255,0.45)',
                    }}
                  />
                )}

                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      key="expanded"
                      variants={contentRevealVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        padding: '0 10px',
                        width: '100%',
                        height: '100%',
                      }}
                    >
                      {isProcessing && !anyRecording ? (
                        <ThinkingDots />
                      ) : (
                        <>
                          {appTarget?.iconBase64 ? (
                            <motion.img
                              variants={iconPopVariants}
                              draggable={false}
                              src={`data:image/png;base64,${appTarget.iconBase64}`}
                              style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                flexShrink: 0,
                              }}
                            />
                          ) : !isIdle ? (
                            <motion.div variants={iconPopVariants} style={{ flexShrink: 0 }}>
                              <ItoIcon width={20} height={20} className="text-white" />
                            </motion.div>
                          ) : null}

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
                                    fontSize: 11,
                                    fontWeight: 500,
                                    color: 'rgba(255,255,255,0.65)',
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
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.15 }}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                  }}
                                >
                                  {isManualRecording ? (
                                    <>
                                      <AudioWaveform
                                        audioLevel={currentAudioLevel}
                                        active
                                        width={52}
                                        height={28}
                                        strokeColor={SILVER}
                                      />
                                      <motion.button
                                        onClick={handleStop}
                                        whileHover={{ scale: 1.1 }}
                                        whileTap={{ scale: 0.9 }}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          background: 'rgba(255,255,255,0.15)',
                                          border: '1px solid rgba(255,255,255,0.2)',
                                          borderRadius: 6,
                                          padding: '3px',
                                          cursor: 'pointer',
                                        }}
                                      >
                                        <Square width={12} height={12} color={SILVER} fill="currentColor" />
                                      </motion.button>
                                    </>
                                  ) : anyRecording ? (
                                    <AudioWaveform
                                      audioLevel={currentAudioLevel}
                                      active
                                      width={78}
                                      height={28}
                                      strokeColor={SILVER}
                                    />
                                  ) : null}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </>
                      )}
                    </motion.div>
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
