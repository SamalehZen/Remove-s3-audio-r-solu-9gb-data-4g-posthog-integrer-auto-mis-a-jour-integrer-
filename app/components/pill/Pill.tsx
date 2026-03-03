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

// Enhanced dimensions
const MIN_PILL_WIDTH = 56
const MIN_PILL_HEIGHT = 10
const EXPANDED_PILL_WIDTH = 210
const EXPANDED_PILL_HEIGHT = 48

function getBarUpdateInterval(): number {
  const { activeTier } = usePerformanceStore.getState()
  if (activeTier === 'low') return 200
  if (activeTier === 'balanced') return 100
  return 64
}

// IMPRESSIVE animation variants
const pillContainerVariants = {
  hidden: {
    opacity: 0,
    y: 40,
    scale: 0.6,
    filter: 'blur(10px)',
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: {
      type: 'spring',
      stiffness: 300,
      damping: 20,
      mass: 1,
      staggerChildren: 0.08,
    },
  },
  exit: {
    opacity: 0,
    y: 30,
    scale: 0.8,
    filter: 'blur(8px)',
    transition: {
      duration: 0.25,
      ease: [0.4, 0, 0.2, 1],
    },
  },
}

const idleLineVariants = {
  initial: {
    width: MIN_PILL_WIDTH,
    height: MIN_PILL_HEIGHT,
    borderRadius: 5,
    scale: 1,
  },
  hover: {
    width: EXPANDED_PILL_WIDTH,
    height: EXPANDED_PILL_HEIGHT,
    borderRadius: 24,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 350,
      damping: 22,
      mass: 0.9,
    },
  },
  recording: {
    width: EXPANDED_PILL_WIDTH,
    height: EXPANDED_PILL_HEIGHT,
    borderRadius: 24,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 450,
      damping: 18,
      mass: 0.7,
    },
  },
}

const idleLineContentVariants = {
  hidden: { opacity: 0, scaleX: 0.5 },
  visible: {
    opacity: 1,
    scaleX: 1,
    transition: {
      duration: 0.4,
      ease: [0.4, 0, 0.2, 1],
    },
  },
}

const contentRevealVariants = {
  hidden: {
    opacity: 0,
    scale: 0.7,
    y: 20,
    filter: 'blur(8px)',
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 25,
      mass: 0.8,
      staggerChildren: 0.06,
      delayChildren: 0.05,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.9,
    y: -10,
    filter: 'blur(4px)',
    transition: {
      duration: 0.15,
      ease: 'easeIn',
    },
  },
}

const iconPopVariants = {
  hidden: { scale: 0, rotate: -180, opacity: 0 },
  visible: {
    scale: 1,
    rotate: 0,
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
  hidden: { opacity: 0, y: 15, scale: 0.8 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 450,
      damping: 20,
    },
  },
  exit: {
    opacity: 0,
    y: -10,
    scale: 0.9,
    transition: { duration: 0.12 },
  },
}

const cancelButtonVariants = {
  hidden: { scale: 0, rotate: -90, opacity: 0 },
  visible: {
    scale: 1,
    rotate: 0,
    opacity: 1,
    transition: {
      type: 'spring',
      stiffness: 600,
      damping: 15,
    },
  },
  exit: {
    scale: 0,
    rotate: 90,
    opacity: 0,
    transition: { duration: 0.15 },
  },
}

