import { SonioxNodeClient, RealtimeSttSession } from '@soniox/node'
import { EventEmitter } from 'events'

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionState = 'idle' | 'connecting' | 'streaming' | 'paused' | 'closing'

export interface SonioxPersistentSessionConfig {
  idleTimeoutMs?: number
  maxSessionAgeMs?: number
  audioFormat?: string
  sampleRate?: number
  numChannels?: number
}

export interface UtteranceResult {
  text: string
  durationMs: number
  tokenCount: number
}

export interface PersistentSessionDiagnostics {
  state: SessionState
  sessionId: string
  sessionAgeMs: number
  totalUtterances: number
  totalChunksSent: number
  totalBytesSent: number
  currentUtteranceChunks: number
  lastUtteranceLatencyMs: number
  reconnectCount: number
  lastError: string | null
}

export interface PersistentSessionEvents {
  token: (token: { text: string; is_final: boolean }) => void
  'utterance-text': (text: string) => void
  'state-change': (newState: SessionState, oldState: SessionState) => void
  error: (error: Error) => void
  'auto-closed': (reason: 'idle' | 'age-limit' | 'error') => void
}

export interface SonioxTranslationConfig {
  type: 'one_way' | 'two_way'
  targetLanguage?: string
  languageA?: string
  languageB?: string
}

export interface SonioxContextConfig {
  general?: Array<{ key: string; value: string }>
  text?: string
  terms?: string[]
  translation_terms?: Array<{ source: string; target: string }>
}

export interface EnsureReadyOptions {
  disableEndpointDetection?: boolean
  context?: SonioxContextConfig
  languageHints?: string[]
}

// ── SonioxPersistentSession ──────────────────────────────────────────────────

export class SonioxPersistentSession extends EventEmitter {
  private client: SonioxNodeClient | null = null
  private session: RealtimeSttSession | null = null
  private state: SessionState = 'idle'
  private config: SonioxPersistentSessionConfig

  private sessionId = ''
  private sessionStartTime = 0
  private needsReconnect = false
  private lastError: string | null = null
  private reconnectCount = 0

  private idleTimer: ReturnType<typeof setTimeout> | null = null

  private totalUtterances = 0
  private totalChunksSent = 0
  private totalBytesSent = 0
  private lastUtteranceLatencyMs = 0

  private currentUtteranceText = ''
  private currentUtteranceTokenCount = 0
  private currentUtteranceStartTime = 0
  private currentUtteranceChunks = 0

  private lastTranslationConfig: SonioxTranslationConfig | undefined
  private lastOptions: EnsureReadyOptions | undefined
  private isTranslationMode = false

