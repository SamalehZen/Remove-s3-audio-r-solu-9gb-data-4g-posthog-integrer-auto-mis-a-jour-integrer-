import { useState, useRef, useEffect } from 'react'
import React from 'react'
import { useCustomModesStore, type CustomMode } from '@/app/store/useCustomModesStore'
import { DEFAULT_MODE_PROMPTS } from '@/app/constants/modePresets'
import { ModeActivationRules } from './ModeActivationRules'
import { Button } from '@/app/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select'
import {
  ChevronDown,
  ChevronRight,
  Sparkles,
  Microphone,
  Message,
  Envelope,
  FileText,
  UsersGroup,
  Square,
  Pencil,
  Trash,
  Refresh,
} from '@mynaui/icons-react'

function getModeIcon(icon: string, className: string): React.ReactElement {
  switch (icon) {
    case 'sparkles':
    case 'super':
      return <Sparkles className={className} />
    case 'microphone':
    case 'voice_to_text':
      return <Microphone className={className} />
    case 'message':
      return <Message className={className} />
    case 'mail':
      return <Envelope className={className} />
    case 'note':
      return <FileText className={className} />
    case 'meeting':
      return <UsersGroup className={className} />
    case 'custom_prompt':
      return <Pencil className={className} />
    default:
      return <Square className={className} />
  }
}

const PRESET_OPTIONS = [
  { value: 'super', label: 'Super', itoMode: 1 },
  { value: 'voice_to_text', label: 'Voice to text', itoMode: 0 },
  { value: 'message', label: 'Message', itoMode: 1 },
  { value: 'mail', label: 'Mail', itoMode: 1 },
  { value: 'note', label: 'Note', itoMode: 1 },
  { value: 'meeting', label: 'Meeting', itoMode: 1 },
  { value: 'custom_prompt', label: 'Custom Prompt', itoMode: 1 },
  { value: 'blank', label: 'Blank', itoMode: 0 },
]

const LANGUAGES = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'es', label: 'Spanish' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ar', label: 'Arabic' },
  { value: 'ru', label: 'Russian' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'sv', label: 'Swedish' },
  { value: 'tr', label: 'Turkish' },
]

type Props = { mode: CustomMode }

export function ModeCard({ mode }: Props) {
  const { updateMode, deleteMode } = useCustomModesStore()
  const [isOpen, setIsOpen] = useState(false)
  const [localName, setLocalName] = useState(mode.name)
  const [localPrompt, setLocalPrompt] = useState(mode.promptTemplate)
  const nameTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const promptTimerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    setLocalName(mode.name)
    setLocalPrompt(mode.promptTemplate)
  }, [mode.name, mode.promptTemplate])

  const handleNameChange = (value: string) => {
    setLocalName(value)
    clearTimeout(nameTimerRef.current)
    nameTimerRef.current = setTimeout(() => {
      updateMode({ id: mode.id, name: value })
    }, 500)
  }

  const handlePromptChange = (value: string) => {
    setLocalPrompt(value)
    clearTimeout(promptTimerRef.current)
    promptTimerRef.current = setTimeout(() => {
      updateMode({ id: mode.id, promptTemplate: value })
    }, 500)
  }

  const handleResetPrompt = () => {
    clearTimeout(promptTimerRef.current)
    const defaultPrompt = DEFAULT_MODE_PROMPTS[mode.presetType] ?? ''
    setLocalPrompt(defaultPrompt)
    updateMode({ id: mode.id, promptTemplate: defaultPrompt })
  }

  const defaultPrompt = DEFAULT_MODE_PROMPTS[mode.presetType] ?? ''
  const canReset = defaultPrompt !== '' && localPrompt !== defaultPrompt

  const handlePresetChange = (presetType: string) => {
    const preset = PRESET_OPTIONS.find(p => p.value === presetType)
    updateMode({ id: mode.id, presetType, itoMode: preset?.itoMode ?? 0 })
  }

  const handleLanguageChange = (language: string) => {
    updateMode({ id: mode.id, language })
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-white shadow-[var(--shadow-card)] overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-muted-bg)] transition-colors"
      >
        <div className="w-8 h-8 rounded-lg bg-[var(--color-muted-bg)] flex items-center justify-center flex-shrink-0">
          {getModeIcon(mode.icon, 'w-4 h-4 text-[var(--color-subtext)]')}
        </div>
        <span className="flex-1 text-left font-medium text-sm text-foreground">
          {mode.name}
        </span>
        {mode.isSystem && (
          <span className="text-xs text-[var(--color-subtext)] bg-[var(--color-muted-bg)] px-2 py-0.5 rounded-full">
            System
          </span>
        )}
        {mode.isDefault && (
          <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
            Default
          </span>
        )}
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-[var(--color-subtext)] flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-[var(--color-subtext)] flex-shrink-0" />
        )}
      </button>

      {isOpen && (
        <div className="px-4 pb-4 space-y-4 border-t border-[var(--border)]">
          <div className="space-y-1.5 pt-4">
            <label className="text-xs font-medium text-[var(--color-subtext)]">
              Name
            </label>
            <input
              type="text"
              className="w-full bg-white border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:border-transparent"
              value={localName}
              onChange={e => handleNameChange(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--color-subtext)]">
                Preset
              </label>
              <Select value={mode.presetType} onValueChange={handlePresetChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESET_OPTIONS.map(p => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--color-subtext)]">
                Language
              </label>
              <Select value={mode.language} onValueChange={handleLanguageChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map(l => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-[var(--color-subtext)]">
                Custom prompt
              </label>
              {canReset && (
                <button
                  onClick={handleResetPrompt}
                  className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 transition-colors"
                >
                  <Refresh className="w-3 h-3" />
                  Reset
                </button>
              )}
            </div>
            <textarea
              className="w-full bg-white border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:border-transparent resize-none"
              rows={3}
              value={localPrompt}
              onChange={e => handlePromptChange(e.target.value)}
              placeholder="Custom prompt for this mode..."
            />
          </div>

          <ModeActivationRules mode={mode} />

          {!mode.isSystem && (
            <div className="pt-2 border-t border-[var(--border)]">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteMode(mode.id)}
                className="text-red-500 hover:text-red-600 hover:bg-red-50"
              >
                <Trash className="w-4 h-4 mr-1.5" />
                Delete Mode
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
