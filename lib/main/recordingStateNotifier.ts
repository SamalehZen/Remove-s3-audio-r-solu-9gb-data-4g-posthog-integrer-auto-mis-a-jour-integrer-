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
import { persistentContextDetector } from './context/PersistentContextDetector'
import { AppTargetTable } from './sqlite/appTargetRepo'
import { getCurrentUserId } from './store'
import { normalizeAppTargetId } from '../utils/appTargetUtils'
import { fetchFavicon } from './faviconFetcher'
import { activeWindowMonitor } from './ActiveWindowMonitor'

const DEFAULT_LOCAL_USER_ID = 'local-user'
const DETECTION_TIMEOUT_MS = 800

const BROWSER_URL_TIMEOUT_MS = 500

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

export class RecordingStateNotifier {
  private generation = 0
  private isCurrentlyRecording = false
  private windowChangeHandler: ((window: any) => void) | null = null
  private lastSentAppName: string | null = null
  private lastSentAppIcon: string | null = null
  private static readonly MAX_FAVICON_CACHE_SIZE = 50
  private faviconCache = new Map<string, string>()

  private setFaviconCache(domain: string, icon: string): void {
    this.faviconCache.delete(domain)
    this.faviconCache.set(domain, icon)
    if (
      this.faviconCache.size > RecordingStateNotifier.MAX_FAVICON_CACHE_SIZE
    ) {
      const oldestEntry = this.faviconCache.keys().next()
      if (!oldestEntry.done) {
        this.faviconCache.delete(oldestEntry.value)
      }
    }
  }

  private getCachedFavicon(domain: string): string | null {
    const icon = this.faviconCache.get(domain)
    if (icon) {
      this.faviconCache.delete(domain)
      this.faviconCache.set(domain, icon)
      return icon
    }
    return null
  }

  public notifyRecordingStarted(
    mode: ItoMode,
    contextSource?: 'screen' | 'selection' | null,
    screenThumbnailBase64?: string | null,
  ) {
    const gen = ++this.generation
    const isNewRecording = !this.isCurrentlyRecording
    this.isCurrentlyRecording = true

    if (isNewRecording) {
      this.emitNewRecording(gen, mode, contextSource, screenThumbnailBase64)
    } else {
      this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
        isRecording: true,
        mode,
        contextSource: contextSource ?? undefined,
        screenThumbnailBase64: screenThumbnailBase64 ?? undefined,
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
    let immediateName: string | null = null
    let immediateIcon: string | null = null

    if (cached?.window?.appName) {
      const lowerName = cached.window.appName.toLowerCase()
      if (!BLOCKED_APPS.has(lowerName)) {
        immediateName = cached.window.appName
        // Use cached icon immediately, don't block for pending fetches
        immediateIcon = cached.iconBase64 ?? null

        // Try to get icon from cache without waiting
        if (!immediateIcon) {
          const cacheKey = activeWindowMonitor.getIconCacheKeyForWindow(
            cached.window,
          )
          immediateIcon = activeWindowMonitor.getCachedIcon(cacheKey)
        }
      }
    }

    this.lastSentAppName = immediateName
    this.lastSentAppIcon = immediateIcon
    this.setupWindowChangeListener(gen, mode)

    // Send recording state immediately - don't wait for browser URL resolution
    this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
      isRecording: true,
      mode,
      appTargetName: immediateName,
      appTargetIconBase64: immediateIcon,
      contextSource: contextSource ?? undefined,
      screenThumbnailBase64: screenThumbnailBase64 ?? undefined,
    })

