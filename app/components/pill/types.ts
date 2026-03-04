import type { ItoMode } from '@/app/generated/ito_pb'
import type { OnboardingCategory } from '@/app/store/useOnboardingStore'
import type { RecordingStatePayload, ProcessingStatePayload } from '@/lib/types/ipc'

export type PillPhase =
  | 'idle'
  | 'recording'
  | 'manualRecording'
  | 'processing'
  | 'agentProcessing'

export interface PillContext {
  appTarget: { name: string; iconBase64: string | null } | null
  contextSource: 'screen' | 'selection' | null
  screenThumbnail: string | null
  currentMode: ItoMode | undefined
}

export interface PillState {
  phase: PillPhase
  context: PillContext
}

export type PillAction =
  | { type: 'RECORDING_STATE_UPDATE'; payload: RecordingStatePayload; wasRecording: boolean }
  | { type: 'PROCESSING_STATE_UPDATE'; payload: ProcessingStatePayload }
  | { type: 'MANUAL_RECORDING_START' }
  | { type: 'MANUAL_RECORDING_STOP' }
  | { type: 'MANUAL_RECORDING_CANCEL' }
  | { type: 'RESET_CONTEXT' }

export interface SettingsIPCPayload {
  showItoBarAlways: boolean
  interactionSounds: boolean
}

export interface OnboardingIPCPayload {
  onboardingCategory: OnboardingCategory
  onboardingCompleted: boolean
}

export interface AuthUserIPCPayload {
  id: string
  email?: string
  name?: string
  provider?: string
}
