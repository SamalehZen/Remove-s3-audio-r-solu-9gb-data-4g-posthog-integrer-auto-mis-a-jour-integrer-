import { create } from 'zustand'

export type CustomMode = {
  id: string
  userId: string
  name: string
  icon: string
  presetType: string
  promptTemplate: string
  language: string
  itoMode: number
  toneId: string | null
  sortOrder: number
  isDefault: boolean
  isSystem: boolean
  playbackWhenRecording: string
  autoPaste: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type ModeActivationRule = {
  id: string
  modeId: string
  userId: string
  ruleType: 'app' | 'domain'
  value: string
  appName: string | null
  iconBase64: string | null
  createdAt: string
}

export type InstalledAppInfo = {
  name: string
  exePath: string | null
  bundleId: string | null
  iconBase64: string | null
}

type CustomModesState = {
  modes: CustomMode[]
  rulesByMode: Record<string, ModeActivationRule[]>
  installedApps: InstalledAppInfo[]
  isLoadingApps: boolean
  isLoading: boolean
  loadModes: () => Promise<void>
  createMode: (data: Partial<CustomMode>) => Promise<CustomMode | null>
  updateMode: (data: Partial<CustomMode> & { id: string }) => Promise<void>
  deleteMode: (id: string) => Promise<void>
  loadRules: (modeId: string) => Promise<void>
  addRule: (data: {
    modeId: string
    ruleType: 'app' | 'domain'
    value: string
    appName?: string
    iconBase64?: string
  }) => Promise<void>
  deleteRule: (ruleId: string, modeId: string) => Promise<void>
  loadInstalledApps: () => Promise<void>
}

export const useCustomModesStore = create<CustomModesState>((set, _get) => ({
  modes: [],
  rulesByMode: {},
  installedApps: [],
  isLoadingApps: false,
  isLoading: false,

  loadModes: async () => {
    set({ isLoading: true })
    try {
      const modes = await window.api.customModes.list()
      set({ modes })
    } catch (e) {
      console.error('Failed to load modes:', e)
    } finally {
      set({ isLoading: false })
    }
  },

  createMode: async data => {
    try {
      const id = crypto.randomUUID()
      const mode = await window.api.customModes.upsert({ ...data, id })
      set(s => ({ modes: [...s.modes, mode] }))
      return mode
    } catch (e) {
      console.error('Failed to create mode:', e)
      return null
    }
  },

  updateMode: async data => {
    try {
      const current = _get().modes.find(m => m.id === data.id)
      const merged = current ? { ...current, ...data } : data
      const mode = await window.api.customModes.upsert(merged)
      set(s => ({ modes: s.modes.map(m => (m.id === mode.id ? mode : m)) }))
    } catch (e) {
      console.error('Failed to update mode:', e)
    }
  },

  deleteMode: async id => {
    try {
      await window.api.customModes.delete(id)
      set(s => ({ modes: s.modes.filter(m => m.id !== id) }))
    } catch (e) {
      console.error('Failed to delete mode:', e)
    }
  },

  loadRules: async modeId => {
    try {
      const rules = await window.api.modeRules.list(modeId)
      set(s => ({ rulesByMode: { ...s.rulesByMode, [modeId]: rules } }))
    } catch (e) {
      console.error('Failed to load rules:', e)
    }
  },

  addRule: async data => {
    try {
      const rule = await window.api.modeRules.add({
        ...data,
        id: crypto.randomUUID(),
      })
      set(s => ({
        rulesByMode: {
          ...s.rulesByMode,
          [data.modeId]: [...(s.rulesByMode[data.modeId] || []), rule],
        },
      }))
    } catch (e) {
      console.error('Failed to add rule:', e)
    }
  },

  deleteRule: async (ruleId, modeId) => {
    try {
      await window.api.modeRules.delete(ruleId)
      set(s => ({
        rulesByMode: {
          ...s.rulesByMode,
          [modeId]: (s.rulesByMode[modeId] || []).filter(r => r.id !== ruleId),
        },
      }))
    } catch (e) {
      console.error('Failed to delete rule:', e)
    }
  },

  loadInstalledApps: async () => {
    set({ isLoadingApps: true })
    try {
      const apps = await window.api.modeRules.listInstalledAppsWithIcons()
      set({ installedApps: apps })
    } catch (e) {
      console.error('Failed to load installed apps:', e)
    } finally {
      set({ isLoadingApps: false })
    }
  },
}))
