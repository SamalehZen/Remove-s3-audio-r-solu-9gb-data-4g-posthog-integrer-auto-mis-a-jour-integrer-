import { ItoMode } from '@/app/generated/ito_pb'
import { getPillWindow, mainWindow } from './app'
import {
  IPC_EVENTS,
  RecordingStatePayload,
  ProcessingStatePayload,
} from '../types/ipc'
import { getActiveWindowWithIcon } from '../media/active-application'
import type { ActiveWindowWithIcon } from '../media/active-application'
import { getBrowserUrl } from '../media/browser-url'
import { fetchFavicon } from './faviconFetcher'
import { faviconCache } from './faviconCache'
import { activeWindowMonitor } from './ActiveWindowMonitor'
import { cleanupAppDisplayName } from './installedAppsHelper'

const DETECTION_TIMEOUT_MS = 800
const BROWSER_URL_TIMEOUT_MS = 500
const WEBSITE_ICON_WAIT_MS = 120

const KNOWN_BROWSERS = new Set([
  'google chrome',
  'chrome',
  'chromium',
  'firefox',
  'mozilla firefox',
  'safari',
  'microsoft edge',
  'edge',
  'brave',
  'brave browser',
  'opera',
  'opera gx',
  'vivaldi',
  'arc',
  'zen',
  'orion',
  'waterfox',
  'thorium',
])

const BROWSER_HOME_DOMAINS = new Set([
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'start.duckduckgo.com',
  'search.yahoo.com',
  'startpage.com',
])

const BLOCKED_APPS = new Set([
  'electron',
  'ito',
  'ito-dev',
  'explorer',
  'finder',
  'desktop',
  'shell',
])

type ResolvedAppTarget = {
  name: string
  iconBase64: string | null
  websiteDomain: string | null
}

export class RecordingStateNotifier {
  private generation = 0
  private isCurrentlyRecording = false
  private windowChangeHandler: ((window: any) => void) | null = null
  private browserUrlChangeHandler: ((domain: string | null) => void) | null =
    null
  private lastSentAppName: string | null = null
  private lastSentAppIcon: string | null = null
  private currentCustomModeName: string | null = null
  private currentCustomModeIcon: string | null = null
  private currentMode: ItoMode | null = null
  private currentWebsiteDomain: string | null = null

  constructor() {
    activeWindowMonitor.on('browser-url-changed', () => {
      const cached = activeWindowMonitor.getCachedState()
      const domain = cached?.browserInfo?.domain
      if (!domain || this.isBrowserHomeDomain(domain)) return
      void this.prefetchFavicon(this.normalizeDomain(domain))
    })
  }

  public setCustomMode(
    name: string | null,
    icon: string | null,
  ): void {
    this.currentCustomModeName = name
    this.currentCustomModeIcon = icon
  }

