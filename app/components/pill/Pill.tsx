import React, { useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePerformanceStore } from '../../store/usePerformanceStore'
import { X } from '@mynaui/icons-react'
import { ONBOARDING_CATEGORIES } from '../../store/useOnboardingStore'
import { ProcessingStatusDisplay } from './contents/AudioBarsBase'
import { PillRecordingContent } from './contents/PillRecordingContent'
import { PillHoverContent } from './contents/PillHoverContent'
import { useAudioStore } from '@/app/store/useAudioStore'
import { analytics, ANALYTICS_EVENTS } from '../analytics'
import { soundPlayer } from '@/app/utils/soundPlayer'
import { usePillReducer } from './hooks/usePillReducer'
import { usePillIPC } from './hooks/usePillIPC'
import { usePillVolume } from './hooks/usePillVolume'
import {
  IDLE_WIDTH,
  IDLE_HEIGHT,
  RECORDING_WIDTH,
  RECORDING_HEIGHT,
  THINKING_WIDTH,
  THINKING_HEIGHT,
  HOVER_WIDTH,
  HOVER_HEIGHT,
  pillContainerVariants,
  cancelButtonVariants,
  STAGED_TRANSITION,
  CONTENT_ENTER,
  CONTENT_EXIT,
} from './constants'
import './pill-window.css'

