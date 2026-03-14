import { ItoMode } from '@/app/generated/ito_pb'
import { voiceInputService } from './voiceInputService'
import { recordingStateNotifier } from './recordingStateNotifier'
import { itoStreamController } from './itoStreamController'
import { TextInserter } from './text/TextInserter'
import { interactionManager } from './interactions/InteractionManager'
import { contextGrabber, ContextData } from './context/ContextGrabber'
import { GrammarRulesService } from './grammar/GrammarRulesService'
import { getAdvancedSettings, getCurrentUserId, store } from './store'
import log from 'electron-log'
import { preventAppNap, allowAppNap } from './appNap'
import { timingCollector, TimingEventName } from './timing/TimingCollector'
import {
  SonioxPersistentSession,
  type SonioxTranslationConfig,
} from './soniox/SonioxPersistentSession'
import { sonioxTempKeyManager } from './soniox/SonioxTempKeyManager'
import { audioRecorderService } from '../media/audio'
import { unmuteSystemAudio } from '../media/systemAudio'
import { itoHttpClient } from '../clients/itoHttpClient'
import { STORE_KEYS } from '../constants/store-keys'
import { DEFAULT_ADVANCED_SETTINGS } from '../constants/generated-defaults'
import { customModeResolver } from './context/CustomModeResolver'
import { activeWindowMonitor } from './ActiveWindowMonitor'
import type { ResolvedCustomMode } from './context/CustomModeResolver'

export class ItoSessionManager {
  private readonly MINIMUM_AUDIO_DURATION_MS = 100
  private readonly SONIOX_MAX_PENDING_BYTES = 512 * 1024

  private textInserter = new TextInserter()
  private streamResponsePromise: Promise<{
    response: any
    audioBuffer: Buffer
    sampleRate: number
  }> | null = null
  private grammarRulesService = new GrammarRulesService('')

  private sonioxPersistentSession: SonioxPersistentSession | null = null
  private isSonioxMode = false
  private currentMode: ItoMode = ItoMode.TRANSCRIBE
  private sonioxAudioHandler: ((chunk: Buffer) => void) | null = null
  private sonioxContext: ContextData | null = null
  private contextGatherPromise: Promise<void> | null = null
  private resolvedCustomMode: ResolvedCustomMode | null = null