  constructor(config?: SonioxPersistentSessionConfig) {
    super()
    this.config = config ?? {}
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async ensureReady(
    tempApiKey: string,
    translationConfig?: SonioxTranslationConfig,
    options?: EnsureReadyOptions,
  ): Promise<void> {
    if (this.state !== 'idle' && this.hasConfigChanged(translationConfig, options)) {
      console.log(`[SonioxPersistent:${this.sessionId}] Config changed, forcing reconnect`)
      this.close()
    }

    if (this.state !== 'idle' && this.isSessionExpired()) {
      console.log(`[SonioxPersistent:${this.sessionId}] Session expired (age rotation), forcing reconnect`)
      this.close()
      this.emit('auto-closed', 'age-limit')
    }

    if (this.state !== 'idle' && this.needsReconnect) {
      console.log(`[SonioxPersistent:${this.sessionId}] Needs reconnect after error, forcing reconnect`)
      this.close()
    }

    if (this.state !== 'idle') return

    this.lastTranslationConfig = translationConfig
    this.lastOptions = options
    this.isTranslationMode = !!translationConfig
    this.needsReconnect = false

    this.sessionId = `ssx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    this.sessionStartTime = Date.now()

    this.transitionTo('connecting')
    console.log(
      `[SonioxPersistent:${this.sessionId}] Connecting | mode=${translationConfig ? 'translation' : 'transcription'} | hasContext=${!!options?.context}`,
    )

    try {
      this.client = new SonioxNodeClient({ api_key: tempApiKey })

      const sessionConfig: any = {
        model: 'stt-rt-v4',
        audio_format: this.config.audioFormat ?? 'pcm_s16le',
        sample_rate: this.config.sampleRate ?? 16000,
        num_channels: this.config.numChannels ?? 1,
        enable_endpoint_detection: !options?.disableEndpointDetection,
        enable_language_identification: true,
      }

      if (!translationConfig) {
        sessionConfig.language_hints = options?.languageHints ?? ['fr']
      } else if (options?.languageHints) {
        sessionConfig.language_hints = options.languageHints
      }

      if (options?.context) {
        const ctx: any = {}
        if (options.context.general?.length) ctx.general = options.context.general
        if (options.context.text) ctx.text = options.context.text
        if (options.context.terms?.length) ctx.terms = options.context.terms
        if (options.context.translation_terms?.length)
          ctx.translation_terms = options.context.translation_terms
        if (Object.keys(ctx).length > 0) {
          sessionConfig.context = ctx
          console.log(`[SonioxPersistent:${this.sessionId}] Context injected:`, {
            general: ctx.general?.length || 0,
            text: ctx.text?.length || 0,
            terms: ctx.terms?.length || 0,
            translation_terms: ctx.translation_terms?.length || 0,
          })
        }
      }

      if (translationConfig) {
        if (translationConfig.type === 'one_way') {
          sessionConfig.translation = {
            type: 'one_way',
            target_language: translationConfig.targetLanguage,
          }
        } else if (translationConfig.type === 'two_way') {
          sessionConfig.translation = {
            type: 'two_way',
            language_a: translationConfig.languageA,
            language_b: translationConfig.languageB,
          }
        }
      }

      this.session = this.client.realtime.stt(sessionConfig)
      this.attachSessionListeners()

      const connectStart = Date.now()
      await this.session.connect()
      const connectMs = Date.now() - connectStart

      console.log(
        `[SonioxPersistent:${this.sessionId}] Connected in ${connectMs}ms | mode=${translationConfig ? 'translation' : 'transcription'}`,
      )

      this.session.pause()
      this.transitionTo('paused')
      this.startIdleTimer()
    } catch (error) {
      console.error(`[SonioxPersistent:${this.sessionId}] Connection failed:`, error)
      this.cleanupSession()
      this.transitionTo('idle')
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  startStreaming(): void {
    if (this.state === 'streaming') return

    if (this.state === 'paused' && this.isSessionExpired()) {
      console.log(`[SonioxPersistent:${this.sessionId}] Session expired before streaming, marking for reconnect`)
      this.close()
      this.emit('auto-closed', 'age-limit')
      throw new Error('Session expired — caller must call ensureReady() with a fresh key')
    }

    if (this.state !== 'paused') {
      throw new Error(`Cannot start streaming from state '${this.state}' — must be 'paused'`)
    }

    this.clearIdleTimer()

    this.currentUtteranceText = ''
    this.currentUtteranceTokenCount = 0
    this.currentUtteranceStartTime = Date.now()
    this.currentUtteranceChunks = 0

    this.session!.resume()
    this.transitionTo('streaming')

    console.log(
      `[SonioxPersistent:${this.sessionId}] Streaming started | utterance #${this.totalUtterances + 1} | sessionAge=${Date.now() - this.sessionStartTime}ms`,
    )
  }

  async stopStreaming(): Promise<UtteranceResult> {
    if (this.state !== 'streaming') {
      return { text: this.currentUtteranceText, durationMs: 0, tokenCount: 0 }
    }

    const utteranceStart = this.currentUtteranceStartTime
    const textBeforePause = this.currentUtteranceText

    if (this.session) {
      try {
        this.session.pause()
      } catch (e) {
        console.error(`[SonioxPersistent:${this.sessionId}] Error calling pause():`, e)
      }
    }

    if (this.currentUtteranceTokenCount > 0 || textBeforePause.length > 0) {
      await this.waitForFinalTokens(500)
    }

    if (this.state === 'streaming') {
      this.transitionTo('paused')
      this.startIdleTimer()
    }

    this.totalUtterances++

    const result: UtteranceResult = {
      text: this.currentUtteranceText,
      durationMs: Date.now() - utteranceStart,
      tokenCount: this.currentUtteranceTokenCount,
    }

    this.lastUtteranceLatencyMs = result.durationMs

    console.log(
      `[SonioxPersistent:${this.sessionId}] Utterance #${this.totalUtterances} complete: ${result.text.length} chars, ${result.tokenCount} tokens, ${result.durationMs}ms`,
    )

    return result
  }

