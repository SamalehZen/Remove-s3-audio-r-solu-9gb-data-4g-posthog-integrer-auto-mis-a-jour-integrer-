import { ItoMode } from '@/app/generated/ito_pb'
import { Notification, BrowserWindow } from 'electron'
import { recordingStateNotifier } from '../recordingStateNotifier'
import { voiceInputService } from '../voiceInputService'
import { itoStreamController } from '../itoStreamController'
import { interactionManager } from '../interactions/InteractionManager'
import { preventAppNap, allowAppNap } from '../appNap'
import { getAdvancedSettings } from '../store'
import { audioRecorderService } from '../../media/audio'
import { customModeResolver } from '../context/CustomModeResolver'
import { activeWindowMonitor } from '../ActiveWindowMonitor'
import { contextGrabber } from '../context/ContextGrabber'
import { SonioxStreamingService } from '../soniox/SonioxStreamingService'
import { sonioxTempKeyManager } from '../soniox/SonioxTempKeyManager'
import { setFocusedText } from '../../media/text-writer'
import { Agent } from './agent'
import { GetContextTool, DraftTool, WriteToTextFieldTool, StopTool } from './tools'
import type { AgentWindowMessage, AgentWindowState } from './types'

const MINIMUM_AUDIO_DURATION_MS = 100

class AgentSessionManager {
  private streamResponsePromise: Promise<{
    response: any
    audioBuffer: Buffer
    sampleRate: number
  }> | null = null
  private isSonioxMode = false
  private sonioxService: SonioxStreamingService | null = null
  private sonioxAudioHandler: ((chunk: Buffer) => void) | null = null

  private agent: Agent | null = null
  private stopTool: StopTool | null = null
  private draftTool: DraftTool | null = null
  private writeToTextFieldTool: WriteToTextFieldTool | null = null
  private uiMessages: AgentWindowMessage[] = []
  private currentDraft: string | null = null

  private initAgent(): Agent {
    console.info('[AgentSession] ── initAgent START ──')
    console.info('[AgentSession] Creating tools: GetContext, Draft, WriteToTextField, Stop')

    this.stopTool = new StopTool()
    this.draftTool = new DraftTool()
    this.writeToTextFieldTool = new WriteToTextFieldTool()

    this.draftTool.setOnDraftUpdated((draft) => {
      this.currentDraft = draft
      console.info(`[AgentSession] Draft updated (${draft?.length ?? 0} chars)`)
      this.broadcastWindowState()
    })

    this.writeToTextFieldTool.setStopTool(this.stopTool)
    this.writeToTextFieldTool.setDraftTool(this.draftTool)

    const tools = [
      new GetContextTool(),
      this.draftTool,
      this.writeToTextFieldTool,
      this.stopTool,
    ]

    const agent = new Agent(tools)
    console.info('[AgentSession] ── initAgent DONE ──')
    return agent
  }

