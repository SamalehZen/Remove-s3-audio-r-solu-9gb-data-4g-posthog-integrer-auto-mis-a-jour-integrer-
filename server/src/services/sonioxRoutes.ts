import type { FastifyInstance } from 'fastify'
import { sonioxClient } from '../clients/sonioxClient.js'
import { getLlmProvider } from '../clients/providerUtils.js'
import { DEFAULT_ADVANCED_SETTINGS } from '../constants/generated-defaults.js'
import { ItoMode } from '../generated/ito_pb.js'
import { getPromptForMode, createUserPromptWithContext } from './ito/helpers.js'
import { getTranslationBasePrompt, getTranslationTonePrompt, getLanguageNameFromCode } from './ito/translationHelpers.js'
import { applyReplacements, filterLeakedContext } from './ito/llmUtils.js'
import { guardLanguage, detectTextLanguage } from './ito/languageGuard.js'
import type { ItoContext } from './ito/types.js'
import type { SupabaseJwtPayload } from '../auth/supabaseJwt.js'

interface AdjustTranscriptBody {
  transcript: string
  mode: 'transcribe' | 'edit' | 'translate' | 'context_awareness'
  targetLanguage?: string
  screenshotBase64?: string
  context?: {
    windowTitle?: string
    appName?: string
    contextText?: string
    browserUrl?: string
    browserDomain?: string
    tonePrompt?: string
    userDetailsContext?: string
  }
  llmSettings?: {
    llmProvider?: string
    llmModel?: string
    llmTemperature?: number
    transcriptionPrompt?: string
    editingPrompt?: string
  }
  replacements?: Array<{
    fromText: string
    toText: string
  }>
}