  sendAudio(chunk: Buffer): void {
    if (this.state !== 'streaming' || !this.session) {
      return
    }

    try {
      this.session.sendAudio(chunk)
      this.currentUtteranceChunks++
      this.totalChunksSent++
      this.totalBytesSent += chunk.length

      if (this.totalChunksSent % 200 === 0) {
        console.log(
          `[SonioxPersistent:${this.sessionId}] Audio stats: chunks=${this.totalChunksSent} bytes=${(this.totalBytesSent / 1024).toFixed(1)}KB sessionAge=${Date.now() - this.sessionStartTime}ms utterance=#${this.totalUtterances + 1}`,
        )
      }
    } catch (error) {
      console.error(
        `[SonioxPersistent:${this.sessionId}] sendAudio error at chunk #${this.totalChunksSent + 1}:`,
        error,
      )
      this.lastError = error instanceof Error ? error.message : String(error)
      this.needsReconnect = true
      this.reconnectCount++
      this.transitionTo('idle')
      this.cleanupSession()
      this.emit('error', error instanceof Error ? error : new Error('Failed to send audio chunk'))
    }
  }

  close(): void {
    if (this.state === 'idle') return

    const prevState = this.state
    this.transitionTo('closing')

    console.log(
      `[SonioxPersistent:${this.sessionId}] Closing session | prevState=${prevState} | age=${Date.now() - this.sessionStartTime}ms | utterances=${this.totalUtterances} | chunks=${this.totalChunksSent}`,
    )

    this.clearIdleTimer()
    this.cleanupSession()
    this.transitionTo('idle')
  }

  getDiagnostics(): PersistentSessionDiagnostics {
    return {
      state: this.state,
      sessionId: this.sessionId,
      sessionAgeMs: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0,
      totalUtterances: this.totalUtterances,
      totalChunksSent: this.totalChunksSent,
      totalBytesSent: this.totalBytesSent,
      currentUtteranceChunks: this.currentUtteranceChunks,
      lastUtteranceLatencyMs: this.lastUtteranceLatencyMs,
      reconnectCount: this.reconnectCount,
      lastError: this.lastError,
    }
  }

  getState(): SessionState {
    return this.state
  }