  private broadcastWindowState(): void {
    const state: AgentWindowState = {
      messages: this.uiMessages.map((m) => ({
        ...m,
        tools: m.tools ? [...m.tools] : undefined,
      })),
    }
    const windows = BrowserWindow.getAllWindows()
    let sent = 0
    windows.forEach((window) => {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send('agent-window-update', state)
        sent++
      }
    })
    console.log(`[AgentSession] Broadcast UI state to ${sent}/${windows.length} windows (${this.uiMessages.length} messages)`)
  }

  public async startSession() {
    const startMs = Date.now()
    console.info('[AgentSession] ══════ SESSION START ══════')
    interactionManager.initialize()

    contextGrabber.setCustomModePrompt(null)
    recordingStateNotifier.setCustomMode(null, null)

    try {
      const cached = activeWindowMonitor.getCachedState()
      if (cached?.window) {
        const resolved = await customModeResolver.resolve({
          domain: cached.browserInfo?.domain ?? null,
          bundleId: cached.window.bundleId ?? null,
          exePath: cached.window.exePath ?? null,
          appName: cached.window.appName ?? null,
        })
        if (resolved) {
          recordingStateNotifier.setCustomMode(resolved.mode.name, resolved.mode.icon)
          contextGrabber.setCustomModePrompt(resolved.mode.promptTemplate || null)
          console.info('[AgentSession] Auto-activated custom mode:', resolved.mode.name)
        }
      }
    } catch (error) {
      console.error('[AgentSession] Custom mode resolution failed:', error)
    }

    if (!this.agent) {
      console.info('[AgentSession] No existing agent, creating new one')
      this.agent = this.initAgent()
    } else {
      console.info('[AgentSession] Reusing existing agent instance')
    }

    this.uiMessages = []
    this.currentDraft = null
    this.broadcastWindowState()

    const { llm } = getAdvancedSettings()
    const isSoniox = llm?.asrProvider === 'soniox'

    console.info(
      `[AgentSession] ASR config: provider="${llm?.asrProvider || 'default'}", mode=${isSoniox ? 'soniox' : 'grpc'}`,
    )
    console.info(
      `[AgentSession] LLM config: provider="${llm?.llmProvider || 'default'}", model="${llm?.llmModel || 'default'}"`,
    )

    if (isSoniox) {
      await this.startSonioxAgentSession()
    } else {
      await this.startGrpcAgentSession()
    }

    const elapsed = Date.now() - startMs
    console.info(`[AgentSession] Session started in ${elapsed}ms`)
  }

  private async startGrpcAgentSession() {
    this.isSonioxMode = false
    console.info('[AgentSession] Starting gRPC agent session...')

    const started = await itoStreamController.initialize(ItoMode.TRANSCRIBE)
    if (!started) {
      console.error('[AgentSession] FAILED: itoStreamController.initialize() returned false. Possible concurrent stream.')
      return
    }

    console.info('[AgentSession] Stream controller initialized, starting gRPC stream...')
    this.streamResponsePromise = itoStreamController.startGrpcStream()
    voiceInputService.startAudioRecording()
    recordingStateNotifier.notifyRecordingStarted(ItoMode.TRANSCRIBE)
    preventAppNap()
    console.info('[AgentSession] gRPC recording active')
  }

  private async startSonioxAgentSession() {
    this.isSonioxMode = true
    console.info('[AgentSession] Starting Soniox agent session...')

    this.sonioxAudioHandler = (chunk: Buffer) => {
      if (this.sonioxService) {
        this.sonioxService.sendAudio(chunk)
      }
    }
    audioRecorderService.on('audio-chunk', this.sonioxAudioHandler)

    voiceInputService.startAudioRecording()
    recordingStateNotifier.notifyRecordingStarted(ItoMode.TRANSCRIBE)
    preventAppNap()

    try {
      console.info('[AgentSession] Requesting Soniox temp key...')
      const tempKey = await sonioxTempKeyManager.getKey()
      console.info('[AgentSession] Soniox temp key obtained, connecting...')
      this.sonioxService = new SonioxStreamingService()
      await this.sonioxService.start(tempKey, undefined)
      console.info('[AgentSession] Soniox connected and recording')
    } catch (error) {
      console.error('[AgentSession] Soniox connect failed:', error)
      this.cleanupSoniox()
    }
  }

  public async completeSession() {
    console.info(`[AgentSession] completeSession() called (mode=${this.isSonioxMode ? 'soniox' : 'grpc'})`)
    if (this.isSonioxMode) {
      await this.completeSonioxAgentSession()
      return
    }
    await this.completeGrpcAgentSession()
  }

  private async completeGrpcAgentSession() {
    const completeStartMs = Date.now()
    console.info('[AgentSession] ── completeGrpcAgentSession START ──')

    const responsePromise = this.streamResponsePromise
    this.streamResponsePromise = null

    console.info('[AgentSession] Stopping audio recording...')
    await voiceInputService.stopAudioRecording()

    const audioDurationMs = itoStreamController.getAudioDurationMs()
    console.info(`[AgentSession] Audio duration: ${audioDurationMs}ms`)

    if (audioDurationMs < MINIMUM_AUDIO_DURATION_MS) {
      console.info(`[AgentSession] Audio too short (${audioDurationMs}ms < ${MINIMUM_AUDIO_DURATION_MS}ms), cancelling`)
      itoStreamController.cancelTranscription()
      itoStreamController.clearInteractionAudio()
      recordingStateNotifier.notifyRecordingStopped()
      if (responsePromise) {
        try {
          await responsePromise
        } catch {
          /* expected */
        }
      }
      allowAppNap()
      return
    }

    console.info('[AgentSession] Ending interaction, waiting for transcription...')
    itoStreamController.endInteraction()
    recordingStateNotifier.notifyProcessingStarted(true)
    recordingStateNotifier.notifyRecordingStopped()

    if (responsePromise) {
      try {
        const result = await responsePromise
        const transcript = result.response?.transcript?.trim()

        if (!transcript || transcript.length < 2) {
          console.info(`[AgentSession] Transcript too short or empty: "${transcript || ''}"`)
        } else {
          console.info(`[AgentSession] Transcript received: "${transcript}" (${transcript.length} chars)`)
          await this.runAgentWithTranscript(transcript)
        }
      } catch (error) {
        console.error('[AgentSession] gRPC stream error:', error)
        this.uiMessages.push({
          text: 'Failed to transcribe audio. Please try again.',
          sender: 'agent',
          isError: true,
        })
        this.broadcastWindowState()
      } finally {
        contextGrabber.setCustomModePrompt(null)
        recordingStateNotifier.notifyProcessingStopped()
        allowAppNap()
        itoStreamController.clearInteractionAudio()
        this.resetToolState()
        const elapsed = Date.now() - completeStartMs
        console.info(`[AgentSession] ── completeGrpcAgentSession DONE (${elapsed}ms) ──`)
      }
    } else {
      console.warn('[AgentSession] No responsePromise available — session may have been cancelled')
      contextGrabber.setCustomModePrompt(null)
      recordingStateNotifier.notifyProcessingStopped()
      allowAppNap()
      this.resetToolState()
    }
  }

  private async completeSonioxAgentSession() {
    const completeStartMs = Date.now()
    console.info('[AgentSession] ── completeSonioxAgentSession START ──')

    await voiceInputService.stopAudioRecording()

    if (this.sonioxAudioHandler) {
      audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
      this.sonioxAudioHandler = null
    }

    recordingStateNotifier.notifyProcessingStarted(true)
    recordingStateNotifier.notifyRecordingStopped()

    const service = this.sonioxService
    this.sonioxService = null

    let rawTranscript = ''
    if (service) {
      try {
        console.info('[AgentSession] Stopping Soniox service...')
        rawTranscript = await service.stop()
        console.info(`[AgentSession] Soniox transcript: "${rawTranscript.slice(0, 100)}" (${rawTranscript.length} chars)`)
      } catch (error) {
        console.error('[AgentSession] Soniox stop error:', error)
        rawTranscript = service.getAccumulatedText() || ''
        console.info(`[AgentSession] Soniox fallback text: "${rawTranscript.slice(0, 100)}" (${rawTranscript.length} chars)`)
      }
    } else {
      console.warn('[AgentSession] No Soniox service to stop')
    }

    if (!rawTranscript || rawTranscript.trim().length < 2) {
      console.info('[AgentSession] No speech from Soniox, skipping agent')
      recordingStateNotifier.notifyProcessingStopped()
      allowAppNap()
      return
    }

    try {
      await this.runAgentWithTranscript(rawTranscript.trim())
    } catch (error) {
      console.error('[AgentSession] Agent error:', error)
    } finally {
      contextGrabber.setCustomModePrompt(null)
      recordingStateNotifier.notifyProcessingStopped()
      allowAppNap()
      this.resetToolState()
      const elapsed = Date.now() - completeStartMs
      console.info(`[AgentSession] ── completeSonioxAgentSession DONE (${elapsed}ms) ──`)
    }
  }

  private async runAgentWithTranscript(transcript: string) {
    const runStartMs = Date.now()
    console.info('[AgentSession] ══════ runAgentWithTranscript START ══════')
    console.info(`[AgentSession] Transcript: "${transcript}"`)

    if (!this.agent) {
      console.info('[AgentSession] Agent not initialized, creating...')
      this.agent = this.initAgent()
    }

    this.uiMessages.push({ text: transcript, sender: 'me' })
    this.broadcastWindowState()

    const liveTools: string[] = []
    this.uiMessages.push({ text: '', sender: 'agent', tools: liveTools })

    console.info(`[AgentSession] Calling agent.run()...`)

    const result = await this.agent.run(transcript, {
      onToolExecuted: (tool) => {
        console.info(`[AgentSession] Tool executed: ${tool.displayName} (${tool.didSucceed ? 'SUCCESS' : 'FAILED'})`)
        liveTools.push(tool.displayName)
        this.broadcastWindowState()
      },
    })

    const elapsed = Date.now() - runStartMs
    console.info(
      `[AgentSession] Agent completed in ${elapsed}ms: response=${result.response?.length ?? 0} chars, isError=${result.isError}, history=${result.history.length} turns`,
    )

    this.uiMessages.pop()

    if (result.isError) {
      console.error(`[AgentSession] Agent returned error: ${result.response}`)
      this.uiMessages.push({
        text: result.response || 'An unexpected error occurred.',
        sender: 'agent',
        isError: true,
      })
      this.broadcastWindowState()

      new Notification({
        title: 'Agent error',
        body: result.response || 'An unexpected error occurred.',
      }).show()
      return
    }

    const hasWritten = result.history.some(
      (m) =>
        m.type === 'assistant' &&
        m.tools.some((t) => t.name === 'write_to_text_field' && t.didSucceed),
    )

    if (hasWritten) {
      const lastMsg = result.history[result.history.length - 1]
      const toolDisplayNames =
        lastMsg?.type === 'assistant' ? lastMsg.tools.map((t) => t.displayName) : []

      this.uiMessages.push({
        text: result.response || 'Done!',
        sender: 'agent',
        tools: toolDisplayNames,
        draft: this.currentDraft ?? undefined,
      })
      this.currentDraft = null
      this.broadcastWindowState()
      console.info('[AgentSession] Agent wrote text to field')
      return
    }

    if (result.response) {
      const lastMsg = result.history[result.history.length - 1]
      const toolDisplayNames =
        lastMsg?.type === 'assistant' ? lastMsg.tools.map((t) => t.displayName) : []

      this.uiMessages.push({
        text: result.response,
        sender: 'agent',
        tools: toolDisplayNames,
      })
      this.broadcastWindowState()

      console.info('[AgentSession] Attempting to write response to focused text field...')
      const typed = await setFocusedText(result.response).catch((e) => {
        console.warn('[AgentSession] setFocusedText failed:', e)
        return false
      })
      if (!typed) {
        console.info('[AgentSession] Could not type — showing notification instead')
        new Notification({
          title: 'Agent',
          body: result.response,
        }).show()
      }
    } else {
      this.uiMessages.push({
        text: 'Done — nothing to write.',
        sender: 'agent',
      })
      this.broadcastWindowState()

      new Notification({
        title: 'Agent',
        body: 'Done — nothing to write.',
      }).show()
    }

    console.info('[AgentSession] ══════ runAgentWithTranscript DONE ══════')
  }

  private resetToolState() {
    console.info('[AgentSession] Resetting tool state')
    this.stopTool?.reset()
    this.draftTool?.clearDraft()
    this.currentDraft = null
  }

  public cancelSession() {
    console.info('[AgentSession] ══════ CANCEL SESSION ══════')
    voiceInputService.stopAudioRecording()

    if (this.isSonioxMode) {
      this.cleanupSoniox()
    } else {
      itoStreamController.cancelTranscription()
      itoStreamController.clearInteractionAudio()
    }

    contextGrabber.setCustomModePrompt(null)
    recordingStateNotifier.notifyRecordingStopped()
    recordingStateNotifier.notifyProcessingStopped()
    allowAppNap()
    this.streamResponsePromise = null
    this.resetToolState()
    console.info('[AgentSession] Session cancelled')
  }

  public async cleanup() {
    console.info('[AgentSession] ══════ FULL CLEANUP ══════')
    this.agent?.clearHistory()
    this.uiMessages = []
    this.agent = null
    this.stopTool = null
    this.draftTool = null
    this.writeToTextFieldTool = null
    this.currentDraft = null

    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send('agent-window-update', null)
      }
    })
    console.info('[AgentSession] Cleanup complete')
  }

  private cleanupSoniox() {
    console.info('[AgentSession] Cleaning up Soniox resources')
    if (this.sonioxAudioHandler) {
      audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
      this.sonioxAudioHandler = null
    }
    if (this.sonioxService) {
      this.sonioxService.cancel()
      this.sonioxService = null
    }
  }
}

export const agentSessionManager = new AgentSessionManager()
