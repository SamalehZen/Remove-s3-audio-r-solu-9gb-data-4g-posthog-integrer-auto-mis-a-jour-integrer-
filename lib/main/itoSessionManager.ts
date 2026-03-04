import { ItoMode } from '@/app/generated/ito_pb'
import { voiceInputService } from './voiceInputService'
import { recordingStateNotifier } from './recordingStateNotifier'
import { itoStreamController } from './itoStreamController'
import { TextInserter } from './text/TextInserter'
import { interactionManager } from './interactions/InteractionManager'
import { contextGrabber, ContextData } from './context/ContextGrabber'
import { GrammarRulesService } from './grammar/GrammarRulesService'
import { getAdvancedSettings, store } from './store'
import log from 'electron-log'
import { preventAppNap, allowAppNap } from './appNap'
import { timingCollector, TimingEventName } from './timing/TimingCollector'
import {
  SonioxStreamingService,
  SonioxTranslationConfig,
} from './soniox/SonioxStreamingService'
import { sonioxTempKeyManager } from './soniox/SonioxTempKeyManager'
import { audioRecorderService } from '../media/audio'
import { unmuteSystemAudio } from '../media/systemAudio'
import { itoHttpClient } from '../clients/itoHttpClient'
import { STORE_KEYS } from '../constants/store-keys'

export class ItoSessionManager {
  private readonly MINIMUM_AUDIO_DURATION_MS = 100
  private readonly SONIOX_CONNECT_TIMEOUT_MS = 10_000
  private readonly SONIOX_MAX_PENDING_BYTES = 512 * 1024

  private textInserter = new TextInserter()
  private streamResponsePromise: Promise<{
    response: any
    audioBuffer: Buffer
    sampleRate: number
  }> | null = null
  private grammarRulesService = new GrammarRulesService('')

  private sonioxService: SonioxStreamingService | null = null
  private isSonioxMode = false
  private currentMode: ItoMode = ItoMode.TRANSCRIBE
  private sonioxAudioHandler: ((chunk: Buffer) => void) | null = null
  private sonioxContext: ContextData | null = null
  private sonioxSessionGeneration = 0
  private sonioxSessionActive = false
  private contextGatherPromise: Promise<void> | null = null
  private preWarmedSonioxService: SonioxStreamingService | null = null
  private preWarmTimestamp = 0
  private readonly PRE_WARM_TTL_MS = 30_000

  public async startSession(mode: ItoMode) {
    console.log('[itoSessionManager] Starting session with mode:', mode)
    this.currentMode = mode

    let interactionId = interactionManager.getCurrentInteractionId()
    if (interactionId) {
      console.log(
        '[itoSessionManager] Reusing existing interaction ID:',
        interactionId,
      )
      interactionManager.adoptInteractionId(interactionId)
    } else {
      interactionId = interactionManager.initialize()
    }

    const { llm } = getAdvancedSettings()
    const isSoniox = llm?.asrProvider === 'soniox'

    if (
      mode === ItoMode.TRANSLATE ||
      mode === ItoMode.CONTEXT_AWARENESS ||
      isSoniox
    ) {
      await this.startSonioxSession(mode)
    } else {
      await this.startGrpcSession(mode)
    }

    return interactionId
  }

  private async startGrpcSession(mode: ItoMode) {
    this.isSonioxMode = false

    const started = await itoStreamController.initialize(mode)
    if (!started) {
      log.error('[itoSessionManager] Failed to initialize itoStreamController')
      return
    }

    this.streamResponsePromise = itoStreamController.startGrpcStream()
    voiceInputService.startAudioRecording()
    itoStreamController.setMode(mode)
    recordingStateNotifier.notifyRecordingStarted(mode)
    preventAppNap()

    this.fetchAndSendContext().catch(error => {
      log.error('[itoSessionManager] Failed to fetch/send context:', error)
    })

    timingCollector.startInteraction()
    timingCollector.startTiming(TimingEventName.INTERACTION_ACTIVE)
  }