  public notifyRecordingStarted(
    mode: ItoMode,
    contextSource?: 'screen' | 'selection' | null,
    screenThumbnailBase64?: string | null,
  ) {
    const gen = ++this.generation
    const isNewRecording = !this.isCurrentlyRecording
    this.isCurrentlyRecording = true
    this.currentMode = mode

    if (isNewRecording) {
      void this.emitNewRecording(gen, mode, contextSource, screenThumbnailBase64)
    } else {
      this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
        isRecording: true,
        mode,
        contextSource: contextSource ?? undefined,
        screenThumbnailBase64: screenThumbnailBase64 ?? undefined,
        customModeName: this.currentCustomModeName ?? undefined,
        customModeIcon: this.currentCustomModeIcon ?? undefined,
      })
    }
  }

  private async emitNewRecording(
    gen: number,
    mode: ItoMode,
    contextSource?: 'screen' | 'selection' | null,
    screenThumbnailBase64?: string | null,
  ) {
    const cached = activeWindowMonitor.getCachedState()
    let immediateTarget: ResolvedAppTarget | null = null

    if (cached?.window?.appName) {
      const lowerName = cached.window.appName.toLowerCase()
      if (!BLOCKED_APPS.has(lowerName)) {
        const windowIsBrowser = this.isBrowserApp(cached.window.appName)
        const domain = cached.browserInfo?.domain
        const isRealDomain =
          !!domain && windowIsBrowser && !this.isBrowserHomeDomain(domain)

        if (isRealDomain) {
          const normalizedDomain = this.normalizeDomain(domain)
          this.currentWebsiteDomain = normalizedDomain
          void this.prefetchFavicon(normalizedDomain)

          immediateTarget = {
            name: normalizedDomain,
            iconBase64: await faviconCache.waitForPending(
              normalizedDomain,
              WEBSITE_ICON_WAIT_MS,
            ),
            websiteDomain: normalizedDomain,
          }
        } else {
          let immediateIcon = cached.iconBase64 ?? null
          this.currentWebsiteDomain = null

          if (!immediateIcon) {
            const cacheKey = activeWindowMonitor.getIconCacheKeyForWindow(
              cached.window,
            )
            immediateIcon = activeWindowMonitor.getCachedIcon(cacheKey)
          }

          immediateTarget = {
            name: cleanupAppDisplayName(cached.window.appName),
            iconBase64: immediateIcon,
            websiteDomain: null,
          }
        }
      }
    }

    this.updateLastSentTarget(immediateTarget)
    this.setupWindowChangeListener(gen, mode)

    this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
      isRecording: true,
      mode,
      appTargetName: immediateTarget ? immediateTarget.name : undefined,
      appTargetIconBase64: immediateTarget
        ? immediateTarget.iconBase64
        : undefined,
      contextSource: contextSource ?? undefined,
      screenThumbnailBase64: screenThumbnailBase64 ?? undefined,
      customModeName: this.currentCustomModeName ?? undefined,
      customModeIcon: this.currentCustomModeIcon ?? undefined,
    })

    const isBrowser =
      !!cached?.window?.appName && this.isBrowserApp(cached.window.appName)
    if (isBrowser) {
      this.resolveAppTargetWithIcon()
        .then(result => {
          if (gen !== this.generation || !result || this.isSameTarget(result)) {
            return
          }

          this.updateLastSentTarget(result)
          this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
            isRecording: true,
            mode,
            appTargetName: result.name,
            appTargetIconBase64: result.iconBase64,
            customModeName: this.currentCustomModeName ?? undefined,
            customModeIcon: this.currentCustomModeIcon ?? undefined,
          })
        })
        .catch(() => {})
    }
  }

  public notifyRecordingStopped() {
    ++this.generation
    this.isCurrentlyRecording = false
    this.lastSentAppName = null
    this.lastSentAppIcon = null
    this.currentWebsiteDomain = null
    this.currentCustomModeName = null
    this.currentCustomModeIcon = null
    this.currentMode = null
    this.teardownWindowChangeListener()
    this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
      isRecording: false,
    })
  }

  public notifyProcessingStarted(isAgent?: boolean) {
    this.sendToWindows(IPC_EVENTS.PROCESSING_STATE_UPDATE, {
      isProcessing: true,
      isAgent,
    })
  }

  public notifyProcessingStopped() {
    this.sendToWindows(IPC_EVENTS.PROCESSING_STATE_UPDATE, {
      isProcessing: false,
    })
  }

  private setupWindowChangeListener(gen: number, mode: ItoMode): void {
    this.teardownWindowChangeListener()

    this.windowChangeHandler = async () => {
      if (gen !== this.generation) {
        this.teardownWindowChangeListener()
        return
      }

      const preState = activeWindowMonitor.getCachedState()
      const isBrowserSwitch =
        !!preState?.window?.appName &&
        this.isBrowserApp(preState.window.appName)

      if (isBrowserSwitch) {
        await activeWindowMonitor.waitForBrowserUrl(300)
      } else {
        await new Promise(r => setTimeout(r, 150))
      }

      if (gen !== this.generation) return

      const result = await this.resolveAppTargetWithIcon()
      if (gen !== this.generation || !result || this.isSameTarget(result)) return

      this.updateLastSentTarget(result)
      this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
        isRecording: true,
        mode,
        appTargetName: result.name,
        appTargetIconBase64: result.iconBase64,
        customModeName: this.currentCustomModeName ?? undefined,
        customModeIcon: this.currentCustomModeIcon ?? undefined,
      })
    }

    activeWindowMonitor.on('window-changed', this.windowChangeHandler)

    this.browserUrlChangeHandler = async () => {
      if (gen !== this.generation) return

      const result = await this.resolveAppTargetWithIcon()
      if (gen !== this.generation || !result || this.isSameTarget(result)) return

      this.updateLastSentTarget(result)
      this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
        isRecording: true,
        mode,
        appTargetName: result.name,
        appTargetIconBase64: result.iconBase64,
        customModeName: this.currentCustomModeName ?? undefined,
        customModeIcon: this.currentCustomModeIcon ?? undefined,
      })
    }

    activeWindowMonitor.on('browser-url-changed', this.browserUrlChangeHandler)
  }

  private teardownWindowChangeListener(): void {
    if (this.windowChangeHandler) {
      activeWindowMonitor.off('window-changed', this.windowChangeHandler)
      this.windowChangeHandler = null
    }
    if (this.browserUrlChangeHandler) {
      activeWindowMonitor.off(
        'browser-url-changed',
        this.browserUrlChangeHandler,
      )
      this.browserUrlChangeHandler = null
    }
  }

  private normalizeDomain(domain: string): string {
    return domain.toLowerCase().replace(/^www\./, '')
  }

  private isBrowserApp(appName: string): boolean {
    return KNOWN_BROWSERS.has(appName.toLowerCase())
  }

  private isBrowserHomeDomain(domain: string): boolean {
    return BROWSER_HOME_DOMAINS.has(this.normalizeDomain(domain))
  }

  private isSameTarget(target: ResolvedAppTarget): boolean {
    return (
      target.name === this.lastSentAppName &&
      target.iconBase64 === this.lastSentAppIcon
    )
  }

  private updateLastSentTarget(target: ResolvedAppTarget | null): void {
    this.lastSentAppName = target?.name ?? null
    this.lastSentAppIcon = target?.iconBase64 ?? null
    this.currentWebsiteDomain = target?.websiteDomain ?? null
  }

  private async prefetchFavicon(domain: string): Promise<string | null> {
    const favicon = await faviconCache.prefetch(domain, () =>
      fetchFavicon(domain),
    )

    if (
      favicon &&
      this.isCurrentlyRecording &&
      this.currentMode !== null &&
      this.lastSentAppName === domain &&
      this.lastSentAppIcon !== favicon
    ) {
      this.lastSentAppIcon = favicon
      this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
        isRecording: true,
        mode: this.currentMode,
        appTargetName: domain,
        appTargetIconBase64: favicon,
        customModeName: this.currentCustomModeName ?? undefined,
        customModeIcon: this.currentCustomModeIcon ?? undefined,
      })
    }

    return favicon
  }

  private async resolveAppTargetWithIcon(): Promise<ResolvedAppTarget | null> {
    let window: ActiveWindowWithIcon | null = null

    const cached = activeWindowMonitor.getCachedState()

    if (cached?.window) {
      let icon = cached.iconBase64 ?? null

      if (!icon) {
        const daemonIcon = await activeWindowMonitor.requestIcon()
        icon = daemonIcon ?? null

        if (icon && cached.window) {
          const currentCached = activeWindowMonitor.getCachedState()
          if (currentCached?.window?.windowId === cached.window.windowId) {
            activeWindowMonitor.storeIcon(cached.window, icon)
          }
        }
      }

      window = {
        ...cached.window,
        iconBase64: icon,
      }
    } else {
      const windowPromise = getActiveWindowWithIcon()
      const windowTimeout = new Promise<null>(resolve =>
        setTimeout(() => resolve(null), DETECTION_TIMEOUT_MS),
      )
      window = await Promise.race([windowPromise, windowTimeout])
    }

    if (!window?.appName) return null

    const lowerName = window.appName.toLowerCase()
    if (BLOCKED_APPS.has(lowerName)) {
      return null
    }

    let browserInfo: {
      url: string | null
      domain: string | null
      browser: string | null
    }

    const cachedForUrl = activeWindowMonitor.getCachedState()
    if (
      cachedForUrl?.browserInfo &&
      Date.now() - cachedForUrl.timestamp < 2000
    ) {
      browserInfo = cachedForUrl.browserInfo
    } else {
      const browserInfoPromise = getBrowserUrl(window)
      const browserUrlTimeout = new Promise<{
        url: null
        domain: null
        browser: null
      }>(resolve =>
        setTimeout(
          () => resolve({ url: null, domain: null, browser: null }),
          BROWSER_URL_TIMEOUT_MS,
        ),
      )
      browserInfo = await Promise.race([browserInfoPromise, browserUrlTimeout])
    }

    const isBrowser = this.isBrowserApp(window.appName)
    const hasDomain = !!browserInfo.domain
    const isRealWebsite =
      hasDomain && !this.isBrowserHomeDomain(browserInfo.domain!)

    if (isBrowser && isRealWebsite) {
      return this.resolveDomainTarget(browserInfo.domain!)
    }

    if (isBrowser && !hasDomain && this.currentWebsiteDomain) {
      return {
        name: this.currentWebsiteDomain,
        iconBase64:
          (this.lastSentAppName === this.currentWebsiteDomain
            ? this.lastSentAppIcon
            : null) ??
          (await faviconCache.waitForPending(
            this.currentWebsiteDomain,
            WEBSITE_ICON_WAIT_MS,
          )),
        websiteDomain: this.currentWebsiteDomain,
      }
    }

    return {
      name: cleanupAppDisplayName(window.appName),
      iconBase64: window.iconBase64 || null,
      websiteDomain: null,
    }
  }

  private async resolveDomainTarget(rawDomain: string): Promise<ResolvedAppTarget> {
    const domain = this.normalizeDomain(rawDomain)

    const cachedFavicon = await faviconCache.get(domain)
    if (cachedFavicon) {
      return {
        name: domain,
        iconBase64: cachedFavicon,
        websiteDomain: domain,
      }
    }

    void this.prefetchFavicon(domain)

    return {
      name: domain,
      iconBase64: this.lastSentAppName === domain ? this.lastSentAppIcon : null,
      websiteDomain: domain,
    }
  }

  private sendToWindows(
    event: string,
    payload: RecordingStatePayload | ProcessingStatePayload,
  ) {
    getPillWindow()?.webContents.send(event, payload)

    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed()
    ) {
      mainWindow.webContents.send(event, payload)
    }
  }
}

export const recordingStateNotifier = new RecordingStateNotifier()