  isReady(): boolean {
    return this.state === 'paused' || this.state === 'streaming'
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private attachSessionListeners(): void {
    const session = this.session!

    session.on('result', (result: any) => {
      if (this.state !== 'streaming' && this.state !== 'paused') return

      for (const token of result.tokens ?? []) {
        if (this.isTranslationMode) {
          const status = (token as any).translation_status
          if (status !== 'translation') continue
        }

        this.emit('token', { text: token.text, is_final: token.is_final })

        if (token.is_final && token.text !== '<end>' && token.text !== '<fin>') {
          this.currentUtteranceText += token.text
          this.currentUtteranceTokenCount++
        }
      }

      if (this.currentUtteranceText.length > 0) {
        this.emit('utterance-text', this.currentUtteranceText)
      }
    })

    session.on('error', (error: Error) => {
      if (this.state === 'idle' || this.state === 'closing') {
        console.log(
          `[SonioxPersistent:${this.sessionId}] Error in ${this.state} state (already handled), ignoring: ${error.message}`,
        )
        return
      }

      const errorCode = (error as any).code ?? 'unknown'
      const errorStatus = (error as any).statusCode ?? 'unknown'
      const is503 =
        errorStatus === 503 ||
        String(error.message).includes('503') ||
        String(error.message).includes('Cannot continue request')
      const isQuota =
        errorCode === 'quota_exceeded' ||
        String(error.message).toLowerCase().includes('quota')

      console.error(
        `[SonioxPersistent:${this.sessionId}] Error | state=${this.state} | age=${Date.now() - this.sessionStartTime}ms | is503=${is503} | isQuota=${isQuota} | ${error.message}`,
      )

      this.lastError = error.message
      this.needsReconnect = true
      this.reconnectCount++
      this.transitionTo('idle')
      this.cleanupSession()
      this.emit('error', error)
    })

    session.on('disconnected', (reason?: string) => {
      if (reason === 'client_closed' || this.state === 'closing' || this.state === 'idle') {
        console.log(
          `[SonioxPersistent:${this.sessionId}] Disconnected (expected) | reason="${reason ?? 'none'}" | state=${this.state}`,
        )
        return
      }

      console.error(
        `[SonioxPersistent:${this.sessionId}] Unexpected disconnect | reason="${reason ?? 'none'}" | state=${this.state} | age=${Date.now() - this.sessionStartTime}ms`,
      )

      this.lastError = `Unexpected disconnect: ${reason ?? 'none'}`
      this.needsReconnect = true
      this.reconnectCount++
      this.transitionTo('idle')
      this.cleanupSession()
      this.emit('error', new Error(`Unexpected disconnect: ${reason ?? 'none'}`))
    })

    session.on('connected', () => {
      console.log(
        `[SonioxPersistent:${this.sessionId}] WebSocket connected | age=${Date.now() - this.sessionStartTime}ms`,
      )
    })

    session.on('state_change', (update: { old_state: string; new_state: string }) => {
      console.log(
        `[SonioxPersistent:${this.sessionId}] SDK state: ${update.old_state} → ${update.new_state}`,
      )
    })

    session.on('finished', () => {
      console.log(
        `[SonioxPersistent:${this.sessionId}] Session finished event | age=${Date.now() - this.sessionStartTime}ms`,
      )
    })
  }

  private transitionTo(newState: SessionState): void {
    const oldState = this.state
    if (oldState === newState) return
    this.state = newState
    console.log(
      `[SonioxPersistent:${this.sessionId}] ${oldState} → ${newState} | age=${this.sessionStartTime ? Date.now() - this.sessionStartTime : 0}ms`,
    )
    this.emit('state-change', newState, oldState)
  }

  private cleanupSession(): void {
    this.clearIdleTimer()

    if (this.session) {
      try {
        this.session.close()
      } catch (e) {
        console.error(`[SonioxPersistent:${this.sessionId}] Error closing session:`, e)
      }
      this.session = null
    }

    this.client = null
  }

  private startIdleTimer(): void {
    this.clearIdleTimer()
    const timeoutMs = this.config.idleTimeoutMs ?? 120_000
    this.idleTimer = setTimeout(() => {
      console.log(
        `[SonioxPersistent:${this.sessionId}] Idle timeout (${timeoutMs}ms) — closing session to save billing`,
      )
      this.close()
      this.emit('auto-closed', 'idle')
    }, timeoutMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private isSessionExpired(): boolean {
    if (!this.sessionStartTime) return false
    const maxAge = this.config.maxSessionAgeMs ?? 240 * 60 * 1000
    return Date.now() - this.sessionStartTime > maxAge
  }

  private hasConfigChanged(
    translationConfig?: SonioxTranslationConfig,
    options?: EnsureReadyOptions,
  ): boolean {
    const prevTranslation = JSON.stringify(this.lastTranslationConfig ?? null)
    const newTranslation = JSON.stringify(translationConfig ?? null)
    if (prevTranslation !== newTranslation) return true

    const prevDisableEndpoint = this.lastOptions?.disableEndpointDetection ?? false
    const newDisableEndpoint = options?.disableEndpointDetection ?? false
    if (prevDisableEndpoint !== newDisableEndpoint) return true

    const prevHints = JSON.stringify(this.lastOptions?.languageHints ?? null)
    const newHints = JSON.stringify(options?.languageHints ?? null)
    if (prevHints !== newHints) return true

    return false
  }

  private waitForFinalTokens(maxWaitMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      let lastTokenTime = Date.now()
      const startTime = Date.now()

      const cleanup = () => {
        if (settled) return
        settled = true
        clearInterval(checkInterval)
        clearTimeout(safetyTimeout)
        this.off('token', onToken)
        resolve()
      }

      const onToken = () => {
        lastTokenTime = Date.now()
      }
      this.on('token', onToken)

      const checkInterval = setInterval(() => {
        const sinceLastToken = Date.now() - lastTokenTime
        const totalElapsed = Date.now() - startTime
        if (sinceLastToken > 100 || totalElapsed > maxWaitMs) {
          cleanup()
        }
      }, 50)

      const safetyTimeout = setTimeout(cleanup, maxWaitMs)
    })
  }
}
