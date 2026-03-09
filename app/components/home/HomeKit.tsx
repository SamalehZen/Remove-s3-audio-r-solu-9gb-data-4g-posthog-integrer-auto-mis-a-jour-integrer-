import {
  House,
  BookOpen,
  FileText,
  Sparkle,
  GearSix,
  Info,
  SidebarSimple,
} from '@phosphor-icons/react'
import { ItoIcon } from '../icons/ItoIcon'
import { useMainStore } from '@/app/store/useMainStore'
import { Dialog, DialogContent } from '../ui/dialog'
import { useUserMetadataStore } from '@/app/store/useUserMetadataStore'
import { useOnboardingStore } from '@/app/store/useOnboardingStore'
import { useAuth } from '@/app/components/auth/useAuth'
import { useBilling } from '@/app/contexts/BillingContext'
import { PaidStatus } from '@/lib/main/sqlite/models'
import { useEffect, useState, useRef } from 'react'
import { NavItem } from '../ui/nav-item'
import { Badge } from '../ui/badge'
import { Separator } from '../ui/separator'
import HomeContent from './contents/HomeContent'
import DictionaryContent from './contents/DictionaryContent'
import NotesContent from './contents/NotesContent'
import SettingsContent from './contents/SettingsContent'
import AboutContent from './contents/AboutContent'
import AppStylingContent from './contents/AppStylingContent'

