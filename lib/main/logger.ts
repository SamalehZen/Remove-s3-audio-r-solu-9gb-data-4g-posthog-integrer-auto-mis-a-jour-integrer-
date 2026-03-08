import log from 'electron-log'
import { app } from 'electron'
import os from 'os'
import store, { getCurrentUserId } from './store'
import { STORE_KEYS } from '../constants/store-keys'
import { interactionManager } from './interactions/InteractionManager'

const LOG_QUEUE_KEY = 'log_queue:events'

export function initializeLogging() {
  // Save original console methods BEFORE any overrides
  const _originalLog = console.log
  const _originalInfo = console.info
  const _originalWarn = console.warn
  const _originalError = console.error

  // Configure file transport for the packaged app
  if (app.isPackaged) {
    log.transports.file.level = 'info' // Log 'info' and higher (info, warn, error)
    log.transports.file.format =
      '[{y}-{m}-{d} {h}:{i}:{s}.{l}] [{processType}] [{level}] {text}'
  } else {
    log.transports.console.level = 'debug'
    log.transports.file.level = false
  }

  // Set up IPC transport to receive logs from the renderer process
  log.initialize()

  log.info('Logging initialized.')
  if (app.isPackaged) {
    log.info(`Log file is located at: ${log.transports.file.getFile().path}`)
  }

  // Add remote transport to batch-forward client logs to server
  type LogEvent = {
    ts: number
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'log'
    message: string
    fields?: Record<string, unknown>
    interactionId: string | null
    traceId?: string
    spanId?: string
    appVersion?: string
    platform?: string
    source?: string
    loggedAtIso: string
  }

  const MAX_QUEUE = 5000
  const ARG_MAX_LEN = 200

  const summarizeArgs = (args: any[]): { summary: string } => {
    const parts = args.map(a => {
      if (typeof a === 'string') return a
      try {
        const s = JSON.stringify(a)
        return s.length > ARG_MAX_LEN ? s.slice(0, ARG_MAX_LEN) + '…' : s
      } catch {
        return String(a)
      }
    })
    return { summary: parts.join(' ') }
  }
  const initialEvents =
    (store.get(LOG_QUEUE_KEY) as LogEvent[] | undefined) ?? []
  const queue: LogEvent[] = [...initialEvents]

  // Cache analytics preference to avoid store read on every log call
  let _shareAnalyticsCached = false
  const refreshAnalyticsFlag = () => {
    try {
      const settings = store.get(STORE_KEYS.SETTINGS)
      _shareAnalyticsCached = settings?.shareAnalytics ?? false
    } catch {
      /* ignore */
    }
  }
  refreshAnalyticsFlag()
  const analyticsRefreshTimer = setInterval(refreshAnalyticsFlag, 60_000)

  const persistQueue = () => {
    store.set(LOG_QUEUE_KEY, queue)
  }
  let isSending = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flush = async () => {
    if (isSending || queue.length === 0) return
    isSending = true
    const take = Math.min(50, queue.length)
    const batch = queue.slice(0, take)
    try {
      const baseUrl = import.meta.env.VITE_GRPC_BASE_URL
      if (!baseUrl) return

      const url = new URL('/logs', baseUrl)
      const body = {
        events: batch,
      }
      const token = (store.get(STORE_KEYS.ACCESS_TOKEN) as string | null) || ''
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      })
      if (res.ok || res.status === 204) {
        // Remove sent items only on success
        queue.splice(0, take)
        persistQueue()
      }
    } catch {
      // Keep items in queue on failure; they remain persisted
    } finally {
      isSending = false
    }
  }

  const scheduleFlush = () => {
    if (flushTimer) return
    flushTimer = setTimeout(async () => {
      flushTimer = null
      await flush()
      if (queue.length > 0) {
        // If more remain, schedule another cycle
        scheduleFlush()
      }
    }, 60_000)
  }

  const toEvent = (
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'log',
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    const userId = getCurrentUserId()
    const interactionId = interactionManager.getCurrentInteractionId()
    const now = Date.now()
    const event: LogEvent = {
      ts: now,
      loggedAtIso: new Date(now).toISOString(),
      level,
      message,
      fields: {
        ...fields,
        userId,
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
      },
      interactionId,
      appVersion: app.getVersion?.() ?? 'unknown',
      platform: `${process.platform}-${process.arch}`,
      source: 'client',
    }
    return event
  }

  // Periodic safety-net persist (every 30s) — limits log loss on crash to ~30s
  const persistTimer = setInterval(() => {
    if (queue.length > 0) {
      persistQueue()
    }
  }, 30_000)

  // Wrap core log methods to enqueue events
  const originalInfo = _originalInfo
  const originalWarn = _originalWarn
  const originalError = _originalError
  const originalLog = _originalLog

  // Save original electron-log methods before they get wrapped below
  const _elLogLog = log.log.bind(log)
  const _elLogInfo = log.info.bind(log)
  const _elLogWarn = log.warn.bind(log)
  const _elLogError = log.error.bind(log)

  console.log = (...args: any[]) => {
    try {
      if (_shareAnalyticsCached) {
        queue.push(toEvent('log', String(args[0] ?? ''), summarizeArgs(args)))
        if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
        scheduleFlush()
      }
    } catch (err) {
      originalError('Failed to enqueue log event (log):', err)
    }
    if (app.isPackaged) _elLogLog(...args)
    originalLog.apply(console, args as any)
  }
  console.info = (...args: any[]) => {
    try {
      if (_shareAnalyticsCached) {
        queue.push(toEvent('info', String(args[0] ?? ''), summarizeArgs(args)))
        if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
        scheduleFlush()
      }
    } catch (err) {
      originalError('Failed to enqueue log event (info):', err)
    }
    if (app.isPackaged) _elLogInfo(...args)
    originalInfo.apply(console, args as any)
  }
  console.warn = (...args: any[]) => {
    try {
      if (_shareAnalyticsCached) {
        queue.push(toEvent('warn', String(args[0] ?? ''), summarizeArgs(args)))
        if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
        scheduleFlush()
      }
    } catch (err) {
      originalError('Failed to enqueue log event (warn):', err)
    }
    if (app.isPackaged) _elLogWarn(...args)
    originalWarn.apply(console, args as any)
  }
  console.error = (...args: any[]) => {
    try {
      // Always send errors to server for crash/bug visibility
      queue.push(toEvent('error', String(args[0] ?? ''), summarizeArgs(args)))
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
      scheduleFlush()
    } catch (err) {
      originalError('Failed to enqueue log event (error):', err)
    }
    if (app.isPackaged) _elLogError(...args)
    originalError.apply(console, args as any)
  }

  // Also wrap electron-log methods (log.info, log.warn, etc.) so direct calls are sent
  const levelMap: Record<string, 'debug' | 'info' | 'warn' | 'error'> = {
    verbose: 'debug',
    silly: 'debug',
    debug: 'debug',
    info: 'info',
    log: 'info',
    warn: 'warn',
    error: 'error',
  }
  ;(
    ['info', 'warn', 'error', 'debug', 'verbose', 'silly', 'log'] as const
  ).forEach(method => {
    const original = (log as any)[method]?.bind(log)
    if (typeof original !== 'function') return
    ;(log as any)[method] = (...args: any[]) => {
      try {
        const mapped = levelMap[method] || 'info'
        const isError = method === 'error'
        if (isError || _shareAnalyticsCached) {
          queue.push(toEvent(mapped as any, String(args[0] ?? ''), summarizeArgs(args)))
          if (queue.length > MAX_QUEUE)
            queue.splice(0, queue.length - MAX_QUEUE)
          scheduleFlush()
        }
      } catch (err) {
        originalError(`Failed to enqueue electron-log event (${method}):`, err)
      }
      return original(...args)
    }
  })

  // Best-effort flush when the app is quitting; durability is ensured by persistence
  app.on('before-quit', () => {
    clearInterval(persistTimer)
    clearInterval(analyticsRefreshTimer)
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    void flush()
  })

  // If there are persisted events on startup, schedule an initial flush
  if (queue.length > 0) {
    scheduleFlush()
  }
}
