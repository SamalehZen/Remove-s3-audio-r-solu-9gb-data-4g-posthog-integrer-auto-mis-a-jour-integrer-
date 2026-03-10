import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '@/app/store/useSettingsStore'
import { useOnboardingStore } from '@/app/store/useOnboardingStore'
import { analytics, ANALYTICS_EVENTS } from '../../analytics'
import { soundPlayer } from '@/app/utils/soundPlayer'
import type { RecordingStatePayload, ProcessingStatePayload } from '@/lib/types/ipc'
import type { OnboardingCategory } from '@/app/store/useOnboardingStore'
import type {
  PillAction,
  PillPhase,
  SettingsIPCPayload,
  OnboardingIPCPayload,
  AuthUserIPCPayload,
} from '../types'

export interface PillIPCResult {
  showItoBarAlways: boolean
  onboardingCategory: OnboardingCategory
  onboardingCompleted: boolean
  interactionSounds: boolean
}

export function usePillIPC(
  dispatch: React.Dispatch<PillAction>,
  phaseRef: React.MutableRefObject<PillPhase>,
  onNoInternet?: () => void,
): PillIPCResult {
  const initialShowItoBarAlways = useSettingsStore(s => s.showItoBarAlways)
  const initialInteractionSounds = useSettingsStore(s => s.interactionSounds)
  const initialOnboardingCategory = useOnboardingStore(s => s.onboardingCategory)
  const initialOnboardingCompleted = useOnboardingStore(s => s.onboardingCompleted)

  const [showItoBarAlways, setShowItoBarAlways] = useState(initialShowItoBarAlways)
  const [interactionSounds, setInteractionSounds] = useState(initialInteractionSounds)
  const [onboardingCategory, setOnboardingCategory] = useState(initialOnboardingCategory)
  const [onboardingCompleted, setOnboardingCompleted] = useState(initialOnboardingCompleted)

  const interactionSoundsRef = useRef(initialInteractionSounds)
  const wasRecordingRef = useRef(false)
  const noInternetRef = useRef(false)

  useEffect(() => {
    interactionSoundsRef.current = interactionSounds
  }, [interactionSounds])

  useEffect(() => {
    const unsubRecording = window.api.on(
      'recording-state-update',
      (payload: RecordingStatePayload) => {
        const wasRecording = wasRecordingRef.current
        wasRecordingRef.current = payload.isRecording

        if (payload.isRecording && !navigator.onLine && phaseRef.current !== 'manualRecording') {
          noInternetRef.current = true
        }

        dispatch({ type: 'RECORDING_STATE_UPDATE', payload, wasRecording })

        if (!payload.isRecording && wasRecording && noInternetRef.current) {
          noInternetRef.current = false
          onNoInternet?.()
        }

        if (
          interactionSoundsRef.current &&
          wasRecording !== payload.isRecording
        ) {
          soundPlayer.play(
            payload.isRecording ? 'recording-start' : 'recording-stop',
          )
        }

        const isManual = phaseRef.current === 'manualRecording'
        if (!isManual && wasRecording !== payload.isRecording) {
          const analyticsEvent = payload.isRecording
            ? ANALYTICS_EVENTS.RECORDING_STARTED
            : ANALYTICS_EVENTS.RECORDING_COMPLETED
          analytics.track(analyticsEvent, {
            is_recording: payload.isRecording,
            mode: payload.mode,
          })
        }
      },
    )

    const unsubProcessing = window.api.on(
      'processing-state-update',
      (payload: ProcessingStatePayload) => {
        dispatch({ type: 'PROCESSING_STATE_UPDATE', payload })
      },
    )

    const unsubSettings = window.api.on(
      'settings-update',
      (settings: SettingsIPCPayload) => {
        setShowItoBarAlways(settings.showItoBarAlways)
        setInteractionSounds(settings.interactionSounds)
      },
    )

    const unsubOnboarding = window.api.on(
      'onboarding-update',
      (onboarding: OnboardingIPCPayload) => {
        setOnboardingCategory(onboarding.onboardingCategory)
        setOnboardingCompleted(onboarding.onboardingCompleted)
      },
    )

    const unsubUserAuth = window.api.on(
      'user-auth-update',
      (authUser: AuthUserIPCPayload | null) => {
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
      },
    )

    return () => {
      unsubRecording()
      unsubProcessing()
      unsubSettings()
      unsubOnboarding()
      unsubUserAuth()
    }
  }, [dispatch, phaseRef, onNoInternet])

  return { showItoBarAlways, onboardingCategory, onboardingCompleted, interactionSounds }
}
