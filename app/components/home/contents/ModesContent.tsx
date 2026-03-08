import { useEffect, useState } from 'react'
import { useCustomModesStore } from '@/app/store/useCustomModesStore'
import { ModeCard } from './settings/ModeCard'
import { CreateModeDialog } from './settings/CreateModeDialog'
import { Button } from '@/app/components/ui/button'
import { Plus } from '@mynaui/icons-react'

export default function ModesContent() {
  const { modes, isLoading, loadModes } = useCustomModesStore()
  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => {
    loadModes()
  }, [loadModes])

  const sorted = [...modes].sort((a, b) => a.sortOrder - b.sortOrder)

  return (
    <div className="w-full max-w-2xl mx-auto px-6 pb-8">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[30px] font-semibold tracking-tight font-sans text-foreground">
              Modes
            </h1>
            <p className="text-sm text-[var(--color-subtext)] mt-1">
              Create modes for your tasks. Auto-activate by app or website.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
            <Plus className="w-4 h-4" /> Create Mode
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-[var(--color-subtext)]">
            <div className="w-4 h-4 border-2 border-warm-300 border-t-warm-600 rounded-full animate-spin" />
            <span className="text-sm">Loading modes...</span>
          </div>
        ) : (
          <div className="space-y-3">
            {sorted.map(mode => (
              <ModeCard key={mode.id} mode={mode} />
            ))}
          </div>
        )}
      </div>

      <CreateModeDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
