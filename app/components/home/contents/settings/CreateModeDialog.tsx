import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/app/components/ui/dialog'
import { useCustomModesStore } from '@/app/store/useCustomModesStore'
import {
  Sparkles,
  Microphone,
  Message,
  Envelope,
  FileText,
  UsersGroup,
  Square,
} from '@mynaui/icons-react'

type PresetConfig = {
  name: string
  icon: string
  presetType: string
  itoMode: number
  description: string
  promptTemplate: string
  recommended?: boolean
  IconComponent: React.ElementType
}

const PRESET_CONFIGS: PresetConfig[] = [
  {
    name: 'Super',
    icon: 'super',
    presetType: 'super',
    itoMode: 1,
    description: 'Enhanced AI editing & rewriting',
    promptTemplate: '',
    recommended: true,
    IconComponent: Sparkles,
  },
  {
    name: 'Voice to text',
    icon: 'voice_to_text',
    presetType: 'voice_to_text',
    itoMode: 0,
    description: 'Accurate verbatim transcription',
    promptTemplate: '',
    IconComponent: Microphone,
  },
  {
    name: 'Message',
    icon: 'message',
    presetType: 'message',
    itoMode: 1,
    description: 'Casual, conversational tone',
    promptTemplate:
      '- Keep the language casual and conversational like a text message\n- Capitalize the first letter of each sentence\n- Remove filler words\n- Keep question marks and exclamation points\n- Never end the last sentence with a period',
    IconComponent: Message,
  },
  {
    name: 'Mail',
    icon: 'mail',
    presetType: 'mail',
    itoMode: 1,
    description: 'Professional email format',
    promptTemplate:
      '- Sound like the speaker, but written\n- Fix grammar, remove filler\n- Format as a professional email with greeting, body, and sign-off\n- Preserve the speaker greeting and sign-off if present\n- DO NOT introduce new phrasing or change intent',
    IconComponent: Envelope,
  },
  {
    name: 'Note',
    icon: 'note',
    presetType: 'note',
    itoMode: 1,
    description: 'Structured notes & bullet points',
    promptTemplate:
      '- Organize the speech into clear, structured notes\n- Use bullet points for main ideas\n- Add headers for distinct topics\n- Remove filler words and repetition\n- Keep the original meaning intact',
    IconComponent: FileText,
  },
  {
    name: 'Meeting',
    icon: 'meeting',
    presetType: 'meeting',
    itoMode: 1,
    description: 'Meeting summaries & action items',
    promptTemplate:
      '- Structure as meeting notes with clear sections\n- List action items and decisions separately\n- Include key discussion points\n- Keep it professional and concise',
    IconComponent: UsersGroup,
  },
  {
    name: 'Blank',
    icon: 'blank',
    presetType: 'blank',
    itoMode: 0,
    description: 'Start from scratch',
    promptTemplate: '',
    IconComponent: Square,
  },
]

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateModeDialog({ open, onOpenChange }: Props) {
  const { modes, createMode } = useCustomModesStore()

  const handleSelectPreset = async (preset: PresetConfig) => {
    await createMode({
      name: preset.name,
      icon: preset.icon,
      presetType: preset.presetType,
      itoMode: preset.itoMode,
      promptTemplate: preset.promptTemplate,
      language: 'auto',
      sortOrder: modes.length,
      isDefault: false,
      isSystem: false,
      playbackWhenRecording: 'keep_playing',
      autoPaste: 'on',
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Mode</DialogTitle>
          <DialogDescription>
            Choose a preset to get started. You can customize everything after.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 pt-2">
          {PRESET_CONFIGS.map(preset => {
            const Icon = preset.IconComponent
            return (
              <button
                key={preset.presetType}
                onClick={() => handleSelectPreset(preset)}
                className="relative flex items-start gap-3 p-4 rounded-xl border-2 border-[var(--border)] hover:border-blue-400 hover:bg-blue-50 transition-all text-left group"
              >
                {preset.recommended && (
                  <span className="absolute top-2 right-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600">
                    Recommended
                  </span>
                )}
                <div className="w-9 h-9 rounded-lg bg-[var(--color-muted-bg)] group-hover:bg-blue-100 flex items-center justify-center flex-shrink-0 transition-colors">
                  <Icon className="w-5 h-5 text-[var(--color-subtext)] group-hover:text-blue-500 transition-colors" />
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <p className="font-medium text-sm text-foreground">
                    {preset.name}
                  </p>
                  <p className="text-xs text-[var(--color-subtext)] mt-0.5 line-clamp-2">
                    {preset.description}
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
