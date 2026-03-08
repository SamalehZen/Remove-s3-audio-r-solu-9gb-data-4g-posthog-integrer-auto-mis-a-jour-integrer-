import { shell, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { friendlyNameFromPackage } from '../utils/uwpAppNames'

export { cleanupAppDisplayName } from '../utils/uwpAppNames'

const execFileAsync = promisify(execFile)

export interface InstalledAppInfo {
  name: string
  exePath: string | null
  bundleId: string | null
  iconBase64: string | null
}

const BLOCKED_NAMES = [
  'electron',
  'ito',
  'uninstall',
  'setup',
  'update',
  'helper',
]
const NOISE_PATTERNS = [
  /uninstall/i,
  /^remove /i,
  /readme/i,
  /release notes/i,
  /documentation/i,
  /license/i,
  /changelog/i,
  /what's new/i,
  /getting started/i,
]

function isBlocked(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    BLOCKED_NAMES.some(b => lower.includes(b)) ||
    NOISE_PATTERNS.some(p => p.test(name))
  )
}

// ---------------------------------------------------------------------------
// Disk cache — avoids rescanning on every call
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30 * 60 * 1000

interface DiskCache {
  timestamp: number
  apps: InstalledAppInfo[]
}

function getCachePath(): string {
  return path.join(app.getPath('userData'), 'installed-apps-cache.json')
}

function readCache(): InstalledAppInfo[] | null {
  try {
    const raw = fs.readFileSync(getCachePath(), 'utf-8')
    const cache: DiskCache = JSON.parse(raw)
    if (Date.now() - cache.timestamp < CACHE_TTL_MS) return cache.apps
  } catch {}
  return null
}

function writeCache(apps: InstalledAppInfo[]): void {
  try {
    const cache: DiskCache = { timestamp: Date.now(), apps }
    fs.writeFileSync(getCachePath(), JSON.stringify(cache), 'utf-8')
  } catch {}
}

export async function listInstalledAppsWithIcons(): Promise<InstalledAppInfo[]> {
  const cached = readCache()
  if (cached) return cached

  const platform = process.platform
  let apps: InstalledAppInfo[] = []
  if (platform === 'win32') apps = await listWindowsApps()
  else if (platform === 'darwin') apps = await listMacApps()
  else if (platform === 'linux') apps = await listLinuxApps()

  if (apps.length > 0) writeCache(apps)
  return apps
}

// ---------------------------------------------------------------------------
// Windows: .lnk shortcuts + SystemApps manifest + registry UWP packages
// Zero PowerShell — only native reg.exe and filesystem reads.
// ---------------------------------------------------------------------------

async function listWindowsApps(): Promise<InstalledAppInfo[]> {
  const seen = new Set<string>()
  const apps: InstalledAppInfo[] = []

  const addApp = (info: InstalledAppInfo) => {
    const lower = info.name.toLowerCase()
    if (seen.has(lower)) return
    if (isBlocked(info.name)) return
    seen.add(lower)
    apps.push(info)
  }

  await collectWindowsLnkApps(addApp)
  collectWindowsSystemApps(addApp)
  await collectWindowsRegistryUwpApps(addApp)

  return apps.sort((a, b) => a.name.localeCompare(b.name))
}

// Source 1: Start Menu .lnk shortcuts (classic Win32 apps)
async function collectWindowsLnkApps(
  addApp: (info: InstalledAppInfo) => void,
): Promise<void> {
  const startMenuDirs = [
    path.join(
      process.env.PROGRAMDATA || 'C:\\ProgramData',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
    ),
    path.join(
      process.env.APPDATA || '',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
    ),
  ]
  for (const dir of startMenuDirs) {
    const lnkFiles = findLnkFilesRecursive(dir)
    for (const lnkFile of lnkFiles) {
      try {
        const details = shell.readShortcutLink(lnkFile)
        if (!details.target || !details.target.toLowerCase().endsWith('.exe'))
          continue
        const name = path.basename(lnkFile, '.lnk')
        let iconBase64: string | null = null
        try {
          const nativeImage = await app.getFileIcon(details.target, {
            size: 'large',
          })
          iconBase64 = nativeImage.toPNG().toString('base64')
        } catch {}
        addApp({ name, exePath: details.target, bundleId: null, iconBase64 })
      } catch {}
    }
  }
}

