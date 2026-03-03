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

const IDLE_WIDTH = 40
const IDLE_HEIGHT = 8
const RECORDING_WIDTH = 130
const RECORDING_HEIGHT = 34
const THINKING_WIDTH = 45
const THINKING_HEIGHT = 34
const HOVER_WIDTH = 110
const HOVER_HEIGHT = 32

const IOS_SPRING = {
  type: 'spring' as const,
  stiffness: 380,
  damping: 30,
  mass: 0.8,
}

const IOS_SPRING_SNAPPY = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 26,
  mass: 0.7,
}

const CONTENT_ENTER = {
  type: 'spring' as const,
  stiffness: 400,
  damping: 28,
  mass: 0.7,
}

const CONTENT_EXIT = {
  duration: 0.12,
  ease: [0.4, 0, 1, 1] as const,
}

function getBarUpdateInterval(): number {
  const { activeTier } = usePerformanceStore.getState()
  if (activeTier === 'low') return 200
  if (activeTier === 'balanced') return 100
  return 64
}

const pillContainerVariants = {
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

const labelFloatVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: IOS_SPRING,
  },
  exit: {
    opacity: 0,
    y: -6,
    transition: { duration: 0.1 },
  },
}

const cancelButtonVariants = {
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

  const blurValue = config.enableBackdropBlur ? 'blur(16px)' : 'none'
  const currentAudioLevel = volumeHistory[volumeHistory.length - 1] || 0

  const anyRecording = isRecording || isManualRecording
  const isIdle = !anyRecording && !isProcessing
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
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', system-ui, sans-serif;
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

  const getDimensions = () => {
    if (anyRecording) return { w: RECORDING_WIDTH, h: RECORDING_HEIGHT }
    if (isProcessing) return { w: THINKING_WIDTH, h: THINKING_HEIGHT }
    if (isHovered && isIdle) return { w: HOVER_WIDTH, h: HOVER_HEIGHT }
    return { w: IDLE_WIDTH, h: IDLE_HEIGHT }
  }

  const dims = getDimensions()
  const pillRadius = dims.h / 2
  const isExpanded = dims.h > IDLE_HEIGHT

  const getBgColor = () => {
    if (anyRecording || isProcessing) return 'rgba(28,28,32,0.96)'
    if (isHovered) return 'rgba(36,36,42,0.95)'
    return 'rgba(140,140,155,0.55)'
  }

  const getShadow = () => {
    if (anyRecording || isProcessing) {
      return '0 2px 16px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(180,185,195,0.1)'
    }
    if (isHovered) {
      return '0 2px 12px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(180,185,195,0.08)'
    }
    return '0 1px 6px rgba(0,0,0,0.18)'
  }

  const getBorder = () => {
    if (anyRecording || isProcessing) return '1px solid rgba(180,185,195,0.18)'
    if (isHovered) return '1px solid rgba(180,185,195,0.14)'
    return '1px solid rgba(200,200,210,0.1)'
  }

  const contentAbsolute: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
            <AnimatePresence mode="wait">
              {isHovered && isIdle && (
                <motion.div
                  key="label"
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
                      color: 'rgba(255,255,255,0.55)',
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

            <div
              style={{
                position: 'relative',
                padding: '10px 14px',
                margin: '-10px -14px',
              }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
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
                      top: 0,
                      right: 4,
                      width: 22,
                      height: 22,
                      borderRadius: 11,
                      background: 'rgba(220,60,60,0.9)',
                      border: '1.5px solid rgba(255,255,255,0.25)',
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
                    <X width={12} height={12} color="white" strokeWidth={2.5} />
                  </motion.button>
                )}
              </AnimatePresence>

              <motion.div
                initial={false}
                animate={{
                  width: dims.w,
                  height: dims.h,
                  borderRadius: pillRadius,
                  backgroundColor: getBgColor(),
                  boxShadow: getShadow(),
                }}
                transition={IOS_SPRING}
                style={{
                  border: getBorder(),
                  backdropFilter: blurValue,
                  WebkitBackdropFilter: blurValue,
                  cursor: isIdle ? 'pointer' : 'default',
                  overflow: 'hidden',
                  position: 'relative',
                }}
                onClick={handleClick}
              >
                <AnimatePresence>
                  {!isExpanded && (
                    <motion.div
                      key="idle-line"
                      initial={{ opacity: 0, scaleX: 0.5 }}
                      animate={{ opacity: 1, scaleX: 1 }}
                      exit={{ opacity: 0, scaleX: 0.6 }}
                      transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                      style={contentAbsolute}
                    >
                      <div
                        style={{
                          width: '55%',
                          height: 3,
                          borderRadius: 1.5,
                          background: 'linear-gradient(90deg, rgba(190,195,205,0.35) 0%, rgba(215,220,230,0.55) 50%, rgba(190,195,205,0.35) 100%)',
                        }}
                      />
                    </motion.div>
                  )}

                  {isExpanded && anyRecording && (
                    <motion.div
                      key="recording-content"
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9, transition: CONTENT_EXIT }}
                      transition={CONTENT_ENTER}
                      style={{
                        ...contentAbsolute,
                        gap: 6,
                        padding: '0 10px',
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
                          <motion.img
                            initial={{ scale: 0.7, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={IOS_SPRING_SNAPPY}
                            draggable={false}
                            src={`data:image/png;base64,${appTarget.iconBase64}`}
                            style={{
                              width: 20,
                              height: 20,
                              borderRadius: 5,
                              flexShrink: 0,
                            }}
                          />
                        ) : (
                          <motion.div
                            initial={{ scale: 0.7, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={IOS_SPRING_SNAPPY}
                          >
                            <ItoIcon width={18} height={18} className="text-white" />
                          </motion.div>
                        )}

                        {contextSource === 'screen' && screenThumbnail && (
                          <motion.img
                            initial={{ scale: 0.7, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={IOS_SPRING_SNAPPY}
                            draggable={false}
                            src={`data:image/png;base64,${screenThumbnail}`}
                            style={{
                              width: 28,
                              height: 18,
                              borderRadius: 3,
                              objectFit: 'cover',
                              border: '1px solid rgba(255,255,255,0.15)',
                              flexShrink: 0,
                            }}
                          />
                        )}

                        {contextSource === 'selection' && (
                          <motion.span
                            initial={{ scale: 0.7, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={IOS_SPRING_SNAPPY}
                            style={{ fontSize: 13 }}
                          >
                            📝
                          </motion.span>
                        )}
                      </div>

                      <div
                        style={{
                          flex: 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minWidth: 0,
                        }}
                      >
                        {isManualRecording ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <AudioWaveform
                              audioLevel={currentAudioLevel}
                              active
                              width={60}
                              height={RECORDING_HEIGHT}
                              strokeColor="rgba(200,205,215,0.85)"
                            />
                            <motion.button
                              onClick={handleStop}
                              whileHover={{ scale: 1.1 }}
                              whileTap={{ scale: 0.9 }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'rgba(200,205,215,0.15)',
                                border: '1px solid rgba(200,205,215,0.2)',
                                borderRadius: 5,
                                padding: '3px',
                                cursor: 'pointer',
                              }}
                            >
                              <Square width={12} height={12} color="rgba(200,205,215,0.9)" fill="currentColor" />
                            </motion.button>
                          </div>
                        ) : (
                          <AudioWaveform
                            audioLevel={currentAudioLevel}
                            active
                            width={80}
                            height={RECORDING_HEIGHT}
                            strokeColor="rgba(200,205,215,0.85)"
                          />
                        )}
                      </div>
                    </motion.div>
                  )}

                  {isExpanded && isProcessing && !anyRecording && (
                    <motion.div
                      key="thinking-content"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.85, transition: CONTENT_EXIT }}
                      transition={CONTENT_ENTER}
                      style={contentAbsolute}
                    >
                      <ProcessingStatusDisplay color="rgba(200,205,215,0.9)" />
                    </motion.div>
                  )}

                  {isExpanded && isIdle && isHovered && (
                    <motion.div
                      key="hover-content"
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95, transition: CONTENT_EXIT }}
                      transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                      style={{
                        ...contentAbsolute,
                        gap: 8,
                        padding: '0 12px',
                      }}
                    >
                      <ItoIcon width={16} height={16} className="text-white" style={{ opacity: 0.7, flexShrink: 0 }} />
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 500,
                          color: 'rgba(200,205,215,0.7)',
                          whiteSpace: 'nowrap',
                          letterSpacing: '0.2px',
                        }}
                      >
                        Click to dictate
                      </span>
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
