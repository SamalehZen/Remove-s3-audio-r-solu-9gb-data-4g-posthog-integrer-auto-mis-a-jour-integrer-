import { beforeEach, describe, expect, mock, test } from 'bun:test'

const mockKeyValueStore = {
  get: mock(async (_key: string): Promise<string | undefined> => undefined),
  set: mock(async (_key: string, _value: string): Promise<void> => undefined),
}

function setupMocks() {
  mock.module('./sqlite/repo', () => ({
    KeyValueStore: mockKeyValueStore,
  }))
}

setupMocks()

describe('FaviconCache', () => {
  beforeEach(() => {
    setupMocks()
    mockKeyValueStore.get.mockReset()
    mockKeyValueStore.set.mockReset()
    mockKeyValueStore.get.mockResolvedValue(undefined)
    mockKeyValueStore.set.mockResolvedValue(undefined)
  })

  test('loads persisted favicons from disk-backed cache', async () => {
    mockKeyValueStore.get.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        entries: [
          {
            domain: 'youtube.com',
            iconBase64: 'youtube-icon',
            updatedAt: 1,
          },
        ],
      }),
    )

    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    expect(await cache.get('www.youtube.com')).toBe('youtube-icon')
    expect(mockKeyValueStore.get).toHaveBeenCalledWith('favicon-cache:v1')
  })

  test('persists newly fetched favicons for future app launches', async () => {
    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()
    const fetcher = mock(async () => 'new-youtube-icon')

    expect(await cache.prefetch('youtube.com', fetcher)).toBe('new-youtube-icon')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await cache.get('youtube.com')).toBe('new-youtube-icon')
    expect(mockKeyValueStore.set).toHaveBeenCalledTimes(1)

    const [key, rawPayload] = mockKeyValueStore.set.mock.calls[0] as unknown as [
      string,
      string,
    ]
    expect(key).toBe('favicon-cache:v1')

    const payload = JSON.parse(rawPayload) as {
      version: number
      entries: Array<{ domain: string; iconBase64: string }>
    }
    expect(payload.version).toBe(1)
    expect(payload.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: 'youtube.com',
          iconBase64: 'new-youtube-icon',
        }),
      ]),
    )
  })

  test('deduplicates concurrent fetches for the same domain', async () => {
    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    let resolveFetch: ((value: string | null) => void) | null = null
    const fetcher = mock(
      () =>
        new Promise<string | null>(resolve => {
          resolveFetch = resolve
        }),
    )

    const first = cache.prefetch('youtube.com', fetcher)
    const second = cache.prefetch('www.youtube.com', fetcher)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetcher).toHaveBeenCalledTimes(1)

    if (!resolveFetch) {
      throw new Error('Expected concurrent fetch to be pending')
    }

    resolveFetch('shared-youtube-icon')

    expect(await first).toBe('shared-youtube-icon')
    expect(await second).toBe('shared-youtube-icon')
    expect(await cache.get('youtube.com')).toBe('shared-youtube-icon')
  })

  test('recovers gracefully from corrupted JSON in disk cache', async () => {
    mockKeyValueStore.get.mockResolvedValueOnce('not-valid-json{{{')

    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    expect(await cache.get('youtube.com')).toBeNull()

    const fetcher = mock(async () => 'fresh-icon')
    expect(await cache.prefetch('youtube.com', fetcher)).toBe('fresh-icon')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('recovers from invalid cache schema version', async () => {
    mockKeyValueStore.get.mockResolvedValueOnce(
      JSON.stringify({ version: 99, entries: [] }),
    )

    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    expect(await cache.get('github.com')).toBeNull()
  })

  test('skips malformed entries during hydration without losing valid ones', async () => {
    mockKeyValueStore.get.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        entries: [
          { domain: 'youtube.com', iconBase64: 'yt-icon', updatedAt: 1 },
          { domain: null, iconBase64: 'bad', updatedAt: 2 },
          { domain: 'github.com', iconBase64: 123, updatedAt: 3 },
          { domain: 'twitter.com', iconBase64: 'tw-icon', updatedAt: 4 },
        ],
      }),
    )

    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    expect(await cache.get('youtube.com')).toBe('yt-icon')
    expect(await cache.get('twitter.com')).toBe('tw-icon')
    expect(await cache.get('github.com')).toBeNull()
  })

  test('returns null and does not cache when fetcher returns null', async () => {
    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()
    const fetcher = mock(async () => null)

    expect(await cache.prefetch('no-favicon.com', fetcher)).toBeNull()
    expect(await cache.get('no-favicon.com')).toBeNull()
    expect(mockKeyValueStore.set).not.toHaveBeenCalled()
  })

  test('returns null safely when fetcher throws', async () => {
    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()
    const fetcher = mock(async () => {
      throw new Error('network timeout')
    })

    expect(await cache.prefetch('broken.com', fetcher)).toBeNull()
    expect(await cache.get('broken.com')).toBeNull()
  })

  test('waitForPending returns cached value immediately if available', async () => {
    mockKeyValueStore.get.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        entries: [
          { domain: 'youtube.com', iconBase64: 'cached-icon', updatedAt: 1 },
        ],
      }),
    )

    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    const result = await cache.waitForPending('youtube.com', 120)
    expect(result).toBe('cached-icon')
  })

  test('waitForPending returns null when no pending fetch exists', async () => {
    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    const result = await cache.waitForPending('unknown.com', 120)
    expect(result).toBeNull()
  })

  test('waitForPending resolves with null on timeout when fetch is slow', async () => {
    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    const fetcher = mock(
      () =>
        new Promise<string | null>(resolve =>
          setTimeout(() => resolve('late-icon'), 500),
        ),
    )

    const prefetchPromise = cache.prefetch('slow.com', fetcher)
    await new Promise(resolve => setTimeout(resolve, 0))

    const start = Date.now()
    const result = await cache.waitForPending('slow.com', 50)
    const elapsed = Date.now() - start

    expect(result).toBeNull()
    expect(elapsed).toBeLessThan(200)

    await prefetchPromise
  })

  test('normalizes domains consistently (www, uppercase)', async () => {
    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    await cache.set('www.YouTube.COM', 'yt-icon')

    expect(await cache.get('youtube.com')).toBe('yt-icon')
    expect(await cache.get('www.youtube.com')).toBe('yt-icon')
    expect(await cache.get('WWW.YOUTUBE.COM')).toBe('yt-icon')
  })

  test('evicts oldest entries when cache exceeds max size', async () => {
    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    for (let i = 0; i < 201; i++) {
      await cache.set(`site${i}.com`, `icon-${i}`)
    }

    expect(await cache.get('site0.com')).toBeNull()
    expect(await cache.get('site200.com')).toBe('icon-200')
    expect(await cache.get('site1.com')).toBe('icon-1')
  })

  test('prefetch returns cached value without calling fetcher', async () => {
    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    await cache.set('youtube.com', 'existing-icon')

    const fetcher = mock(async () => 'new-icon')
    expect(await cache.prefetch('youtube.com', fetcher)).toBe('existing-icon')
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('set overwrites existing entry and persists', async () => {
    const { FaviconCache } = await import('./faviconCache')
    const cache = new FaviconCache()

    await cache.set('youtube.com', 'old-icon')
    await cache.set('youtube.com', 'new-icon')

    expect(await cache.get('youtube.com')).toBe('new-icon')
    expect(mockKeyValueStore.set).toHaveBeenCalledTimes(2)
  })
})