  public async startSession(mode: ItoMode) {
    console.log('[itoSessionManager] Starting session with mode:', mode)

    let effectiveMode = mode
    contextGrabber.setCustomModePrompt(null)

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
          this.resolvedCustomMode = resolved
          recordingStateNotifier.setCustomMode(
            resolved.mode.name,
            resolved.mode.icon,
          )
          contextGrabber.setCustomModePrompt(
            resolved.mode.promptTemplate || null,
          )
          effectiveMode = resolved.mode.itoMode as ItoMode
          console.log(
            '[itoSessionManager] Auto-activated custom mode:',
            resolved.mode.name,
            '→ effectiveMode:',
            effectiveMode,
          )
        }
      }
    } catch (error) {
      console.error(
        '[itoSessionManager] Custom mode resolution failed:',
        error,
      )
    }

    this.currentMode = effectiveMode

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
      effectiveMode === ItoMode.TRANSLATE ||
      effectiveMode === ItoMode.CONTEXT_AWARENESS ||
      isSoniox
    ) {
      await this.startSonioxSession(effectiveMode)
    } else {
      await this.startGrpcSession(effectiveMode)
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
    this.currentMode = mode

    console.log(
      `[itoSessionManager] [SONIOX-START] mode=${mode}`,
    )

    if (!this.sonioxPersistentSession) {
      this.sonioxPersistentSession = new SonioxPersistentSession({
        idleTimeoutMs: 120_000,
        maxSessionAgeMs: 240 * 60 * 1000,
      })

      this.sonioxPersistentSession.on('error', (error: Error) => {
        console.error(
          `[itoSessionManager] [SONIOX-PERSISTENT-ERROR] ${error.message}`,
        )
        this.handleSonioxStreamError(error)
      })

      this.sonioxPersistentSession.on('auto-closed', (reason) => {
        console.log(
          `[itoSessionManager] [SONIOX-AUTO-CLOSED] reason=${reason}`,
        )
      })
    }

    const pendingChunks: Buffer[] = []
    let pendingBytes = 0
    let sonioxReady = false
    let droppedChunks = 0

    this.sonioxAudioHandler = (chunk: Buffer) => {
      if (sonioxReady && this.sonioxPersistentSession) {
        this.sonioxPersistentSession.sendAudio(chunk)
      } else if (pendingBytes < this.SONIOX_MAX_PENDING_BYTES) {
        pendingChunks.push(chunk)
        pendingBytes += chunk.length
      } else {
        droppedChunks++
        if (droppedChunks === 1 || droppedChunks % 20 === 0) {
          console.warn(
            `[itoSessionManager] [SONIOX-AUDIO] Pending buffer full (${(this.SONIOX_MAX_PENDING_BYTES / 1024).toFixed(0)}KB) — DROPPING chunk #${droppedChunks} (${chunk.length}B)`,
          )
        }
      }
    }
    audioRecorderService.on('audio-chunk', this.sonioxAudioHandler)

    voiceInputService.startAudioRecording()
    recordingStateNotifier.notifyRecordingStarted(mode)
    preventAppNap()

    try {
      const tempKey = await sonioxTempKeyManager.getKey()
      await this.sonioxPersistentSession.ensureReady(
        tempKey,
        this.getTranslationConfig(),
        {},
      )

      this.sonioxPersistentSession.startStreaming()
      sonioxReady = true

      console.log(
        `[itoSessionManager] [SONIOX-CONNECTED] Flushing ${pendingChunks.length} buffered chunks (${(pendingBytes / 1024).toFixed(1)}KB)`,
      )
      for (const chunk of pendingChunks) {
        this.sonioxPersistentSession.sendAudio(chunk)
      }
      pendingChunks.length = 0
    } catch (error) {
      if (this.currentMode === ItoMode.TRANSLATE) {
        console.error(
          '[itoSessionManager] Translation mode requires Soniox. Ensure Soniox API key is configured on the server.',
        )
      }
      console.error('[itoSessionManager] Failed to start Soniox persistent session:', error)
      if (this.sonioxAudioHandler) {
        audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
        this.sonioxAudioHandler = null
      }
      voiceInputService.stopAudioRecording().catch(() => {})
      recordingStateNotifier.notifyRecordingStopped()
      allowAppNap()
      return
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
    contextGrabber.setCustomModePrompt(null)
    this.resolvedCustomMode = null

    if (this.isSonioxMode) {
      if (this.sonioxPersistentSession?.getState() === 'streaming') {
        this.sonioxPersistentSession.stopStreaming().catch(() => {})
      }
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
      contextGrabber.setCustomModePrompt(null)
      this.resolvedCustomMode = null
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
        contextGrabber.setCustomModePrompt(null)
        this.resolvedCustomMode = null
      }
    } else {
      console.warn('[itoSessionManager] No stream response promise to wait for')
      recordingStateNotifier.notifyProcessingStopped()
      contextGrabber.setCustomModePrompt(null)
      this.resolvedCustomMode = null
    }
  }

  private unmuteIfNeeded() {
    if (store.get(STORE_KEYS.SETTINGS)?.muteAudioWhenDictating) {
      unmuteSystemAudio()
    }
  }

  private async completeSonioxSession() {
    if (!this.sonioxPersistentSession || this.sonioxPersistentSession.getState() !== 'streaming') {
      console.warn(
        `[itoSessionManager] [SONIOX-COMPLETE] completeSonioxSession called but not streaming, skipping`,
      )
      return
    }

    timingCollector.endTiming(TimingEventName.INTERACTION_ACTIVE)

    const mode = this.currentMode

    console.log(
      `[itoSessionManager] [SONIOX-COMPLETE] ── START ── mode=${mode}`,
    )

    const hasCustomPrompt = this.sonioxContext?.tone?.promptTemplate?.trim()

    if (mode === ItoMode.TRANSCRIBE && !hasCustomPrompt) {
      await new Promise(resolve => setTimeout(resolve, this.DRAIN_FLUSH_MS))
      audioRecorderService.stopRecording()
      if (this.sonioxAudioHandler) {
        audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
        this.sonioxAudioHandler = null
        console.log(
          `[itoSessionManager] [SONIOX-COMPLETE] Audio handler removed after stopRecording`,
        )
      }
      if (store.get(STORE_KEYS.SETTINGS)?.muteAudioWhenDictating) {
        unmuteSystemAudio()
      }

      recordingStateNotifier.notifyProcessingStarted()
      recordingStateNotifier.notifyRecordingStopped()

      let rawTranscript = ''
      if (this.sonioxPersistentSession) {
        try {
          const utteranceResult = await this.sonioxPersistentSession.stopStreaming()
          rawTranscript = utteranceResult.text.trim()
          console.log(
            `[itoSessionManager] [SONIOX-COMPLETE] stopStreaming() returned | rawTranscript="${rawTranscript.slice(0, 80)}" (${rawTranscript.length} chars)`,
          )
        } catch (error) {
          console.error(
            `[itoSessionManager] [SONIOX-COMPLETE] stopStreaming() threw:`,
            error,
          )
        }
      } else {
        console.warn(
          `[itoSessionManager] [SONIOX-COMPLETE] persistent session is null — no transcript available`,
        )
      }

      if (!rawTranscript || rawTranscript.trim().length === 0) {
        console.warn(
          `[itoSessionManager] [SONIOX-COMPLETE] No speech detected (empty transcript)`,
        )
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

      const advSettings = getAdvancedSettings()

      const sonioxFastEnabled = advSettings.llm?.sonioxFastLlmEnabled
      if (sonioxFastEnabled && textToInsert.trim().length > 0) {
        try {
          const fastProvider = advSettings.llm?.sonioxFastLlmProvider || DEFAULT_ADVANCED_SETTINGS.sonioxFastLlmProvider
          const fastModel = advSettings.llm?.sonioxFastLlmModel || DEFAULT_ADVANCED_SETTINGS.sonioxFastLlmModel
          const fastPrompt = (advSettings.llm?.sonioxFastPrompt && advSettings.llm.sonioxFastPrompt.trim())
            ? advSettings.llm.sonioxFastPrompt
            : DEFAULT_ADVANCED_SETTINGS.sonioxFastPrompt

          const fastRequestBody: Record<string, any> = {
            transcript: textToInsert,
            mode: 'transcribe',
            llmSettings: {
              llmProvider: fastProvider,
              llmModel: fastModel || undefined,
              llmTemperature: 0.1,
              transcriptionPrompt: fastPrompt,
            },
          }
          if (ctx?.userDetails) {
            fastRequestBody.context = {
              userDetailsContext: this.buildUserDetailsContextString(ctx.userDetails),
            }
          }
          const fastStart = Date.now()
          const fastResponse = await itoHttpClient.post(
            '/adjust-transcript',
            fastRequestBody,
            { requireAuth: true, timeoutMs: 5000 },
          )
          const fastDuration = Date.now() - fastStart
          if (fastResponse?.success && fastResponse?.transcript) {
            textToInsert = fastResponse.transcript
            console.log(
              `[itoSessionManager] [SONIOX-FASTLLM] Applied in ${fastDuration}ms | input=${rawTranscript.length} chars → output=${textToInsert.length} chars`,
            )
          } else {
            console.warn(
              `[itoSessionManager] [SONIOX-FASTLLM] Response not successful after ${fastDuration}ms | success=${fastResponse?.success} hasTranscript=${!!fastResponse?.transcript}`,
            )
          }
        } catch (error) {
          console.error('[itoSessionManager] [SONIOX-FASTLLM] Failed, using raw transcript:', error)
        }
      }

      const { grammarServiceEnabled } = advSettings
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
      return
    }

    await new Promise(resolve => setTimeout(resolve, this.DRAIN_FLUSH_MS))
    await voiceInputService.stopAudioRecording()

    if (this.sonioxAudioHandler) {
      audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
      this.sonioxAudioHandler = null
      console.log(
        `[itoSessionManager] [SONIOX-COMPLETE] Audio handler removed (non-TRANSCRIBE path)`,
      )
    }

    recordingStateNotifier.notifyProcessingStarted()
    recordingStateNotifier.notifyRecordingStopped()

    let rawTranscript = ''
    if (this.sonioxPersistentSession) {
      try {
        const utteranceResult = await this.sonioxPersistentSession.stopStreaming()
        rawTranscript = utteranceResult.text.trim()
        console.log(
          `[itoSessionManager] [SONIOX-COMPLETE] stopStreaming() returned | rawTranscript="${rawTranscript.slice(0, 80)}" (${rawTranscript.length} chars)`,
        )
      } catch (error) {
        console.error(
          `[itoSessionManager] [SONIOX-COMPLETE] stopStreaming() threw:`,
          error,
        )
      }
    } else {
      console.warn(
        `[itoSessionManager] [SONIOX-COMPLETE] persistent session is null on non-TRANSCRIBE path`,
      )
    }

    if (!rawTranscript || rawTranscript.trim().length === 0) {
      console.warn(
        `[itoSessionManager] [SONIOX-COMPLETE] No speech detected (non-TRANSCRIBE path)`,
      )
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

      if (mode === ItoMode.CONTEXT_AWARENESS && ctx?.screenCaptureBase64) {
        const lightBody: Record<string, any> = {
          transcript: rawTranscript,
          screenshotBase64: ctx.screenCaptureBase64,
          screenshotMimeType: ctx.screenCaptureMimeType || 'image/jpeg',
          llmSettings: {
            llmTemperature: llm?.llmTemperature ?? undefined,
            visionModel: llm?.visionModel || undefined,
          },
          context: {
            windowTitle: ctx.windowTitle || '',
            appName: ctx.appName || '',
            browserUrl: ctx.browserUrl || undefined,
            tonePrompt: ctx.tone?.promptTemplate || undefined,
            userDetailsContext: ctx.userDetails
              ? this.buildUserDetailsContextString(ctx.userDetails)
              : undefined,
          },
        }

        try {
          const lightResponse = await itoHttpClient.post(
            '/adjust-context-light',
            lightBody,
            { requireAuth: true, timeoutMs: 5000 },
          )
          if (lightResponse?.success && lightResponse?.transcript) {
            let textToInsert = lightResponse.transcript

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
            return
          }
        } catch (lightError) {
          console.error('[itoSessionManager] adjust-context-light failed, falling back to adjust-transcript:', lightError)
        }
      }

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
          visionModel: llm?.visionModel || undefined,
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
    contextGrabber.setCustomModePrompt(null)
    this.resolvedCustomMode = null
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
    console.error(
      `[itoSessionManager] [SONIOX-ERROR] Stream error — cleaning up: ${error.message}`,
    )

    if (this.sonioxAudioHandler) {
      audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
      this.sonioxAudioHandler = null
    }

    voiceInputService.stopAudioRecording().catch(e => {
      console.error(
        '[itoSessionManager] Error stopping audio after Soniox error:',
        e,
      )
    })

    recordingStateNotifier.notifyRecordingStopped()
    recordingStateNotifier.notifyProcessingStopped()
    timingCollector.clearInteraction()
    interactionManager.clearCurrentInteraction()
    allowAppNap()
    this.cleanupSonioxState()
  }
}

export const itoSessionManager = new ItoSessionManager()
