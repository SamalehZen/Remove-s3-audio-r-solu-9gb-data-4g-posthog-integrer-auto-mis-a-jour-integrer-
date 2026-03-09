import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Info,
  Copy,
  Check,
  Fire,
  Rocket,
  Trophy,
  Microphone,
  ArrowRight,
  Clock,
  WarningCircle,
} from '@phosphor-icons/react'
import { EXTERNAL_LINKS } from '@/lib/constants/external-links'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { Tooltip, TooltipTrigger, TooltipContent } from '../../ui/tooltip'
import { useAuthStore } from '@/app/store/useAuthStore'
import { Interaction } from '@/lib/main/sqlite/models'
import { ItoMode } from '@/app/generated/ito_pb'
import { getKeyDisplay } from '@/app/utils/keyboard'
import { KeyName } from '@/lib/types/keyboard'
import { usePlatform } from '@/app/hooks/usePlatform'
import { ProUpgradeDialog } from '../ProUpgradeDialog'
import { Button } from '../../ui/button'
import { Badge } from '../../ui/badge'
import { Card, CardContent } from '../../ui/card'
import { Separator } from '../../ui/separator'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog'
import { useBilling } from '@/app/contexts/BillingContext'

interface InteractionStats {
  streakDays: number
  totalWords: number
  averageWPM: number
}

interface HomeContentProps {
  isStartingTrial?: boolean
}