  private async startSonioxSession(mode: ItoMode) {
    this.isSonioxMode = true
    this.sonioxSessionActive = true
    const generation = ++this.sonioxSessionGeneration

    const pendingChunks: Buffer[] = []
    let pendingBytes = 0
    let sonioxReady = false

    this.sonioxAudioHandler = (chunk: Buffer) => {
      if (sonioxReady && this.sonioxService) {
        this.sonioxService.sendAudio(chunk)
      } else if (pendingBytes < this.SONIOX_MAX_PENDING_BYTES) {
        pendingChunks.push(chunk)
        pendingBytes += chunk.length
      }
    }
    audioRecorderService.on('audio-chunk', this.sonioxAudioHandler)

    voiceInputService.startAudioRecording()
    recordingStateNotifier.notifyRecordingStarted(mode)
    preventAppNap()

    try {
      const connectWithTimeout = async () => {
        const tempKey = await sonioxTempKeyManager.getKey()

        if (generation !== this.sonioxSessionGeneration) {
          console.log(
            '[itoSessionManager] Soniox session was cancelled during key fetch, aborting',
          )
          return false
        }

        const preWarmed = this.preWarmedSonioxService
        this.preWarmedSonioxService = null

        if (
          preWarmed &&
          preWarmed.isCurrentlyActive() &&
          !preWarmed.hasEncounteredError() &&
          Date.now() - this.preWarmTimestamp < this.PRE_WARM_TTL_MS &&
          mode === ItoMode.TRANSCRIBE
        ) {
          this.sonioxService = preWarmed
          this.sonioxService.on('error', (error: Error) => {
            console.error(
              '[itoSessionManager] Soniox streaming error:',
              error.message,
            )
            this.handleSonioxStreamError(error)
          })
          console.log(
            '[itoSessionManager] Reusing pre-warmed Soniox connection',
          )
        } else {
          if (preWarmed) {
            preWarmed.cancel()
          }
          this.sonioxService = new SonioxStreamingService()
          this.sonioxService.on('error', (error: Error) => {
            console.error(
              '[itoSessionManager] Soniox streaming error:',
              error.message,
            )
            this.handleSonioxStreamError(error)
          })
          await this.sonioxService.start(tempKey, this.getTranslationConfig())
        }

        if (generation !== this.sonioxSessionGeneration) {
          console.log(
            '[itoSessionManager] Soniox session was cancelled during connect, cleaning up',
          )
          this.sonioxService.cancel()
          this.sonioxService = null
          return false
        }

        return true
      }

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Soniox connection timed out')),
          this.SONIOX_CONNECT_TIMEOUT_MS,
        ),
      )

      const connected = await Promise.race([connectWithTimeout(), timeout])

