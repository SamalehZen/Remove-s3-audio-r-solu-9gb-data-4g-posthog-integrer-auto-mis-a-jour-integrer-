import { KeyValueStore } from './sqlite/repo'

const FAVICON_CACHE_KEY = 'favicon-cache:v1'
const MAX_FAVICON_CACHE_SIZE = 200

type CachedFaviconEntry = {
  iconBase64: string
  updatedAt: number
}

type PersistedFaviconCache = {
  version: 1
  entries: Array<{
    domain: string
    iconBase64: string
    updatedAt: number
  }>
}

export class FaviconCache {
  private cache = new Map<string, CachedFaviconEntry>()
  private pendingFetches = new Map<string, Promise<string | null>>()
  private isHydrated = false
  private hydratePromise: Promise<void> | null = null
  private persistPromise: Promise<void> = Promise.resolve()

  private normalizeDomain(domain: string): string {
    return domain.toLowerCase().replace(/^www\./, '')
  }

  private touch(domain: string, entry: CachedFaviconEntry): string {
    this.cache.delete(domain)
    this.cache.set(domain, {
      iconBase64: entry.iconBase64,
      updatedAt: Date.now(),
    })
    return entry.iconBase64
  }

  private getFromMemory(domain: string): string | null {
    const entry = this.cache.get(domain)
    if (!entry) return null
    return this.touch(domain, entry)
  }

  private upsertMemory(
    domain: string,
    iconBase64: string,
    updatedAt: number = Date.now(),
  ): void {
    this.cache.delete(domain)
    this.cache.set(domain, { iconBase64, updatedAt })

    while (this.cache.size > MAX_FAVICON_CACHE_SIZE) {
      const oldestEntry = this.cache.keys().next()
      if (oldestEntry.done) break
      this.cache.delete(oldestEntry.value)
    }
  }

  private async ensureHydrated(): Promise<void> {
    if (this.isHydrated) return
    if (this.hydratePromise) {
      await this.hydratePromise
      return
    }

    this.hydratePromise = (async () => {
      try {
        const raw = await KeyValueStore.get(FAVICON_CACHE_KEY)
        if (!raw) {
          this.isHydrated = true
          return
        }

        const parsed = JSON.parse(raw) as PersistedFaviconCache
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
          throw new Error('Invalid favicon cache payload')
        }

        parsed.entries
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .forEach(entry => {
            if (
              !entry ||
              typeof entry.domain !== 'string' ||
              typeof entry.iconBase64 !== 'string' ||
              typeof entry.updatedAt !== 'number'
            ) {
              return
            }

            this.upsertMemory(
              this.normalizeDomain(entry.domain),
              entry.iconBase64,
              entry.updatedAt,
            )
          })

        this.isHydrated = true
      } catch (error) {
        console.warn('[FaviconCache] Failed to hydrate cache:', error)
        this.isHydrated = true
      } finally {
        this.hydratePromise = null
      }
    })()

    await this.hydratePromise
  }

  private queuePersist(): Promise<void> {
    this.persistPromise = this.persistPromise
      .catch(() => {})
      .then(async () => {
        const payload: PersistedFaviconCache = {
          version: 1,
          entries: Array.from(this.cache.entries()).map(([domain, entry]) => ({
            domain,
            iconBase64: entry.iconBase64,
            updatedAt: entry.updatedAt,
          })),
        }

        await KeyValueStore.set(FAVICON_CACHE_KEY, JSON.stringify(payload))
      })
      .catch(error => {
        console.warn('[FaviconCache] Failed to persist cache:', error)
      })

    return this.persistPromise
  }

  public async get(domain: string): Promise<string | null> {
    await this.ensureHydrated()
    return this.getFromMemory(this.normalizeDomain(domain))
  }

  public async set(domain: string, iconBase64: string): Promise<void> {
    await this.ensureHydrated()
    this.upsertMemory(this.normalizeDomain(domain), iconBase64)
    await this.queuePersist()
  }

  public async prefetch(
    domain: string,
    fetcher: () => Promise<string | null>,
  ): Promise<string | null> {
    await this.ensureHydrated()
    const normalizedDomain = this.normalizeDomain(domain)

    const existing = this.getFromMemory(normalizedDomain)
    if (existing) return existing

    const pending = this.pendingFetches.get(normalizedDomain)
    if (pending) return pending

    const request = (async () => {
      try {
        const iconBase64 = await fetcher()
        if (!iconBase64) return null

        this.upsertMemory(normalizedDomain, iconBase64)
        await this.queuePersist()
        return iconBase64
      } catch (error) {
        console.warn('[FaviconCache] Fetch failed for', normalizedDomain, error)
        return null
      } finally {
        this.pendingFetches.delete(normalizedDomain)
      }
    })()

    this.pendingFetches.set(normalizedDomain, request)
    return request
  }

  public async waitForPending(
    domain: string,
    timeoutMs: number,
  ): Promise<string | null> {
    await this.ensureHydrated()
    const normalizedDomain = this.normalizeDomain(domain)

    const existing = this.getFromMemory(normalizedDomain)
    if (existing) return existing

    const pending = this.pendingFetches.get(normalizedDomain)
    if (!pending) return null

    const timeout = new Promise<string | null>(resolve => {
      const timer = setTimeout(() => {
        resolve(this.getFromMemory(normalizedDomain))
      }, timeoutMs)
      pending.finally(() => clearTimeout(timer))
    })

    return Promise.race([pending.catch(() => null), timeout])
  }
}

export const faviconCache = new FaviconCache()