const glowPulseVariants = {
  idle: {
    boxShadow: '0 0 0px rgba(255,255,255,0)',
  },
  hover: {
    boxShadow: [
      '0 0 20px rgba(255,255,255,0.1)',
      '0 0 30px rgba(255,255,255,0.2)',
      '0 0 20px rgba(255,255,255,0.1)',
    ],
    transition: {
      boxShadow: {
        duration: 1.5,
        repeat: Infinity,
        ease: 'easeInOut',
      },
    },
  },
  recording: {
    boxShadow: [
      '0 0 25px rgba(59,130,246,0.5)',
      '0 0 50px rgba(59,130,246,0.7)',
      '0 0 25px rgba(59,130,246,0.5)',
    ],
    transition: {
      boxShadow: {
        duration: 0.8,
        repeat: Infinity,
        ease: 'easeInOut',
      },
    },
  },
  processing: {
    boxShadow: [
      '0 0 20px rgba(168,85,247,0.4)',
      '0 0 40px rgba(168,85,247,0.6)',
      '0 0 20px rgba(168,85,247,0.4)',
    ],
    transition: {
      boxShadow: {
        duration: 1,
        repeat: Infinity,
        ease: 'easeInOut',
      },
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

  const blurValue = config.enableBackdropBlur ? 'blur(20px) saturate(180%)' : 'none'
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
      document.fonts.load('14px Inter').catch(() => {})
      document.fonts.load('12px Inter').catch(() => {})
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

  const processingLabel = isAgentMode
    ? 'Agent...'
    : currentMode === ItoMode.CONTEXT_AWARENESS
      ? 'Analyzing...'
      : 'Transcribing'

  const getLineVariant = () => {
    if (anyRecording || isProcessing) return 'recording'
    if (isHovered) return 'hover'
    return 'initial'
  }

  const getGlowVariant = () => {
    if (anyRecording) return 'recording'
    if (isProcessing) return 'processing'
    if (isHovered) return 'hover'
    return 'idle'
  }

  const getBackground = () => {
    if (isExpanded) {
      return 'linear-gradient(135deg, rgba(35,35,42,0.96) 0%, rgba(25,25,32,0.94) 50%, rgba(20,20,28,0.96) 100%)'
    }
    return 'linear-gradient(135deg, rgba(50,50,58,0.75) 0%, rgba(40,40,48,0.65) 100%)'
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
      
      <AnimatePresence mode="wait">
        {shouldShow && (
          <motion.div
            variants={pillContainerVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            style={{
              position: 'fixed',
              bottom: 24,
              left: '50%',
              x: '-50%',
              zIndex: 50,
              pointerEvents: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
            }}
          >
            {/* Floating label */}
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
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'rgba(255,255,255,0.7)',
                      whiteSpace: 'nowrap',
                      userSelect: 'none',
                      letterSpacing: '0.5px',
                      textShadow: '0 2px 8px rgba(0,0,0,0.4)',
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
              {/* Cancel button */}
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
                      top: -12,
                      right: -12,
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                      border: '2px solid rgba(255,255,255,0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      zIndex: 30,
                      padding: 0,
                      boxShadow: '0 4px 15px rgba(239,68,68,0.5), 0 0 0 4px rgba(239,68,68,0.1)',
                    }}
                    whileHover={{ scale: 1.15, rotate: 90 }}
                    whileTap={{ scale: 0.85 }}
                  >
                    <X width={16} height={16} color="white" strokeWidth={3} />
                  </motion.button>
                )}
              </AnimatePresence>

              {/* Main Morphing Pill */}
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
                }}
                animate={{
                  ...idleLineVariants[getLineVariant()],
                  boxShadow: glowPulseVariants[getGlowVariant()].boxShadow,
                }}
                transition={idleLineVariants[getLineVariant()].transition}
                onClick={handleClick}
              >
                {/* Inner shimmer */}
                <motion.div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: 'inherit',
                    background: 'linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.08) 50%, transparent 60%)',
                    backgroundSize: '200% 100%',
                  }}
                  animate={{
                    backgroundPosition: isHovered || isActive ? ['200% 0%', '-200% 0%'] : '200% 0%',
                  }}
                  transition={{
                    duration: 1.5,
                    repeat: isHovered || isActive ? Infinity : 0,
                    ease: 'linear',
                  }}
                />

                {/* Collapsed state - animated line */}
                {!isExpanded && (
                  <motion.div
                    variants={idleLineContentVariants}
                    initial="hidden"
                    animate="visible"
                    style={{
                      width: '50%',
                      height: 4,
                      borderRadius: 2,
                      background: 'linear-gradient(90deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.8) 50%, rgba(255,255,255,0.5) 100%)',
                      boxShadow: '0 0 12px rgba(255,255,255,0.4), 0 0 20px rgba(255,255,255,0.2)',
                    }}
                  />
                )}

                {/* Expanded state - full content */}
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
                        gap: 12,
                        padding: '0 18px',
                        width: '100%',
                        height: '100%',
                      }}
                    >
                      {/* Icons section */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flexShrink: 0,
                        }}
                      >
                        {appTarget?.iconBase64 ? (
                          <motion.img
                            variants={iconPopVariants}
                            draggable={false}
                            src={`data:image/png;base64,${appTarget.iconBase64}`}
                            style={{
                              width: 26,
                              height: 26,
                              borderRadius: 6,
                              flexShrink: 0,
                              boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
                            }}
                          />
                        ) : (
                          <motion.div variants={iconPopVariants}>
                            <ItoIcon width={26} height={26} className="text-white" />
                          </motion.div>
                        )}
                        
                        {contextSource === 'screen' && screenThumbnail && (
                          <motion.img
                            variants={iconPopVariants}
                            draggable={false}
                            src={`data:image/png;base64,${screenThumbnail}`}
                            style={{
                              width: 38,
                              height: 24,
                              borderRadius: 4,
                              objectFit: 'cover',
                              border: '1.5px solid rgba(255,255,255,0.3)',
                              flexShrink: 0,
                              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                            }}
                          />
                        )}
                        
                        {contextSource === 'selection' && (
                          <motion.span
                            variants={iconPopVariants}
                            style={{ fontSize: 18 }}
                          >
                            📝
                          </motion.span>
                        )}
                      </div>

                      {/* Center content */}
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
                              initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
                              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                              exit={{ opacity: 0, y: -8, filter: 'blur(4px)' }}
                              transition={{ duration: 0.2 }}
                              style={{
                                fontSize: 14,
                                fontWeight: 600,
                                color: 'rgba(255,255,255,0.6)',
                                whiteSpace: 'nowrap',
                                letterSpacing: '0.3px',
                              }}
                            >
                              Click to dictate
                            </motion.span>
                          ) : (
                            <motion.div
                              key="active-content"
                              initial={{ opacity: 0, scale: 0.8 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.9 }}
                              transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                              }}
                            >
                              {isManualRecording ? (
                                <>
                                  <AudioWaveform
                                    audioLevel={currentAudioLevel}
                                    active
                                    width={100}
                                    height={EXPANDED_PILL_HEIGHT}
                                  />
                                  <motion.button
                                    onClick={handleStop}
                                    whileHover={{ scale: 1.2, rotate: 5 }}
                                    whileTap={{ scale: 0.85 }}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      background: 'rgba(255,255,255,0.2)',
                                      border: '2px solid rgba(255,255,255,0.3)',
                                      borderRadius: 10,
                                      padding: '8px',
                                      cursor: 'pointer',
                                      boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
                                    }}
                                  >
                                    <Square width={18} height={18} color="white" fill="currentColor" />
                                  </motion.button>
                                </>
                              ) : anyRecording ? (
                                <AudioWaveform
                                  audioLevel={currentAudioLevel}
                                  active
                                  width={140}
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