// Source 2: C:\Windows\SystemApps — Notepad, Explorer, Calculator, etc.
// Read AppxManifest.xml from each folder to get the DisplayName.
function collectWindowsSystemApps(
  addApp: (info: InstalledAppInfo) => void,
): void {
  const systemAppsDirs = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'SystemApps'),
  ]
  for (const dir of systemAppsDirs) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const manifestPath = path.join(dir, entry.name, 'AppxManifest.xml')
        const raw = fs.readFileSync(manifestPath, 'utf-8')
        let displayName = parseManifestDisplayName(raw)
        if (!displayName) {
          displayName = friendlyNameFromPackage(entry.name)
        }
        if (!displayName) continue
        const packageFamilyName = derivePackageFamilyName(entry.name)
        const iconBase64 = extractUwpIconFromManifest(raw, path.join(dir, entry.name))
        addApp({
          name: displayName,
          exePath: null,
          bundleId: packageFamilyName,
          iconBase64,
        })
      } catch {}
    }
  }
}

// Source 3: Registry — HKCU AppModel Repository lists all UWP packages for
// the current user. Read with reg.exe (tiny native binary, instant, no
// PowerShell overhead).
const UWP_NOISE = [
  /microsoft\.net/i,
  /microsoft\.vclibs/i,
  /microsoft\.ui\./i,
  /microsoft\.services\./i,
  /microsoft\.directx/i,
  /microsoft\.windowsappruntime/i,
  /microsoft\.desktopappinstaller/i,
  /microsoft\.storePurchaseapp/i,
  /microsoft\.windowsstore$/i,
  /microsoft\.549981/i,
  /microsoft\.getstarted/i,
  /microsoft\.MicrosoftEdge\.Stable/i,
  /^AD2F1837/i,
  /^Microsoft\.Advertising/i,
  /^AppUp\.IntelGraphics/i,
  /inputapp/i,
  /^NcsiUwpApp/i,
  /^1527c705-839a/i,
  /^c5e2524a-ea46/i,
  /^E2A4F912-2574/i,
  /^F46D4000-FD22/i,
  /^Microsoft\.AAD\./i,
  /^Microsoft\.AsyncTextService/i,
  /^Microsoft\.BioEnrollment/i,
  /^Microsoft\.CredDialogHost/i,
  /^Microsoft\.ECApp/i,
  /^Microsoft\.LockApp/i,
  /^Microsoft\.MicrosoftEdgeDevToolsClient/i,
  /^Microsoft\.Win32WebViewHost/i,
  /^Microsoft\.Windows\./i,
  /^windows\.immersivecontrolpanel/i,
  /^MicrosoftWindows\./i,
]

async function collectWindowsRegistryUwpApps(
  addApp: (info: InstalledAppInfo) => void,
): Promise<void> {
  const regPath =
    'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages'
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', regPath, '/s', '/v', 'DisplayName'],
      { timeout: 5000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
    )

    let currentKey = ''
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('HKEY_')) {
        currentKey = trimmed
        continue
      }
      const match = trimmed.match(/^DisplayName\s+REG_SZ\s+(.+)/)
      if (!match) continue
      const rawDisplayName = match[1].trim()
      if (!rawDisplayName) continue

      const keyParts = currentKey.split('\\')
      const packageFullName = keyParts[keyParts.length - 1] || ''
      if (UWP_NOISE.some(p => p.test(packageFullName))) continue

      const packageFamilyName = derivePackageFamilyName(packageFullName)
      const friendlyName = friendlyNameFromPackage(packageFullName)
      const displayName = rawDisplayName.startsWith('ms-resource:') ? null : rawDisplayName
      const finalName = friendlyName || displayName
      if (!finalName) continue
      const iconBase64 = await tryExtractUwpIcon(packageFullName)
      addApp({
        name: finalName,
        exePath: null,
        bundleId: packageFamilyName,
        iconBase64,
      })
    }
  } catch (e) {
    console.error('[installedAppsHelper] reg query UWP failed:', e)
  }
}

// Derive PackageFamilyName from a full package key name.
// Full name looks like "Microsoft.WindowsNotepad_11.2408.13.0_x64__8wekyb3d8bbwe"
// Family name is "Microsoft.WindowsNotepad_8wekyb3d8bbwe"
function derivePackageFamilyName(fullName: string): string {
  const parts = fullName.split('_')
  if (parts.length >= 2) {
    const publisher = parts[parts.length - 1]
    return `${parts[0]}_${publisher}`
  }
  return fullName
}

