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
  SonioxStreamingService,
  SonioxTranslationConfig,
  type SonioxContextConfig,
} from './soniox/SonioxStreamingService'
import { sonioxTempKeyManager } from './soniox/SonioxTempKeyManager'
import {
  SpeechmaticsStreamingService,
  type SpeechmaticsStreamingOptions,
} from './speechmatics/SpeechmaticsStreamingService'
import { speechmaticsTempKeyManager } from './speechmatics/SpeechmaticsTempKeyManager'
import { audioRecorderService } from '../media/audio'
import { unmuteSystemAudio } from '../media/systemAudio'
import { itoHttpClient } from '../clients/itoHttpClient'
import { STORE_KEYS } from '../constants/store-keys'
import { DEFAULT_ADVANCED_SETTINGS } from '../constants/generated-defaults'
import { customModeResolver } from './context/CustomModeResolver'
import { activeWindowMonitor } from './ActiveWindowMonitor'
import type { ResolvedCustomMode } from './context/CustomModeResolver'
import { domainContextProvider } from './context/DomainContextProvider'
import { UserDetailsTable } from './sqlite/userDetailsRepo'
import { DictionaryTable } from './sqlite/repo'

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
  private resolvedCustomMode: ResolvedCustomMode | null = null

  // ── Diagnostic: session lifecycle tracking ─────────────────────────────────
  private sonioxSessionStartTime = 0
  private sonioxPendingChunksCount = 0
  private sonioxPendingBytesAtFlush = 0
  // ────────────────────────────────────────────────────────────────────────────

  private speechmaticsService: SpeechmaticsStreamingService | null = null
  private isSpeechmaticsMode = false
  private speechmaticsAudioHandler: ((chunk: Buffer) => void) | null = null
  private speechmaticsSessionActive = false
  private speechmaticsSessionStartTime = 0

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
    const isSpeechmatics = llm?.asrProvider === 'speechmatics'

    if (
      effectiveMode === ItoMode.TRANSLATE ||
      effectiveMode === ItoMode.CONTEXT_AWARENESS ||
      isSoniox
    ) {
      await this.startSonioxSession(effectiveMode)
    } else if (isSpeechmatics) {
      await this.startSpeechmaticsSession(effectiveMode)
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
    this.sonioxSessionActive = true
    const generation = ++this.sonioxSessionGeneration
    this.sonioxSessionStartTime = Date.now()

    console.log(
      `[itoSessionManager] [SONIOX-START] generation=${generation} mode=${mode} sessionActive=true`,
    )

    const pendingChunks: Buffer[] = []
    let pendingBytes = 0
    let sonioxReady = false
    let droppedChunks = 0

    this.sonioxAudioHandler = (chunk: Buffer) => {
      if (sonioxReady && this.sonioxService) {
        this.sonioxService.sendAudio(chunk)
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

    const contextPromise = this.gatherSonioxContext(mode)

    let connectTimeoutId: ReturnType<typeof setTimeout> | null = null
    try {
      const connectWithTimeout = async () => {
        const tempKey = await sonioxTempKeyManager.getKey()

        if (generation !== this.sonioxSessionGeneration) {
          console.log(
            '[itoSessionManager] Soniox session was cancelled during key fetch, aborting',
          )
          return false
        }

        const userId = getCurrentUserId() || 'local-user'
        const userDetails = await UserDetailsTable.findByUserId(userId)
        const hasDomainContext = !!userDetails?.domain_context_slug
        const dictionaryItems = await DictionaryTable.findAll(userId)
        const hasVocabulary = dictionaryItems.length > 0

        const preWarmed = this.preWarmedSonioxService
        this.preWarmedSonioxService = null

        const preWarmAge = preWarmed ? Date.now() - this.preWarmTimestamp : -1
        // [FINDING-1] Log de l'état de la connexion pre-warmée au moment de l'utilisation.
        // Un WebSocket pré-chaufé peut être silencieusement fermé par Soniox côté serveur
        // sans que le client le sache (si 'disconnected' n'est pas écouté — Finding 3).
        // Si isActive=true mais disconnected a été reçu, le sendAudio va échouer silencieusement.
        if (preWarmed) {
          console.log(
            `[itoSessionManager] [FINDING-1-PREWARM-HEALTH] Pre-warm snapshot at reuse decision:` +
              ` age=${preWarmAge}ms (TTL=${this.PRE_WARM_TTL_MS}ms)` +
              ` isActive=${preWarmed.isCurrentlyActive()}` +
              ` hasErrored=${preWarmed.hasEncounteredError()}` +
              ` sessionId=${preWarmed.getSessionId()}` +
              ` sessionAge=${preWarmed.getSessionAgeMs()}ms` +
              ` — Watch for DISCONNECTED event logged above for same sessionId`,
          )
        }
        const preWarmValid =
          !!preWarmed &&
          preWarmed.isCurrentlyActive() &&
          !preWarmed.hasEncounteredError() &&
          preWarmAge < this.PRE_WARM_TTL_MS &&
          mode === ItoMode.TRANSCRIBE &&
          !hasDomainContext &&
          !hasVocabulary

        console.log(
          `[itoSessionManager] [SONIOX-PREWARM] preWarmExists=${!!preWarmed}` +
            ` preWarmAge=${preWarmAge}ms` +
            ` preWarmActive=${preWarmed?.isCurrentlyActive()}` +
            ` preWarmErrored=${preWarmed?.hasEncounteredError()}` +
            ` preWarmTTL=${this.PRE_WARM_TTL_MS}ms` +
            ` mode=${mode}` +
            ` hasDomainContext=${hasDomainContext}` +
            ` hasVocabulary=${hasVocabulary}` +
            ` → willReuse=${preWarmValid}`,
        )

        if (preWarmValid) {
          this.sonioxService = preWarmed!
          this.sonioxService.on('error', (error: Error) => {
            console.error(
              `[itoSessionManager] [SONIOX-ERROR] Soniox streaming error (reused pre-warm session=${preWarmed?.getSessionId()}):`,
              error.message,
            )
            this.handleSonioxStreamError(error)
          })
          console.log(
            `[itoSessionManager] [SONIOX-PREWARM] Reusing pre-warmed connection | sessionId=${preWarmed?.getSessionId()} age=${preWarmAge}ms`,
          )
        } else {
          if (preWarmed) {
            console.log(
              `[itoSessionManager] [SONIOX-PREWARM] Discarding stale pre-warm | sessionId=${preWarmed.getSessionId()} age=${preWarmAge}ms active=${preWarmed.isCurrentlyActive()} errored=${preWarmed.hasEncounteredError()}`,
            )
            preWarmed.cancel()
          }

          let sonioxContext: SonioxContextConfig | null = null
          try {
            sonioxContext = await Promise.race([
              contextPromise,
              new Promise<null>(resolve =>
                setTimeout(() => resolve(null), 500),
              ),
            ])
          } catch (error) {
            console.warn(
              '[itoSessionManager] Context gathering failed:',
              error,
            )
          }

          this.sonioxService = new SonioxStreamingService()
          this.sonioxService.on('error', (error: Error) => {
            console.error(
              `[itoSessionManager] [SONIOX-ERROR] Soniox streaming error (fresh session=${this.sonioxService?.getSessionId()}):`,
              error.message,
            )
            this.handleSonioxStreamError(error)
          })
          console.log(
            `[itoSessionManager] [SONIOX-CONNECT] Starting fresh Soniox connection | generation=${generation}`,
          )
          await this.sonioxService.start(
            tempKey,
            this.getTranslationConfig(),
            {
              context: sonioxContext || undefined,
            },
          )
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

      const timeout = new Promise<never>((_, reject) => {
        connectTimeoutId = setTimeout(
          () => reject(new Error('Soniox connection timed out')),
          this.SONIOX_CONNECT_TIMEOUT_MS,
        )
      })

      const connected = await Promise.race([connectWithTimeout(), timeout])

      if (connected) {
        sonioxReady = true
        this.sonioxPendingChunksCount = pendingChunks.length
        this.sonioxPendingBytesAtFlush = pendingBytes
        console.log(
          `[itoSessionManager] [SONIOX-CONNECTED] Flushing ${pendingChunks.length} buffered chunks (${(pendingBytes / 1024).toFixed(1)}KB) | droppedChunks=${droppedChunks} | connectDelta=${Date.now() - this.sonioxSessionStartTime}ms`,
        )
        for (const chunk of pendingChunks) {
          this.sonioxService!.sendAudio(chunk)
        }
        pendingChunks.length = 0
      }
    } catch (error) {
      if (this.currentMode === ItoMode.TRANSLATE) {
        console.error(
          '[itoSessionManager] Translation mode requires Soniox. Ensure Soniox API key is configured on the server.',
        )
      }
      log.error('[itoSessionManager] Failed to start Soniox session:', error)
      if (this.sonioxAudioHandler) {
        audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
        this.sonioxAudioHandler = null
      }
      this.sonioxService = null
    } finally {
      if (connectTimeoutId) clearTimeout(connectTimeoutId)
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

  private async gatherSonioxContext(
    mode: ItoMode,
  ): Promise<SonioxContextConfig | null> {
    const context = await contextGrabber.gatherContext(mode)
    this.sonioxContext = context

    const userId = getCurrentUserId() || 'local-user'
    const userDetails = await UserDetailsTable.findByUserId(userId)
    const domainSlug = userDetails?.domain_context_slug || null

    return domainContextProvider.buildSonioxContext(
      domainSlug,
      context.vocabularyWords,
    )
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

    if (this.isSonioxMode || this.isSpeechmaticsMode) {
      recordingStateNotifier.notifyRecordingStarted(mode)
      return
    }

    itoStreamController.setMode(mode)
    recordingStateNotifier.notifyRecordingStarted(mode)
  }

  public async cancelSession() {
    contextGrabber.setCustomModePrompt(null)
    this.resolvedCustomMode = null

    if (this.isSpeechmaticsMode) {
      this.speechmaticsSessionActive = false

      this.speechmaticsService?.cancel()
      this.speechmaticsService = null
      if (this.speechmaticsAudioHandler) {
        audioRecorderService.off('audio-chunk', this.speechmaticsAudioHandler)
        this.speechmaticsAudioHandler = null
      }
      await voiceInputService.stopAudioRecording()
      recordingStateNotifier.notifyRecordingStopped()
      timingCollector.clearInteraction()
      interactionManager.clearCurrentInteraction()
      this.cleanupSpeechmaticsState()
      allowAppNap()
      return
    }

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
    if (this.isSpeechmaticsMode) {
      await this.completeSpeechmaticsSession()
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
    const completeCallTime = Date.now()
    const sessionAge = this.sonioxSessionStartTime > 0 ? completeCallTime - this.sonioxSessionStartTime : -1

    if (!this.sonioxSessionActive) {
      console.warn(
        `[itoSessionManager] [SONIOX-COMPLETE] completeSonioxSession called but no active session, skipping | sessionAge=${sessionAge}ms`,
      )
      return
    }
    this.sonioxSessionActive = false

    timingCollector.endTiming(TimingEventName.INTERACTION_ACTIVE)

    const mode = this.currentMode
    const service = this.sonioxService

    const diagnostics = service?.getDiagnostics()
    console.log(
      `[itoSessionManager] [SONIOX-COMPLETE] ── START ──` +
        ` | sessionAge=${sessionAge}ms` +
        ` | mode=${mode}` +
        ` | serviceExists=${!!service}` +
        ` | serviceActive=${diagnostics?.isActive}` +
        ` | serviceErrored=${diagnostics?.hasErrored}` +
        ` | serviceSessionId=${diagnostics?.sessionId}` +
        ` | connectTimeMs=${diagnostics?.connectTimeMs}` +
        ` | firstTokenLatencyMs=${diagnostics?.firstTokenLatencyMs}` +
        ` | serviceChunks=${diagnostics?.totalChunksSent}` +
        ` | serviceBytes=${diagnostics ? (diagnostics.totalBytesSent / 1024).toFixed(1) : 'N/A'}KB` +
        ` | serviceFinalTokens=${diagnostics?.finalTokensReceived}` +
        ` | serviceAccumChars=${diagnostics?.accumTextLength}` +
        ` | droppedAfterError=${diagnostics?.droppedChunksAfterError}` +
        ` | pendingChunksAtStart=${this.sonioxPendingChunksCount}` +
        ` | pendingBytesAtFlush=${(this.sonioxPendingBytesAtFlush / 1024).toFixed(1)}KB`,
    )

    const hasCustomPrompt = this.sonioxContext?.tone?.promptTemplate?.trim()

    if (mode === ItoMode.TRANSCRIBE && !hasCustomPrompt) {
      // [FINDING-2] Le path gRPC attend DRAIN_FLUSH_MS (80ms) avant d'envoyer le signal de fin
      // pour laisser le pipeline audio vider ses derniers chunks. Ce path Soniox n'a PAS ce délai.
      // Impact : les ~80 dernières ms d'audio peuvent ne pas être capturées avant stopRecording().
      // Comparaison : gRPC → await new Promise(r => setTimeout(r, DRAIN_FLUSH_MS)) // 80ms
      //               Soniox → rien ← ici
      const drainGapStart = Date.now()
      console.warn(
        `[itoSessionManager] [FINDING-2-DRAIN] No drain wait before stopRecording() (gRPC has ${this.DRAIN_FLUSH_MS}ms drain) | sessionAge=${sessionAge}ms | If last words are truncated, this window is the cause`,
      )
      // FIX: Remove the audio handler BEFORE nulling this.sonioxService to prevent
      // last audio chunks from being silently dropped into a defunct pendingChunks closure.
      // Previously: sonioxService=null → stopRecording → off(handler) [RACE: chunks dropped]
      // Now:        stopRecording → off(handler) → sonioxService=null [correct order]
      audioRecorderService.stopRecording()
      const drainGapDuration = Date.now() - drainGapStart
      console.log(
        `[itoSessionManager] [FINDING-2-DRAIN] stopRecording() completed | elapsed since last audio possible=${drainGapDuration}ms | for reference gRPC drains ${this.DRAIN_FLUSH_MS}ms first`,
      )
      if (this.sonioxAudioHandler) {
        audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
        this.sonioxAudioHandler = null
        console.log(
          `[itoSessionManager] [SONIOX-COMPLETE] Audio handler removed after stopRecording | sessionAge=${Date.now() - this.sonioxSessionStartTime}ms`,
        )
      }
      this.sonioxService = null
      if (store.get(STORE_KEYS.SETTINGS)?.muteAudioWhenDictating) {
        unmuteSystemAudio()
      }

      recordingStateNotifier.notifyProcessingStarted()
      recordingStateNotifier.notifyRecordingStopped()

      let rawTranscript = ''
      if (service) {
        const stopStart = Date.now()
        try {
          rawTranscript = await service.stop()
          const stopDuration = Date.now() - stopStart
          console.log(
            `[itoSessionManager] [SONIOX-COMPLETE] service.stop() returned in ${stopDuration}ms | rawTranscript="${rawTranscript.slice(0, 80)}" (${rawTranscript.length} chars)`,
          )
        } catch (error) {
          const stopDuration = Date.now() - stopStart
          console.error(
            `[itoSessionManager] [SONIOX-COMPLETE] service.stop() threw after ${stopDuration}ms:`,
            error,
          )
          rawTranscript = service.getAccumulatedText() || ''
          console.log(
            `[itoSessionManager] [SONIOX-COMPLETE] Using fallback accumulatedText: "${rawTranscript.slice(0, 80)}" (${rawTranscript.length} chars)`,
          )
        }
      } else {
        console.warn(
          `[itoSessionManager] [SONIOX-COMPLETE] service is null — no transcript available (was it cancelled or errored before stop?)`,
        )
      }

      if (!rawTranscript || rawTranscript.trim().length === 0) {
        console.warn(
          `[itoSessionManager] [SONIOX-COMPLETE] No speech detected (empty transcript) | sessionAge=${Date.now() - this.sonioxSessionStartTime}ms`,
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
      this.preWarmSonioxConnection()
      return
    }

    // FIX: Stop audio and remove handler BEFORE nulling sonioxService (same race condition fix as TRANSCRIBE path)
    await voiceInputService.stopAudioRecording()

    if (this.sonioxAudioHandler) {
      audioRecorderService.off('audio-chunk', this.sonioxAudioHandler)
      this.sonioxAudioHandler = null
      console.log(
        `[itoSessionManager] [SONIOX-COMPLETE] Audio handler removed (non-TRANSCRIBE path) | sessionAge=${Date.now() - this.sonioxSessionStartTime}ms`,
      )
    }
    this.sonioxService = null

    recordingStateNotifier.notifyProcessingStarted()
    recordingStateNotifier.notifyRecordingStopped()

    let rawTranscript = ''
    if (service) {
      const stopStart = Date.now()
      try {
        rawTranscript = await service.stop()
        console.log(
          `[itoSessionManager] [SONIOX-COMPLETE] service.stop() returned in ${Date.now() - stopStart}ms | rawTranscript="${rawTranscript.slice(0, 80)}" (${rawTranscript.length} chars)`,
        )
      } catch (error) {
        console.error(
          `[itoSessionManager] [SONIOX-COMPLETE] service.stop() threw after ${Date.now() - stopStart}ms:`,
          error,
        )
        rawTranscript = service.getAccumulatedText() || ''
        console.log(
          `[itoSessionManager] [SONIOX-COMPLETE] Using fallback accumulatedText: "${rawTranscript.slice(0, 80)}" (${rawTranscript.length} chars)`,
        )
      }
    } else {
      console.warn(
        `[itoSessionManager] [SONIOX-COMPLETE] service is null on non-TRANSCRIBE path`,
      )
    }

    if (!rawTranscript || rawTranscript.trim().length === 0) {
      console.warn(
        `[itoSessionManager] [SONIOX-COMPLETE] No speech detected (non-TRANSCRIBE path) | sessionAge=${Date.now() - this.sonioxSessionStartTime}ms`,
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

  private preWarmSonioxConnection() {
    if (this.preWarmedSonioxService) {
      console.log(
        `[itoSessionManager] [SONIOX-PREWARM] Pre-warm skipped — already have a pre-warmed service (sessionId=${this.preWarmedSonioxService.getSessionId()} age=${Date.now() - this.preWarmTimestamp}ms)`,
      )
      return
    }
    const warmStart = Date.now()
    console.log('[itoSessionManager] [SONIOX-PREWARM] Starting pre-warm...')
    sonioxTempKeyManager
      .getKey()
      .then(async tempKey => {
        if (this.preWarmedSonioxService || this.sonioxSessionActive) {
          console.log(
            `[itoSessionManager] [SONIOX-PREWARM] Aborted after key fetch — preWarmedExists=${!!this.preWarmedSonioxService} sessionActive=${this.sonioxSessionActive}`,
          )
          return
        }
        const service = new SonioxStreamingService()
        service.on('error', (error: Error) => {
          console.error(
            `[itoSessionManager] [SONIOX-PREWARM] Pre-warmed service errored (sessionId=${service.getSessionId()} age=${service.getSessionAgeMs()}ms): ${error.message}`,
          )
          if (this.preWarmedSonioxService === service) {
            this.preWarmedSonioxService = null
            this.preWarmTimestamp = 0
          }
        })
        await service.start(tempKey)
        if (this.sonioxSessionActive) {
          console.log(
            `[itoSessionManager] [SONIOX-PREWARM] Session became active during pre-warm connect — cancelling (sessionId=${service.getSessionId()})`,
          )
          service.cancel()
          return
        }
        this.preWarmedSonioxService = service
        this.preWarmTimestamp = Date.now()
        console.log(
          `[itoSessionManager] [SONIOX-PREWARM] Ready | sessionId=${service.getSessionId()} | totalTime=${Date.now() - warmStart}ms | TTL=${this.PRE_WARM_TTL_MS}ms`,
        )
        // [SONIOX-DOCS] KEEPALIVE MANQUANT : La doc Soniox recommande d'envoyer un keepalive
        // toutes les 20 secondes pendant les silences. Le SDK expose session.pause() qui active
        // les keepalives automatiques (défaut 5s) ET session.keepAlive() pour envoi manuel.
        // Cette connexion pré-chaufée reste IDLE jusqu'à ${PRE_WARM_TTL_MS}ms SANS keepalive.
        // Soniox ferme silencieusement les connexions inactives -> zombie.
        // Fix à appliquer : service.pause() ici, service.resume() au moment de réutiliser.
        console.warn(
          `[itoSessionManager] [SONIOX-DOCS-KEEPALIVE] Pre-warm session ${service.getSessionId()} is now IDLE for up to ${this.PRE_WARM_TTL_MS / 1000}s with NO keepalive. SDK has session.pause() (auto-keepalive) and session.keepAlive() (manual). Soniox closes idle connections after ~20s. This IS the root cause of zombie connections.`,
        )
      })
      .catch(error => {
        console.warn(
          '[itoSessionManager] [SONIOX-PREWARM] Failed:',
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

  private async startSpeechmaticsSession(mode: ItoMode) {
    this.isSpeechmaticsMode = true
    this.speechmaticsSessionActive = true
    this.speechmaticsSessionStartTime = Date.now()

    console.log(`[itoSessionManager] [SPEECHMATICS-START] mode=${mode}`)

    const pendingChunks: Buffer[] = []
    let pendingBytes = 0
    let speechmaticsReady = false
    const MAX_PENDING_BYTES = 512 * 1024

    this.speechmaticsAudioHandler = (chunk: Buffer) => {
      if (speechmaticsReady && this.speechmaticsService) {
        this.speechmaticsService.sendAudio(chunk)
      } else if (pendingBytes < MAX_PENDING_BYTES) {
        pendingChunks.push(chunk)
        pendingBytes += chunk.length
      }
    }

    audioRecorderService.on('audio-chunk', this.speechmaticsAudioHandler)
    voiceInputService.startAudioRecording()
    recordingStateNotifier.notifyRecordingStarted(mode)
    preventAppNap()

    try {
      const jwt = await speechmaticsTempKeyManager.getJwt()

      if (!this.speechmaticsSessionActive) {
        console.log('[itoSessionManager] Speechmatics session cancelled during JWT fetch')
        return
      }

      const { llm } = getAdvancedSettings()

      const userId = getCurrentUserId() || 'local-user'
      const dictionaryItems = await DictionaryTable.findAll(userId)
      const additionalVocab: string[] = dictionaryItems
        .filter(item => !item.deleted_at && item.word?.trim())
        .map(item => item.word.trim())

      const speechmaticsOptions: SpeechmaticsStreamingOptions = {
        language: llm?.speechmaticsLanguage || 'fr',
        operatingPoint: (llm?.speechmaticsOperatingPoint as 'standard' | 'enhanced') || 'enhanced',
        enablePartials: true,
        removeDisfluencies: llm?.speechmaticsRemoveDisfluencies || false,
        additionalVocab: additionalVocab.length > 0 ? additionalVocab : undefined,
      }

      this.speechmaticsService = new SpeechmaticsStreamingService()

      this.speechmaticsService.on('error', (error: Error) => {
        this.handleSpeechmaticsStreamError(error)
      })

      this.speechmaticsService.on('finished', () => {
        console.log('[itoSessionManager] [SPEECHMATICS] Session finished')
      })

      await this.speechmaticsService.start(jwt, speechmaticsOptions)

      speechmaticsReady = true
      if (pendingChunks.length > 0) {
        console.log(`[itoSessionManager] [SPEECHMATICS] Flushing ${pendingChunks.length} pending chunks (${pendingBytes} bytes)`)
        for (const chunk of pendingChunks) {
          this.speechmaticsService.sendAudio(chunk)
        }
      }
    } catch (error: any) {
      console.error('[itoSessionManager] [SPEECHMATICS] Failed to start:', error)
      if (this.speechmaticsAudioHandler) {
        audioRecorderService.off('audio-chunk', this.speechmaticsAudioHandler)
        this.speechmaticsAudioHandler = null
      }
      this.speechmaticsService = null
      recordingStateNotifier.notifyRecordingStopped()
      voiceInputService.stopAudioRecording().catch(console.error)
      allowAppNap()
      return
    }

    this.contextGatherPromise = this.gatherAndCacheContext(mode)
    this.contextGatherPromise.catch(error => {
      console.error('[itoSessionManager] Failed to gather context for Speechmatics:', error)
    })

    timingCollector.startInteraction()
    timingCollector.startTiming(TimingEventName.INTERACTION_ACTIVE)
  }

  private async completeSpeechmaticsSession() {
    const completeCallTime = Date.now()
    const sessionAge = this.speechmaticsSessionStartTime > 0
      ? completeCallTime - this.speechmaticsSessionStartTime : -1

    if (!this.speechmaticsSessionActive) {
      console.warn(
        `[itoSessionManager] [SPEECHMATICS-COMPLETE] called but no active session, skipping | sessionAge=${sessionAge}ms`,
      )
      return
    }
    this.speechmaticsSessionActive = false

    timingCollector.endTiming(TimingEventName.INTERACTION_ACTIVE)

    const mode = this.currentMode
    const service = this.speechmaticsService

    const hasCustomPrompt = this.sonioxContext?.tone?.promptTemplate?.trim()

    if (mode === ItoMode.TRANSCRIBE && !hasCustomPrompt) {
      audioRecorderService.stopRecording()
      if (this.speechmaticsAudioHandler) {
        audioRecorderService.off('audio-chunk', this.speechmaticsAudioHandler)
        this.speechmaticsAudioHandler = null
      }
      this.speechmaticsService = null
      this.unmuteIfNeeded()

      recordingStateNotifier.notifyProcessingStarted()
      recordingStateNotifier.notifyRecordingStopped()

      let rawTranscript = ''
      if (service) {
        try {
          rawTranscript = await service.stop()
          console.log(
            `[itoSessionManager] [SPEECHMATICS-COMPLETE] service.stop() | rawTranscript="${rawTranscript.slice(0, 80)}" (${rawTranscript.length} chars)`,
          )
        } catch (error) {
          console.error('[itoSessionManager] [SPEECHMATICS-COMPLETE] service.stop() threw:', error)
          rawTranscript = service.getAccumulatedText() || ''
        }
      }

      if (!rawTranscript || rawTranscript.trim().length === 0) {
        console.warn(`[itoSessionManager] [SPEECHMATICS-COMPLETE] No speech detected`)
        recordingStateNotifier.notifyProcessingStopped()
        allowAppNap()
        this.cleanupSpeechmaticsState()
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
          if (fastResponse?.success && fastResponse?.transcript) {
            textToInsert = fastResponse.transcript
            console.log(
              `[itoSessionManager] [SPEECHMATICS-FASTLLM] Applied in ${Date.now() - fastStart}ms`,
            )
          }
        } catch (error) {
          console.error('[itoSessionManager] [SPEECHMATICS-FASTLLM] Failed, using raw:', error)
        }
      }

      const { grammarServiceEnabled } = advSettings
      if (grammarServiceEnabled) {
        textToInsert = this.grammarRulesService.setCaseFirstWord(textToInsert)
        textToInsert = this.grammarRulesService.addLeadingSpaceIfNeeded(textToInsert)
      }

      this.textInserter.insertText(textToInsert)
      recordingStateNotifier.notifyProcessingStopped()

      interactionManager
        .createInteraction(rawTranscript, Buffer.alloc(0), 16000, undefined)
        .catch(error => console.error('[itoSessionManager] Failed to create interaction:', error))

      allowAppNap()
      this.cleanupSpeechmaticsState()
      return
    }

    await voiceInputService.stopAudioRecording()
    if (this.speechmaticsAudioHandler) {
      audioRecorderService.off('audio-chunk', this.speechmaticsAudioHandler)
      this.speechmaticsAudioHandler = null
    }
    this.speechmaticsService = null

    recordingStateNotifier.notifyProcessingStarted()
    recordingStateNotifier.notifyRecordingStopped()

    let rawTranscript = ''
    if (service) {
      try {
        rawTranscript = await service.stop()
      } catch (error) {
        console.error('[itoSessionManager] [SPEECHMATICS-COMPLETE] service.stop() threw:', error)
        rawTranscript = service.getAccumulatedText() || ''
      }
    }

    if (!rawTranscript || rawTranscript.trim().length === 0) {
      console.warn('[itoSessionManager] [SPEECHMATICS-COMPLETE] No speech (non-TRANSCRIBE)')
      recordingStateNotifier.notifyProcessingStopped()
      allowAppNap()
      this.cleanupSpeechmaticsState()
      return
    }

    if (this.contextGatherPromise) {
      try {
        await this.contextGatherPromise
      } catch {
        // already logged
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
              textToInsert = this.grammarRulesService.addLeadingSpaceIfNeeded(textToInsert)
            }

            this.textInserter.insertText(textToInsert)

            interactionManager.createInteraction(rawTranscript, Buffer.alloc(0), 16000, undefined)
              .catch(error => console.error('[itoSessionManager] Failed to create interaction:', error))

            allowAppNap()
            this.cleanupSpeechmaticsState()
            return
          }
        } catch (lightError) {
          console.error('[itoSessionManager] adjust-context-light failed, falling back:', lightError)
        }
      }

      const requestBody: Record<string, any> = {
        transcript: rawTranscript,
        mode:
          mode === ItoMode.EDIT ? 'edit'
            : mode === ItoMode.CONTEXT_AWARENESS ? 'context_awareness'
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
          textToInsert = this.grammarRulesService.addLeadingSpaceIfNeeded(textToInsert)
        }

        this.textInserter.insertText(textToInsert)
      } else {
        console.error('[itoSessionManager] LLM adjustment failed:', response?.error)
        this.textInserter.insertText(rawTranscript)
      }
    } catch (error) {
      console.error('[itoSessionManager] Error during LLM adjustment:', error)
      this.textInserter.insertText(rawTranscript)
    } finally {
      recordingStateNotifier.notifyProcessingStopped()
    }

    try {
      await interactionManager.createInteraction(rawTranscript, Buffer.alloc(0), 16000, undefined)
    } catch (error) {
      console.error('[itoSessionManager] Failed to create interaction:', error)
    }

    allowAppNap()
    this.cleanupSpeechmaticsState()
  }

  private handleSpeechmaticsStreamError(error: Error) {
    const sessionAge = this.speechmaticsSessionStartTime > 0
      ? Date.now() - this.speechmaticsSessionStartTime : -1

    if (!this.speechmaticsSessionActive) {
      console.warn(
        `[itoSessionManager] [SPEECHMATICS-ERROR] Error after session ended (age=${sessionAge}ms), ignoring: ${error.message}`,
      )
      return
    }

    console.error(
      `[itoSessionManager] [SPEECHMATICS-ERROR] Stream error (age=${sessionAge}ms): ${error.message}`,
    )

    this.speechmaticsSessionActive = false

    if (this.speechmaticsAudioHandler) {
      audioRecorderService.off('audio-chunk', this.speechmaticsAudioHandler)
      this.speechmaticsAudioHandler = null
    }

    this.speechmaticsService?.cancel()
    this.speechmaticsService = null

    voiceInputService.stopAudioRecording().catch(console.error)
    recordingStateNotifier.notifyRecordingStopped()
    timingCollector.clearInteraction()
    interactionManager.clearCurrentInteraction()
    allowAppNap()
    this.cleanupSpeechmaticsState()
  }

  private cleanupSpeechmaticsState() {
    timingCollector.finalizeInteraction()
    interactionManager.clearCurrentInteraction()
    this.isSpeechmaticsMode = false
    this.sonioxContext = null
    this.contextGatherPromise = null
    contextGrabber.setCustomModePrompt(null)
    this.resolvedCustomMode = null
  }

  private handleSonioxStreamError(error: Error) {
    const sessionAge = this.sonioxSessionStartTime > 0 ? Date.now() - this.sonioxSessionStartTime : -1
    if (!this.sonioxSessionActive) {
      console.warn(
        `[itoSessionManager] [SONIOX-ERROR] Stream error after session ended (sessionAge=${sessionAge}ms), ignoring: ${error.message}`,
      )
      return
    }

    console.error(
      `[itoSessionManager] [SONIOX-ERROR] Stream error during active session (sessionAge=${sessionAge}ms) — cleaning up: ${error.message}`,
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
