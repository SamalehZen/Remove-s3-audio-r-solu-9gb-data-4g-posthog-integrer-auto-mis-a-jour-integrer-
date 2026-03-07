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
      let promptText =
        'Transcris ce fichier audio en français, mot à mot, fidèlement. Retourne UNIQUEMENT le texte transcrit, sans formatage, sans commentaire, sans explication. Conserve les noms propres (Ito, Arka) tels quels. Si tu ne détectes pas de parole, retourne une chaîne vide.'

      const vocabulary = options?.vocabulary
      const systemInstruction = [
        'Tu es un système de transcription audio. Ta SEULE tâche est de transcrire fidèlement les paroles prononcées dans l\'audio.',
        'RÈGLE CRITIQUE : Si l\'audio ne contient PAS de parole humaine claire (silence, bruit de fond, souffle, clics), tu DOIS retourner EXACTEMENT une chaîne vide. Ne génère AUCUN texte.',
        vocabulary && vocabulary.length > 0
          ? `AIDE ORTHOGRAPHIQUE (NE PAS AJOUTER AU TEXTE) : Les mots suivants peuvent apparaître dans l'audio. Si tu entends un son qui correspond, utilise cette orthographe : ${vocabulary.join(', ')}. Ces mots sont UNIQUEMENT des indices — ne les insère JAMAIS dans la transcription s'ils ne sont pas clairement prononcés.`
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
    options?: IntentTranscriptionOptions & { mimeType?: string; max_tokens?: number },
  ): Promise<string> {
    if (!this.isAvailable) {
      throw new ClientUnavailableError(ClientProvider.GEMINI)
    }

    if (!screenshotBase64 || screenshotBase64.length < 100) {
      throw new VisionAnalysisError(
        `Screenshot data is missing or too small (${screenshotBase64?.length ?? 0} chars)`,
      )
    }

    const mimeType = options?.mimeType || 'image/png'

    console.log(
      `[GeminiClient] analyzeScreenContext called - screenshot: ${Math.round(screenshotBase64.length / 1024)}KB (${mimeType}), command: "${voiceCommand}", model: ${options?.model || 'gemini-2.5-flash'}`,
    )

    try {
      const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [
        {
          inlineData: {
            mimeType,
            data: screenshotBase64,
          },
        },
        {
          text: voiceCommand,
        },
      ]

      const response = await this._client.models.generateContent({
        model: options?.model || 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        config: {
          systemInstruction: systemPrompt,
          temperature: options?.temperature ?? 0.3,
          ...(options?.max_tokens && { maxOutputTokens: options.max_tokens }),
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
    geminiClient = new GeminiClient(apiKey, 'gemini-2.5-flash-lite')
    console.log('Gemini client initialized successfully')
  } catch (error) {
    console.error('Failed to initialize Gemini client:', error)
    geminiClient = null
  }
} else {
  console.log('GEMINI_API_KEY not set - Gemini client will not be available')
}

export { geminiClient }