    // For browsers: resolve domain name and favicon asynchronously
    // This avoids blocking the recording start while fetching the URL
    const isBrowser = !!immediateName && this.isBrowserApp(immediateName)
    if (isBrowser) {
      // Fire-and-forget URL resolution - will send update when ready
      this.resolveAppTargetWithIcon()
        .then(result => {
          if (gen !== this.generation) return
          if (!result) return
          const resolvedIcon = result.iconBase64 ?? null
          if (
            result.name === this.lastSentAppName &&
            resolvedIcon === this.lastSentAppIcon
          )
            return
          this.lastSentAppName = result.name
          this.lastSentAppIcon = resolvedIcon
          this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
            isRecording: true,
            mode,
            appTargetName: result.name,
            appTargetIconBase64: resolvedIcon,
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
      if (gen !== this.generation) return
      if (!result) return

      const resolvedIcon = result.iconBase64 ?? null
      if (
        result.name === this.lastSentAppName &&
        resolvedIcon === this.lastSentAppIcon
      )
        return

      this.lastSentAppName = result.name
      this.lastSentAppIcon = resolvedIcon
      this.sendToWindows(IPC_EVENTS.RECORDING_STATE_UPDATE, {
        isRecording: true,
        mode,
        appTargetName: result.name,
        appTargetIconBase64: resolvedIcon,
      })
    }

    activeWindowMonitor.on('window-changed', this.windowChangeHandler)
  }

  private teardownWindowChangeListener(): void {
    if (this.windowChangeHandler) {
      activeWindowMonitor.off('window-changed', this.windowChangeHandler)
      this.windowChangeHandler = null
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

  private async resolveAppTargetWithIcon(): Promise<{
    name: string
    iconBase64: string | null
  } | null> {
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
      return this.resolveDomainTarget(browserInfo.domain!, window)
    }

    const resolved = await persistentContextDetector.resolveForWindow(
      window,
      browserInfo.domain,
    )

    if (resolved.target) {
      return {
        name: resolved.target.name,
        iconBase64: window.iconBase64 || resolved.target.iconBase64,
      }
    }

    this.autoRegisterApp(window, browserInfo.domain).catch(err => {
      console.warn('[RecordingStateNotifier] Auto-register failed:', err)
    })

    return {
      name: window.appName,
      iconBase64: window.iconBase64 || null,
    }
  }

  private async resolveDomainTarget(
    rawDomain: string,
    window: {
      appName: string
      iconBase64?: string | null
      bundleId?: string | null
      exePath?: string | null
    },
  ): Promise<{ name: string; iconBase64: string | null }> {
    const userId = getCurrentUserId() || DEFAULT_LOCAL_USER_ID
    const domain = this.normalizeDomain(rawDomain)

    const existingTarget = await AppTargetTable.findByDomain(domain, userId)

    if (existingTarget) {
      if (existingTarget.iconBase64) {
        return {
          name: existingTarget.name,
          iconBase64: existingTarget.iconBase64,
        }
      }

      const cachedFavicon = this.getCachedFavicon(domain)
      if (cachedFavicon) {
        return {
          name: existingTarget.name,
          iconBase64: cachedFavicon,
        }
      }

      this.fetchAndUpdateFavicon(existingTarget.id, domain).catch(err => {
        console.warn('[RecordingStateNotifier] Favicon re-fetch failed:', err)
      })

      return {
        name: existingTarget.name,
        iconBase64: window.iconBase64 || null,
      }
    }

    this.autoRegisterDomainTarget(domain, window).catch(err => {
      console.warn('[RecordingStateNotifier] Auto-register domain failed:', err)
    })

    return {
      name: domain,
      iconBase64: window.iconBase64 || null,
    }
  }

  private async autoRegisterDomainTarget(
    domain: string,
    window: {
      appName: string
      iconBase64?: string | null
      bundleId?: string | null
      exePath?: string | null
    },
  ): Promise<void> {
    const userId = getCurrentUserId() || DEFAULT_LOCAL_USER_ID
    const appId = normalizeAppTargetId(`domain_${domain}`)

    const existing = await AppTargetTable.findById(appId, userId)
    if (existing) return

    const favicon = await fetchFavicon(domain)
    if (favicon) {
      this.setFaviconCache(domain, favicon)
    }

    await AppTargetTable.upsert({
      id: appId,
      userId,
      name: domain,
      matchType: 'domain',
      domain: domain,
      toneId: null,
      iconBase64: favicon || null,
    })

    await persistentContextDetector.registerSignaturesForTarget(
      appId,
      null,
      null,
      domain,
    )

    console.log(
      `[RecordingStateNotifier] Auto-registered domain: ${domain} (${appId})${favicon ? ' with favicon' : ' without favicon'}`,
    )
  }

  private async fetchAndUpdateFavicon(
    targetId: string,
    domain: string,
  ): Promise<void> {
    const favicon = await fetchFavicon(domain)
    if (!favicon) return

    this.setFaviconCache(domain, favicon)

    const userId = getCurrentUserId() || DEFAULT_LOCAL_USER_ID
    const target = await AppTargetTable.findById(targetId, userId)
    if (!target) return

    await AppTargetTable.upsert({
      id: target.id,
      userId: target.userId,
      name: target.name,
      matchType: target.matchType,
      domain: target.domain,
      toneId: target.toneId,
      iconBase64: favicon,
    })

    console.log(
      `[RecordingStateNotifier] Updated favicon for domain: ${domain}`,
    )
  }

  private async autoRegisterApp(
    window: {
      appName: string
      iconBase64?: string | null
      bundleId?: string | null
      exePath?: string | null
    },
    browserDomain: string | null,
  ): Promise<void> {
    const userId = getCurrentUserId() || DEFAULT_LOCAL_USER_ID
    const appId = normalizeAppTargetId(window.appName)

    const existing = await AppTargetTable.findById(appId, userId)
    if (existing) return

    await AppTargetTable.upsert({
      id: appId,
      userId,
      name: window.appName,
      matchType: 'app',
      domain: browserDomain,
      toneId: null,
      iconBase64: window.iconBase64 || null,
    })

    await persistentContextDetector.registerSignaturesForTarget(
      appId,
      window.bundleId || null,
      window.exePath || null,
      browserDomain,
    )

    console.log(
      `[RecordingStateNotifier] Auto-registered app: ${window.appName} (${appId})`,
    )
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
