import { SonioxNodeClient, RealtimeSttSession } from '@soniox/node'
import { EventEmitter } from 'events'

interface SonioxToken {
  text: string
  is_final: boolean
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

export interface SonioxEvents {
  token: (token: SonioxToken) => void
  'final-text': (text: string) => void
  finished: () => void
  error: (error: Error) => void
}

export class SonioxStreamingService extends EventEmitter {
  private client: SonioxNodeClient | null = null
  private session: RealtimeSttSession | null = null
  private isActive = false
  private accumulatedText = ''
  private hasErrored = false
  private isTranslationMode = false
  private static readonly FINISH_TIMEOUT_MS = 8000

  // ── Diagnostic state ────────────────────────────────────────────────────────
  private sessionId = ''
  private sessionStartTime = 0
  private connectTime = 0
  private totalChunksSent = 0
  private totalBytesSent = 0
  private lastChunkSentTime = 0
  private totalTokensReceived = 0
  private finalTokensReceived = 0
  private lastFinalTokenTime = 0
  private firstTokenTime = 0
  private droppedChunksAfterError = 0   // Bug fix: compteur séparé pour les chunks droppés post-erreur
  // ────────────────────────────────────────────────────────────────────────────

  async start(
    tempApiKey: string,
    translationConfig?: SonioxTranslationConfig,
    options?: {
      disableEndpointDetection?: boolean
      context?: SonioxContextConfig
    },
  ): Promise<void> {
    if (this.isActive) {
      console.warn(
        '[SonioxStreaming] Already active, stopping previous session',
      )
      await this.stop()
    }

    // Reset all state
    this.accumulatedText = ''
    this.hasErrored = false
    this.isTranslationMode = !!translationConfig
    this.totalChunksSent = 0
    this.totalBytesSent = 0
    this.lastChunkSentTime = 0
    this.totalTokensReceived = 0
    this.finalTokensReceived = 0
    this.lastFinalTokenTime = 0
    this.firstTokenTime = 0
    this.droppedChunksAfterError = 0

    this.sessionId = `ssx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    this.sessionStartTime = Date.now()

    console.log(
      `[SonioxStreaming:${this.sessionId}] ── START ── mode=${translationConfig ? 'translation' : 'transcription'} disableEndpoint=${!!options?.disableEndpointDetection} hasContext=${!!options?.context}`,
    )

    this.client = new SonioxNodeClient({ api_key: tempApiKey })

    const sessionConfig: any = {
      model: 'stt-rt-v4',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      enable_endpoint_detection: !options?.disableEndpointDetection,
      enable_language_identification: true,
    }

    if (!translationConfig) {
      sessionConfig.language_hints = ['fr']
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
        console.log(`[SonioxStreaming:${this.sessionId}] Context injected:`, {
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

    this.session.on('result', result => {
      if (!this.isActive) {
        console.warn(
          `[SonioxStreaming:${this.sessionId}] result received but session is inactive — token dropped`,
        )
        return
      }
      try {
        if (result.tokens && result.tokens.length > 0) {
          const now = Date.now()
          if (this.firstTokenTime === 0) {
            this.firstTokenTime = now
            const latency = now - this.sessionStartTime
            console.log(
              `[SonioxStreaming:${this.sessionId}] First token received | latency from connect: ${latency}ms`,
            )
          }
          this.totalTokensReceived += result.tokens.length

          for (const token of result.tokens) {
            if (this.isTranslationMode) {
              const status = (token as any).translation_status
              if (status === 'translation') {
                this.emit('token', {
                  text: token.text,
                  is_final: token.is_final,
                })
                if (token.is_final) {
                  this.accumulatedText += token.text
                  this.finalTokensReceived++
                  this.lastFinalTokenTime = now
                  console.log(
                    `[SonioxStreaming:${this.sessionId}] Final token #${this.finalTokensReceived}: "${token.text.slice(0, 40)}" | accum: ${this.accumulatedText.length} chars | +${now - this.sessionStartTime}ms`,
                  )
                }
              }
            } else {
              this.emit('token', {
                text: token.text,
                is_final: token.is_final,
              })
              if (token.is_final) {
                this.accumulatedText += token.text
                this.finalTokensReceived++
                this.lastFinalTokenTime = now
                console.log(
                  `[SonioxStreaming:${this.sessionId}] Final token #${this.finalTokensReceived}: "${token.text.slice(0, 40)}" | accum: ${this.accumulatedText.length} chars | +${now - this.sessionStartTime}ms`,
                )
              }
            }
          }
          this.emit('final-text', this.accumulatedText)
        }
      } catch (error) {
        console.error(`[SonioxStreaming:${this.sessionId}] Error processing result:`, error)
      }
    })

    this.session.on('finished', () => {
      const elapsed = Date.now() - this.sessionStartTime
      console.log(
        `[SonioxStreaming:${this.sessionId}] Session 'finished' event received | age: ${elapsed}ms | finalTokens: ${this.finalTokensReceived} | accum: ${this.accumulatedText.length} chars`,
      )
      this.emit('finished')
    })

    // ── Finding 3 FIX: écoute de l'événement 'disconnected' ────────────────────
    // Le SDK émet 'disconnected' (pas 'error') quand le serveur ferme le WebSocket.
    // Si la raison est 'client_closed', c'est notre propre session.close() → normal.
    // Sinon, c'est une fermeture serveur inattendue → on marque la session comme errored
    // pour éviter que sendAudio continue d'envoyer sur un socket mort silencieusement.
    this.session.on('disconnected', (reason?: string) => {
      const elapsed = Date.now() - this.sessionStartTime
      const isClientInitiated = reason === 'client_closed'
      if (!isClientInitiated && this.isActive && !this.hasErrored) {
        console.error(
          `[SonioxStreaming:${this.sessionId}] [FIX-3-DISCONNECTED] Unexpected server disconnect` +
            ` | reason="${reason ?? 'none'}"` +
            ` | age=${elapsed}ms` +
            ` | accumChars=${this.accumulatedText.length}` +
            ` | chunks=${this.totalChunksSent}` +
            ` — marking session as errored to prevent zombie sends`,
        )
        this.hasErrored = true
        this.isActive = false
        this.safeEmitError(new Error(`Soniox WebSocket disconnected unexpectedly (reason: ${reason ?? 'none'})`))
      } else {
        console.log(
          `[SonioxStreaming:${this.sessionId}] [FIX-3-DISCONNECTED] Disconnected` +
            ` | reason="${reason ?? 'none'}"` +
            ` | age=${elapsed}ms` +
            ` | isActive=${this.isActive}` +
            ` | hasErrored=${this.hasErrored}` +
            ` | accumChars=${this.accumulatedText.length}`,
        )
      }
    })

    // ── Logs SDK supplémentaires pour visibilité complète ────────────────────
    this.session.on('connected', () => {
      const elapsed = Date.now() - this.sessionStartTime
      console.log(
        `[SonioxStreaming:${this.sessionId}] CONNECTED event | age=${elapsed}ms (WebSocket handshake confirmed)`,
      )
    })

    this.session.on('state_change', (update: { old_state: string; new_state: string }) => {
      const elapsed = Date.now() - this.sessionStartTime
      console.log(
        `[SonioxStreaming:${this.sessionId}] STATE_CHANGE: ${update.old_state} → ${update.new_state} | age=${elapsed}ms`,
      )
    })

    this.session.on('error', (error: Error) => {
      const elapsed = Date.now() - this.sessionStartTime
      // [SONIOX-DOCS] Détecter le 503 "Cannot continue request" — force l'ouverture d'une nouvelle session
      const errorCode = (error as any).code ?? 'unknown'
      const errorStatus = (error as any).statusCode ?? 'unknown'
      const is503 = errorStatus === 503 || String(error.message).includes('503') || String(error.message).includes('Cannot continue request')
      const isQuota = errorCode === 'quota_exceeded' || String(error.message).toLowerCase().includes('quota')
      console.error(
        `[SonioxStreaming:${this.sessionId}] Session ERROR | age: ${elapsed}ms | chunks: ${this.totalChunksSent} | bytes: ${(this.totalBytesSent / 1024).toFixed(1)}KB | accum: ${this.accumulatedText.length} chars` +
          ` | errorCode=${errorCode} | statusCode=${errorStatus}` +
          ` | [SONIOX-DOCS] is503=${is503} isQuota=${isQuota}` +
          (is503 ? ' — 503: must open NEW session' : '') +
          (isQuota ? ' — QUOTA: temp key may be exhausted (Finding 4)' : '') +
          ` | error: ${error.message}`,
      )
      this.hasErrored = true
      this.isActive = false
      this.safeEmitError(error)
    })

    const connectStart = Date.now()
    await this.session.connect()
    this.connectTime = Date.now() - connectStart
    this.isActive = true

    console.log(
      `[SonioxStreaming:${this.sessionId}] Connected in ${this.connectTime}ms | mode=${translationConfig ? 'translation' : 'transcription'}`,
    )
  }

  private safeEmitError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    } else {
      console.error(
        `[SonioxStreaming:${this.sessionId}] Unhandled error (no listener):`,
        error.message,
      )
    }
  }

  sendAudio(chunk: Buffer): void {
    if (!this.isActive || !this.session || this.hasErrored) {
      if (this.hasErrored) {
        // Bug fix: utiliser droppedChunksAfterError (compteur dédié) et non totalChunksSent
        // (qui est statique une fois hasErrored=true), sinon la condition % 50 est toujours
        // évaluée sur la même valeur → spam continu ou silence total selon la valeur.
        this.droppedChunksAfterError++
        if (this.droppedChunksAfterError === 1 || this.droppedChunksAfterError % 50 === 0) {
          console.warn(
            `[SonioxStreaming:${this.sessionId}] sendAudio ignored — hasErrored=true | droppedAfterError=${this.droppedChunksAfterError} | totalChunksSent=${this.totalChunksSent}`,
          )
        }
      }
      return
    }
    try {
      this.session.sendAudio(chunk)
      this.totalChunksSent++
      this.totalBytesSent += chunk.length
      this.lastChunkSentTime = Date.now()

      // Log audio throughput every 50 chunks
      if (this.totalChunksSent % 50 === 0) {
        const elapsed = Date.now() - this.sessionStartTime
        const silenceSinceLastToken =
          this.lastFinalTokenTime > 0
            ? Date.now() - this.lastFinalTokenTime
            : -1
        const sessionMinutes = elapsed / 60_000
        // [SONIOX-DOCS] Recommandation : redémarrer la session toutes les 15-20 min
        const sessionAgeWarning = sessionMinutes >= 15
          ? ` [⚠️ DOCS: session age ${sessionMinutes.toFixed(1)}min ≥ 15min recommended restart threshold]`
          : ''
        console.log(
          `[SonioxStreaming:${this.sessionId}] Audio stats: chunks=${this.totalChunksSent} bytes=${(this.totalBytesSent / 1024).toFixed(1)}KB sessionAge=${elapsed}ms finalTokens=${this.finalTokensReceived} accumChars=${this.accumulatedText.length} silenceSinceLastToken=${silenceSinceLastToken}ms${sessionAgeWarning}`,
        )
      }
    } catch (error) {
      console.error(
        `[SonioxStreaming:${this.sessionId}] Error sending audio chunk #${this.totalChunksSent + 1}:`,
        error,
      )
      this.hasErrored = true
      this.isActive = false
      this.safeEmitError(
        error instanceof Error
          ? error
          : new Error('Failed to send audio chunk'),
      )
    }
  }

  async stop(): Promise<string> {
    const stopCallTime = Date.now()
    const sessionAge = this.sessionStartTime > 0 ? stopCallTime - this.sessionStartTime : -1
    const timeSinceLastChunk =
      this.lastChunkSentTime > 0 ? stopCallTime - this.lastChunkSentTime : -1
    const timeSinceLastToken =
      this.lastFinalTokenTime > 0 ? stopCallTime - this.lastFinalTokenTime : -1

    // [SONIOX-DOCS] Log de l'état SDK natif de la session au moment du stop
    const sdkState = this.session?.state ?? 'null'
    console.log(
      `[SonioxStreaming:${this.sessionId}] ── STOP called ──` +
        ` | sessionAge=${sessionAge}ms` +
        ` | sdkState=${sdkState}` +
        ` | hasErrored=${this.hasErrored}` +
        ` | isActive=${this.isActive}` +
        ` | sessionNull=${!this.session}` +
        ` | totalChunks=${this.totalChunksSent}` +
        ` | totalBytes=${(this.totalBytesSent / 1024).toFixed(1)}KB` +
        ` | totalTokens=${this.totalTokensReceived}` +
        ` | finalTokens=${this.finalTokensReceived}` +
        ` | accumChars=${this.accumulatedText.length}` +
        ` | timeSinceLastChunk=${timeSinceLastChunk}ms` +
        ` | timeSinceLastToken=${timeSinceLastToken}ms`,
    )

    if (!this.session) {
      console.warn(
        `[SonioxStreaming:${this.sessionId}] stop() — session is null, returning accumulated text (${this.accumulatedText.length} chars)`,
      )
      this.removeAllListeners()
      return this.accumulatedText
    }

    const textBeforeStop = this.accumulatedText

    try {
      if (!this.hasErrored) {
        // [FIX-3] Call finalize() before finish() to flush server-side pending tokens.
        // Confirmed from SDK: session.finalize(options?: { trailing_silence_ms?: number }): void
        // Without this, tokens held server-side waiting for an endpoint signal are lost on close().
        const sdkStateForFinalize = this.session.state ?? 'unknown'
        if (sdkStateForFinalize === 'connected') {
          console.log(
            `[SonioxStreaming:${this.sessionId}] [FIX-3-FINALIZE] Calling finalize() before finish() | chunks=${this.totalChunksSent} | accumChars=${this.accumulatedText.length} | sdkState=${sdkStateForFinalize}`,
          )
          try {
            this.session.finalize()
            console.log(
              `[SonioxStreaming:${this.sessionId}] [FIX-3-FINALIZE] finalize() called — server will flush pending tokens before finish()`,
            )
          } catch (finalizeErr: any) {
            console.warn(
              `[SonioxStreaming:${this.sessionId}] [FIX-3-FINALIZE] finalize() threw: ${finalizeErr?.message ?? finalizeErr} — proceeding with finish() anyway`,
            )
          }
        } else {
          console.log(
            `[SonioxStreaming:${this.sessionId}] [FIX-3-FINALIZE] Skipping finalize() | sdkState=${sdkStateForFinalize} (need 'connected') | chunks=${this.totalChunksSent}`,
          )
        }
        let finishTimeoutId: ReturnType<typeof setTimeout> | null = null
        const finishStart = Date.now()
        console.log(
          `[SonioxStreaming:${this.sessionId}] Calling finish() — textBeforeStop=${textBeforeStop.length} chars, timeout=${SonioxStreamingService.FINISH_TIMEOUT_MS}ms`,
        )
        try {
          await Promise.race([
            this.session.finish(),
            new Promise<void>((_, reject) => {
              finishTimeoutId = setTimeout(
                () => reject(new Error('finish() timed out')),
                SonioxStreamingService.FINISH_TIMEOUT_MS,
              )
            }),
          ])
          const finishDuration = Date.now() - finishStart
          console.log(
            `[SonioxStreaming:${this.sessionId}] finish() COMPLETED in ${finishDuration}ms` +
              ` | textAfterStop=${this.accumulatedText.length} chars` +
              ` | newTokensFromFinalizeAndFinish=${this.accumulatedText.length - textBeforeStop.length} chars` +
              ` | finalTokensTotal=${this.finalTokensReceived}`,
          )
        } catch (err: any) {
          const finishDuration = Date.now() - finishStart
          const charsGainedDuringStop = this.accumulatedText.length - textBeforeStop.length
          console.warn(
            `[SonioxStreaming:${this.sessionId}] finish() TIMED OUT after ${finishDuration}ms (limit=${SonioxStreamingService.FINISH_TIMEOUT_MS}ms)` +
              ` | charsBeforeStop=${textBeforeStop.length}` +
              ` | charsGainedDuringStop=${charsGainedDuringStop}` +
              ` | charsAtTimeout=${this.accumulatedText.length}` +
              ` | ⚠️ tokens still server-side are LOST after close()` +
              ` | error: ${err.message}`,
          )
        } finally {
          if (finishTimeoutId) clearTimeout(finishTimeoutId)
        }
      } else {
        console.warn(
          `[SonioxStreaming:${this.sessionId}] Skipping finish() because hasErrored=true | accumText="${this.accumulatedText.slice(0, 80)}" (${this.accumulatedText.length} chars)`,
        )
      }
      this.session.close()
      console.log(
        `[SonioxStreaming:${this.sessionId}] session.close() called | finalText="${this.accumulatedText.slice(0, 80)}" (${this.accumulatedText.length} chars)`,
      )
    } catch (error) {
      console.error(`[SonioxStreaming:${this.sessionId}] Error during stop():`, error)
    }

    this.isActive = false
    const finalText = this.accumulatedText

    this.isTranslationMode = false
    this.session = null
    this.client = null
    this.removeAllListeners()

    console.log(
      `[SonioxStreaming:${this.sessionId}] ── STOP complete ──` +
        ` | returnedText="${finalText.slice(0, 80)}" (${finalText.length} chars)`,
    )

    return finalText
  }

  cancel(): void {
    const sessionAge = this.sessionStartTime > 0 ? Date.now() - this.sessionStartTime : -1
    console.log(
      `[SonioxStreaming:${this.sessionId}] cancel() | sessionAge=${sessionAge}ms | chunks=${this.totalChunksSent} | accum=${this.accumulatedText.length} chars`,
    )
    if (!this.session) {
      this.removeAllListeners()
      return
    }
    try {
      this.session.close()
    } catch (error) {
      console.error(`[SonioxStreaming:${this.sessionId}] Error during cancel():`, error)
    }
    this.isActive = false
    this.isTranslationMode = false
    this.hasErrored = false
    this.session = null
    this.client = null
    this.accumulatedText = ''
    this.removeAllListeners()
  }

  getAccumulatedText(): string {
    return this.accumulatedText
  }

  isCurrentlyActive(): boolean {
    return this.isActive
  }

  hasEncounteredError(): boolean {
    return this.hasErrored
  }

  getSessionId(): string {
    return this.sessionId
  }

  getSessionAgeMs(): number {
    return this.sessionStartTime > 0 ? Date.now() - this.sessionStartTime : -1
  }

  getDiagnostics(): {
    sessionId: string
    sessionAgeMs: number
    connectTimeMs: number
    firstTokenLatencyMs: number
    totalChunksSent: number
    totalBytesSent: number
    totalTokensReceived: number
    finalTokensReceived: number
    accumTextLength: number
    isActive: boolean
    hasErrored: boolean
    droppedChunksAfterError: number
    timeSinceLastChunkMs: number
    timeSinceLastFinalTokenMs: number
  } {
    const now = Date.now()
    return {
      sessionId: this.sessionId,
      sessionAgeMs: this.sessionStartTime > 0 ? now - this.sessionStartTime : -1,
      connectTimeMs: this.connectTime,
      firstTokenLatencyMs: this.firstTokenTime > 0 ? this.firstTokenTime - this.sessionStartTime : -1,
      totalChunksSent: this.totalChunksSent,
      totalBytesSent: this.totalBytesSent,
      totalTokensReceived: this.totalTokensReceived,
      finalTokensReceived: this.finalTokensReceived,
      accumTextLength: this.accumulatedText.length,
      isActive: this.isActive,
      hasErrored: this.hasErrored,
      droppedChunksAfterError: this.droppedChunksAfterError,
      timeSinceLastChunkMs:
        this.lastChunkSentTime > 0 ? now - this.lastChunkSentTime : -1,
      timeSinceLastFinalTokenMs:
        this.lastFinalTokenTime > 0 ? now - this.lastFinalTokenTime : -1,
    }
  }
}
