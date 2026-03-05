import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { getNativeBinaryPath } from '../media/native-interface'
import type { ActiveWindow } from '../media/active-application'
import { getBrowserUrl, type BrowserUrlInfo } from '../media/browser-url'

const NATIVE_MODULE_NAME = 'active-application'
const HEARTBEAT_CHECK_INTERVAL_MS = 5000
const BROWSER_POLL_INTERVAL_MS = 1000

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
const HEARTBEAT_TIMEOUT_MS = 15000
const MAX_RESTART_ATTEMPTS = 5
const RESTART_BACKOFF_BASE_MS = 1000

interface WindowChangedEvent {
  type: 'window_changed'
  title: string
  appName: string
  windowId: number
  processId: number
  position: { x: number; y: number; width: number; height: number }
  bundleId?: string | null
  exePath?: string | null
  timestamp: string
}

interface IconResponseEvent {
  type: 'icon_response'
  requestId: string
  appName: string | null
  iconBase64: string | null
  error?: string
}

interface HeartbeatEvent {
  type: 'heartbeat_ping'
  id: string
  timestamp: string
}

type DaemonEvent = WindowChangedEvent | IconResponseEvent | HeartbeatEvent

export interface CachedWindowState {
  window: ActiveWindow
  browserInfo: BrowserUrlInfo | null
  iconBase64: string | null
  timestamp: number
}

export class ActiveWindowMonitor extends EventEmitter {
  private process: ChildProcess | null = null
  private cachedState: CachedWindowState | null = null
  private lastHeartbeat = Date.now()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private pendingIconCallbacks = new Map<
    string,
    (icon: string | null) => void
  >()
  private iconRequestCounter = 0
  private isStopped = false
  private restartAttempts = 0
  private pendingBrowserUrlWindow: ActiveWindow | null = null
  private isBrowserUrlFetching = false
  private static readonly MAX_ICON_CACHE_SIZE = 50
  private iconCache = new Map<string, string>()
  private iconFetchInProgress = new Set<string>()
  private browserPollInterval: NodeJS.Timeout | null = null
  private lastPolledDomain: string | null = null