// Parse <DisplayName> from an AppxManifest.xml.
// Skip ms-resource: references — those require MRT and aren't readable.
function parseManifestDisplayName(xml: string): string | null {
  const match = xml.match(/<DisplayName>([^<]+)<\/DisplayName>/)
  if (!match) return null
  const name = match[1].trim()
  if (name.startsWith('ms-resource:')) return null
  return name || null
}

function extractUwpIconFromManifest(
  manifestXml: string,
  packageDir: string,
): string | null {
  try {
    const logoMatch = manifestXml.match(
      /<Logo>([^<]+)<\/Logo>|<uap:VisualElements[^>]+Square44x44Logo="([^"]+)"|<uap:VisualElements[^>]+Square150x150Logo="([^"]+)"/,
    )
    if (!logoMatch) return null
    const logoRelPath = (logoMatch[1] || logoMatch[2] || logoMatch[3]).trim()
    if (logoRelPath.startsWith('ms-resource:')) return null
    const logoDir = path.join(packageDir, path.dirname(logoRelPath))
    const logoBaseName = path.basename(logoRelPath, path.extname(logoRelPath))
    const logoExt = path.extname(logoRelPath)
    const candidates = [
      path.join(packageDir, logoRelPath),
      path.join(logoDir, `${logoBaseName}.scale-200${logoExt}`),
      path.join(logoDir, `${logoBaseName}.scale-100${logoExt}`),
      path.join(logoDir, `${logoBaseName}.scale-150${logoExt}`),
      path.join(logoDir, `${logoBaseName}.targetsize-256${logoExt}`),
      path.join(logoDir, `${logoBaseName}.targetsize-128${logoExt}`),
      path.join(logoDir, `${logoBaseName}.targetsize-64${logoExt}`),
      path.join(logoDir, `${logoBaseName}.targetsize-48${logoExt}`),
      path.join(logoDir, `${logoBaseName}.targetsize-32${logoExt}`),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const buf = fs.readFileSync(candidate)
        return buf.toString('base64')
      }
    }
    try {
      if (fs.existsSync(logoDir)) {
        const files = fs.readdirSync(logoDir)
        const matching = files
          .filter(f => f.toLowerCase().startsWith(logoBaseName.toLowerCase()) && /\.(png|jpg|jpeg)$/i.test(f))
          .sort((a, b) => {
            const sizeA = parseInt(a.match(/(?:scale|targetsize)-(\d+)/)?.[1] || '0')
            const sizeB = parseInt(b.match(/(?:scale|targetsize)-(\d+)/)?.[1] || '0')
            return sizeB - sizeA
          })
        if (matching.length > 0) {
          const buf = fs.readFileSync(path.join(logoDir, matching[0]))
          return buf.toString('base64')
        }
      }
    } catch {}
  } catch {}
  return null
}

const _dirListCache = new Map<string, string[]>()

function cachedReaddirSync(dir: string): string[] {
  const cached = _dirListCache.get(dir)
  if (cached) return cached
  try {
    const entries = fs.readdirSync(dir)
    _dirListCache.set(dir, entries)
    return entries
  } catch {
    _dirListCache.set(dir, [])
    return []
  }
}

