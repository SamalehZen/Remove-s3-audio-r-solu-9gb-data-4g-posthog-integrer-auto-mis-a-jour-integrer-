import { app, Menu, Tray, nativeImage, powerMonitor, screen } from 'electron'
import { join } from 'path'
import { audioRecorderService } from '../media/audio'
import store, { SettingsStore } from './store'
import { STORE_KEYS } from '../constants/store-keys'
import { createAppWindow, mainWindow, setIsQuitting } from './app'
import { voiceInputService } from './voiceInputService'

let tray: Tray | null = null
const TRAY_GUID = '7c6b7a2e-0d7e-4a4a-9d3d-2a3d9b6f2b10'
const TRAY_HEIGHT = 16
const TRAY_HEALTH_CHECK_MS = process.platform === 'win32' ? 30_000 : 3 * 60 * 1000
const TRAY_FORCE_RECREATE_MS = 5 * 60 * 1000
let trayHealthTimer: ReturnType<typeof setInterval> | null = null
let cachedTrayImage: Electron.NativeImage | null = null
let isRecreating = false
let lastForceRecreateTs = 0

function getTrayIconPath(): string {
  if (!app.isPackaged) {
    return join(__dirname, '../../resources/build/ito-logo.png')
  }
  return join(process.resourcesPath, 'build', 'ito-logo.png')
}

function buildTrayImage(): Electron.NativeImage {
  if (cachedTrayImage && !cachedTrayImage.isEmpty()) return cachedTrayImage

  const iconPath = getTrayIconPath()
  let image = nativeImage.createFromPath(iconPath)

  if (image.isEmpty()) {
    if (process.platform === 'darwin') {
      image = nativeImage.createFromNamedImage('NSImageNameStatusAvailable')
    } else {
      const fallbackPath = !app.isPackaged
        ? join(__dirname, '../../resources/build/icon.png')
        : join(process.resourcesPath, 'build', 'icon.png')
      image = nativeImage.createFromPath(fallbackPath)
      if (!image.isEmpty()) {
        console.warn('[Tray] ito-logo.png missing, using app icon fallback')
      } else {
        console.error('[Tray] No icon files found for system tray')
        return image
      }
    }
  }

  cachedTrayImage = image.resize({ height: TRAY_HEIGHT })
  return cachedTrayImage
}

async function buildMicrophoneSubmenu(): Promise<
  Electron.MenuItemConstructorOptions[]
> {
  const settings = store.get(STORE_KEYS.SETTINGS) as SettingsStore
  const currentDeviceId = settings.microphoneDeviceId

  let devices: string[] = []
  try {
    devices = await audioRecorderService.getDeviceList()
  } catch {
    devices = []
  }

  const onSelect = (deviceId: string, label: string) => {
    const prev = store.get(STORE_KEYS.SETTINGS) as SettingsStore
    const updated: SettingsStore = {
      ...prev,
      microphoneDeviceId: deviceId,
      microphoneName: label,
    }
    store.set(STORE_KEYS.SETTINGS, updated)
    voiceInputService.handleMicrophoneChanged(deviceId)
    void rebuildTrayMenu()
  }

  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Auto-detect',
      type: 'radio',
      checked: currentDeviceId === 'default',
      click: () => onSelect('default', 'Auto-detect'),
    },
  ]

  for (const deviceName of devices) {
    items.push({
      label: deviceName,
      type: 'radio',
      checked: currentDeviceId === deviceName,
      click: () => onSelect(deviceName, deviceName),
    })
  }

  items.push({ type: 'separator' })
  items.push({
    label: 'Refresh devices',
    click: () => {
      void rebuildTrayMenu()
    },
  })

  return items
}

async function rebuildTrayMenu(): Promise<void> {
  if (!tray || tray.isDestroyed()) return

  try {
    const micSubmenu = await buildMicrophoneSubmenu()

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Open Dashboard',
        click: () => {
          if (!mainWindow) {
            createAppWindow()
          } else {
            if (process.platform === 'win32') {
              mainWindow.setSkipTaskbar(false)
            }
            if (!mainWindow.isVisible()) mainWindow.show()
            mainWindow.focus()
          }
        },
      },
      {
        label: 'Select Microphone',
        submenu: micSubmenu,
      },
      { type: 'separator' },
      {
        label: 'Quit Ito',
        click: () => {
          setIsQuitting(true)
          app.quit()
        },
      },
    ]

    if (tray && !tray.isDestroyed()) {
      const menu = Menu.buildFromTemplate(template)
      tray.setContextMenu(menu)
    }
  } catch (err) {
    console.error('[Tray] Failed to rebuild menu:', err)
  }
}

