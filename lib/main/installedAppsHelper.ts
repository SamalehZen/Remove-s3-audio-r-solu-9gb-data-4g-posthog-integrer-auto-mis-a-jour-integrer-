import { shell, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

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

export async function listInstalledAppsWithIcons(): Promise<InstalledAppInfo[]> {
  const platform = process.platform
  if (platform === 'win32') return listWindowsApps()
  if (platform === 'darwin') return listMacApps()
  if (platform === 'linux') return listLinuxApps()
  return []
}

async function listWindowsApps(): Promise<InstalledAppInfo[]> {
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
  const apps: InstalledAppInfo[] = []
  const seen = new Set<string>()
  for (const dir of startMenuDirs) {
    const lnkFiles = findLnkFilesRecursive(dir)
    for (const lnkFile of lnkFiles) {
      try {
        const details = shell.readShortcutLink(lnkFile)
        if (!details.target || !details.target.toLowerCase().endsWith('.exe'))
          continue
        const name = path.basename(lnkFile, '.lnk')
        const lowerName = name.toLowerCase()
        if (seen.has(lowerName)) continue
        if (BLOCKED_NAMES.some(b => lowerName.includes(b))) continue
        if (NOISE_PATTERNS.some(p => p.test(name))) continue
        seen.add(lowerName)
        let iconBase64: string | null = null
        try {
          const nativeImage = await app.getFileIcon(details.target, {
            size: 'large',
          })
          iconBase64 = nativeImage.toPNG().toString('base64')
        } catch {}
        apps.push({ name, exePath: details.target, bundleId: null, iconBase64 })
      } catch {}
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name))
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

async function listMacApps(): Promise<InstalledAppInfo[]> {
  const dirs = [
    '/Applications',
    `${process.env.HOME}/Applications`,
    '/System/Applications',
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

async function listLinuxApps(): Promise<InstalledAppInfo[]> {
  try {
    const entries = fs
      .readdirSync('/usr/share/applications')
      .filter(e => e.endsWith('.desktop'))
    const apps: InstalledAppInfo[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      try {
        const content = fs.readFileSync(
          path.join('/usr/share/applications', entry),
          'utf-8',
        )
        const nameMatch = content.match(/^Name=(.+)$/m)
        const execMatch = content.match(/^Exec=(\S+)/)
        if (!nameMatch) continue
        const name = nameMatch[1]
        if (
          seen.has(name.toLowerCase()) ||
          BLOCKED_NAMES.some(b => name.toLowerCase().includes(b))
        )
          continue
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
    return apps.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}
