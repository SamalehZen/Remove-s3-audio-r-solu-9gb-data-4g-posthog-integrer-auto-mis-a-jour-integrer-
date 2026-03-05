import { net } from 'electron'

const KNOWN_DEFAULT_FAVICON_SIZES = new Set([726, 276, 124])

function isSubdomain(domain: string): boolean {
  const parts = domain.split('.')
  return parts.length > 2 && parts[0] !== 'www'
}

export async function fetchFavicon(domain: string): Promise<string | null> {
  const googleUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`
  const directUrl = `https://${domain}/favicon.ico`

  if (isSubdomain(domain)) {
    try {
      const base64 = await fetchImageAsBase64(directUrl)
      if (base64) return base64
    } catch (error) {
      console.warn('[FaviconFetcher] Direct fetch failed for', domain, error)
    }

    try {
      const base64 = await fetchImageAsBase64(googleUrl)
      if (base64 && !isDefaultGoogleFavicon(base64)) return base64
    } catch (error) {
      console.warn('[FaviconFetcher] Google API failed for', domain, error)
    }

    return null
  }

  try {
    const base64 = await fetchImageAsBase64(googleUrl)
    if (base64 && !isDefaultGoogleFavicon(base64)) return base64
  } catch (error) {
    console.warn('[FaviconFetcher] Google API failed for', domain, error)
  }

  try {
    const base64 = await fetchImageAsBase64(directUrl)
    if (base64) return base64
  } catch (error) {
    console.warn('[FaviconFetcher] Direct fetch failed for', domain, error)
  }

  return null
}

function isDefaultGoogleFavicon(base64: string): boolean {
  try {
    const byteLength = Buffer.from(base64, 'base64').length
    return KNOWN_DEFAULT_FAVICON_SIZES.has(byteLength)
  } catch {
    return false
  }
}

function fetchImageAsBase64(url: string): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const request = net.request(url)
      const chunks: Buffer[] = []
      let settled = false

      const settle = (value: string | null) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }

      request.on('response', response => {
        if (response.statusCode !== 200) {
          settle(null)
          return
        }

        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })

        response.on('end', () => {
          if (chunks.length === 0) {
            settle(null)
            return
          }
          const buffer = Buffer.concat(chunks)
          if (buffer.length < 200 || buffer.length > 102400) {
            settle(null)
            return
          }
          settle(buffer.toString('base64'))
        })

        response.on('error', () => settle(null))
      })

      request.on('error', () => settle(null))

      setTimeout(() => {
        if (!settled) {
          request.abort()
          settle(null)
        }
      }, 3000)

      request.end()
    } catch {
      resolve(null)
    }
  })
}