export async function createAppTray(): Promise<void> {
  if (tray) return

  const trayImage = buildTrayImage()
  if (trayImage.isEmpty()) {
    console.error('[Tray] Cannot create tray with empty icon, will retry on next health check')
    startTrayHealthCheck()
    return
  }

  tray = new Tray(trayImage, TRAY_GUID)
  tray.setToolTip('Ito')

  await rebuildTrayMenu()

  if (process.platform !== 'darwin') {
    tray.on('click', async () => {
      try {
        await rebuildTrayMenu()
        if (tray && !tray.isDestroyed()) tray.popUpContextMenu()
      } catch (err) {
        console.error('[Tray] Click handler error:', err)
      }
    })

    tray.on('right-click', async () => {
      try {
        await rebuildTrayMenu()
        if (tray && !tray.isDestroyed()) tray.popUpContextMenu()
      } catch (err) {
        console.error('[Tray] Right-click handler error:', err)
      }
    })
  }

  startTrayHealthCheck()
}

function isTrayAlive(): boolean {
  try {
    return tray !== null && !tray.isDestroyed()
  } catch {
    return false
  }
}

function pingTray(): boolean {
  if (!isTrayAlive() || !cachedTrayImage) return false
  try {
    tray!.setImage(cachedTrayImage)
    return true
  } catch {
    return false
  }
}

function safeDestroyTray(): void {
  if (tray) {
    try { tray.destroy() } catch { /* already gone */ }
  }
  tray = null
  cachedTrayImage = null
}

async function ensureTrayAlive(): Promise<void> {
  if (isRecreating) return
  isRecreating = true
  try {
    if (process.platform === 'win32') {
      const needsForceRecreate = Date.now() - lastForceRecreateTs > TRAY_FORCE_RECREATE_MS

      if (needsForceRecreate || !pingTray()) {
        if (needsForceRecreate) {
          console.log('[Tray] Forced periodic recreation (Windows Shell safeguard)')
        } else {
          console.warn('[Tray] Tray icon lost or unresponsive, recreating...')
        }
        lastForceRecreateTs = Date.now()
        safeDestroyTray()
        await createAppTray()
      }
    } else {
      if (!isTrayAlive()) {
        console.warn('[Tray] Tray icon lost, recreating...')
        tray = null
        await createAppTray()
      }
    }
  } finally {
    isRecreating = false
  }
}

function startTrayHealthCheck(): void {
  if (trayHealthTimer) return

  lastForceRecreateTs = Date.now()

  trayHealthTimer = setInterval(() => {
    ensureTrayAlive().catch(err =>
      console.error('[Tray] Health check failed:', err),
    )
  }, TRAY_HEALTH_CHECK_MS)

  powerMonitor.on('resume', () => {
    console.log('[Tray] System resumed, checking tray...')
    ensureTrayAlive().catch(err =>
      console.error('[Tray] Resume restore failed:', err),
    )
  })

  powerMonitor.on('unlock-screen', () => {
    console.log('[Tray] Screen unlocked, checking tray...')
    ensureTrayAlive().catch(err =>
      console.error('[Tray] Unlock restore failed:', err),
    )
  })

  if (process.platform === 'win32') {
    let displayDebounce: ReturnType<typeof setTimeout> | null = null

    const onDisplayChange = (reason: string) => {
      if (displayDebounce) clearTimeout(displayDebounce)
      displayDebounce = setTimeout(() => {
        displayDebounce = null
        console.log(`[Tray] ${reason}, verifying tray...`)
        lastForceRecreateTs = 0
        ensureTrayAlive().catch(err =>
          console.error('[Tray] Display-change restore failed:', err),
        )
      }, 2000)
    }

    screen.on('display-added', () => onDisplayChange('Display added'))
    screen.on('display-removed', () => onDisplayChange('Display removed'))
    screen.on('display-metrics-changed', () => onDisplayChange('Display metrics changed'))
  }
}

export function destroyAppTray(): void {
  if (trayHealthTimer) {
    clearInterval(trayHealthTimer)
    trayHealthTimer = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
  cachedTrayImage = null
}
