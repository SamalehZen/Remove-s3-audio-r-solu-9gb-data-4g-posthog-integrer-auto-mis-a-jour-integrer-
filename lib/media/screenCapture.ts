import { desktopCapturer, screen } from 'electron'

export type CaptureMode = 'fullscreen' | 'active_window'

export interface ScreenCaptureResult {
  base64: string
  thumbnailBase64: string
  width: number
  height: number
}

export async function captureScreen(
  mode: CaptureMode = 'fullscreen',
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

    const resized =
      thumbnail.getSize().width > 1280
        ? thumbnail.resize({ width: 1280 })
        : thumbnail

    const pngBuffer = resized.toPNG()
    const base64 = pngBuffer.toString('base64')

    console.log(
      `[screenCapture] Captured ${mode}: ${resized.getSize().width}x${resized.getSize().height}, ${Math.round(pngBuffer.length / 1024)}KB`,
    )

    const thumbImg = resized.resize({ width: 120 })
    const thumbnailBase64 = thumbImg.toPNG().toString('base64')

    return {
      base64,
      thumbnailBase64,
      width: resized.getSize().width,
      height: resized.getSize().height,
    }
  } catch (error) {
    console.error('[screenCapture] Failed to capture screen:', error)
    return null
  }
}

function getThumbnailSize(): { width: number; height: number } {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.size
  const scale = Math.min(1, 1280 / width)
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  }
}
