import { net } from 'electron'

const KNOWN_DEFAULT_FAVICON_SIZES = new Set([726, 276, 124])

const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'or.jp', 'ne.jp',
  'com.au', 'net.au', 'org.au',
  'com.br', 'org.br', 'net.br',
  'co.in', 'net.in', 'org.in',
  'co.kr', 'or.kr',
  'co.nz', 'net.nz', 'org.nz',
  'co.za', 'org.za',
  'com.mx', 'org.mx',
  'com.cn', 'org.cn', 'net.cn',
  'com.tw', 'org.tw',
  'com.hk', 'org.hk',
  'com.sg', 'org.sg',
  'co.id', 'or.id',
  'co.th', 'or.th',
  'com.ar', 'org.ar',
  'com.co', 'org.co',
  'com.tr', 'org.tr',
  'co.il', 'org.il',
  'com.pl', 'org.pl',
  'com.ua', 'org.ua',
  'com.vn', 'org.vn',
])

function isSubdomain(domain: string): boolean {
  const parts = domain.split('.')
  if (parts.length <= 2) return false
  const lastTwo = parts.slice(-2).join('.')
  const effectiveLength = MULTI_PART_TLDS.has(lastTwo)
    ? parts.length - 1
    : parts.length
  if (effectiveLength <= 2) return false
  if (effectiveLength === 3 && parts[0] === 'www') return false
  return true
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
