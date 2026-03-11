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
  private isStopping = false
  private static readonly FINISH_TIMEOUT_MS = 3000

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

    this.accumulatedText = ''
    this.hasErrored = false
    this.isTranslationMode = !!translationConfig
    this.isStopping = false
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
        console.log('[SonioxStreaming] Context injected:', {
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
      if (!this.isActive) return
      try {
        if (result.tokens && result.tokens.length > 0) {
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
                }
              }
            } else {
              this.emit('token', {
                text: token.text,
                is_final: token.is_final,
              })
              if (token.is_final) {
                this.accumulatedText += token.text
              }
            }
          }
          this.emit('final-text', this.accumulatedText)
        }
      } catch (error) {
        console.error('[SonioxStreaming] Error processing result:', error)
      }
    })

    this.session.on('finished', () => {
      console.log('[SonioxStreaming] Session finished')
      this.emit('finished')
    })

    this.session.on('disconnected', (reason?: string) => {
      if (this.isStopping || this.hasErrored) {
        return
      }

      const message = reason
        ? `Session disconnected unexpectedly: ${reason}`
        : 'Session disconnected unexpectedly'

      console.warn(
        '[SonioxStreaming] Session disconnected:',
        reason || 'unknown',
      )
      this.hasErrored = true
      this.isActive = false
      this.safeEmitError(new Error(message))
    })

    this.session.on('error', (error: Error) => {
      if (this.isStopping) return
      console.error('[SonioxStreaming] Session error:', error.message)
      this.hasErrored = true
      this.isActive = false
      this.safeEmitError(error)
    })

    await this.session.connect()
    this.isActive = true
    console.log(
      '[SonioxStreaming] Session started',
      translationConfig ? '(translation mode)' : '(transcription mode)',
    )
  }

  private safeEmitError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    } else {
      console.error(
        '[SonioxStreaming] Unhandled error (no listener):',
        error.message,
      )
    }
  }

  sendAudio(chunk: Buffer): void {
    if (!this.isActive || !this.session || this.hasErrored) return
    try {
      this.session.sendAudio(chunk)
    } catch (error) {
      console.error('[SonioxStreaming] Error sending audio chunk:', error)
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
    if (!this.session) {
      this.isStopping = false
      this.removeAllListeners()
      return this.accumulatedText
    }

    this.isStopping = true

    try {
      if (!this.hasErrored) {
        let finishTimeoutId: ReturnType<typeof setTimeout> | null = null
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
        } catch (err: any) {
          console.warn(
            '[SonioxStreaming] finish() did not complete in time, forcing close:',
            err.message,
          )
        } finally {
          if (finishTimeoutId) clearTimeout(finishTimeoutId)
        }
      }
      this.session.close()
    } catch (error) {
      console.error('[SonioxStreaming] Error during stop:', error)
    }

    this.isActive = false
    const finalText = this.accumulatedText

    this.isTranslationMode = false
    this.hasErrored = false
    this.isStopping = false
    this.session = null
    this.client = null
    this.removeAllListeners()

    return finalText
  }

  cancel(): void {
    if (!this.session) {
      this.isStopping = false
      this.removeAllListeners()
      return
    }
    this.isStopping = true
    try {
      this.session.close()
    } catch (error) {
      console.error('[SonioxStreaming] Error during cancel:', error)
    }
    this.isActive = false
    this.isTranslationMode = false
    this.hasErrored = false
    this.isStopping = false
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
}
