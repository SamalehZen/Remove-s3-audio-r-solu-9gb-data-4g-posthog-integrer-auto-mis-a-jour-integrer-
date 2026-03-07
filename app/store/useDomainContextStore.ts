import { create } from 'zustand'

interface DomainInfo {
  slug: string
  name: string
  nameFr: string | null
  icon: string
  description: string | null
  descriptionFr: string | null
}

interface DomainContextState {
  domains: DomainInfo[]
  selectedSlug: string | null
  isLoading: boolean
  loadDomains: () => Promise<void>
  loadUserDomain: () => Promise<void>
  setUserDomain: (slug: string | null) => Promise<void>
}

export const useDomainContextStore = create<DomainContextState>((set) => ({
  domains: [],
  selectedSlug: null,
  isLoading: true,

  loadDomains: async () => {
    set({ isLoading: true })
    try {
      const domains = await window.api.domainContexts.list()
      set({ domains, isLoading: false })
    } catch (error) {
      console.error('[DomainContext] Failed to load domains:', error)
      set({ isLoading: false })
    }
  },

  loadUserDomain: async () => {
    try {
      const slug = await window.api.domainContexts.getUserDomain()
      set({ selectedSlug: slug })
    } catch (error) {
      console.error('[DomainContext] Failed to load user domain:', error)
    }
  },

  setUserDomain: async (slug: string | null) => {
    try {
      await window.api.domainContexts.setUserDomain(slug)
      set({ selectedSlug: slug })
    } catch (error) {
      console.error('[DomainContext] Failed to set user domain:', error)
    }
  },
}))
