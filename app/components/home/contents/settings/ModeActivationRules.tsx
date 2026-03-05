import { useState, useEffect, useMemo } from 'react'
import {
  useCustomModesStore,
  type CustomMode,
  type InstalledAppInfo,
} from '@/app/store/useCustomModesStore'
import { Plus, X, Search, Globe } from '@mynaui/icons-react'
import AppWindowIcon from '@/app/components/icons/AppWindowIcon'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/app/components/ui/dialog'
import { Button } from '@/app/components/ui/button'

function extractDomain(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = new URL(
      trimmed.startsWith('http') ? trimmed : `https://${trimmed}`,
    )
    return url.hostname
  } catch {
    if (
      trimmed.includes('.') &&
      !trimmed.includes(' ') &&
      trimmed.length >= 3
    ) {
      return trimmed.toLowerCase()
    }
    return null
  }
}

type Props = { mode: CustomMode }

export function ModeActivationRules({ mode }: Props) {
  const {
    rulesByMode,
    installedApps,
    isLoadingApps,
    loadRules,
    addRule,
    deleteRule,
    loadInstalledApps,
  } = useCustomModesStore()

  const rules = rulesByMode[mode.id] || []
  const appRules = rules.filter(r => r.ruleType === 'app')
  const domainRules = rules.filter(r => r.ruleType === 'domain')

  const [appPickerOpen, setAppPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [domainInput, setDomainInput] = useState('')

  useEffect(() => {
    loadRules(mode.id)
    if (installedApps.length === 0 && !isLoadingApps) {
      loadInstalledApps()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.id])

  const filteredApps = useMemo(() => {
    if (!search.trim()) return installedApps
    const lower = search.toLowerCase()
    return installedApps.filter(a => a.name.toLowerCase().includes(lower))
  }, [installedApps, search])

  const handleOpenAppPicker = () => {
    setSearch('')
    setAppPickerOpen(true)
  }

  const handleAddApp = async (app: InstalledAppInfo) => {
    await addRule({
      modeId: mode.id,
      ruleType: 'app',
      value: app.exePath || app.bundleId || app.name,
      appName: app.name,
      iconBase64: app.iconBase64 ?? undefined,
    })
    setAppPickerOpen(false)
  }

  const handleAddDomain = async () => {
    const domain = extractDomain(domainInput)
    if (!domain) return
    await addRule({ modeId: mode.id, ruleType: 'domain', value: domain })
    setDomainInput('')
  }

  const parsedDomain = extractDomain(domainInput)

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium text-[var(--color-subtext)]">
        Activate when using
      </p>

      {/* App chips row */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleOpenAppPicker}
          className="w-16 h-16 rounded-xl border-2 border-dashed border-blue-300 flex flex-col items-center justify-center gap-1 hover:border-blue-400 hover:bg-blue-50 transition-colors"
        >
          <Plus className="w-5 h-5 text-blue-500" />
          <span className="text-[10px] text-[var(--color-subtext)]">
            Add App
          </span>
        </button>

        {appRules.map(rule => (
          <div key={rule.id} className="relative group">
            <div className="flex flex-col items-center gap-1 w-16">
              <div className="relative w-12 h-12 rounded-xl bg-[var(--color-muted-bg)] flex items-center justify-center overflow-visible">
                <div className="w-12 h-12 rounded-xl bg-[var(--color-muted-bg)] flex items-center justify-center overflow-hidden">
                  {rule.iconBase64 ? (
                    <img
                      src={`data:image/png;base64,${rule.iconBase64}`}
                      className="w-10 h-10 rounded"
                      alt={rule.appName || rule.value}
                    />
                  ) : (
                    <AppWindowIcon className="w-6 h-6 text-[var(--color-subtext)]" />
                  )}
                </div>
                <button
                  onClick={() => deleteRule(rule.id, mode.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                >
                  <X className="w-3 h-3 text-white" />
                </button>
              </div>
              <span className="text-[10px] text-[var(--color-subtext)] truncate w-full text-center">
                {rule.appName || rule.value}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Domain section */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 bg-white border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:border-transparent"
            placeholder="e.g. example.com"
            value={domainInput}
            onChange={e => setDomainInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAddDomain()
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleAddDomain}
            disabled={!parsedDomain}
          >
            Add website
          </Button>
        </div>

        {domainRules.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {domainRules.map(rule => (
              <div
                key={rule.id}
                className="flex items-center gap-1 bg-[var(--color-muted-bg)] rounded-full px-2.5 py-1 text-xs"
              >
                <Globe className="w-3 h-3 text-[var(--color-subtext)]" />
                <span>{rule.value}</span>
                <button
                  onClick={() => deleteRule(rule.id, mode.id)}
                  className="ml-0.5 hover:text-red-500 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* App Picker Dialog */}
      <Dialog open={appPickerOpen} onOpenChange={setAppPickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Application</DialogTitle>
            <DialogDescription>
              Choose an app to activate this mode automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-subtext)]" />
            <input
              className="w-full bg-[var(--color-surface,white)] border border-[var(--border)] rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              placeholder="Search applications..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
          </div>

          <div className="max-h-[300px] overflow-y-auto -mx-1 px-1">
            {isLoadingApps ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[var(--color-subtext)]">
                <div className="w-4 h-4 border-2 border-warm-300 border-t-warm-600 rounded-full animate-spin" />
                <span className="text-sm">Loading apps...</span>
              </div>
            ) : filteredApps.length === 0 ? (
              <div className="py-8 text-center text-sm text-[var(--color-subtext)]">
                {search ? 'No apps match your search' : 'No apps found'}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3 p-1">
                {filteredApps.map(app => (
                  <button
                    key={app.name}
                    onClick={() => handleAddApp(app)}
                    className="flex flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-[var(--color-muted-bg)] transition-colors"
                  >
                    <div className="w-12 h-12 rounded-lg bg-[var(--color-muted-bg)] flex items-center justify-center overflow-hidden">
                      {app.iconBase64 ? (
                        <img
                          src={`data:image/png;base64,${app.iconBase64}`}
                          alt={app.name}
                          className="w-10 h-10 rounded"
                        />
                      ) : (
                        <AppWindowIcon className="w-6 h-6 text-[var(--color-subtext)]" />
                      )}
                    </div>
                    <span className="text-xs text-center truncate w-full">
                      {app.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
