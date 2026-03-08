import { ItoMode } from '@/app/generated/ito_pb'
import { DictionaryTable } from '../sqlite/repo'
import {
  UserDetailsTable,
  UserAdditionalInfoTable,
} from '../sqlite/userDetailsRepo'
import { type Tone } from '../sqlite/appTargetRepo'
import { getCurrentUserId, getAdvancedSettings, store } from '../store'
import { getActiveWindow } from '../../media/active-application'
import {
  getSelectedTextString,
  getCursorContext,
} from '../../media/selected-text-reader'
import { getBrowserUrl } from '../../media/browser-url'
import { canGetContextFromCurrentApp } from '../../utils/applicationDetection'
import log from 'electron-log'
import { captureScreen, CaptureMode } from '../../media/screenCapture'
import { STORE_KEYS } from '../../constants/store-keys'
import { activeWindowMonitor } from '../ActiveWindowMonitor'

const DEFAULT_LOCAL_USER_ID = 'local-user'
import { timingCollector, TimingEventName } from '../timing/TimingCollector'
import { macOSAccessibilityContextProvider } from '../../media/macOSAccessibilityContextProvider'

export interface ContextData {
  vocabularyWords: string[]
  replacements: { from: string; to: string }[]
  userDetails: {
    fullName: string
    occupation: string
    companyName: string | null
    role: string | null
    email: string | null
    phoneNumber: string | null
    businessAddress: string | null
    website: string | null
    linkedin: string | null
    additionalInfo: { key: string; value: string }[]
  } | null
  windowTitle: string
  appName: string
  contextText: string
  browserUrl: string | null
  browserDomain: string | null
  advancedSettings: ReturnType<typeof getAdvancedSettings>
  tone: Tone | null
  screenCaptureBase64: string | null
  screenThumbnailBase64: string | null
  contextSource: 'screen' | 'selection' | null
}

/**
 * ContextGrabber centralizes all context gathering logic for transcription streams.
 * It collects vocabulary, window info, selected text, and settings.
 */
export class ContextGrabber {
  private customModePrompt: string | null = null

  public setCustomModePrompt(prompt: string | null): void {
    this.customModePrompt = prompt
  }

  /**
   * Gather all context data needed for a transcription stream
   */
  public async gatherContext(mode: ItoMode): Promise<ContextData> {
    console.log('[ContextGrabber] Gathering context for mode:', mode)

    // Get vocabulary words from dictionary
    const { vocabularyWords, replacements } =
      await this.getVocabularyAndReplacements()

    // Get user details
    const userDetails = await this.getUserDetails()

    // Single native binary call for active window
    const activeWindow = await timingCollector.timeAsync(
      TimingEventName.WINDOW_CONTEXT_GATHER,
      async () => {
        const cached = activeWindowMonitor.getCachedState()
        if (cached && (Date.now() - cached.timestamp) < 1500) {
          return cached.window
        }
        try {
          return await getActiveWindow()
        } catch (error) {
          log.error('[ContextGrabber] Error getting active window:', error)
          return null
        }
      },
    )

    // Single browser URL detection — reuses activeWindow
    const { url: browserUrl, domain: browserDomain } =
      await timingCollector.timeAsync(
        TimingEventName.BROWSER_URL_GATHER,
        async () => {
          const cached = activeWindowMonitor.getCachedState()
          if (cached?.browserInfo && (Date.now() - cached.timestamp) < 1500) {
            return cached.browserInfo
          }
          return await getBrowserUrl(activeWindow)
        },
      )

    let contextText = ''
    let screenCaptureBase64: string | null = null
    let screenThumbnailBase64: string | null = null
    let contextSource: 'screen' | 'selection' | null = null

    if (mode === ItoMode.CONTEXT_AWARENESS) {
      contextText = await this.getContextText(ItoMode.EDIT)

      if (contextText && contextText.trim().length > 0) {
        contextSource = 'selection'
        console.log('[ContextGrabber] CONTEXT_AWARENESS using selected text')
      } else {
        const settings = store.get(STORE_KEYS.SETTINGS)
        const captureMode: CaptureMode =
          settings?.contextAwarenessCaptureMode || 'fullscreen'

        const capture = await captureScreen(captureMode)
        if (capture) {
          screenCaptureBase64 = capture.base64
          screenThumbnailBase64 = capture.thumbnailBase64
          contextSource = 'screen'
          console.log(
            `[ContextGrabber] CONTEXT_AWARENESS captured ${captureMode}: ${capture.width}x${capture.height}`,
          )
        }
      }
    } else {
      contextText = await this.getContextText(mode)
    }

    // Get advanced settings
    const advancedSettings = getAdvancedSettings()

    const effectiveTone = this.customModePrompt
      ? {
          id: 'custom-mode-tone',
          userId: null,
          name: 'Custom Mode',
          promptTemplate: this.customModePrompt,
          isSystem: false,
          sortOrder: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        }
      : null

    console.log('[ContextGrabber] App name:', activeWindow?.appName)
    console.log('[ContextGrabber] Active mode prompt:', this.customModePrompt ? 'custom mode' : 'none')
    console.log('[ContextGrabber] Context gathered successfully')

    return {
      vocabularyWords,
      replacements,
      userDetails,
      windowTitle: activeWindow?.title || '',
      appName: activeWindow?.appName || '',
      contextText,
      browserUrl,
      browserDomain,
      advancedSettings,
      tone: effectiveTone,
      screenCaptureBase64,
      screenThumbnailBase64,
      contextSource,
    }
  }