      if (connected) {
        sonioxReady = true
        for (const chunk of pendingChunks) {
          this.sonioxService!.sendAudio(chunk)
        }
        pendingChunks.length = 0
        console.log(
          '[itoSessionManager] Soniox connected, buffered chunks flushed',
        )
      }
    } catch (error) {
      if (this.currentMode === ItoMode.TRANSLATE) {
        console.error(
          '[itoSessionManager] Translation mode requires Soniox. Ensure Soniox API key is configured on the server.',
        )
      }
      log.error('[itoSessionManager] Failed to start Soniox session:', error)
      this.sonioxService = null
    }

    this.contextGatherPromise = this.gatherAndCacheContext(mode)
    this.contextGatherPromise.catch(error => {
      log.error(
        '[itoSessionManager] Failed to gather context for Soniox:',
        error,
      )
    })

    timingCollector.startInteraction()
    timingCollector.startTiming(TimingEventName.INTERACTION_ACTIVE)
  }

  private async gatherAndCacheContext(mode: ItoMode) {
    console.log('[itoSessionManager] Gathering context for Soniox mode...')
    const context = await contextGrabber.gatherContext(mode)
    this.sonioxContext = context

    if (mode === ItoMode.CONTEXT_AWARENESS && context.contextSource) {
      recordingStateNotifier.notifyRecordingStarted(
        mode,
        context.contextSource,
        context.screenThumbnailBase64,
      )
    }

    const { grammarServiceEnabled } = getAdvancedSettings()
    if (grammarServiceEnabled) {
      const cursorContext = await timingCollector.timeAsync(
        TimingEventName.GRAMMAR_SERVICE,
        async () => await contextGrabber.getCursorContextForGrammar(),
      )
      this.grammarRulesService = new GrammarRulesService(cursorContext)
    }
  }

  private async fetchAndSendContext() {
    console.log('[itoSessionManager] Gathering context...')

    const context = await contextGrabber.gatherContext(
      itoStreamController.getCurrentMode(),
    )

    await itoStreamController.scheduleConfigUpdate(context)

    if (
      itoStreamController.getCurrentMode() === ItoMode.CONTEXT_AWARENESS &&
      context.contextSource
    ) {
      recordingStateNotifier.notifyRecordingStarted(
        itoStreamController.getCurrentMode(),
        context.contextSource,
        context.screenThumbnailBase64,
      )
    }

    const { grammarServiceEnabled } = getAdvancedSettings()
    if (grammarServiceEnabled) {
      const cursorContext = await timingCollector.timeAsync(
        TimingEventName.GRAMMAR_SERVICE,
        async () => await contextGrabber.getCursorContextForGrammar(),
      )
      this.grammarRulesService = new GrammarRulesService(cursorContext)
    }
  }

  public setMode(mode: ItoMode) {
    this.currentMode = mode

    if (this.isSonioxMode) {
      recordingStateNotifier.notifyRecordingStarted(mode)
      return
    }

    itoStreamController.setMode(mode)
    recordingStateNotifier.notifyRecordingStarted(mode)
  }

  public async cancelSession() {
    if (this.isSonioxMode) {
      this.sonioxSessionActive = false
      this.sonioxSessionGeneration++

      this.sonioxService?.cancel()
      this.sonioxService = null
      if (this.sonioxAudioHandler) {
        audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
        this.sonioxAudioHandler = null
      }
      await voiceInputService.stopAudioRecording()
      recordingStateNotifier.notifyRecordingStopped()
      timingCollector.clearInteraction()
      interactionManager.clearCurrentInteraction()
      this.cleanupSonioxState()
      allowAppNap()
      return
    }

    const responsePromise = this.streamResponsePromise
    this.streamResponsePromise = null

    timingCollector.clearInteraction()
    itoStreamController.cancelTranscription()
    interactionManager.clearCurrentInteraction()
    itoStreamController.clearInteractionAudio()

    await voiceInputService.stopAudioRecording()
    recordingStateNotifier.notifyRecordingStopped()

    if (responsePromise) {
      try {
        await responsePromise
      } catch (error) {
        console.log('[itoSessionManager] Stream cancelled as expected:', error)
      }
    }
    allowAppNap()
  }

  private readonly DRAIN_FLUSH_MS = 80

  public async completeSession() {
    if (this.isSonioxMode) {
      await this.completeSonioxSession()
      return
    }

    const responsePromise = this.streamResponsePromise
    this.streamResponsePromise = null

    timingCollector.endTiming(TimingEventName.INTERACTION_ACTIVE)

    audioRecorderService.stopRecording()

    const audioDurationMs = itoStreamController.getAudioDurationMs()

    if (audioDurationMs < this.MINIMUM_AUDIO_DURATION_MS) {
      console.log(
        `[itoSessionManager] Audio too short (${audioDurationMs}ms < ${this.MINIMUM_AUDIO_DURATION_MS}ms), cancelling`,
      )
      itoStreamController.cancelTranscription()
      itoStreamController.clearInteractionAudio()
      recordingStateNotifier.notifyRecordingStopped()
      this.unmuteIfNeeded()

      if (responsePromise) {
        try {
          await responsePromise
        } catch (error) {
          console.log(
            '[itoSessionManager] Stream cancelled as expected:',
            error,
          )
        }
      }
      allowAppNap()
      return
    }

    await new Promise(resolve => setTimeout(resolve, this.DRAIN_FLUSH_MS))

    itoStreamController.endInteraction()
    this.unmuteIfNeeded()
    recordingStateNotifier.notifyProcessingStarted()
    recordingStateNotifier.notifyRecordingStopped()

    if (responsePromise) {
      console.log(
        '[itoSessionManager] Waiting for stream response from server...',
      )
      try {
        const result = await responsePromise
        console.log('[itoSessionManager] Received stream response:', {
          hasTranscript: !!result.response?.transcript,
          transcriptLength: result.response?.transcript?.length || 0,
          hasError: !!result.response?.error,
          audioBufferSize: result.audioBuffer.length,
        })
        await this.handleTranscriptionResponse(result)
      } catch (error) {
        console.error(
          '[itoSessionManager] Error waiting for stream response:',
          error,
        )
        await this.handleTranscriptionError(error)
      } finally {
        recordingStateNotifier.notifyProcessingStopped()
      }
    } else {
      console.warn('[itoSessionManager] No stream response promise to wait for')
      recordingStateNotifier.notifyProcessingStopped()
    }
  }

  private unmuteIfNeeded() {
    if (store.get(STORE_KEYS.SETTINGS)?.muteAudioWhenDictating) {
      unmuteSystemAudio()
    }
  }

  private async completeSonioxSession() {
    if (!this.sonioxSessionActive) {
      console.warn(
        '[itoSessionManager] completeSonioxSession called but no active session, skipping',
      )
      return
    }
    this.sonioxSessionActive = false

    timingCollector.endTiming(TimingEventName.INTERACTION_ACTIVE)

    const mode = this.currentMode
    const service = this.sonioxService
    this.sonioxService = null

    if (mode === ItoMode.TRANSCRIBE) {
      audioRecorderService.stopRecording()
      if (this.sonioxAudioHandler) {
        audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
        this.sonioxAudioHandler = null
      }
      if (store.get(STORE_KEYS.SETTINGS)?.muteAudioWhenDictating) {
        unmuteSystemAudio()
      }

      recordingStateNotifier.notifyProcessingStarted()
      recordingStateNotifier.notifyRecordingStopped()

      let rawTranscript = ''
      if (service) {
        try {
          rawTranscript = await service.stop()
        } catch (error) {
          console.error('[itoSessionManager] Error stopping Soniox service:', error)
          rawTranscript = service.getAccumulatedText() || ''
        }
      }

      if (!rawTranscript || rawTranscript.trim().length === 0) {
        console.warn('[itoSessionManager] No speech detected from Soniox')
        recordingStateNotifier.notifyProcessingStopped()
        allowAppNap()
        this.cleanupSonioxState()
        return
      }

      let textToInsert = rawTranscript

      const ctx = this.sonioxContext
      if (ctx?.replacements && ctx.replacements.length > 0) {
        textToInsert = this.applyCustomReplacements(textToInsert, ctx.replacements)
      }

      const { grammarServiceEnabled } = getAdvancedSettings()
      if (grammarServiceEnabled) {
        textToInsert = this.grammarRulesService.setCaseFirstWord(textToInsert)
        textToInsert =
          this.grammarRulesService.addLeadingSpaceIfNeeded(textToInsert)
      }

      this.textInserter.insertText(textToInsert)
      recordingStateNotifier.notifyProcessingStopped()

      interactionManager
        .createInteraction(rawTranscript, Buffer.alloc(0), 16000, undefined)
        .catch(error =>
          console.error(
            '[itoSessionManager] Failed to create interaction:',
            error,
          ),
        )

      allowAppNap()
      this.cleanupSonioxState()
      this.preWarmSonioxConnection()
      return
    }

    await voiceInputService.stopAudioRecording()

    if (this.sonioxAudioHandler) {
      audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
      this.sonioxAudioHandler = null
    }

    recordingStateNotifier.notifyProcessingStarted()
    recordingStateNotifier.notifyRecordingStopped()

    let rawTranscript = ''
    if (service) {
      try {
        rawTranscript = await service.stop()
      } catch (error) {
        console.error(
          '[itoSessionManager] Error stopping Soniox service:',
          error,
        )
        rawTranscript = service.getAccumulatedText() || ''
      }
    }

    if (!rawTranscript || rawTranscript.trim().length === 0) {
      console.warn('[itoSessionManager] No speech detected from Soniox')
      recordingStateNotifier.notifyProcessingStopped()
      allowAppNap()
      this.cleanupSonioxState()
      return
    }

    if (this.contextGatherPromise) {
      try {
        await this.contextGatherPromise
      } catch {
        // already logged at call site
      }
      this.contextGatherPromise = null
    }

    try {
      const { llm } = getAdvancedSettings()
      const ctx = this.sonioxContext

      const requestBody: Record<string, any> = {
        transcript: rawTranscript,
        mode:
          mode === ItoMode.EDIT
            ? 'edit'
            : mode === ItoMode.TRANSLATE
              ? 'translate'
              : mode === ItoMode.CONTEXT_AWARENESS
                ? 'context_awareness'
                : 'transcribe',
        llmSettings: {
          llmProvider: llm?.llmProvider || undefined,
          llmModel: llm?.llmModel || undefined,
          llmTemperature: llm?.llmTemperature ?? undefined,
          transcriptionPrompt: llm?.transcriptionPrompt || undefined,
          editingPrompt: llm?.editingPrompt || undefined,
        },
      }

      if (mode === ItoMode.TRANSLATE) {
        const settings = store.get(STORE_KEYS.SETTINGS)
        requestBody.targetLanguage = settings?.translationTargetLanguage || 'en'
      }

      if (ctx) {
        requestBody.context = {
          windowTitle: ctx.windowTitle || '',
          appName: ctx.appName || '',
          contextText: ctx.contextText || '',
          browserUrl: ctx.browserUrl || undefined,
          browserDomain: ctx.browserDomain || undefined,
          tonePrompt: ctx.tone?.promptTemplate || undefined,
          userDetailsContext: ctx.userDetails
            ? this.buildUserDetailsContextString(ctx.userDetails)
            : undefined,
        }
        if (mode === ItoMode.CONTEXT_AWARENESS && ctx.screenCaptureBase64) {
          requestBody.screenshotBase64 = ctx.screenCaptureBase64
        }
        if (ctx.replacements && ctx.replacements.length > 0) {
          requestBody.replacements = ctx.replacements.map(r => ({
            fromText: r.from,
            toText: r.to,
          }))
        }
      }

      const response = await itoHttpClient.post(
        '/adjust-transcript',
        requestBody,
        { requireAuth: true },
      )

      if (response?.success && response?.transcript) {
        let textToInsert = response.transcript

        const { grammarServiceEnabled } = getAdvancedSettings()
        if (grammarServiceEnabled) {
          textToInsert = this.grammarRulesService.setCaseFirstWord(textToInsert)
          textToInsert =
            this.grammarRulesService.addLeadingSpaceIfNeeded(textToInsert)
        }

        this.textInserter.insertText(textToInsert)
      } else {
        console.error(
          '[itoSessionManager] LLM adjustment failed:',
          response?.error,
        )
        this.textInserter.insertText(rawTranscript)
      }
    } catch (error) {
      console.error('[itoSessionManager] Error during LLM adjustment:', error)
      this.textInserter.insertText(rawTranscript)
    } finally {
      recordingStateNotifier.notifyProcessingStopped()
    }

    try {
      await interactionManager.createInteraction(
        rawTranscript,
        Buffer.alloc(0),
        16000,
        undefined,
      )
    } catch (error) {
      console.error('[itoSessionManager] Failed to create interaction:', error)
    }

    allowAppNap()
    this.cleanupSonioxState()
  }

  private applyCustomReplacements(
    transcript: string,
    replacements: Array<{ from: string; to: string }>,
  ): string {
    if (!replacements || replacements.length === 0) return transcript

    let result = transcript
    for (const replacement of replacements) {
      const from = replacement.from
      const to = replacement.to
      if (!from || !to) continue
      if (from.toLowerCase() === to.toLowerCase()) continue

      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`\\b${escaped}\\b`, 'gi')
      result = result.replace(regex, to)
    }
    return result
  }

  private buildUserDetailsContextString(
    userDetails: NonNullable<ContextData['userDetails']>,
  ): string {
    const lines: string[] = []
    if (userDetails.fullName) lines.push(`Name: ${userDetails.fullName}`)
    if (userDetails.occupation)
      lines.push(`Occupation: ${userDetails.occupation}`)
    if (userDetails.companyName)
      lines.push(`Company: ${userDetails.companyName}`)
    if (userDetails.role) lines.push(`Role: ${userDetails.role}`)
    if (userDetails.email) lines.push(`Email: ${userDetails.email}`)
    if (userDetails.phoneNumber) lines.push(`Phone: ${userDetails.phoneNumber}`)
    if (userDetails.businessAddress)
      lines.push(`Address: ${userDetails.businessAddress}`)
    if (userDetails.website) lines.push(`Website: ${userDetails.website}`)
    if (userDetails.linkedin) lines.push(`LinkedIn: ${userDetails.linkedin}`)
    if (userDetails.additionalInfo && userDetails.additionalInfo.length > 0) {
      for (const info of userDetails.additionalInfo) {
        if (info.key.trim() && info.value.trim())
          lines.push(`${info.key}: ${info.value}`)
      }
    }
    return lines.join('\n')
  }

  private getTranslationConfig(): SonioxTranslationConfig | undefined {
    if (this.currentMode !== ItoMode.TRANSLATE) return undefined

    const settings = store.get(STORE_KEYS.SETTINGS)
    const type = settings?.translationType || 'one_way'

    if (type === 'one_way') {
      return {
        type: 'one_way',
        targetLanguage: settings?.translationTargetLanguage || 'en',
      }
    } else {
      return {
        type: 'two_way',
        languageA: settings?.translationLanguageA || 'fr',
        languageB: settings?.translationLanguageB || 'en',
      }
    }
  }

  private cleanupSonioxState() {
    timingCollector.finalizeInteraction()
    interactionManager.clearCurrentInteraction()
    this.isSonioxMode = false
    this.sonioxContext = null
    this.contextGatherPromise = null
  }

  private preWarmSonioxConnection() {
    if (this.preWarmedSonioxService) return
    sonioxTempKeyManager
      .getKey()
      .then(async tempKey => {
        if (this.preWarmedSonioxService || this.sonioxSessionActive) return
        const service = new SonioxStreamingService()
        service.on('error', () => {
          if (this.preWarmedSonioxService === service) {
            this.preWarmedSonioxService = null
            this.preWarmTimestamp = 0
          }
        })
        await service.start(tempKey)
        if (this.sonioxSessionActive) {
          service.cancel()
          return
        }
        this.preWarmedSonioxService = service
        this.preWarmTimestamp = Date.now()
        console.log(
          '[itoSessionManager] Pre-warmed Soniox connection ready',
        )
      })
      .catch(error => {
        console.warn(
          '[itoSessionManager] Pre-warm Soniox connection failed:',
          error,
        )
      })
  }

  private async handleTranscriptionResponse(result: {
    response: any
    audioBuffer: Buffer
    sampleRate: number
  }) {
    const { response, audioBuffer, sampleRate } = result

    const errorMessage = response.error ? response.error.message : undefined

    if (response.error) {
      interactionManager.createInteraction(
        response.transcript || '',
        audioBuffer,
        sampleRate,
        errorMessage,
      ).catch(err => console.error('[itoSessionManager] Failed to save interaction:', err))
      timingCollector.clearInteraction()
      interactionManager.clearCurrentInteraction()
      itoStreamController.clearInteractionAudio()
    } else {
      if (response.transcript && !response.error) {
        let textToInsert = response.transcript

        const { grammarServiceEnabled } = getAdvancedSettings()
        if (grammarServiceEnabled) {
          textToInsert = this.grammarRulesService.setCaseFirstWord(textToInsert)
          textToInsert =
            this.grammarRulesService.addLeadingSpaceIfNeeded(textToInsert)
        }

        this.textInserter.insertText(textToInsert)

        interactionManager.createInteraction(
          response.transcript,
          audioBuffer,
          sampleRate,
          errorMessage,
        ).catch(err => console.error('[itoSessionManager] Failed to save interaction:', err))
      } else {
        log.warn('[itoSessionManager] Skipping text insertion:', {
          hasTranscript: !!response.transcript,
          transcriptLength: response.transcript?.length || 0,
          hasError: !!response.error,
        })
      }
      timingCollector.finalizeInteraction()
      interactionManager.clearCurrentInteraction()
      itoStreamController.clearInteractionAudio()
    }
    allowAppNap()
  }

  private async handleTranscriptionError(error: any) {
    log.error(
      '[itoSessionManager] An unexpected error occurred during transcription:',
      error,
    )
    timingCollector.clearInteraction()
    interactionManager.clearCurrentInteraction()
    itoStreamController.clearInteractionAudio()
    allowAppNap()
  }

  private handleSonioxStreamError(error: Error) {
    if (!this.sonioxSessionActive) {
      console.warn(
        '[itoSessionManager] Soniox stream error after session ended, ignoring:',
        error.message,
      )
      return
    }

    console.error(
      '[itoSessionManager] Soniox stream error, cleaning up session:',
      error.message,
    )

    this.sonioxSessionActive = false
    this.sonioxSessionGeneration++

    if (this.sonioxAudioHandler) {
      audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
      this.sonioxAudioHandler = null
    }

    this.sonioxService?.cancel()
    this.sonioxService = null

    voiceInputService.stopAudioRecording().catch(e => {
      console.error(
        '[itoSessionManager] Error stopping audio after Soniox error:',
        e,
      )
    })

    recordingStateNotifier.notifyRecordingStopped()
    timingCollector.clearInteraction()
    interactionManager.clearCurrentInteraction()
    allowAppNap()
    this.cleanupSonioxState()
  }
}

export const itoSessionManager = new ItoSessionManager()