export default function HomeContent({
  isStartingTrial = false,
}: HomeContentProps) {
  const { getItoModeShortcuts } = useSettingsStore()
  const keyboardShortcut = getItoModeShortcuts(ItoMode.TRANSCRIBE)[0].keys
  const { user } = useAuthStore()
  const firstName = user?.name?.split(' ')[0]
  const platform = usePlatform()
  const INTERACTIONS_PAGE_SIZE = 50
  const [interactions, setInteractions] = useState<Interaction[]>([])
  const [loading, setLoading] = useState(true)

  const [visibleCount, setVisibleCount] = useState(INTERACTIONS_PAGE_SIZE)
  const [copiedItems, setCopiedItems] = useState<Set<string>>(new Set())
  const [openTooltipKey, setOpenTooltipKey] = useState<string | null>(null)
  const [stats, setStats] = useState<InteractionStats>({
    streakDays: 0,
    totalWords: 0,
    averageWPM: 0,
  })
  const [showProDialog, setShowProDialog] = useState(false)
  const [showStatsDialog, setShowStatsDialog] = useState(false)
  const billingState = useBilling()

  const [hasShownTrialDialog, setHasShownTrialDialogState] = useState(() => {
    try {
      const authStore = window.electron?.store?.get('auth') || {}
      const value = authStore?.hasShownTrialDialog === true
      return value
    } catch {
      return false
    }
  })

  const setHasShownTrialDialog = useCallback((value: boolean) => {
    try {
      setHasShownTrialDialogState(value)
      window.api.send('electron-store-set', 'auth.hasShownTrialDialog', value)
    } catch {
      console.warn('Failed to persist hasShownTrialDialog flag')
    }
  }, [])

  useEffect(() => {
    if (
      billingState.isTrialActive &&
      billingState.proStatus === 'free_trial' &&
      !hasShownTrialDialog &&
      !billingState.isLoading
    ) {
      setShowProDialog(true)
      setHasShownTrialDialog(true)
    }
  }, [
    billingState.isTrialActive,
    billingState.proStatus,
    billingState.isLoading,
    isStartingTrial,
    hasShownTrialDialog,
    setHasShownTrialDialog,
  ])

  const billingRefreshRef = useRef(billingState.refresh)
  useEffect(() => {
    billingRefreshRef.current = billingState.refresh
  }, [billingState.refresh])

  useEffect(() => {
    const offTrialStarted = window.api.on('trial-started', async () => {
      await billingRefreshRef.current()
    })
    const offBillingSuccess = window.api.on(
      'billing-session-completed',
      async () => {
        await billingRefreshRef.current()
      },
    )
    return () => {
      offTrialStarted?.()
      offBillingSuccess?.()
    }
  }, [])

  useEffect(() => {
    if (billingState.isLoading) {
      return
    }

    const shouldReset =
      billingState.proStatus === 'active_pro' ||
      (billingState.proStatus === 'none' && !billingState.isTrialActive)

    if (shouldReset && hasShownTrialDialog) {
      setHasShownTrialDialog(false)
    }
  }, [
    billingState.proStatus,
    billingState.isTrialActive,
    billingState.isLoading,
    hasShownTrialDialog,
    setHasShownTrialDialog,
  ])

  const calculateStats = useCallback(
    (interactions: Interaction[]): InteractionStats => {
      if (interactions.length === 0) {
        return { streakDays: 0, totalWords: 0, averageWPM: 0 }
      }

      const streakDays = calculateStreak(interactions)
      const totalWords = calculateTotalWords(interactions)
      const averageWPM = calculateAverageWPM(interactions)

      return { streakDays, totalWords, averageWPM }
    },
    [],
  )

  const calculateStreak = (interactions: Interaction[]): number => {
    if (interactions.length === 0) return 0

    const dateGroups = new Map<string, Interaction[]>()
    interactions.forEach(interaction => {
      const date = new Date(interaction.created_at).toDateString()
      if (!dateGroups.has(date)) {
        dateGroups.set(date, [])
      }
      dateGroups.get(date)!.push(interaction)
    })

    const sortedDates = Array.from(dateGroups.keys()).sort(
      (a, b) => new Date(b).getTime() - new Date(a).getTime(),
    )

    let streak = 0
    const today = new Date()

    for (let i = 0; i < sortedDates.length; i++) {
      const currentDate = new Date(sortedDates[i])
      const expectedDate = new Date(today)
      expectedDate.setDate(today.getDate() - i)

      if (currentDate.toDateString() === expectedDate.toDateString()) {
        streak++
      } else {
        break
      }
    }

    return streak
  }

  const calculateTotalWords = (interactions: Interaction[]): number => {
    return interactions.reduce((total, interaction) => {
      const transcript = interaction.asr_output?.transcript?.trim()
      if (transcript) {
        const words = transcript.split(/\s+/).filter(word => word.length > 0)
        return total + words.length
      }
      return total
    }, 0)
  }

  const calculateAverageWPM = (interactions: Interaction[]): number => {
    const validInteractions = interactions.filter(
      interaction =>
        interaction.asr_output?.transcript?.trim() && interaction.duration_ms,
    )

    if (validInteractions.length === 0) return 0

    let totalWords = 0
    let totalDurationMs = 0

    validInteractions.forEach(interaction => {
      const transcript = interaction.asr_output?.transcript?.trim()
      if (transcript && interaction.duration_ms) {
        const words = transcript.split(/\s+/).filter(word => word.length > 0)
        totalWords += words.length
        totalDurationMs += interaction.duration_ms
      }
    })

    if (totalDurationMs === 0) return 0

    const totalMinutes = totalDurationMs / (1000 * 60)
    const wpm = totalWords / totalMinutes

    return Math.round(Math.max(1, wpm))
  }

  const formatStreakText = (days: number): string => {
    if (days === 0) return '0 days'
    if (days === 1) return '1 day'
    if (days < 7) return `${days} days`
    if (days < 14) return '1 week'
    if (days < 30) return `${Math.floor(days / 7)} weeks`
    if (days < 60) return '1 month'
    return `${Math.floor(days / 30)} months`
  }

  const loadInteractions = useCallback(async () => {
    try {
      const allInteractions = await window.api.interactions.getAll()

      const sortedInteractions = allInteractions.sort(
        (a: Interaction, b: Interaction) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      setInteractions(sortedInteractions)

      const calculatedStats = calculateStats(sortedInteractions)
      setStats(calculatedStats)
    } catch (error) {
      console.error('Failed to load interactions:', error)
    } finally {
      setLoading(false)
    }
  }, [calculateStats])

  useEffect(() => {
    loadInteractions()

    const handleInteractionCreated = () => {
      loadInteractions()
    }

    const unsubscribe = window.api.on(
      'interaction-created',
      handleInteractionCreated,
    )

    return unsubscribe
  }, [loadInteractions])

  useEffect(() => {
    setVisibleCount(INTERACTIONS_PAGE_SIZE)
  }, [interactions.length])

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    const today = new Date()
    const yesterday = new Date()
    yesterday.setDate(today.getDate() - 1)

    const isToday = date.toDateString() === today.toDateString()
    const isYesterday = date.toDateString() === yesterday.toDateString()

    if (isToday) return 'Today'
    if (isYesterday) return 'Yesterday'

    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    })
  }

  const groupInteractionsByDate = (interactions: Interaction[]) => {
    const groups: { [key: string]: Interaction[] } = {}

    interactions.forEach(interaction => {
      const dateKey = formatDate(interaction.created_at)
      if (!groups[dateKey]) {
        groups[dateKey] = []
      }
      groups[dateKey].push(interaction)
    })

    return groups
  }

  const getDisplayText = (interaction: Interaction) => {
    if (interaction.asr_output?.error) {
      const code = interaction.asr_output?.errorCode
      if (code === 'CLIENT_TRANSCRIPTION_QUALITY_ERROR') {
        return {
          text: 'Audio quality too low',
          isError: true,
          tooltip:
            'Audio quality was too low to generate a reliable transcript',
        }
      }
      if (
        interaction.asr_output.error.includes('No speech detected in audio.') ||
        interaction.asr_output.error.includes('Unable to transcribe audio.')
      ) {
        return {
          text: 'Audio is silent',
          isError: true,
          tooltip: "Ito didn't detect any words so the transcript is empty",
        }
      }
      return {
        text: 'Transcription failed',
        isError: true,
        tooltip: interaction.asr_output.error,
      }
    }

    const transcript = interaction.asr_output?.transcript?.trim()

    if (!transcript) {
      return {
        text: 'Audio is silent.',
        isError: true,
        tooltip: "Ito didn't detect any words so the transcript is empty",
      }
    }

    return {
      text: transcript,
      isError: false,
      tooltip: null,
    }
  }

  const visibleInteractions = useMemo(
    () => interactions.slice(0, visibleCount),
    [interactions, visibleCount],
  )

  const groupedInteractions = useMemo(
    () => groupInteractionsByDate(visibleInteractions),
    [visibleInteractions],
  )

  const copyToClipboard = async (text: string, interactionId: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedItems(prev => new Set(prev).add(interactionId))
      setOpenTooltipKey(`copy:${interactionId}`)

      setTimeout(() => {
        setCopiedItems(prev => {
          const newSet = new Set(prev)
          newSet.delete(interactionId)
          return newSet
        })
        setOpenTooltipKey(prev =>
          prev === `copy:${interactionId}` ? null : prev,
        )
      }, 2000)
    } catch (error) {
      console.error('Failed to copy text:', error)
    }
  }

  const getGreeting = () => {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning'
    if (hour < 18) return 'Good afternoon'
    return 'Good evening'
  }

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-shrink-0 px-8 lg:px-12 max-w-4xl mx-auto w-full pt-10">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-1">
            {getGreeting()}{firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="text-sm text-muted-foreground">
            Here's your dictation activity overview
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6">
          <Card
            className="gap-0 py-0 cursor-pointer hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-900 transition-all duration-200"
            onClick={() => setShowStatsDialog(true)}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Streak</span>
                <div className="w-8 h-8 rounded-md bg-orange-100 dark:bg-orange-950/40 flex items-center justify-center">
                  <Fire size={16} weight="fill" className="text-orange-500" />
                </div>
              </div>
              <div className="text-xl font-bold tracking-tight">
                {formatStreakText(stats.streakDays)}
              </div>
            </CardContent>
          </Card>

          <Card
            className="gap-0 py-0 cursor-pointer hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-900 transition-all duration-200"
            onClick={() => setShowStatsDialog(true)}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Words</span>
                <div className="w-8 h-8 rounded-md bg-indigo-100 dark:bg-indigo-950/40 flex items-center justify-center">
                  <Rocket size={16} weight="fill" className="text-indigo-500" />
                </div>
              </div>
              <div className="text-xl font-bold tracking-tight">
                {stats.totalWords.toLocaleString()}
              </div>
            </CardContent>
          </Card>

          <Card
            className="gap-0 py-0 cursor-pointer hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-900 transition-all duration-200"
            onClick={() => setShowStatsDialog(true)}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Speed</span>
                <div className="w-8 h-8 rounded-md bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
                  <Trophy size={16} weight="fill" className="text-emerald-500" />
                </div>
              </div>
              <div className="text-xl font-bold tracking-tight">
                {stats.averageWPM} <span className="text-sm font-normal text-muted-foreground">WPM</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="gap-0 py-0 mb-8 overflow-hidden bg-gradient-to-r from-indigo-500 to-violet-500 border-0 text-white">
          <CardContent className="p-0">
            <div className="flex items-center justify-between p-5">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-white/20 backdrop-blur flex items-center justify-center flex-shrink-0">
                  <Microphone size={20} weight="fill" className="text-white" />
                </div>
                <div>
                  <div className="text-sm font-semibold mb-0.5">
                    Voice dictation in any app
                  </div>
                  <div className="text-xs text-white/80 flex items-center gap-1.5 flex-wrap">
                    <span>Hold</span>
                    {keyboardShortcut.map((key, index) => (
                      <React.Fragment key={index}>
                        <kbd className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-mono font-medium bg-white/20 border border-white/20">
                          {getKeyDisplay(key as KeyName, platform, {
                            showDirectionalText: false,
                            format: 'label',
                          })}
                        </kbd>
                        {index < keyboardShortcut.length - 1 && (
                          <span className="text-white/60">+</span>
                        )}
                      </React.Fragment>
                    ))}
                    <span>and speak into any textbox</span>
                  </div>
                </div>
              </div>
              <Button
                size="sm"
                className="gap-1.5 rounded-md bg-white text-indigo-600 hover:bg-white/90 font-semibold shadow-none"
                onClick={() =>
                  window.api?.invoke('web-open-url', EXTERNAL_LINKS.WEBSITE)
                }
              >
                Use cases
                <ArrowRight size={14} />
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-3 mb-4">
          <span className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">
            Recent activity
          </span>
          {interactions.length > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-medium">
              {interactions.length}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex-1 px-8 lg:px-12 max-w-4xl mx-auto w-full overflow-y-auto pb-10">
        {loading ? (
          <Card className="gap-0 py-0 border-border/50">
            <CardContent className="p-8 text-center">
              <div className="flex items-center justify-center gap-2 text-muted-foreground">
                <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
                <span className="text-sm">Loading activity...</span>
              </div>
            </CardContent>
          </Card>
        ) : interactions.length === 0 ? (
          <Card className="gap-0 py-0 border-border/50 border-dashed">
            <CardContent className="p-10 text-center">
              <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mx-auto mb-4">
                <Microphone size={24} className="text-muted-foreground" />
              </div>
              <p className="text-sm font-medium mb-1">No interactions yet</p>
              <p className="text-xs text-muted-foreground">
                Press{' '}
                {keyboardShortcut.map((key, index) => (
                  <React.Fragment key={index}>
                    <kbd className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-mono bg-muted border border-border">
                      {getKeyDisplay(key as KeyName, platform, {
                        showDirectionalText: false,
                        format: 'label',
                      })}
                    </kbd>
                    {index < keyboardShortcut.length - 1 && ' + '}
                  </React.Fragment>
                ))}{' '}
                to start dictating
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-5">
            {Object.entries(groupedInteractions).map(
              ([dateLabel, dateInteractions]) => (
                <div key={dateLabel}>
                  <div className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground mb-2 px-1">
                    {dateLabel}
                  </div>
                  <Card className="gap-0 py-0 overflow-hidden">
                    <CardContent className="p-0 divide-y divide-border">
                      {dateInteractions.map(interaction => {
                        const displayInfo = getDisplayText(interaction)

                        return (
                          <div
                            key={interaction.id}
                            className="flex items-start justify-between px-4 py-3.5 gap-4 hover:bg-muted/50 transition-colors duration-150 group"
                          >
                            <div className="flex items-start gap-3 min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 text-muted-foreground text-xs mt-0.5 flex-shrink-0">
                                <Clock size={12} />
                                <span className="tabular-nums min-w-[58px]">
                                  {formatTime(interaction.created_at)}
                                </span>
                              </div>
                              <div className="min-w-0 flex-1">
                                {displayInfo.isError ? (
                                  <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
                                    <WarningCircle size={14} className="flex-shrink-0 text-muted-foreground/70" />
                                    <span>{displayInfo.text}</span>
                                    {displayInfo.tooltip && (
                                      <Tooltip>
                                        <TooltipTrigger>
                                          <Info size={13} className="text-muted-foreground/50" />
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          {displayInfo.tooltip}
                                        </TooltipContent>
                                      </Tooltip>
                                    )}
                                  </div>
                                ) : (
                                  <p className="text-sm text-foreground leading-relaxed line-clamp-2">
                                    {displayInfo.text}
                                  </p>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex-shrink-0 mt-0.5">
                              {!displayInfo.isError && (
                                <Tooltip
                                  open={
                                    openTooltipKey === `copy:${interaction.id}`
                                  }
                                  onOpenChange={open => {
                                    if (open) {
                                      setOpenTooltipKey(`copy:${interaction.id}`)
                                    } else {
                                      if (!copiedItems.has(interaction.id)) {
                                        setOpenTooltipKey(prev =>
                                          prev === `copy:${interaction.id}`
                                            ? null
                                            : prev,
                                        )
                                      }
                                    }
                                  }}
                                >
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className={`h-7 w-7 rounded-md ${
                                        copiedItems.has(interaction.id)
                                          ? 'text-emerald-600'
                                          : 'text-muted-foreground'
                                      }`}
                                      onClick={() =>
                                        copyToClipboard(
                                          displayInfo.text,
                                          interaction.id,
                                        )
                                      }
                                    >
                                      {copiedItems.has(interaction.id) ? (
                                        <Check size={14} weight="bold" />
                                      ) : (
                                        <Copy size={14} />
                                      )}
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" sideOffset={5}>
                                    {copiedItems.has(interaction.id)
                                      ? 'Copied!'
                                      : 'Copy'}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </CardContent>
                  </Card>
                </div>
              ),
            )}
            {interactions.length > visibleCount && (
              <Button
                variant="ghost"
                className="w-full text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setVisibleCount(prev => prev + INTERACTIONS_PAGE_SIZE)
                }
              >
                Show more ({interactions.length - visibleCount} remaining)
              </Button>
            )}
          </div>
        )}
      </div>

      <ProUpgradeDialog open={showProDialog} onOpenChange={setShowProDialog} />

      <Dialog open={showStatsDialog} onOpenChange={setShowStatsDialog}>
        <DialogContent className="!border-border/50 shadow-xl p-0 max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle className="sr-only">Your Stats</DialogTitle>
          </DialogHeader>
          <div className="p-7">
            <div className="text-center mb-6">
              <h2 className="text-lg font-bold mb-1">
                You've been flowing hard
              </h2>
              <p className="text-sm text-muted-foreground">
                Your productivity snapshot with Ito
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted/60 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Fire size={14} weight="fill" className="text-orange-500" />
                  <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Daily Streak
                  </span>
                </div>
                <div className="text-2xl font-bold mb-0.5">
                  {stats.streakDays}
                  <span className="text-sm font-normal text-muted-foreground ml-1">
                    {stats.streakDays === 1 ? 'day' : 'days'}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {stats.streakDays === 0
                    ? 'Start your streak today!'
                    : stats.streakDays === 1
                      ? 'Just getting started!'
                      : stats.streakDays < 7
                        ? `${stats.streakDays} days strong`
                        : 'On fire! Keep going!'}
                </div>
              </div>

              <div className="rounded-lg bg-muted/60 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Trophy size={14} weight="fill" className="text-emerald-500" />
                  <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Avg Speed
                  </span>
                </div>
                <div className="text-2xl font-bold mb-0.5">
                  {stats.averageWPM}
                  <span className="text-sm font-normal text-muted-foreground ml-1">
                    WPM
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Top performer!
                </div>
              </div>

              <div className="rounded-lg bg-muted/60 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Rocket size={14} weight="fill" className="text-indigo-500" />
                  <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Total Words
                  </span>
                </div>
                <div className="text-2xl font-bold mb-0.5">
                  {stats.totalWords.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">
                  {stats.totalWords < 1000
                    ? 'Getting warmed up!'
                    : stats.totalWords < 5000
                      ? `${Math.floor(stats.totalWords / 280)} tweets worth!`
                      : `${Math.floor(stats.totalWords / 250)} pages of text!`}
                </div>
              </div>

              <div className="rounded-lg bg-muted/60 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Microphone size={14} weight="fill" className="text-indigo-500" />
                  <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Sessions
                  </span>
                </div>
                <div className="text-2xl font-bold mb-0.5">
                  {interactions.length}
                </div>
                <div className="text-xs text-muted-foreground">
                  {interactions.length < 10
                    ? 'Keep using Ito!'
                    : 'Almost at flow mastery!'}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
