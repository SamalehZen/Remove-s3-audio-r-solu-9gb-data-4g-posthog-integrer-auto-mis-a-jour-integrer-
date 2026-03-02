import type { ToolResult } from '../types'
import { macOSAccessibilityContextProvider } from '../../../media/macOSAccessibilityContextProvider'
import { getActiveWindow } from '../../../media/active-application'
import { getBrowserUrl } from '../../../media/browser-url'
import { getSelectedTextString, getCursorContext } from '../../../media/selected-text-reader'
import { isTerminalApplication } from '../../../utils/applicationDetection'
import { activeWindowMonitor } from '../../ActiveWindowMonitor'
import { BaseTool } from './base.tool'

const AGENT_CURSOR_CONTEXT_LENGTH = 1000

const BROWSER_APPS = new Set([
  'google chrome', 'chrome', 'firefox', 'mozilla firefox',
  'safari', 'microsoft edge', 'edge', 'opera', 'brave browser',
  'brave', 'vivaldi', 'arc', 'chromium', 'waterfox', 'tor browser',
])

export class GetContextTool extends BaseTool<Record<string, unknown>> {
  readonly name = 'get_context'
  readonly displayName = 'Get Context'
  readonly description =
    'Get the text field content and surrounding screen context. ALWAYS call this first when the user asks you to write, reply, or respond to something — you need to see what they are looking at. Also use it when you need to understand the user\'s current context.'
  readonly parameters = undefined

  protected async execInternal(): Promise<ToolResult> {
    const platform = process.platform
    console.info(`[GetContextTool] Starting context gathering (platform=${platform})`)

    const cached = activeWindowMonitor.getCachedState()
    console.info(
      `[GetContextTool] Cached window state: ${cached ? `app="${cached.window?.appName}", title="${cached.window?.title}"` : 'none'}`,
    )

    let activeWindow = cached?.window || null
    if (!activeWindow) {
      console.info('[GetContextTool] No cached window, fetching active window...')
      try {
        activeWindow = await getActiveWindow()
        console.info(
          `[GetContextTool] Active window: app="${activeWindow?.appName}", title="${activeWindow?.title}"`,
        )
      } catch (e) {
        console.warn('[GetContextTool] getActiveWindow() failed:', e)
        activeWindow = null
      }
    }

    let textContent: string | null = null
    let selectedText: string | null = null

    if (platform === 'darwin') {
      console.info('[GetContextTool] macOS: attempting accessibility context...')
      if (macOSAccessibilityContextProvider.isRunning()) {
        try {
          const result = await macOSAccessibilityContextProvider.getCursorContext({
            maxCharsBefore: 2000,
            maxCharsAfter: 1000,
            timeout: 800,
            debug: false,
          })
          if (result.success && result.context) {
            textContent =
              [result.context.textBefore, result.context.textAfter]
                .filter(Boolean)
                .join('[CURSOR]') || null
            selectedText = result.context.selectedText || null
            console.info(
              `[GetContextTool] macOS accessibility: textContent=${textContent ? textContent.length + ' chars' : 'null'}, selectedText=${selectedText ? selectedText.length + ' chars' : 'null'}`,
            )
          } else {
            console.warn('[GetContextTool] macOS accessibility returned no context')
          }
        } catch (e) {
          console.warn('[GetContextTool] macOS accessibility context failed:', e)
        }
      } else {
        console.warn(
          '[GetContextTool] macOS accessibility provider not running. Ensure accessibility permissions are granted.',
        )
      }
    } else if (platform === 'win32') {
      console.info('[GetContextTool] Windows: accessibility context via selected text fallback')
    } else {
      console.info(`[GetContextTool] Platform "${platform}": no native accessibility, using fallback`)
    }

    if (!textContent && !selectedText) {
      console.info('[GetContextTool] No text from accessibility, trying selected text reader...')
      try {
        selectedText = await getSelectedTextString()
        if (selectedText) {
          console.info(`[GetContextTool] Selected text reader: ${selectedText.length} chars`)
        } else {
          console.info('[GetContextTool] Selected text reader: no text returned')
        }
      } catch (e) {
        console.warn('[GetContextTool] Selected text reader failed:', e)
      }
    }

    if (!textContent && !selectedText) {
      const appName = activeWindow?.appName || ''
      const lowerAppName = appName.toLowerCase()
      const isBrowser = BROWSER_APPS.has(lowerAppName)
      const skipCursorContext = isBrowser || (appName && isTerminalApplication(appName))
      if (skipCursorContext) {
        console.info(`[GetContextTool] Skipping cursor context for ${isBrowser ? 'browser' : 'terminal'} app: ${appName}`)
      } else {
        console.info(`[GetContextTool] No selected text, trying cursor context (${AGENT_CURSOR_CONTEXT_LENGTH} chars)...`)
        try {
          const cursorText = await getCursorContext(AGENT_CURSOR_CONTEXT_LENGTH)
          if (cursorText && cursorText.trim().length > 0) {
            textContent = cursorText.trim()
            console.info(`[GetContextTool] Cursor context: ${textContent.length} chars`)
          } else {
            console.info('[GetContextTool] Cursor context: no text returned')
          }
        } catch (e) {
          console.warn('[GetContextTool] Cursor context failed:', e)
        }
      }
    }

    let browserUrl: string | null = null
    if (cached?.browserInfo?.url) {
      browserUrl = cached.browserInfo.url
      console.info(`[GetContextTool] Browser URL (cached): ${browserUrl}`)
    } else if (activeWindow) {
      console.info('[GetContextTool] Fetching browser URL...')
      try {
        const urlInfo = await getBrowserUrl(activeWindow)
        browserUrl = urlInfo.url
        console.info(`[GetContextTool] Browser URL: ${browserUrl || 'none'}`)
      } catch (e) {
        console.warn('[GetContextTool] Browser URL fetch failed:', e)
      }
    }

    if (!textContent && !selectedText && !activeWindow) {
      const errMsg =
        platform === 'darwin'
          ? 'Could not get context. Accessibility permissions may be required (System Preferences → Privacy & Security → Accessibility).'
          : platform === 'win32'
            ? 'Could not get context. No text field is focused. Try selecting text before using the agent.'
            : 'Could not get context. On Linux, try selecting text before using the agent.'
      console.warn(`[GetContextTool] FAILED: ${errMsg}`)
      return {
        success: false,
        output: { error: errMsg },
      }
    }

    const result = {
      appName: activeWindow?.appName || null,
      windowTitle: activeWindow?.title || null,
      browserUrl,
      textContent,
      selectedText,
    }

    console.info(
      `[GetContextTool] SUCCESS: app="${result.appName}", hasText=${!!textContent}, hasSelection=${!!selectedText}, hasUrl=${!!browserUrl}`,
    )

    return { success: true, output: result }
  }
}