const contentAbsolute: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const Pill = () => {
  const { startRecording, stopRecording } = useAudioStore()
  const config = usePerformanceStore(s => s.config)

  const [state, dispatch] = usePillReducer()
  const phaseRef = useRef(state.phase)
  phaseRef.current = state.phase

  const { showItoBarAlways, onboardingCategory, onboardingCompleted } =
    usePillIPC(dispatch, phaseRef)

  const anyRecording =
    state.phase === 'recording' || state.phase === 'manualRecording'
  const isManualRecording = state.phase === 'manualRecording'
  const isProcessing =
    state.phase === 'processing' || state.phase === 'agentProcessing'
  const isIdle = state.phase === 'idle'
  const isActive = !isIdle

  const audioLevelRef = usePillVolume(anyRecording)

  const [isHovered, setIsHovered] = React.useState(false)
  const cssInjectedRef = useRef(false)

  const blurValue = config.enableBackdropBlur ? 'blur(16px)' : 'none'

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
    if (cssInjectedRef.current) return
    cssInjectedRef.current = true
    document.documentElement.classList.add('pill-window')
    if (document.fonts) {
      document.fonts.load('12px Inter').catch(() => {})
      document.fonts.load('10px Inter').catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (isIdle) dispatch({ type: 'RESET_CONTEXT' })
  }, [isIdle, dispatch])

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true)
    window.api?.send('pill-set-mouse-events', false)
  }, [])

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false)
    window.api?.send('pill-set-mouse-events', true, { forward: true })
  }, [])

  const handleClick = useCallback(() => {
    if (!isIdle) return
    phaseRef.current = 'manualRecording'
    dispatch({ type: 'MANUAL_RECORDING_START' })
    startRecording()
    analytics.track(ANALYTICS_EVENTS.MANUAL_RECORDING_STARTED, {
      is_recording: true,
    })
  }, [isIdle, dispatch, startRecording])

  const handleCancel = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      phaseRef.current = 'idle'
      dispatch({ type: 'MANUAL_RECORDING_CANCEL' })
      stopRecording()
      analytics.track(ANALYTICS_EVENTS.MANUAL_RECORDING_ABANDONED, {
        is_recording: false,
      })
    },
    [dispatch, stopRecording],
  )

  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      phaseRef.current = 'idle'
      dispatch({ type: 'MANUAL_RECORDING_STOP' })
      stopRecording()
      analytics.track(ANALYTICS_EVENTS.MANUAL_RECORDING_COMPLETED, {
        is_recording: false,
      })
    },
    [dispatch, stopRecording],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && isIdle) {
        e.preventDefault()
        phaseRef.current = 'manualRecording'
        dispatch({ type: 'MANUAL_RECORDING_START' })
        startRecording()
        analytics.track(ANALYTICS_EVENTS.MANUAL_RECORDING_STARTED, {
          is_recording: true,
        })
      }
      if (e.key === 'Escape' && isManualRecording) {
        e.preventDefault()
        phaseRef.current = 'idle'
        dispatch({ type: 'MANUAL_RECORDING_CANCEL' })
        stopRecording()
        analytics.track(ANALYTICS_EVENTS.MANUAL_RECORDING_ABANDONED, {
          is_recording: false,
        })
      }
    },
    [isIdle, isManualRecording, dispatch, startRecording, stopRecording],
  )

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

  const getBorderColor = () => {
    if (anyRecording || isProcessing) return 'rgba(180,185,195,0.18)'
    if (isHovered) return 'rgba(180,185,195,0.14)'
    return 'rgba(200,200,210,0.1)'
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        left: 0,
        right: 0,
        zIndex: 50,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence mode="wait">
        {shouldShow && (
          <motion.div
            variants={pillContainerVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
            }}
          >
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
                    aria-label="Cancel recording"
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
                role="button"
                tabIndex={0}
                aria-label={
                  anyRecording
                    ? 'Recording in progress'
                    : isProcessing
                      ? 'Processing audio'
                      : 'Click to start dictation'
                }
                initial={false}
                animate={{
                  width: dims.w,
                  height: dims.h,
                  borderRadius: pillRadius,
                  backgroundColor: getBgColor(),
                  boxShadow: getShadow(),
                  borderColor: getBorderColor(),
                }}
                transition={STAGED_TRANSITION}
                style={{
                  borderWidth: 1,
                  borderStyle: 'solid',
                  backdropFilter: blurValue,
                  WebkitBackdropFilter: blurValue,
                  cursor: isIdle ? 'pointer' : 'default',
                  overflow: 'hidden',
                  position: 'relative',
                  outline: 'none',
                }}
                onClick={handleClick}
                onKeyDown={handleKeyDown}
              >
                <AnimatePresence mode="wait">
                  {!isExpanded && (
                    <motion.div
                      key="idle-line"
                      initial={{ opacity: 0, scaleX: 0.5 }}
                      animate={{ opacity: 1, scaleX: 1 }}
                      exit={{ opacity: 0, scaleX: 0.6 }}
                      transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                      style={contentAbsolute}
                    >
                      <motion.div
                        animate={{ opacity: [0.7, 1, 0.7] }}
                        transition={{
                          duration: 3,
                          repeat: Infinity,
                          ease: 'easeInOut',
                        }}
                        style={{
                          width: '55%',
                          height: 3,
                          borderRadius: 1.5,
                          background:
                            'linear-gradient(90deg, rgba(190,195,205,0.35) 0%, rgba(215,220,230,0.55) 50%, rgba(190,195,205,0.35) 100%)',
                        }}
                      />
                    </motion.div>
                  )}

                  {isExpanded && anyRecording && (
                    <PillRecordingContent
                      isManualRecording={isManualRecording}
                      audioLevelRef={audioLevelRef}
                      appTarget={state.context.appTarget}
                      contextSource={state.context.contextSource}
                      screenThumbnail={state.context.screenThumbnail}
                      customModeName={state.context.customModeName}
                      onStop={handleStop}
                    />
                  )}

                  {isExpanded && isProcessing && !anyRecording && (
                    <motion.div
                      key="thinking-content"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{
                        opacity: 0,
                        scale: 0.85,
                        transition: CONTENT_EXIT,
                      }}
                      transition={CONTENT_ENTER}
                      style={contentAbsolute}
                    >
                      <ProcessingStatusDisplay color="rgba(200,205,215,0.9)" />
                    </motion.div>
                  )}

                  {isExpanded && isIdle && isHovered && <PillHoverContent />}
                </AnimatePresence>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default Pill
