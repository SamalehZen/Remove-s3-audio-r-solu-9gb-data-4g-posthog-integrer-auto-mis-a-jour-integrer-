import { useReducer } from 'react'
import type { PillState, PillAction } from '../types'

const INITIAL_STATE: PillState = {
  phase: 'idle',
  context: {
    appTarget: null,
    contextSource: null,
    screenThumbnail: null,
    currentMode: undefined,
  },
}

function pillReducer(state: PillState, action: PillAction): PillState {
  switch (action.type) {
    case 'RECORDING_STATE_UPDATE': {
      const { payload, wasRecording } = action

      if (payload.isRecording) {
        const newPhase =
          state.phase === 'manualRecording' ? 'manualRecording' : 'recording'

        let appTarget = state.context.appTarget
        if (
          payload.appTargetName !== undefined ||
          payload.appTargetIconBase64 !== undefined
        ) {
          const newName =
            payload.appTargetName ?? state.context.appTarget?.name ?? 'Ito'
          const incomingIcon =
            payload.appTargetIconBase64 !== undefined
              ? (payload.appTargetIconBase64 ?? null)
              : (state.context.appTarget?.iconBase64 ?? null)
          const newIcon =
            !incomingIcon &&
            state.context.appTarget?.iconBase64 &&
            newName === state.context.appTarget.name
              ? state.context.appTarget.iconBase64
              : incomingIcon

          if (
            !state.context.appTarget ||
            state.context.appTarget.name !== newName ||
            state.context.appTarget.iconBase64 !== newIcon
          ) {
            appTarget = { name: newName, iconBase64: newIcon }
          }
        } else if (!wasRecording) {
          appTarget = null
        }

        return {
          phase: newPhase,
          context: {
            appTarget,
            contextSource:
              payload.contextSource ?? state.context.contextSource,
            screenThumbnail:
              payload.screenThumbnailBase64 ?? state.context.screenThumbnail,
            currentMode: payload.mode ?? state.context.currentMode,
          },
        }
      }

      if (
        state.phase === 'recording' ||
        state.phase === 'manualRecording'
      ) {
        return { ...state, phase: 'idle' }
      }
      return state
    }

    case 'PROCESSING_STATE_UPDATE': {
      const { payload } = action
      if (payload.isProcessing) {
        return {
          ...state,
          phase: payload.isAgent ? 'agentProcessing' : 'processing',
        }
      }
      if (
        state.phase === 'processing' ||
        state.phase === 'agentProcessing'
      ) {
        return { ...state, phase: 'idle' }
      }
      return state
    }

    case 'MANUAL_RECORDING_START':
      if (state.phase === 'idle') return { ...state, phase: 'manualRecording' }
      return state

    case 'MANUAL_RECORDING_STOP':
    case 'MANUAL_RECORDING_CANCEL':
      if (state.phase === 'manualRecording')
        return { ...state, phase: 'idle' }
      return state

    case 'RESET_CONTEXT':
      return {
        ...state,
        context: {
          appTarget: null,
          contextSource: null,
          screenThumbnail: null,
          currentMode: undefined,
        },
      }

    default:
      return state
  }
}

export function usePillReducer() {
  return useReducer(pillReducer, INITIAL_STATE)
}
