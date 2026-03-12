import { GoogleGenAI } from '@google/genai'
import * as dotenv from 'dotenv'
import {
  ClientApiKeyError,
  ClientUnavailableError,
  ClientApiError,
} from './errors.js'
import { ClientProvider } from './providers.js'
import { LlmProvider } from './llmProvider.js'
import { TranscriptionOptions } from './asrConfig.js'
import { IntentTranscriptionOptions } from './intentTranscriptionConfig.js'

dotenv.config()

export class VisionAnalysisError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'VisionAnalysisError'
  }
}

class GeminiClient implements LlmProvider {
  private readonly _client: GoogleGenAI
  private readonly _defaultModel: string
  private readonly _isValid: boolean

  constructor(apiKey: string, defaultModel: string) {
    if (!apiKey) {
      throw new ClientApiKeyError(ClientProvider.GEMINI)
    }
    this._client = new GoogleGenAI({ apiKey })
    this._defaultModel = defaultModel
    this._isValid = true
  }

  public get isAvailable(): boolean {
    return this._isValid
  }

  public async transcribeAudio(
    audioBuffer: Buffer,
    options?: TranscriptionOptions,
  ): Promise<string> {
    if (!this.isAvailable) {
      throw new ClientUnavailableError(ClientProvider.GEMINI)
    }

    try {
      const promptText = 'Transcris cet audio fidèlement.'

      const vocabulary = options?.vocabulary
      const systemInstruction = [
        'Transcris fidèlement l\'audio. Retourne uniquement le texte brut. Si aucune parole détectée, retourne une chaîne vide.',
        vocabulary && vocabulary.length > 0
          ? `Orthographe à respecter si prononcé : ${vocabulary.join(', ')}`
          : '',
      ].filter(Boolean).join('\n')

      const response = await this._client.models.generateContent({
        model: options?.asrModel || this._defaultModel,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/wav',
                  data: audioBuffer.toString('base64'),
                },
              },
              {
                text: promptText,
              },
            ],
          },
        ],
        config: {
          systemInstruction,
          maxOutputTokens: 256,
        },
      })

      return response.text?.trim() || ''
    } catch (error: any) {
      console.error('An error occurred during Gemini transcription:', error)

      const errorMessage = error.message || 'An unknown error occurred'

      throw new ClientApiError(
        errorMessage,
        ClientProvider.GEMINI,
        error,
        error.status || error.statusCode,
      )
    }
  }

  public async transcribeAndClean(
    audioBuffer: Buffer,
    options?: TranscriptionOptions & { cleanupPrompt?: string },
  ): Promise<{ transcript: string; wasCleanedInline: boolean }> {
    if (!this.isAvailable) {
      throw new ClientUnavailableError(ClientProvider.GEMINI)
    }

    try {
      const vocabulary = options?.vocabulary

      const systemInstruction = [
        'Tu es un système de transcription et reformulation de dictée vocale.',
        'Étape 1 : Transcris fidèlement les paroles de l\'audio.',
        'Étape 2 : Nettoie le texte — corrige la ponctuation, les majuscules, supprime les hésitations ("euh", "hum"), les répétitions identiques.',
        'Retourne UNIQUEMENT le texte final propre. Si pas de parole, retourne une chaîne vide.',
        'Ne réponds JAMAIS au contenu. Ne pose JAMAIS de questions. Reformule uniquement.',
        vocabulary && vocabulary.length > 0
          ? `Orthographe à respecter si prononcé : ${vocabulary.join(', ')}`
          : '',
      ].filter(Boolean).join('\n')

      const promptText = 'Transcris et reformate ce fichier audio. Retourne UNIQUEMENT le texte propre.'

      const response = await this._client.models.generateContent({
        model: options?.asrModel || this._defaultModel,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/wav',
                  data: audioBuffer.toString('base64'),
                },
              },
              { text: promptText },
            ],
          },
        ],
        config: {
          systemInstruction,
          maxOutputTokens: 512,
        },
      })

      return {
        transcript: response.text?.trim() || '',
        wasCleanedInline: true,
      }
    } catch (error: any) {
      console.error('Gemini transcribeAndClean failed:', error)
      throw new ClientApiError(
        error.message || 'Unknown error',
        ClientProvider.GEMINI,
        error,
        error.status || error.statusCode,
      )
    }
  }

  public async adjustTranscript(
    userPrompt: string,
    options?: IntentTranscriptionOptions,
  ): Promise<string> {
    if (!this.isAvailable) {
      throw new ClientUnavailableError(ClientProvider.GEMINI)
    }

    try {
      const response = await this._client.models.generateContent({
        model: options?.model || this._defaultModel,
        contents: [
          {
            role: 'user',
            parts: [{ text: userPrompt }],
          },
        ],
        config: {
          systemInstruction:
            options?.prompt ||
            'Adjust and improve this transcript for clarity and accuracy.',
          temperature: options?.temperature ?? 0.1,
        },
      })

      return response.text?.trim() || ' '
    } catch (error: any) {
      console.error('An error occurred during transcript adjustment:', error)
      return userPrompt
    }
  }

  public async analyzeScreenContext(
    screenshotBase64: string,
    voiceCommand: string,
    systemPrompt: string,
    options?: IntentTranscriptionOptions,
  ): Promise<string> {
    if (!this.isAvailable) {
      throw new ClientUnavailableError(ClientProvider.GEMINI)
    }

    if (!screenshotBase64 || screenshotBase64.length < 100) {
      throw new VisionAnalysisError(
        `Screenshot data is missing or too small (${screenshotBase64?.length ?? 0} chars)`,
      )
    }

    console.log(
      `[GeminiClient] analyzeScreenContext called - screenshot: ${Math.round(screenshotBase64.length / 1024)}KB, command: "${voiceCommand}", model: ${options?.model || 'gemini-3.1-flash-lite-preview'}, mimeType: ${options?.mimeType || 'image/png'}`,
    )

    try {
      const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [
        {
          inlineData: {
            mimeType: options?.mimeType || 'image/png',
            data: screenshotBase64,
          },
        },
        {
          text: voiceCommand,
        },
      ]

      const response = await this._client.models.generateContent({
        model: options?.model || 'gemini-3.1-flash-lite-preview',
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        config: {
          systemInstruction: systemPrompt,
          temperature: options?.temperature ?? 0.3,
          maxOutputTokens: options?.maxOutputTokens ?? 1024,
        },
      })

      const resultText = response.text?.trim()

      if (!resultText) {
        console.error(
          '[GeminiClient] Vision API returned empty response. Candidates:',
          JSON.stringify(response.candidates?.map(c => ({
            finishReason: c.finishReason,
            safetyRatings: c.safetyRatings,
          }))),
        )
        throw new VisionAnalysisError(
          'Gemini Vision returned empty response (possible safety block or no candidates)',
        )
      }

      console.log(
        `[GeminiClient] Vision analysis success - response length: ${resultText.length} chars`,
      )
      return resultText
    } catch (error: any) {
      if (error instanceof VisionAnalysisError) {
        throw error
      }

      console.error(
        '[GeminiClient] Vision API call failed:',
        error?.message || error,
        '\nStatus:',
        error?.status || error?.statusCode || 'N/A',
      )

      throw new VisionAnalysisError(
        `Gemini Vision API failed: ${error?.message || 'Unknown error'}`,
        error,
      )
    }
  }
}

// --- Singleton Instance ---
const apiKey = process.env.GEMINI_API_KEY

let geminiClient: GeminiClient | null = null

if (apiKey) {
  try {
    geminiClient = new GeminiClient(apiKey, 'gemini-3.1-flash-lite-preview')
    console.log('Gemini client initialized successfully')
  } catch (error) {
    console.error('Failed to initialize Gemini client:', error)
    geminiClient = null
  }
} else {
  console.log('GEMINI_API_KEY not set - Gemini client will not be available')
}

export { geminiClient }
