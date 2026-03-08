import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'

const pillWindowSend = mock()
const mainWindowSend = mock()
const mockGetActiveWindowWithIcon = mock(async (): Promise<any> => null)
const mockGetBrowserUrl = mock(
  async (): Promise<{
    url: string | null
    domain: string | null
    browser: string | null
  }> => ({ url: null, domain: null, browser: null }),
)
const mockFetchFavicon = mock(async (): Promise<string | null> => null)
const faviconStore = new Map<string, string>()

const mockFaviconCache = {
  get: mock(async (domain: string) => faviconStore.get(domain) ?? null),
  waitForPending: mock(
    async (domain: string) => faviconStore.get(domain) ?? null,
  ),
  prefetch: mock(
    async (domain: string, fetcher: () => Promise<string | null>) => {
      const existing = faviconStore.get(domain)
      if (existing) return existing
      const icon = await fetcher()
      if (icon) faviconStore.set(domain, icon)
      return icon
    },
  ),
}

class MockActiveWindowMonitor extends EventEmitter {
  public cachedState: any = null
  public getCachedState = mock(() => this.cachedState)
  public waitForBrowserUrl = mock(async () => undefined)
  public requestIcon = mock(async () => null)
  public storeIcon = mock(() => undefined)
  public getIconCacheKeyForWindow = mock(() => 'browser-key')
  public getCachedIcon = mock(() => null)
}

const mockActiveWindowMonitor = new MockActiveWindowMonitor()

function setupMocks() {
  mock.module('./app', () => ({
    getPillWindow: () => ({
      webContents: { send: pillWindowSend },
    }),
    mainWindow: {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: mainWindowSend },
    },
  }))
  mock.module('../media/active-application', () => ({
    getActiveWindowWithIcon: mockGetActiveWindowWithIcon,
  }))
  mock.module('../media/browser-url', () => ({
    getBrowserUrl: mockGetBrowserUrl,
  }))
  mock.module('./faviconFetcher', () => ({
    fetchFavicon: mockFetchFavicon,
  }))
  mock.module('./faviconCache', () => ({
    faviconCache: mockFaviconCache,
  }))
  mock.module('./ActiveWindowMonitor', () => ({
    activeWindowMonitor: mockActiveWindowMonitor,
  }))
}

setupMocks()

