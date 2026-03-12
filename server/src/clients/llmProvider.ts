import { TranscriptionOptions } from './asrConfig.js'
import { IntentTranscriptionOptions } from './intentTranscriptionConfig.js'

export interface LlmProvider {
  readonly isAvailable: boolean

  transcribeAudio(
    audioBuffer: Buffer,
    options?: TranscriptionOptions,
  ): Promise<string>

  transcribeAndClean?(
    audioBuffer: Buffer,
    options?: TranscriptionOptions & { cleanupPrompt?: string },
  ): Promise<{ transcript: string; wasCleanedInline: boolean }>

  adjustTranscript(
    userPrompt: string,
    options?: IntentTranscriptionOptions,
  ): Promise<string>

  analyzeScreenContext?(
    screenshotBase64: string,
    voiceCommand: string,
    systemPrompt: string,
    options?: IntentTranscriptionOptions,
  ): Promise<string>
}
