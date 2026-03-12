import { RealtimeClient } from '@speechmatics/real-time-client'
import { EventEmitter } from 'events'

export interface SpeechmaticsStreamingOptions {
  language?: string
  operatingPoint?: 'standard' | 'enhanced'
  enablePartials?: boolean
  removeDisfluencies?: boolean
  additionalVocab?: (string | { content: string; sounds_like?: string[] })[]
}

export class SpeechmaticsStreamingService extends EventEmitter {
  private client: RealtimeClient | null = null
  private isActive = false
  private accumulatedText = ''
  private hasErrored = false

  private sessionId = ''
  private sessionStartTime = 0
  private totalChunksSent = 0
  private totalBytesSent = 0
  private firstResultTime = 0

  private assembleText(results: any[]): string {
    return results.reduce((text: string, r: any) => {
      const content = r.alternatives?.[0]?.content || ''
      if (!content) return text
      if (!text) return content
      if (r.type === 'punctuation' && (r.attaches_to === 'previous' || r.attaches_to === 'both')) {
        return text + content
      }
      return text + ' ' + content
    }, '')
  }

  async start(
    jwt: string,
    options: SpeechmaticsStreamingOptions = {},
  ): Promise<void> {
    if (this.isActive) {
      console.warn('[SpeechmaticsStreaming] Already active, stopping previous session')
      await this.stop()
    }

    this.accumulatedText = ''
    this.hasErrored = false
    this.totalChunksSent = 0
    this.totalBytesSent = 0
    this.firstResultTime = 0
    this.sessionId = `sm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    this.sessionStartTime = Date.now()

    const language = options.language || 'fr'
    const operatingPoint = options.operatingPoint || 'enhanced'
    const enablePartials = options.enablePartials !== false
    const removeDisfluencies = options.removeDisfluencies || false

    console.log(
      `[SpeechmaticsStreaming:${this.sessionId}] ── START ── lang=${language} op=${operatingPoint} partials=${enablePartials} disfluencies=${removeDisfluencies}`,
    )

    this.client = new RealtimeClient({
      appId: 'ito-desktop',
    })

    this.client.addEventListener('receiveMessage', ({ data }) => {
      if (!this.isActive) return

      try {
        if (data.message === 'AddPartialTranscript' && enablePartials) {
          const partialText = this.assembleText(data.results)
          if (partialText) {
            let preview = this.accumulatedText
            if (preview.length > 0) {
              const firstResult = (data.results || []).find((r: any) => r.alternatives?.[0]?.content)
              const startsWithAttachedPunct = firstResult?.type === 'punctuation' &&
                (firstResult?.attaches_to === 'previous' || firstResult?.attaches_to === 'both')
              preview += startsWithAttachedPunct ? '' : ' '
            }
            this.emit('partial-text', preview + partialText)
          }
        } else if (data.message === 'AddTranscript') {
          const now = Date.now()
          if (this.firstResultTime === 0) {
            this.firstResultTime = now
            console.log(
              `[SpeechmaticsStreaming:${this.sessionId}] First final result | latency: ${now - this.sessionStartTime}ms`,
            )
          }

          const text = this.assembleText(data.results)
          if (text) {
            if (this.accumulatedText.length > 0) {
              const firstResult = (data.results || []).find((r: any) => r.alternatives?.[0]?.content)
              const startsWithAttachedPunct = firstResult?.type === 'punctuation' &&
                (firstResult?.attaches_to === 'previous' || firstResult?.attaches_to === 'both')
              if (!startsWithAttachedPunct) {
                this.accumulatedText += ' '
              }
            }
            this.accumulatedText += text
          }
          this.emit('final-text', this.accumulatedText)
        } else if (data.message === 'EndOfTranscript') {
          console.log(
            `[SpeechmaticsStreaming:${this.sessionId}] EndOfTranscript | total: ${this.accumulatedText.length} chars`,
          )
          this.emit('finished')
        } else if (data.message === 'Error') {
          const errorMsg = `${(data as any).type || 'unknown'}: ${(data as any).reason || 'Unknown Speechmatics error'}`
          console.error(`[SpeechmaticsStreaming:${this.sessionId}] Server error: ${errorMsg}`)
          this.hasErrored = true
          this.emit('error', new Error(errorMsg))
        }
      } catch (error) {
        console.error(`[SpeechmaticsStreaming:${this.sessionId}] Error processing message:`, error)
      }
    })

    this.client.addEventListener('socketStateChange', (event: any) => {
      const socketState = event.socketState
      console.log(`[SpeechmaticsStreaming:${this.sessionId}] Socket state: ${socketState}`)
      if (socketState === 'open') {
        this.emit('connected')
      } else if (socketState === 'closed') {
        this.emit('disconnected')
      }
    })

    const transcriptionConfig: any = {
      language,
      enable_partials: enablePartials,
      operating_point: operatingPoint,
    }

    if (options.additionalVocab && options.additionalVocab.length > 0) {
      transcriptionConfig.additional_vocab = options.additionalVocab
    }

    if (removeDisfluencies) {
      transcriptionConfig.transcript_filtering_config = {
        remove_disfluencies: true,
      }
    }

    await this.client.start(jwt, {
      transcription_config: transcriptionConfig,
      audio_format: {
        type: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: 16000,
      },
    })

    this.isActive = true
    console.log(`[SpeechmaticsStreaming:${this.sessionId}] Recognition started`)
  }

  sendAudio(chunk: Buffer): void {
    if (!this.isActive || !this.client || this.hasErrored) {
      return
    }

    try {
      this.client.sendAudio(chunk)
      this.totalChunksSent++
      this.totalBytesSent += chunk.length
    } catch (error: any) {
      if (!this.hasErrored) {
        this.hasErrored = true
        console.error(`[SpeechmaticsStreaming:${this.sessionId}] sendAudio error: ${error.message}`)
        this.emit('error', error)
      }
    }
  }

  async stop(): Promise<string> {
    if (!this.isActive || !this.client) {
      return this.accumulatedText
    }

    const elapsed = Date.now() - this.sessionStartTime
    console.log(
      `[SpeechmaticsStreaming:${this.sessionId}] ── STOP ── age=${elapsed}ms chunks=${this.totalChunksSent} bytes=${this.totalBytesSent} accum=${this.accumulatedText.length} chars`,
    )

    this.isActive = false

    try {
      await this.client.stopRecognition()
    } catch (error) {
      console.warn(`[SpeechmaticsStreaming:${this.sessionId}] stopRecognition error:`, error)
    }

    this.client = null
    return this.accumulatedText
  }

  cancel(): void {
    this.isActive = false
    this.client = null
  }

  getAccumulatedText(): string {
    return this.accumulatedText
  }

  getSessionId(): string {
    return this.sessionId
  }

  getSessionAgeMs(): number {
    return this.sessionStartTime > 0 ? Date.now() - this.sessionStartTime : 0
  }

  isCurrentlyActive(): boolean {
    return this.isActive
  }

  hasEncounteredError(): boolean {
    return this.hasErrored
  }
}