  public start(): void {
    if (this.process) return
    this.isStopped = false
    this.restartAttempts = 0

    const binaryPath = getNativeBinaryPath(NATIVE_MODULE_NAME)
    if (!binaryPath) {
      console.error(
        '[ActiveWindowMonitor] Cannot find active-application binary',
      )
      return
    }

    try {
      this.process = spawn(binaryPath, ['--watch'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          RUST_BACKTRACE: '1',
          OBJC_DISABLE_INITIALIZE_FORK_SAFETY: 'YES',
        },
        detached: true,
      })

      this.process.unref()

      let buffer = ''
      this.process.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.trim()) {
            try {
              const event: DaemonEvent = JSON.parse(line)
              this.handleEvent(event)
            } catch (e) {
              console.error('[ActiveWindowMonitor] Failed to parse:', line, e)
            }
          }
        }
      })

      this.process.stderr?.on('data', (data: Buffer) => {
        console.warn('[ActiveWindowMonitor] stderr:', data.toString())
      })

      this.process.on('error', err => {
        console.error('[ActiveWindowMonitor] Process error:', err)
        this.process = null
      })

      this.process.on('close', (code, signal) => {
        console.warn(
          `[ActiveWindowMonitor] Process closed (code=${code}, signal=${signal})`,
        )
        this.process = null

        if (!this.isStopped && this.restartAttempts < MAX_RESTART_ATTEMPTS) {
          this.restartAttempts++
          const delay =
            RESTART_BACKOFF_BASE_MS * Math.pow(2, this.restartAttempts - 1)
          console.log(
            `[ActiveWindowMonitor] Restarting in ${delay}ms (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})`,
          )
          setTimeout(() => this.start(), delay)
        } else if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
          console.error(
            '[ActiveWindowMonitor] Max restart attempts reached, giving up',
          )
        }
      })

      this.startHeartbeatChecker()
      console.log('[ActiveWindowMonitor] Daemon started')
    } catch (err) {
      console.error('[ActiveWindowMonitor] Failed to spawn:', err)
      this.process = null
    }
  }

  public stop(): void {
    this.isStopped = true
    this.stopBrowserUrlPolling()
    this.stopHeartbeatChecker()
    if (this.process) {
      this.process.kill()
      this.process = null
    }
  }

  public getCachedState(): CachedWindowState | null {
    if (!this.cachedState) return null
    if (!this.process) {
      const age = Date.now() - this.cachedState.timestamp
      if (age > 10000) return null
    }
    return this.cachedState
  }

  public waitForPendingIcon(
    cacheKey: string,
    timeoutMs: number = 150,
  ): Promise<string | null> {
    const existing = this.iconCache.get(cacheKey) ?? null
    if (existing) return Promise.resolve(existing)
    if (!this.iconFetchInProgress.has(cacheKey)) return Promise.resolve(null)

    return new Promise<string | null>(resolve => {
      const start = Date.now()
      const check = () => {
        const icon = this.iconCache.get(cacheKey) ?? null
        if (icon) {
          resolve(icon)
          return
        }
        if (
          !this.iconFetchInProgress.has(cacheKey) ||
          Date.now() - start >= timeoutMs
        ) {
          resolve(null)
          return
        }
        setTimeout(check, 10)
      }
      setTimeout(check, 10)
    })
  }

  private getIconCacheKey(window: ActiveWindow): string {
    return window.bundleId || window.exePath || window.appName
  }

  private setIconCache(key: string, icon: string): void {
    this.iconCache.delete(key)
    this.iconCache.set(key, icon)
    if (this.iconCache.size > ActiveWindowMonitor.MAX_ICON_CACHE_SIZE) {
      const oldestEntry = this.iconCache.keys().next()
      if (!oldestEntry.done) {
        this.iconCache.delete(oldestEntry.value)
      }
    }
  }

  public getCachedIcon(key: string): string | null {
    const icon = this.iconCache.get(key)
    if (icon) {
      this.iconCache.delete(key)
      this.iconCache.set(key, icon)
      return icon
    }
    return null
  }

  public getIconCacheKeyForWindow(window: ActiveWindow): string {
    return this.getIconCacheKey(window)
  }

  public storeIcon(window: ActiveWindow, icon: string): void {
    const key = this.getIconCacheKey(window)
    this.setIconCache(key, icon)
    if (this.cachedState?.window?.windowId === window.windowId) {
      this.cachedState = {
        ...this.cachedState,
        iconBase64: icon,
        timestamp: Date.now(),
      }
    }
  }

  public waitForBrowserUrl(timeoutMs: number): Promise<void> {
    if (!this.isBrowserUrlFetching) return Promise.resolve()

    return new Promise(resolve => {
      const start = Date.now()
      const check = () => {
        if (!this.isBrowserUrlFetching || Date.now() - start >= timeoutMs) {
          resolve()
          return
        }
        setTimeout(check, 15)
      }
      setTimeout(check, 15)
    })
  }

  public requestIcon(): Promise<string | null> {
    return new Promise(resolve => {
      if (!this.process?.stdin?.writable) {
        resolve(null)
        return
      }

      const requestId = `icon-${++this.iconRequestCounter}`
      const timeout = setTimeout(() => {
        this.pendingIconCallbacks.delete(requestId)
        resolve(null)
      }, 800)

      this.pendingIconCallbacks.set(requestId, icon => {
        clearTimeout(timeout)
        resolve(icon)
      })

      try {
        this.process.stdin.write(
          JSON.stringify({ command: 'get_icon', requestId }) + '\n',
        )
      } catch (err) {
        console.warn('[ActiveWindowMonitor] Failed to write to stdin:', err)
        clearTimeout(timeout)
        this.pendingIconCallbacks.delete(requestId)
        resolve(null)
      }
    })
  }

  private handleEvent(event: DaemonEvent): void {
    if (event.type === 'heartbeat_ping') {
      this.lastHeartbeat = Date.now()
      this.restartAttempts = 0
      return
    }

    if (event.type === 'icon_response') {
      const callback = this.pendingIconCallbacks.get(event.requestId)
      if (callback) {
        this.pendingIconCallbacks.delete(event.requestId)
        callback(event.iconBase64 || null)
      }
      return
    }

    if (event.type === 'window_changed') {
      const window: ActiveWindow = {
        title: event.title,
        appName: event.appName,
        windowId: event.windowId,
        processId: event.processId,
        positon: event.position,
        bundleId: event.bundleId,
        exePath: event.exePath,
      }

      const cacheKey = this.getIconCacheKey(window)
      const cachedIcon = this.iconCache.get(cacheKey) ?? null

      this.cachedState = {
        window,
        browserInfo: this.cachedState?.browserInfo ?? null,
        iconBase64: cachedIcon,
        timestamp: Date.now(),
      }

      if (!cachedIcon && !this.iconFetchInProgress.has(cacheKey)) {
        this.iconFetchInProgress.add(cacheKey)
        this.requestIcon()
          .then(icon => {
            if (icon) {
              const currentKey = this.cachedState?.window
                ? this.getIconCacheKey(this.cachedState.window)
                : null
              if (currentKey !== cacheKey) {
                return
              }

              this.setIconCache(cacheKey, icon)
              if (this.cachedState?.window?.windowId === window.windowId) {
                this.cachedState = {
                  ...this.cachedState,
                  iconBase64: icon,
                  timestamp: Date.now(),
                }
              }
            }
          })
          .catch(() => {})
          .finally(() => {
            this.iconFetchInProgress.delete(cacheKey)
          })
      }

      this.scheduleBrowserUrlFetch(window)
      this.emit('window-changed', window)

      if (this.isBrowserApp(window.appName)) {
        this.startBrowserUrlPolling()
      } else {
        this.stopBrowserUrlPolling()
      }
    }
  }

  private isBrowserApp(appName: string): boolean {
    return KNOWN_BROWSERS.has(appName.toLowerCase())
  }

  private startBrowserUrlPolling(): void {
    this.stopBrowserUrlPolling()
    this.lastPolledDomain = this.cachedState?.browserInfo?.domain ?? null
    this.browserPollInterval = setInterval(async () => {
      if (!this.cachedState?.window) return
      try {
        const browserInfo = await getBrowserUrl(this.cachedState.window)
        const newDomain = browserInfo.domain ?? null
        if (newDomain !== this.lastPolledDomain) {
          this.lastPolledDomain = newDomain
          this.cachedState = {
            window: this.cachedState.window,
            browserInfo,
            iconBase64: this.cachedState.iconBase64,
            timestamp: Date.now(),
          }
          this.emit('browser-url-changed', newDomain)
        }
      } catch {}
    }, BROWSER_POLL_INTERVAL_MS)
  }

  private stopBrowserUrlPolling(): void {
    if (this.browserPollInterval) {
      clearInterval(this.browserPollInterval)
      this.browserPollInterval = null
    }
    this.lastPolledDomain = null
  }

  private scheduleBrowserUrlFetch(window: ActiveWindow): void {
    if (this.isBrowserUrlFetching) {
      this.pendingBrowserUrlWindow = window
      return
    }
    this.executeBrowserUrlFetch(window)
  }

  private async executeBrowserUrlFetch(window: ActiveWindow): Promise<void> {
    this.isBrowserUrlFetching = true
    try {
      const browserInfo = await getBrowserUrl(window)
      if (this.cachedState?.window?.windowId === window.windowId) {
        this.cachedState = {
          window: this.cachedState.window,
          browserInfo,
          iconBase64: this.cachedState.iconBase64,
          timestamp: Date.now(),
        }
      }
    } catch {
      if (this.cachedState?.window?.windowId === window.windowId) {
        this.cachedState = {
          window: this.cachedState.window,
          browserInfo: { url: null, domain: null, browser: null },
          iconBase64: this.cachedState.iconBase64,
          timestamp: Date.now(),
        }
      }
    } finally {
      this.isBrowserUrlFetching = false

      if (this.pendingBrowserUrlWindow) {
        const next = this.pendingBrowserUrlWindow
        this.pendingBrowserUrlWindow = null
        this.executeBrowserUrlFetch(next)
      }
    }
  }

  private startHeartbeatChecker(): void {
    this.lastHeartbeat = Date.now()
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        console.warn('[ActiveWindowMonitor] Heartbeat timeout, restarting...')
        this.stopHeartbeatChecker()
        if (this.process) {
          this.process.kill()
          this.process = null
        }
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS)
  }

  private stopHeartbeatChecker(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}

export const activeWindowMonitor = new ActiveWindowMonitor()