async function tryExtractUwpIcon(packageFullName: string): Promise<string | null> {
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
  const windowsApps = path.join(programFiles, 'WindowsApps')
  const systemApps = path.join(process.env.WINDIR || 'C:\\Windows', 'SystemApps')
  const localAppData = process.env['LOCALAPPDATA'] || ''
  const localPackages = localAppData ? path.join(localAppData, 'Packages') : ''
  const baseName = packageFullName.toLowerCase().split('_')[0]

  for (const baseDir of [systemApps, windowsApps]) {
    try {
      const entries = cachedReaddirSync(baseDir)
      const matched = entries.find(e => {
        const eLower = e.toLowerCase()
        return eLower === packageFullName.toLowerCase() || eLower.startsWith(baseName + '_')
      })
      if (!matched) continue
      const manifestPath = path.join(baseDir, matched, 'AppxManifest.xml')
      if (!fs.existsSync(manifestPath)) continue
      const xml = fs.readFileSync(manifestPath, 'utf-8')
      const icon = extractUwpIconFromManifest(xml, path.join(baseDir, matched))
      if (icon) return icon
    } catch {}
  }

  if (localPackages) {
    try {
      const entries = cachedReaddirSync(localPackages)
      const matched = entries.find(e => e.toLowerCase().startsWith(baseName + '_'))
      if (matched) {
        const pkgDir = path.join(localPackages, matched)
        const localStatePath = path.join(pkgDir, 'LocalState')
        const acDir = path.join(pkgDir, 'AC')
        for (const subDir of [pkgDir, localStatePath, acDir]) {
          try {
            const manifestPath = path.join(subDir, 'AppxManifest.xml')
            if (fs.existsSync(manifestPath)) {
              const xml = fs.readFileSync(manifestPath, 'utf-8')
              const icon = extractUwpIconFromManifest(xml, subDir)
              if (icon) return icon
            }
          } catch {}
        }
      }
    } catch {}
  }

  return null
}

function findLnkFilesRecursive(dir: string): string[] {
  const results: string[] = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) results.push(...findLnkFilesRecursive(fullPath))
      else if (entry.name.toLowerCase().endsWith('.lnk'))
        results.push(fullPath)
    }
  } catch {}
  return results
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

async function listMacApps(): Promise<InstalledAppInfo[]> {
  const dirs = [
    '/Applications',
    `${process.env.HOME}/Applications`,
    '/System/Applications',
    '/System/Applications/Utilities',
  ]
  const apps: InstalledAppInfo[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir).filter(e => e.endsWith('.app'))
    } catch {
      continue
    }
    for (const entry of entries) {
      const name = entry.replace(/\.app$/, '')
      if (
        seen.has(name.toLowerCase()) ||
        BLOCKED_NAMES.some(b => name.toLowerCase().includes(b))
      )
        continue
      seen.add(name.toLowerCase())
      const appPath = path.join(dir, entry)
      let bundleId: string | null = null
      try {
        const { execFileSync } = require('child_process')
        bundleId =
          execFileSync(
            'defaults',
            ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleIdentifier'],
            { timeout: 1000, encoding: 'utf-8' },
          ).trim() || null
      } catch {}
      let iconBase64: string | null = null
      try {
        const nativeImage = await app.getFileIcon(appPath, { size: 'large' })
        iconBase64 = nativeImage.toPNG().toString('base64')
      } catch {}
      apps.push({ name, exePath: appPath, bundleId, iconBase64 })
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Linux: scan multiple .desktop directories (system + user + Flatpak + Snap)
// ---------------------------------------------------------------------------

async function listLinuxApps(): Promise<InstalledAppInfo[]> {
  const desktopDirs = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(process.env.HOME || '', '.local', 'share', 'applications'),
    '/var/lib/flatpak/exports/share/applications',
    path.join(
      process.env.HOME || '',
      '.local',
      'share',
      'flatpak',
      'exports',
      'share',
      'applications',
    ),
    '/var/lib/snapd/desktop/applications',
  ]

  const apps: InstalledAppInfo[] = []
  const seen = new Set<string>()

  for (const dir of desktopDirs) {
    try {
      const entries = fs
        .readdirSync(dir)
        .filter(e => e.endsWith('.desktop'))
      for (const entry of entries) {
        try {
          const content = fs.readFileSync(path.join(dir, entry), 'utf-8')
          const noDisplay = content.match(/^NoDisplay=true$/m)
          if (noDisplay) continue
          const nameMatch = content.match(/^Name=(.+)$/m)
          const execMatch = content.match(/^Exec=(\S+)/m)
          if (!nameMatch) continue
          const name = nameMatch[1]
          if (seen.has(name.toLowerCase()) || isBlocked(name)) continue
          seen.add(name.toLowerCase())
          const exePath = execMatch
            ? execMatch[1].replace(/%[a-zA-Z]/g, '').trim()
            : null
          let iconBase64: string | null = null
          if (exePath) {
            try {
              iconBase64 = (
                await app.getFileIcon(exePath, { size: 'large' })
              )
                .toPNG()
                .toString('base64')
            } catch {}
          }
          apps.push({ name, exePath, bundleId: null, iconBase64 })
        } catch {}
      }
    } catch {}
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name))
}
