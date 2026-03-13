import { itoHttpClient } from '../../clients/itoHttpClient'

export class SonioxTempKeyManager {
  async getKey(): Promise<string> {
    const fetchStart = Date.now()
    console.log('[SonioxTempKey] Fetching fresh key (no cache — 1 key per session)')

    const response = await itoHttpClient.post('/soniox/temp-key', undefined, {
      requireAuth: true,
    })

    if (!response.success || !response.key) {
      throw new Error(
        `Failed to get Soniox temp key: ${response.error || 'Unknown error'}`,
      )
    }

    const fetchDuration = Date.now() - fetchStart
    console.log(
      `[SonioxTempKey] Fresh key fetched in ${fetchDuration}ms | expiresIn=${response.expires_in_seconds}s`,
    )
    return response.key
  }

  invalidate(): void {
    // No-op: keys are no longer cached
  }

  async warmup(): Promise<void> {
    // No-op: pre-fetching removed to avoid stale keys
  }
}

export const sonioxTempKeyManager = new SonioxTempKeyManager()