export const registerSonioxRoutes = async (
  fastify: FastifyInstance,
  options: { requireAuth: boolean },
) => {
  const { requireAuth } = options

  fastify.post('/soniox/temp-key', async (request, reply) => {
    try {
      const user = (request as any).user as SupabaseJwtPayload | undefined
      if (requireAuth && !user?.sub) {
        reply.code(401).send({ success: false, error: 'Unauthorized' })
        return
      }

      if (!sonioxClient || !sonioxClient.isAvailable) {
        reply.code(503).send({ success: false, error: 'Soniox not configured' })
        return
      }

      const tempKey = await sonioxClient.createTemporaryKey(3600)

      reply.send({
        success: true,
        key: tempKey,
        expires_in_seconds: 3600,
      })
    } catch (error: any) {
      fastify.log.error({ err: error }, 'Failed to generate Soniox temp key')
      reply.code(500).send({
        success: false,
        error: error?.message || 'Failed to generate temporary key',
      })
    }
  })

  fastify.post('/adjust-transcript', async (request, reply) => {
    try {
      const user = (request as any).user as SupabaseJwtPayload | undefined
      if (requireAuth && !user?.sub) {
        reply.code(401).send({ success: false, error: 'Unauthorized' })
        return
      }

      const body = request.body as AdjustTranscriptBody
      if (!body?.transcript || typeof body.transcript !== 'string') {
        reply.code(400).send({ success: false, error: 'Missing transcript field' })
        return
      }

      const trimmedTranscript = body.transcript.trim()
      if (trimmedTranscript.length < 2) {
        reply.send({ success: true, transcript: trimmedTranscript })
        return
      }

      const mode = body.mode === 'edit' ? ItoMode.EDIT
                   : body.mode === 'translate' ? ItoMode.TRANSLATE
                   : body.mode === 'context_awareness' ? ItoMode.CONTEXT_AWARENESS
                   : ItoMode.TRANSCRIBE

      const windowContext: ItoContext = {
        windowTitle: body.context?.windowTitle || '',
        appName: body.context?.appName || '',
        contextText: body.context?.contextText || '',
        browserUrl: body.context?.browserUrl || '',
        browserDomain: body.context?.browserDomain || '',
        tonePrompt: body.context?.tonePrompt || '',
        userDetailsContext: body.context?.userDetailsContext || '',
        screenCaptureBase64: body.screenshotBase64 || '',
      }

      const advancedSettings = {
        asrModel: DEFAULT_ADVANCED_SETTINGS.asrModel,
        asrProvider: DEFAULT_ADVANCED_SETTINGS.asrProvider,
        asrPrompt: DEFAULT_ADVANCED_SETTINGS.asrPrompt,
        llmProvider: body.llmSettings?.llmProvider || DEFAULT_ADVANCED_SETTINGS.llmProvider,
        llmModel: body.llmSettings?.llmModel || DEFAULT_ADVANCED_SETTINGS.llmModel,
        llmTemperature: body.llmSettings?.llmTemperature ?? DEFAULT_ADVANCED_SETTINGS.llmTemperature,
        transcriptionPrompt: body.llmSettings?.transcriptionPrompt || DEFAULT_ADVANCED_SETTINGS.transcriptionPrompt,
        editingPrompt: body.llmSettings?.editingPrompt || DEFAULT_ADVANCED_SETTINGS.editingPrompt,
        noSpeechThreshold: DEFAULT_ADVANCED_SETTINGS.noSpeechThreshold,
      }

      const hasTonePrompt = windowContext.tonePrompt && windowContext.tonePrompt.trim() !== ''
      const basePrompt = getPromptForMode(mode, advancedSettings)

      console.log(`[adjust-transcript] mode=${body.mode}, hasTone=${hasTonePrompt}, tonePreview="${windowContext.tonePrompt?.slice(0, 60) || ''}"...`)

      let systemPrompt: string
      if (mode === ItoMode.TRANSLATE) {
        const targetLang = body.targetLanguage || 'en'
        systemPrompt = hasTonePrompt
          ? getTranslationTonePrompt(windowContext.tonePrompt, targetLang)
          : getTranslationBasePrompt(basePrompt, targetLang)
      } else if (hasTonePrompt) {
        systemPrompt = `${basePrompt}\n\nOUTPUT STYLE INSTRUCTIONS:\n${windowContext.tonePrompt}`
        console.log(`[adjust-transcript] Combined base prompt (${basePrompt.length} chars) + tone (${windowContext.tonePrompt.length} chars)`)
      } else {
        systemPrompt = basePrompt
      }

      const userPrompt = createUserPromptWithContext(trimmedTranscript, windowContext)

      if (mode === ItoMode.CONTEXT_AWARENESS && windowContext.screenCaptureBase64) {
        console.log(
          `[adjust-transcript] CONTEXT_AWARENESS with screenshot (${Math.round(windowContext.screenCaptureBase64.length / 1024)}KB), voice command: "${trimmedTranscript}"`,
        )

        const { geminiClient } = await import('../clients/geminiClient.js')

        if (!geminiClient) {
          console.error(
            '[adjust-transcript] CRITICAL: geminiClient is null — GEMINI_API_KEY likely not set. Vision analysis impossible.',
          )
        }

        if (geminiClient && typeof geminiClient.analyzeScreenContext === 'function') {
          const contextParts = [
            windowContext.userDetailsContext && `INFORMATIONS UTILISATEUR:\n${windowContext.userDetailsContext}`,
            windowContext.appName && `Application active: ${windowContext.appName}`,
            windowContext.windowTitle && `Titre de fenêtre: ${windowContext.windowTitle}`,
            windowContext.browserUrl && `URL: ${windowContext.browserUrl}`,
          ].filter(Boolean).join('\n')

          const caBasePrompt = getPromptForMode(mode, advancedSettings)
          const baseSystemPrompt = hasTonePrompt
            ? `${caBasePrompt}\n\nOUTPUT STYLE INSTRUCTIONS:\n${windowContext.tonePrompt}`
            : caBasePrompt

          const enrichedSystemPrompt = contextParts
            ? `${baseSystemPrompt}\n\nCONTEXTE ADDITIONNEL:\n${contextParts}`
            : baseSystemPrompt

          const MAX_VISION_RETRIES = 2
          let lastVisionError: unknown = null

          for (let attempt = 1; attempt <= MAX_VISION_RETRIES; attempt++) {
            try {
              console.log(
                `[adjust-transcript] Gemini Vision attempt ${attempt}/${MAX_VISION_RETRIES}`,
              )

              const visionResult = await geminiClient.analyzeScreenContext(
                windowContext.screenCaptureBase64,
                trimmedTranscript,
                enrichedSystemPrompt,
                {
                  temperature: advancedSettings.llmTemperature,
                  model: 'gemini-2.5-flash',
                },
              )

              console.log(
                `[adjust-transcript] Vision analysis succeeded on attempt ${attempt}: ${visionResult.length} chars`,
              )
              reply.send({ success: true, transcript: visionResult.trim() })
              return
            } catch (visionError: any) {
              lastVisionError = visionError
              console.error(
                `[adjust-transcript] Vision attempt ${attempt}/${MAX_VISION_RETRIES} failed:`,
                visionError?.message || visionError,
              )

              if (attempt < MAX_VISION_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
              }
            }
          }

          console.error(
            `[adjust-transcript] All ${MAX_VISION_RETRIES} vision attempts failed. Last error:`,
            lastVisionError,
          )
        }

        console.warn(
          '[adjust-transcript] CONTEXT_AWARENESS: Vision failed or unavailable, falling through to text-only (degraded mode)',
        )

        const editFallback = getPromptForMode(ItoMode.EDIT, advancedSettings)
        systemPrompt = hasTonePrompt
          ? `${editFallback}\n\nOUTPUT STYLE INSTRUCTIONS:\n${windowContext.tonePrompt}`
          : editFallback
        console.log(`[adjust-transcript] Vision fallback to EDIT mode, hasTone=${hasTonePrompt}`)
      }

      let finalUserPrompt = userPrompt
      if (mode === ItoMode.TRANSLATE) {
        const targetLang = body.targetLanguage || 'en'
        const langName = getLanguageNameFromCode(targetLang)
        finalUserPrompt = `[LANGUAGE REMINDER: Output MUST be in ${langName}. Ignore the language of context metadata below.]\n${userPrompt}`
      } else if (mode === ItoMode.CONTEXT_AWARENESS) {
        finalUserPrompt = `[LANGUAGE RULE: Follow the user's voice command below. If the user asks for a translation or a specific language, output in that requested language. Otherwise, output in the SAME language as the user's voice command. Do NOT default to the language of context metadata (window titles, app names, URLs). The voice command language takes priority.]\n${userPrompt}`
      } else {
        finalUserPrompt = `[LANGUAGE RULE: Your output MUST be in the SAME language as the user's dictated text below. Do NOT translate it. Do NOT switch to the language of the context metadata. Preserve the original language of the spoken text exactly.]\n${userPrompt}`
      }

      const llmProvider = getLlmProvider(advancedSettings.llmProvider)
      let adjustedTranscript = await llmProvider.adjustTranscript(finalUserPrompt, {
        temperature: advancedSettings.llmTemperature,
        model: advancedSettings.llmModel,
        prompt: systemPrompt,
      })

      adjustedTranscript = filterLeakedContext(adjustedTranscript)

      const replacements = body.replacements || []
      if (replacements.length > 0) {
        adjustedTranscript = applyReplacements(adjustedTranscript, replacements)
      }

      if (mode !== ItoMode.CONTEXT_AWARENESS) {
        const expectedLang = mode === ItoMode.TRANSLATE
          ? (body.targetLanguage || 'en')
          : detectTextLanguage(trimmedTranscript)

        if (expectedLang) {
          adjustedTranscript = await guardLanguage(adjustedTranscript, {
            expectedLanguage: expectedLang,
            llmProvider,
            llmOptions: {
              temperature: advancedSettings.llmTemperature,
              model: advancedSettings.llmModel,
              prompt: systemPrompt,
            },
            userPrompt: finalUserPrompt,
          })
        }
      } else {
        console.log('[adjust-transcript] Skipping guardLanguage for CONTEXT_AWARENESS — user command may request different output language')
      }

      reply.send({
        success: true,
        transcript: adjustedTranscript,
      })
    } catch (error: any) {
      fastify.log.error({ err: error }, 'Failed to adjust transcript')
      reply.code(500).send({
        success: false,
        error: error?.message || 'Failed to adjust transcript',
      })
    }
  })
}