  private async getUserDetails(): Promise<ContextData['userDetails']> {
    try {
      const userId = getCurrentUserId() || DEFAULT_LOCAL_USER_ID
      const details = await UserDetailsTable.findByUserId(userId)
      if (!details || (!details.full_name && !details.occupation)) return null

      const additionalInfo =
        await UserAdditionalInfoTable.findAllByUserId(userId)

      return {
        fullName: details.full_name,
        occupation: details.occupation,
        companyName: details.company_name,
        role: details.role,
        email: details.email,
        phoneNumber: details.phone_number,
        businessAddress: details.business_address,
        website: details.website,
        linkedin: details.linkedin,
        additionalInfo: additionalInfo.map(item => ({
          key: item.info_key,
          value: item.info_value,
        })),
      }
    } catch (error) {
      log.error('[ContextGrabber] Error getting user details:', error)
      return null
    }
  }

  private async getVocabularyAndReplacements(): Promise<{
    vocabularyWords: string[]
    replacements: { from: string; to: string }[]
  }> {
    try {
      const userId = getCurrentUserId() || DEFAULT_LOCAL_USER_ID
      const dictionaryItems = await DictionaryTable.findAll(userId)
      const activeItems = dictionaryItems.filter(
        item => item.deleted_at === null,
      )

      const vocabularyWords: string[] = []
      const replacements: { from: string; to: string }[] = []

      for (const item of activeItems) {
        if (item.pronunciation !== null && item.pronunciation !== '') {
          vocabularyWords.push(item.word)
          vocabularyWords.push(item.pronunciation)
          replacements.push({ from: item.word, to: item.pronunciation })
        } else {
          vocabularyWords.push(item.word)
        }
      }

      return { vocabularyWords, replacements }
    } catch (error) {
      log.error('[ContextGrabber] Error getting vocabulary:', error)
      return { vocabularyWords: [], replacements: [] }
    }
  }

  private async getContextText(mode: ItoMode): Promise<string> {
    if (mode !== ItoMode.EDIT) {
      return ''
    }

    const { macosAccessibilityContextEnabled } = getAdvancedSettings()

    // Try accessibility API first if enabled
    if (
      process.platform === 'darwin' &&
      macosAccessibilityContextEnabled &&
      macOSAccessibilityContextProvider.isRunning()
    ) {
      try {
        const result = await timingCollector.timeAsync(
          TimingEventName.CURSOR_CONTEXT_GATHER,
          async () =>
            await macOSAccessibilityContextProvider.getCursorContext({
              maxCharsBefore: 1000,
              maxCharsAfter: 1000,
              timeout: 500,
              debug: false,
            }),
        )

        if (result.success && result.context?.selectedText) {
          console.log(
            '[ContextGrabber] Got selected text via accessibility API',
          )
          return result.context.selectedText.trim()
        }
      } catch (error) {
        console.log(
          '[ContextGrabber] Accessibility API failed, falling back to keyboard:',
          error,
        )
      }
    }

    // Fallback to keyboard-based method
    console.log('[ContextGrabber] Using keyboard method for selected text')
    try {
      const text = await timingCollector.timeAsync(
        TimingEventName.SELCTED_TEXT_GATHER,
        async () => await getSelectedTextString(),
      )
      console.log('[ContextGrabber] Selected text from keyboard:', text)
      return text && text.trim().length > 0 ? text : ''
    } catch (error) {
      log.error('[ContextGrabber] Error getting context text:', error)
      return ''
    }
  }

  /**
   * Get cursor context for grammar rules (capitalization, spacing, etc.)
   * This fetches a small amount of text before the cursor position.
   *
   * @param contextLength - Number of characters to fetch before cursor (default: 4)
   * @returns The text before the cursor, or empty string if unavailable
   */
  public async getCursorContextForGrammar(
    contextLength: number = 4,
  ): Promise<string> {
    const { macosAccessibilityContextEnabled } = getAdvancedSettings()

    // Try accessibility API first if enabled
    if (
      process.platform === 'darwin' &&
      macosAccessibilityContextEnabled &&
      macOSAccessibilityContextProvider.isRunning()
    ) {
      try {
        const result = await macOSAccessibilityContextProvider.getCursorContext(
          {
            maxCharsBefore: contextLength,
            maxCharsAfter: 0,
            timeout: 500,
            debug: false,
          },
        )

        if (result.success && result.context?.textBefore) {
          console.log(
            '[ContextGrabber] Got cursor context via accessibility API',
          )
          return result.context.textBefore
        }
      } catch (error) {
        console.log(
          '[ContextGrabber] Accessibility API failed, falling back to keyboard:',
          error,
        )
      }
    }

    // Fallback to keyboard-based method
    console.log('[ContextGrabber] Using keyboard method for cursor context')
    try {
      const canGetContext = await canGetContextFromCurrentApp()

      if (!canGetContext) {
        console.log(
          '[ContextGrabber] Cannot get cursor context from current app',
        )
        return ''
      }

      const cursorContext = await getCursorContext(contextLength)
      return cursorContext || ''
    } catch (error) {
      log.error(
        '[ContextGrabber] Error getting cursor context for grammar:',
        error,
      )
      return ''
    }
  }
}

export const contextGrabber = new ContextGrabber()
