import { create } from 'zustand'

export type MatchType = 'app' | 'domain'

export type AppTarget = {
  id: string
  userId: string
  name: string
  matchType: MatchType
  domain: string | null
  toneId: string | null
  iconBase64: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

type AppStylingState = {
  appTargets: Record<string, AppTarget>
  isLoading: boolean

  loadAppTargets: () => Promise<void>
  deleteAppTarget: (appId: string) => Promise<void>
  getCurrentAppTarget: () => Promise<AppTarget | null>
}

export const useAppStylingStore = create<AppStylingState>(set => ({
  appTargets: {},
  isLoading: false,

  loadAppTargets: async () => {
    set({ isLoading: true })
    try {
      const targets = await window.api.appTargets.list()
      set({
        appTargets: targets.reduce(
          (acc: Record<string, AppTarget>, t: AppTarget) => {
            acc[t.id] = t
            return acc
          },
          {},
        ),
      })
    } catch (error) {
      console.error('Failed to load app targets:', error)
    } finally {
      set({ isLoading: false })
    }
  },

  deleteAppTarget: async (appId: string) => {
    try {
      await window.api.appTargets.delete(appId)
      set(state => {
        const { [appId]: _, ...rest } = state.appTargets
        return { appTargets: rest }
      })
    } catch (error) {
      console.error('Failed to delete app target:', error)
    }
  },

  getCurrentAppTarget: async () => {
    try {
      return await window.api.appTargets.getCurrent()
    } catch (error) {
      console.error('Failed to get current app target:', error)
      return null
    }
  },
}))
