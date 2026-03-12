import { itoHttpClient } from '../../clients/itoHttpClient'

export class SpeechmaticsTempKeyManager {
  private cachedJwt: string | null = null
  private jwtExpiresAt: number = 0
  private jwtFetchedAt: number = 0
  private readonly REFRESH_MARGIN_MS = 15 * 1000

  async getJwt(): Promise<string> {
    const now = Date.now()

    if (
      this.cachedJwt &&
      now < this.jwtExpiresAt - this.REFRESH_MARGIN_MS
    ) {
      console.log(
        `[SpeechmaticsTempKey] Cache HIT | age=${Math.round((now - this.jwtFetchedAt) / 1000)}s | validFor=${Math.round((this.jwtExpiresAt - this.REFRESH_MARGIN_MS - now) / 1000)}s`,
      )
      return this.cachedJwt
    }

    console.log('[SpeechmaticsTempKey] Fetching new JWT from server')

    const fetchStart = Date.now()
    const response = await itoHttpClient.post('/speechmatics/temp-jwt', undefined, {
      requireAuth: true,
    })

    if (!response.success || !response.jwt) {
      throw new Error(
        `Failed to get Speechmatics temp JWT: ${response.error || 'Unknown error'}`,
      )
    }

    this.cachedJwt = response.jwt
    this.jwtExpiresAt = Date.now() + response.expires_in_seconds * 1000
    this.jwtFetchedAt = Date.now()

    const fetchDuration = Date.now() - fetchStart
    console.log(
      `[SpeechmaticsTempKey] New JWT fetched in ${fetchDuration}ms | expiresIn=${response.expires_in_seconds}s`,
    )
    return this.cachedJwt
  }

  invalidate(): void {
    console.log('[SpeechmaticsTempKey] JWT invalidated manually')
    this.cachedJwt = null
    this.jwtExpiresAt = 0
    this.jwtFetchedAt = 0
  }
}

export const speechmaticsTempKeyManager = new SpeechmaticsTempKeyManager()
