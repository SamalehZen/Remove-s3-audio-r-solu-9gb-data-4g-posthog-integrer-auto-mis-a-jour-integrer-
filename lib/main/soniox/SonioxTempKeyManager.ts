import { itoHttpClient } from '../../clients/itoHttpClient'

export class SonioxTempKeyManager {
  private cachedKey: string | null = null
  private keyExpiresAt: number = 0
  private keyFetchedAt: number = 0
  private readonly REFRESH_MARGIN_MS = 5 * 60 * 1000

  // [FINDING-4] Tracker du nombre de sessions utilisant la même clé temporaire
  // Hypothèse : Soniox pourrait limiter le débit ou dégrader les performances
  // après un grand nombre de sessions sur la même clé (certitude 40% - à observer).
  private sessionsOnCurrentKey = 0

  async getKey(): Promise<string> {
    const now = Date.now()

    if (
      this.cachedKey &&
      now < this.keyExpiresAt - this.REFRESH_MARGIN_MS
    ) {
      this.sessionsOnCurrentKey++
      const keyAgeMs = now - this.keyFetchedAt
      const timeUntilRefreshMs = this.keyExpiresAt - this.REFRESH_MARGIN_MS - now
      console.log(
        `[SonioxTempKey] Cache HIT | keyAge=${Math.round(keyAgeMs / 1000)}s | validFor=${Math.round(timeUntilRefreshMs / 1000)}s more before refresh | [FINDING-4] sessionsOnThisKey=${this.sessionsOnCurrentKey}`,
      )
      return this.cachedKey
    }

    if (this.cachedKey) {
      const keyAgeMs = now - this.keyFetchedAt
      const msUntilExpiry = this.keyExpiresAt - now
      console.log(
        `[SonioxTempKey] Cache EXPIRED or in refresh window | keyAge=${Math.round(keyAgeMs / 1000)}s | msUntilExpiry=${msUntilExpiry}ms | [FINDING-4] sessionsOnExpiredKey=${this.sessionsOnCurrentKey} — fetching new key`,
      )
    } else {
      console.log('[SonioxTempKey] No cached key — fetching new key from server')
    }

    const fetchStart = Date.now()
    const response = await itoHttpClient.post('/soniox/temp-key', undefined, {
      requireAuth: true,
    })

    if (!response.success || !response.key) {
      throw new Error(
        `Failed to get Soniox temp key: ${response.error || 'Unknown error'}`,
      )
    }

    this.cachedKey = response.key
    this.keyExpiresAt = Date.now() + response.expires_in_seconds * 1000
    this.keyFetchedAt = Date.now()
    this.sessionsOnCurrentKey = 1

    const fetchDuration = Date.now() - fetchStart
    console.log(
      `[SonioxTempKey] New key fetched in ${fetchDuration}ms | expiresIn=${response.expires_in_seconds}s | expiresAt=${new Date(this.keyExpiresAt).toISOString()} | [FINDING-4] sessionsReset=1`,
    )
    return this.cachedKey
  }

  invalidate(): void {
    console.log(`[SonioxTempKey] Key invalidated manually | wasSessionCount=${this.sessionsOnCurrentKey}`)
    this.cachedKey = null
    this.keyExpiresAt = 0
    this.keyFetchedAt = 0
    this.sessionsOnCurrentKey = 0
  }

  async warmup(): Promise<void> {
    try {
      await this.getKey()
      console.log('[SonioxTempKey] Key pre-warmed successfully')
    } catch (error) {
      console.warn('[SonioxTempKey] Warmup failed (will retry on use):', error)
    }
  }
}

export const sonioxTempKeyManager = new SonioxTempKeyManager()
