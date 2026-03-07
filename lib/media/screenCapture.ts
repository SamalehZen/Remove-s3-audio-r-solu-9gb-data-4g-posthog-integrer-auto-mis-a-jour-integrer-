import { desktopCapturer, screen } from 'electron'

export type CaptureMode = 'fullscreen' | 'active_window'
export type CaptureFormat = 'png' | 'jpeg'

export interface ScreenCaptureResult {
  base64: string
  thumbnailBase64: string
  width: number
  height: number
  mimeType: string
}

export async function captureScreen(
  mode: CaptureMode = 'fullscreen',
  options?: { format?: CaptureFormat; maxWidth?: number; quality?: number },
): Promise<ScreenCaptureResult | null> {
  try {
    const sources = await desktopCapturer.getSources({
      types: mode === 'active_window' ? ['window', 'screen'] : ['screen'],
      thumbnailSize: getThumbnailSize(),
    })

    if (!sources || sources.length === 0) {
      console.warn('[screenCapture] No capture sources found')
      return null
    }

    const source = sources[0]
    const thumbnail = source.thumbnail

    if (thumbnail.isEmpty()) {
      console.warn('[screenCapture] Captured thumbnail is empty')
      return null
    }

    const format = options?.format || 'png'
    const maxWidth = options?.maxWidth || 1920
    const jpegQuality = options?.quality || 80

    const resized =
      thumbnail.getSize().width > maxWidth
        ? thumbnail.resize({ width: maxWidth })
        : thumbnail

    const imageBuffer = format === 'jpeg'
      ? resized.toJPEG(jpegQuality)
      : resized.toPNG()
    const base64 = imageBuffer.toString('base64')
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png'

    console.log(
      `[screenCapture] Captured ${mode} (${format}): ${resized.getSize().width}x${resized.getSize().height}, ${Math.round(imageBuffer.length / 1024)}KB`,
    )

    const thumbImg = resized.resize({ width: 120 })
    const thumbnailBase64 = thumbImg.toPNG().toString('base64')

    return {
      base64,
      thumbnailBase64,
      width: resized.getSize().width,
      height: resized.getSize().height,
      mimeType,
    }
  } catch (error) {
    console.error('[screenCapture] Failed to capture screen:', error)
    return null
  }
}

function getThumbnailSize(): { width: number; height: number } {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.size
  const scale = Math.min(1, 1920 / width)
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  }
}