const flushAsyncWork = async (ticks = 5) => {
  for (let i = 0; i < ticks; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

const makeWindowState = (
  appName: string,
  domain: string | null,
  iconBase64: string = 'chrome-icon',
) => ({
  window: {
    appName,
    windowId: 1,
    processId: 10,
    title: domain ?? appName,
    positon: { x: 0, y: 0, width: 100, height: 100 },
  },
  browserInfo: domain
    ? { url: `https://${domain}/`, domain, browser: appName }
    : null,
  iconBase64,
  timestamp: Date.now(),
})

const getRecordingPayloads = () =>
  pillWindowSend.mock.calls
    .map(([, payload]: [string, any]) => payload)
    .filter((p: any) => p?.isRecording)

const resetFaviconCacheMock = () => {
  mockFaviconCache.get.mockReset()
  mockFaviconCache.waitForPending.mockReset()
  mockFaviconCache.prefetch.mockReset()
  faviconStore.clear()
  mockFaviconCache.get.mockImplementation(
    async (domain: string) => faviconStore.get(domain) ?? null,
  )
  mockFaviconCache.waitForPending.mockImplementation(
    async (domain: string) => faviconStore.get(domain) ?? null,
  )
  mockFaviconCache.prefetch.mockImplementation(
    async (domain: string, fetcher: () => Promise<string | null>) => {
      const existing = faviconStore.get(domain)
      if (existing) return existing
      const icon = await fetcher()
      if (icon) faviconStore.set(domain, icon)
      return icon
    },
  )
}

describe('RecordingStateNotifier', () => {
  beforeEach(() => {
    setupMocks()
    pillWindowSend.mockReset()
    mainWindowSend.mockReset()
    mockGetActiveWindowWithIcon.mockReset()
    mockGetActiveWindowWithIcon.mockResolvedValue(null)
    mockGetBrowserUrl.mockReset()
    mockGetBrowserUrl.mockResolvedValue({
      url: null,
      domain: null,
      browser: null,
    })
    mockFetchFavicon.mockReset()
    mockFetchFavicon.mockResolvedValue(null)
    resetFaviconCacheMock()
    mockActiveWindowMonitor.removeAllListeners()
    mockActiveWindowMonitor.cachedState = null
    mockActiveWindowMonitor.getCachedState.mockClear()
    mockActiveWindowMonitor.waitForBrowserUrl.mockClear()
    mockActiveWindowMonitor.requestIcon.mockClear()
    mockActiveWindowMonitor.storeIcon.mockClear()
    mockActiveWindowMonitor.getIconCacheKeyForWindow.mockClear()
    mockActiveWindowMonitor.getCachedIcon.mockClear()
  })

  test('does not flash the browser app icon for website targets when favicon is missing', async () => {
    const { RecordingStateNotifier } = await import('./recordingStateNotifier')
    mockActiveWindowMonitor.removeAllListeners()

    mockActiveWindowMonitor.cachedState = makeWindowState(
      'Google Chrome',
      'youtube.com',
    )

    const notifier = new RecordingStateNotifier()
    notifier.notifyRecordingStarted(1 as any)
    await flushAsyncWork()

    expect(pillWindowSend).toHaveBeenCalled()
    const [, payload] = pillWindowSend.mock.calls[0] as [string, any]
    expect(payload.appTargetName).toBe('youtube.com')
    expect(payload.appTargetIconBase64).toBeNull()
  })

  test('keeps the website icon stable when browser URL lookup temporarily drops out', async () => {
    const { RecordingStateNotifier } = await import('./recordingStateNotifier')
    mockActiveWindowMonitor.removeAllListeners()

    faviconStore.set('youtube.com', 'youtube-icon')
    mockActiveWindowMonitor.cachedState = makeWindowState(
      'Google Chrome',
      'youtube.com',
    )

    const notifier = new RecordingStateNotifier()
    notifier.notifyRecordingStarted(1 as any)
    await flushAsyncWork()

    mockActiveWindowMonitor.cachedState = {
      ...mockActiveWindowMonitor.cachedState,
      browserInfo: null,
      timestamp: Date.now(),
    }

    mockGetBrowserUrl.mockResolvedValueOnce({
      url: null,
      domain: null,
      browser: 'Google Chrome',
    })

    mockActiveWindowMonitor.emit('browser-url-changed', null)
    await flushAsyncWork()

    const payloads = getRecordingPayloads()
    expect(payloads.length).toBe(1)
    expect(payloads[0].appTargetName).toBe('youtube.com')
    expect(payloads[0].appTargetIconBase64).toBe('youtube-icon')
  })

  test('shows website favicon instantly when it is already cached', async () => {
    const { RecordingStateNotifier } = await import('./recordingStateNotifier')
    mockActiveWindowMonitor.removeAllListeners()

    faviconStore.set('youtube.com', 'cached-yt-icon')
    mockActiveWindowMonitor.cachedState = makeWindowState(
      'Google Chrome',
      'youtube.com',
    )

    const notifier = new RecordingStateNotifier()
    notifier.notifyRecordingStarted(1 as any)
    await flushAsyncWork()

    const firstPayload = getRecordingPayloads()[0]
    expect(firstPayload.appTargetName).toBe('youtube.com')
    expect(firstPayload.appTargetIconBase64).toBe('cached-yt-icon')
  })

  test('updates pill with favicon when prefetch completes during recording', async () => {
    const { RecordingStateNotifier } = await import('./recordingStateNotifier')
    mockActiveWindowMonitor.removeAllListeners()

    let resolveFetch: ((v: string | null) => void) | null = null
    mockFaviconCache.prefetch.mockImplementation(
      async (_domain: string, _fetcher: () => Promise<string | null>) => {
        return new Promise<string | null>(resolve => {
          resolveFetch = (icon: string | null) => {
            if (icon) faviconStore.set('youtube.com', icon)
            resolve(icon)
          }
        })
      },
    )
    mockFaviconCache.waitForPending.mockResolvedValue(null)

    mockActiveWindowMonitor.cachedState = makeWindowState(
      'Google Chrome',
      'youtube.com',
    )

    const notifier = new RecordingStateNotifier()
    notifier.notifyRecordingStarted(1 as any)
    await flushAsyncWork()

    const payloadsBefore = getRecordingPayloads()
    expect(payloadsBefore.length).toBe(1)
    expect(payloadsBefore[0].appTargetName).toBe('youtube.com')
    expect(payloadsBefore[0].appTargetIconBase64).toBeNull()

    resolveFetch!('late-yt-icon')
    await flushAsyncWork()

    const payloadsAfter = getRecordingPayloads()
    expect(payloadsAfter.length).toBe(2)
    expect(payloadsAfter[1].appTargetName).toBe('youtube.com')
    expect(payloadsAfter[1].appTargetIconBase64).toBe('late-yt-icon')
  })

  test('switches domain when user navigates to a different site during recording', async () => {
    const { RecordingStateNotifier } = await import('./recordingStateNotifier')
    mockActiveWindowMonitor.removeAllListeners()

    faviconStore.set('youtube.com', 'yt-icon')
    faviconStore.set('github.com', 'gh-icon')

    mockActiveWindowMonitor.cachedState = makeWindowState(
      'Google Chrome',
      'youtube.com',
    )

    const notifier = new RecordingStateNotifier()
    notifier.notifyRecordingStarted(1 as any)
    await flushAsyncWork()

    const first = getRecordingPayloads()
    expect(first[0].appTargetName).toBe('youtube.com')
    expect(first[0].appTargetIconBase64).toBe('yt-icon')

    mockActiveWindowMonitor.cachedState = makeWindowState(
      'Google Chrome',
      'github.com',
    )

    mockActiveWindowMonitor.emit('browser-url-changed', 'github.com')
    await flushAsyncWork()

    const all = getRecordingPayloads()
    const githubPayload = all.find(
      (p: any) => p.appTargetName === 'github.com',
    )
    expect(githubPayload).toBeTruthy()
    expect(githubPayload.appTargetIconBase64).toBe('gh-icon')
  })

  test('switches from browser website to native app during recording', async () => {
    const { RecordingStateNotifier } = await import('./recordingStateNotifier')
    mockActiveWindowMonitor.removeAllListeners()

    faviconStore.set('youtube.com', 'yt-icon')
    mockActiveWindowMonitor.cachedState = makeWindowState(
      'Google Chrome',
      'youtube.com',
    )

    const notifier = new RecordingStateNotifier()
    notifier.notifyRecordingStarted(1 as any)
    await flushAsyncWork()

    mockActiveWindowMonitor.cachedState = {
      window: {
        appName: 'Visual Studio Code',
        windowId: 2,
        processId: 20,
        title: 'main.ts',
        positon: { x: 0, y: 0, width: 100, height: 100 },
      },
      browserInfo: null,
      iconBase64: 'vscode-icon',
      timestamp: Date.now(),
    }

    mockActiveWindowMonitor.waitForBrowserUrl.mockResolvedValue(undefined)
    mockActiveWindowMonitor.emit(
      'window-changed',
      mockActiveWindowMonitor.cachedState.window,
    )
    await new Promise(r => setTimeout(r, 250))
    await flushAsyncWork(10)

    const all = getRecordingPayloads()
    const vscodePayload = all.find(
      (p: any) => p.appTargetName === 'Visual Studio Code',
    )
    expect(vscodePayload).toBeTruthy()
    expect(vscodePayload.appTargetIconBase64).toBe('vscode-icon')
  })

  test('filters out browser home domains and shows browser app instead', async () => {
    const { RecordingStateNotifier } = await import('./recordingStateNotifier')
    mockActiveWindowMonitor.removeAllListeners()

    mockActiveWindowMonitor.cachedState = makeWindowState(
      'Google Chrome',
      'google.com',
    )

    const notifier = new RecordingStateNotifier()
    notifier.notifyRecordingStarted(1 as any)
    await flushAsyncWork()

    const payloads = getRecordingPayloads()
    expect(payloads[0].appTargetName).toBe('Google Chrome')
  })

  test('does not emit duplicate IPC when target has not changed', async () => {
    const { RecordingStateNotifier } = await import('./recordingStateNotifier')
    mockActiveWindowMonitor.removeAllListeners()

    faviconStore.set('youtube.com', 'yt-icon')
    mockActiveWindowMonitor.cachedState = makeWindowState(
      'Google Chrome',
      'youtube.com',
    )

    const notifier = new RecordingStateNotifier()
    notifier.notifyRecordingStarted(1 as any)
    await flushAsyncWork()

    const countBefore = pillWindowSend.mock.calls.length

    mockActiveWindowMonitor.emit('browser-url-changed', 'youtube.com')
    await flushAsyncWork()

    const countAfter = pillWindowSend.mock.calls.length
    expect(countAfter).toBe(countBefore)
  })

  test('resets all state on recording stop', async () => {
    const { RecordingStateNotifier } = await import('./recordingStateNotifier')
    mockActiveWindowMonitor.removeAllListeners()

    faviconStore.set('youtube.com', 'yt-icon')
    mockActiveWindowMonitor.cachedState = makeWindowState(
      'Google Chrome',
      'youtube.com',
    )

    const notifier = new RecordingStateNotifier()
    notifier.notifyRecordingStarted(1 as any)
    await flushAsyncWork()

    notifier.notifyRecordingStopped()

    const lastPayload = pillWindowSend.mock.calls.at(-1)?.[1]
    expect(lastPayload.isRecording).toBe(false)
  })

  test('blocked apps are not shown as targets', async () => {
    const { RecordingStateNotifier } = await import('./recordingStateNotifier')
    mockActiveWindowMonitor.removeAllListeners()

    mockActiveWindowMonitor.cachedState = {
      window: {
        appName: 'Electron',
        windowId: 1,
        processId: 10,
        title: 'Electron',
        positon: { x: 0, y: 0, width: 100, height: 100 },
      },
      browserInfo: null,
      iconBase64: 'electron-icon',
      timestamp: Date.now(),
    }

    const notifier = new RecordingStateNotifier()
    notifier.notifyRecordingStarted(1 as any)
    await flushAsyncWork()

    const payloads = getRecordingPayloads()
    expect(payloads[0].appTargetName).toBeUndefined()
    expect(payloads[0].appTargetIconBase64).toBeUndefined()
  })
})