export default function HomeKit() {
  const { navExpanded, currentPage, setCurrentPage, toggleNavExpanded } =
    useMainStore()
  const { metadata } = useUserMetadataStore()
  const { onboardingCompleted } = useOnboardingStore()
  const { isAuthenticated, user } = useAuth()
  const billingState = useBilling()
  const [showText, setShowText] = useState(navExpanded)
  const hasStartedTrialRef = useRef(false)
  const previousUserIdRef = useRef<string | undefined>(undefined)
  const [isStartingTrial, setIsStartingTrial] = useState(false)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const isInitialRender = useRef(true)

  const isPro =
    metadata?.paid_status === PaidStatus.PRO ||
    metadata?.paid_status === PaidStatus.PRO_TRIAL ||
    billingState.proStatus === 'active_pro' ||
    billingState.proStatus === 'free_trial'

  useEffect(() => {
    const currentUserId = user?.id
    const previousUserId = previousUserIdRef.current

    if (currentUserId && currentUserId !== previousUserId) {
      hasStartedTrialRef.current = false
      setIsStartingTrial(false)
      previousUserIdRef.current = currentUserId
    } else if (currentUserId && previousUserId === undefined) {
      previousUserIdRef.current = currentUserId
    }
  }, [user?.id])

  useEffect(() => {
    if (billingState.isLoading || !isAuthenticated) return
    if (!onboardingCompleted) return

    const hasTrialOrSubscription =
      billingState.proStatus === 'free_trial' ||
      billingState.proStatus === 'active_pro' ||
      isPro

    if (!hasStartedTrialRef.current && !hasTrialOrSubscription) {
      hasStartedTrialRef.current = true
      setIsStartingTrial(true)
      window.api.trial.startAfterOnboarding().catch(err => {
        console.error('Failed to start trial:', err)
        hasStartedTrialRef.current = false
        setIsStartingTrial(false)
      })
    }
  }, [
    onboardingCompleted,
    isAuthenticated,
    billingState.isLoading,
    billingState.proStatus,
    isPro,
  ])

  const billingRefreshRef = useRef(billingState.refresh)
  useEffect(() => {
    billingRefreshRef.current = billingState.refresh
  }, [billingState.refresh])

  useEffect(() => {
    const offTrialStarted = window.api.on('trial-started', async () => {
      await billingRefreshRef.current()
      setIsStartingTrial(false)
    })
    return () => {
      offTrialStarted?.()
    }
  }, [])

  useEffect(() => {
    if (!onboardingCompleted) {
      hasStartedTrialRef.current = false
      setIsStartingTrial(false)
    }
  }, [onboardingCompleted])

  useEffect(() => {
    const offSuccess = window.api.on(
      'billing-session-completed',
      async (sessionId: string) => {
        try {
          if (sessionId) {
            await window.api.billing.confirmSession(sessionId)
          }
          await window.api.trial.complete()
        } catch (err) {
          console.error('Failed to finalize billing session', err)
        }
      },
    )

    const offCancel = window.api.on('billing-session-cancelled', () => {})

    return () => {
      offSuccess?.()
      offCancel?.()
    }
  }, [])

  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false
      return
    }
    setIsTransitioning(true)
    const timer = setTimeout(() => {
      setIsTransitioning(false)
    }, 250)
    return () => clearTimeout(timer)
  }, [navExpanded])

  useEffect(() => {
    if (navExpanded) {
      const timer = setTimeout(() => {
        setShowText(true)
      }, 75)
      return () => clearTimeout(timer)
    } else {
      setShowText(false)
      return () => {}
    }
  }, [navExpanded])

  const isSettingsOpen = currentPage === 'settings'

  const renderContent = () => {
    switch (currentPage) {
      case 'home':
      case 'settings':
        return <HomeContent isStartingTrial={isStartingTrial} />
      case 'dictionary':
        return <DictionaryContent />
      case 'notes':
        return <NotesContent />
      case 'app-styling':
        return <AppStylingContent />
      case 'about':
        return <AboutContent />
      default:
        return <HomeContent />
    }
  }

  return (
    <div className="flex h-full bg-sidebar-background">
      <div
        className={`${navExpanded ? 'w-56' : 'w-[68px]'} flex flex-col justify-between py-4 px-3 transition-all duration-200 ease-in-out flex-shrink-0`}
        style={{ willChange: isTransitioning ? 'width' : 'auto' }}
      >
        <div>
          <div className="flex items-center px-3 mb-8 h-10">
            <div className="w-6 flex items-center justify-center flex-shrink-0">
              <ItoIcon
                className="w-6 text-white"
                style={{ height: '28px' }}
              />
            </div>
            <div
              className={`flex items-center gap-2 transition-opacity duration-100 ${showText ? 'opacity-100 ml-3' : 'opacity-0 w-0 overflow-hidden'}`}
            >
              <span className="text-xl font-bold tracking-tight text-white">ito</span>
              {isPro && (
                <Badge className="bg-gradient-to-r from-indigo-400 to-violet-400 text-white border-0 text-[10px] px-1.5 py-0 font-semibold">
                  PRO
                </Badge>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-0.5 text-[13px]">
            <NavItem
              icon={<House size={20} weight={currentPage === 'home' ? 'fill' : 'regular'} />}
              label="Home"
              isActive={currentPage === 'home'}
              showText={showText}
              onClick={() => setCurrentPage('home')}
            />
            <NavItem
              icon={<BookOpen size={20} weight={currentPage === 'dictionary' ? 'fill' : 'regular'} />}
              label="Dictionary"
              isActive={currentPage === 'dictionary'}
              showText={showText}
              onClick={() => setCurrentPage('dictionary')}
            />
            <NavItem
              icon={<FileText size={20} weight={currentPage === 'notes' ? 'fill' : 'regular'} />}
              label="Notes"
              isActive={currentPage === 'notes'}
              showText={showText}
              onClick={() => setCurrentPage('notes')}
            />

            <Separator className="my-2 bg-white/10" />

            <NavItem
              icon={<Sparkle size={20} weight={currentPage === 'app-styling' ? 'fill' : 'regular'} />}
              label="App Styling"
              isActive={currentPage === 'app-styling'}
              showText={showText}
              onClick={() => setCurrentPage('app-styling')}
            />
            <NavItem
              icon={<GearSix size={20} weight={currentPage === 'settings' ? 'fill' : 'regular'} />}
              label="Settings"
              isActive={currentPage === 'settings'}
              showText={showText}
              onClick={() => setCurrentPage('settings')}
            />
            <NavItem
              icon={<Info size={20} weight={currentPage === 'about' ? 'fill' : 'regular'} />}
              label="About"
              isActive={currentPage === 'about'}
              showText={showText}
              onClick={() => setCurrentPage('about')}
            />
          </div>
        </div>

        <div className="text-[13px]">
          <NavItem
            icon={<SidebarSimple size={20} />}
            label={navExpanded ? 'Collapse' : 'Expand'}
            showText={showText}
            onClick={toggleNavExpanded}
          />
        </div>
      </div>

      <div className="flex-1 bg-background rounded-xl my-2 mr-2 shadow-sm overflow-hidden flex flex-col border border-border">
        <div className="flex-1 overflow-y-auto">{renderContent()}</div>
      </div>

      <Dialog
        open={isSettingsOpen}
        onOpenChange={open => {
          if (!open) setCurrentPage('home')
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-w-none sm:max-w-none w-[80vw] h-[80vh] p-0 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.12)] grid-rows-[1fr]"
        >
          <SettingsContent />
        </DialogContent>
      </Dialog>
    </div>
  )
}
