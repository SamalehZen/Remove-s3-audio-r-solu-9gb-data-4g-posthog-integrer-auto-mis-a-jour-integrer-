import { agentGenerate } from './agentLlmClient'
import {
  buildDecisionSystemPrompt,
  buildFinalResponseSystemPrompt,
  buildToolArgsSystemPrompt,
  buildUserPrompt,
} from './agent.prompt'
import type { BaseTool } from './tools/base.tool'
import { parseDecisionResponse, parseFinalResponse } from './types'
import type {
  AgentMessage,
  AgentRunResult,
  AgentRunOptions,
  ToolExecution,
  DecisionResponse,
  FinalResponse,
} from './types'

const MAX_ITERATIONS = 16
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 500
const MAX_HISTORY_MESSAGES = 20

function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

async function callLlmWithRetry<T>(
  parse: (text: string) => T,
  input: { system: string; prompt: string },
  label: string,
): Promise<T> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.info(`[Agent] LLM call "${label}" attempt ${attempt + 1}/${MAX_RETRIES}...`)
      const startMs = Date.now()
      const text = await agentGenerate(input)
      const elapsed = Date.now() - startMs
      console.info(`[Agent] LLM call "${label}" returned in ${elapsed}ms (${text.length} chars)`)

      const cleaned = stripCodeFences(text)
      const result = parse(cleaned)
      console.info(`[Agent] LLM call "${label}" parsed successfully`)
      return result
    } catch (error) {
      lastError = error as Error
      console.warn(
        `[Agent] LLM call "${label}" attempt ${attempt + 1}/${MAX_RETRIES} failed: ${(error as Error).message}`,
      )
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAY_MS * (attempt + 1)
        console.info(`[Agent] Retrying "${label}" in ${delay}ms...`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  console.error(`[Agent] LLM call "${label}" exhausted all ${MAX_RETRIES} retries`)
  throw lastError || new Error(`LLM call "${label}" failed after retries`)
}

export class Agent {
  private history: AgentMessage[] = []
  private tools: BaseTool[]
  private toolRecord: Record<string, BaseTool> = {}

  constructor(tools: BaseTool[] = []) {
    this.tools = tools
    for (const tool of tools) {
      this.toolRecord[tool.name] = tool
    }
    console.info(`[Agent] Initialized with ${tools.length} tools: [${tools.map((t) => t.name).join(', ')}]`)
  }

  getHistory(): AgentMessage[] {
    return [...this.history]
  }

  clearHistory(): void {
    this.history = []
    console.info('[Agent] History cleared')
  }

  async run(userInput: string, options?: AgentRunOptions): Promise<AgentRunResult> {
    const runStartMs = Date.now()
    console.info(`[Agent] ══════ RUN START ══════`)
    console.info(`[Agent] Input: "${userInput.slice(0, 100)}${userInput.length > 100 ? '...' : ''}" (${userInput.length} chars)`)
    console.info(`[Agent] History: ${this.history.length} messages`)

    this.history.push({ type: 'user', content: userInput })

    if (this.history.length > MAX_HISTORY_MESSAGES) {
      const trimmed = this.history.length - MAX_HISTORY_MESSAGES
      this.history = this.history.slice(-MAX_HISTORY_MESSAGES)
      console.info(`[Agent] History trimmed: removed ${trimmed} oldest messages, keeping ${MAX_HISTORY_MESSAGES}`)
    }

    const toolExecutions: ToolExecution[] = []
    const decisionSystemPrompt = buildDecisionSystemPrompt(this.tools)

    const buildCurrentPrompt = (): string => {
      if (toolExecutions.length === 0) return userInput

      const toolsSummary = toolExecutions
        .map(
          (t) =>
            `- ${t.name} [${t.didSucceed ? 'SUCCESS' : 'FAILED'}]: ${JSON.stringify(t.output)}`,
        )
        .join('\n')

      return `${userInput}\n\n## Tools Already Called\n${toolsSummary}\n\nIMPORTANT: If a tool succeeded, the task for that tool is COMPLETE. Do NOT call the same tool again. Choose "respond" to finish.`
    }

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const iterStartMs = Date.now()
        console.info(`[Agent] ── Iteration ${iteration}/${MAX_ITERATIONS} ──`)

        const userPrompt = buildUserPrompt(this.history, buildCurrentPrompt())
        console.info(`[Agent] Decision prompt length: ${userPrompt.length} chars`)

        const decision = await callLlmWithRetry<DecisionResponse>(
          (text) => parseDecisionResponse(text),
          { system: decisionSystemPrompt, prompt: userPrompt },
          `decision-iter-${iteration}`,
        )

        console.info(
          `[Agent] Decision: choice="${decision.choice}", reasoning="${decision.reasoning.slice(0, 120)}"`,
        )

        const lastTool = toolExecutions.at(-1)
        const isLooping = lastTool?.didSucceed && lastTool.name === decision.choice

        if (isLooping) {
          console.warn(`[Agent] Loop detected: "${decision.choice}" already succeeded, forcing respond`)
        }

        if (decision.choice === 'respond' || isLooping) {
          const reasoning = isLooping
            ? `Task complete — ${lastTool?.name} succeeded`
            : decision.reasoning

          console.info('[Agent] Generating final response...')
          const response = await this.callFinalResponseLLM(userPrompt, reasoning)
          console.info(`[Agent] Final response: ${response.length} chars`)

          this.history.push({
            type: 'assistant',
            tools: toolExecutions,
            response,
            isError: false,
          })

          const totalMs = Date.now() - runStartMs
          console.info(
            `[Agent] ══════ RUN COMPLETE (${totalMs}ms, ${iteration + 1} iterations, ${toolExecutions.length} tools) ══════`,
          )
          return { response, history: this.getHistory(), isError: false }
        }

        const tool = this.toolRecord[decision.choice]
        if (!tool) {
          console.error(`[Agent] Tool not found: "${decision.choice}". Available: [${Object.keys(this.toolRecord).join(', ')}]`)
          throw new Error(`Tool not found: ${decision.choice}`)
        }

        let toolArgs: Record<string, unknown> = {}
        if (tool.parameters) {
          console.info(`[Agent] Generating args for tool "${tool.name}"...`)
          toolArgs = await this.callToolArgsLLM(tool, userPrompt, decision.reasoning)
          console.info(`[Agent] Tool args: ${JSON.stringify(toolArgs).slice(0, 200)}`)
        }

        console.info(`[Agent] Executing tool "${tool.name}"...`)
        const toolStartMs = Date.now()
        const toolResult = await tool.execute(toolArgs)
        const toolElapsed = Date.now() - toolStartMs

        const execution: ToolExecution = {
          name: tool.name,
          displayName: tool.displayName,
          input: toolArgs,
          output: toolResult.output,
          didSucceed: toolResult.success,
        }
        toolExecutions.push(execution)
        options?.onToolExecuted?.(execution)

        console.info(
          `[Agent] Tool "${tool.name}" ${toolResult.success ? 'SUCCESS' : 'FAILED'} in ${toolElapsed}ms — output: ${JSON.stringify(toolResult.output).slice(0, 200)}`,
        )

        const iterElapsed = Date.now() - iterStartMs
        console.info(`[Agent] ── Iteration ${iteration} done (${iterElapsed}ms) ──`)

        const stopTool = this.toolRecord['stop'] as any
        if (stopTool?.getShouldStop?.()) {
          console.info('[Agent] Stop tool signaled — ending run')
          const hasWritten = toolExecutions.some(
            (t) => t.name === 'write_to_text_field' && t.didSucceed,
          )
          const response = hasWritten ? 'Done!' : ''
          this.history.push({
            type: 'assistant',
            tools: toolExecutions,
            response,
            isError: false,
          })

          const totalMs = Date.now() - runStartMs
          console.info(`[Agent] ══════ RUN STOPPED (${totalMs}ms, wrote=${hasWritten}) ══════`)
          return { response, history: this.getHistory(), isError: false }
        }
      }

      console.error(`[Agent] Maximum iterations (${MAX_ITERATIONS}) reached`)
      throw new Error('Maximum iterations reached without completing the task.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'An unexpected error occurred.'
      const totalMs = Date.now() - runStartMs
      console.error(`[Agent] ══════ RUN ERROR (${totalMs}ms): ${message} ══════`)
      this.history.push({
        type: 'assistant',
        tools: toolExecutions,
        response: message,
        isError: true,
      })
      return { response: message, history: this.getHistory(), isError: true }
    }
  }

  private async callFinalResponseLLM(prompt: string, reasoning: string): Promise<string> {
    const system = buildFinalResponseSystemPrompt(reasoning)
    const result = await callLlmWithRetry<FinalResponse>(
      (text) => parseFinalResponse(text),
      { system, prompt },
      'final-response',
    )
    return result.response
  }

  private async callToolArgsLLM(
    tool: BaseTool,
    prompt: string,
    reasoning: string,
  ): Promise<Record<string, unknown>> {
    const system = buildToolArgsSystemPrompt(tool, reasoning)
    return callLlmWithRetry<Record<string, unknown>>(
      (text) => JSON.parse(text),
      { system, prompt },
      `tool-args-${tool.name}`,
    )
  }
}
