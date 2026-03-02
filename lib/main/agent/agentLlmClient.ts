import { itoHttpClient } from '../../clients/itoHttpClient'
import { getAdvancedSettings } from '../store'
import { DEFAULT_ADVANCED_SETTINGS } from '../../constants/generated-defaults'

const AGENT_REQUEST_TIMEOUT_MS = 45_000
const AGENT_MAX_RETRIES = 0

const VALID_PROVIDERS = ['gemini', 'groq', 'cerebras'] as const
type ValidProvider = (typeof VALID_PROVIDERS)[number]

function isValidProvider(value: unknown): value is ValidProvider {
  return typeof value === 'string' && VALID_PROVIDERS.includes(value as ValidProvider)
}

export interface AgentLlmInput {
  system: string
  prompt: string
}

export async function agentGenerate(input: AgentLlmInput): Promise<string> {
  const startTime = Date.now()
  console.info('[AgentLLM] ── agentGenerate START ──')

  const { llm } = getAdvancedSettings()
  console.info(
    `[AgentLLM] Raw settings: llmProvider=${JSON.stringify(llm?.llmProvider)}, llmModel=${JSON.stringify(llm?.llmModel)}`,
  )

  let llmProvider: string
  if (!llm?.llmProvider || llm.llmProvider === 'null' || !isValidProvider(llm.llmProvider)) {
    console.warn(
      `[AgentLLM] Invalid/null llmProvider="${llm?.llmProvider}", falling back to default="${DEFAULT_ADVANCED_SETTINGS.llmProvider}"`,
    )
    llmProvider = DEFAULT_ADVANCED_SETTINGS.llmProvider
  } else {
    llmProvider = llm.llmProvider
  }

  let llmModel: string
  if (!llm?.llmModel || llm.llmModel === 'null') {
    console.warn(
      `[AgentLLM] Invalid/null llmModel="${llm?.llmModel}", falling back to default="${DEFAULT_ADVANCED_SETTINGS.llmModel}"`,
    )
    llmModel = DEFAULT_ADVANCED_SETTINGS.llmModel
  } else {
    llmModel = llm.llmModel
  }

  console.info(
    `[AgentLLM] Resolved: provider="${llmProvider}", model="${llmModel}"`,
  )
  console.info(
    `[AgentLLM] Prompt length: system=${input.system.length} chars, user=${input.prompt.length} chars`,
  )

  const response = await itoHttpClient.post(
    '/agent/generate',
    {
      system: input.system,
      prompt: input.prompt,
      jsonResponse: {
        name: 'agent_response',
        description: 'Agent structured response',
        schema: {},
      },
      llmSettings: {
        llmProvider,
        llmModel,
        llmTemperature: 0.3,
      },
    },
    {
      requireAuth: true,
      timeoutMs: AGENT_REQUEST_TIMEOUT_MS,
      retries: AGENT_MAX_RETRIES,
    },
  )

  const elapsed = Date.now() - startTime
  console.info(`[AgentLLM] Server responded in ${elapsed}ms`)

  if (response?.isTimeout) {
    console.error(`[AgentLLM] Server timeout after ${elapsed}ms`)
    throw new Error(
      `Agent server did not respond within ${AGENT_REQUEST_TIMEOUT_MS / 1000}s. Check your network connection.`,
    )
  }

  if (!response?.success) {
    const errorMsg = response?.error || 'Agent LLM call failed'
    const status = response?.status
    console.error(`[AgentLLM] Server error (status=${status}): ${errorMsg}`)

    if (status === 401) {
      throw new Error('Authentication failed. Please sign in again.')
    }
    if (status === 503 || status === 502) {
      throw new Error('Agent server is temporarily unavailable. Please try again later.')
    }
    throw new Error(errorMsg)
  }

  if (!response.text || typeof response.text !== 'string') {
    console.error('[AgentLLM] Invalid response shape:', JSON.stringify(response).slice(0, 300))
    throw new Error('Agent LLM returned empty or invalid text')
  }

  console.info(`[AgentLLM] ── agentGenerate OK (${response.text.length} chars, ${elapsed}ms) ──`)
  return response.text
}
