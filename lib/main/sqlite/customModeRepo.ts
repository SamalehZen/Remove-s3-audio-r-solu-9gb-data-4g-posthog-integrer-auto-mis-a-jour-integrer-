import { run, get, all } from './utils'

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

type CustomModeRow = {
  id: string
  user_id: string
  name: string
  icon: string
  preset_type: string
  prompt_template: string
  language: string
  ito_mode: number
  tone_id: string | null
  sort_order: number
  is_default: number
  is_system: number
  playback_when_recording: string
  auto_paste: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

type ModeActivationRuleRow = {
  id: string
  mode_id: string
  user_id: string
  rule_type: string
  value: string
  app_name: string | null
  icon_base64: string | null
  created_at: string
}

function mapCustomModeRow(row: CustomModeRow): CustomMode {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    icon: row.icon,
    presetType: row.preset_type,
    promptTemplate: row.prompt_template,
    language: row.language,
    itoMode: row.ito_mode,
    toneId: row.tone_id,
    sortOrder: row.sort_order,
    isDefault: Boolean(row.is_default),
    isSystem: Boolean(row.is_system),
    playbackWhenRecording: row.playback_when_recording,
    autoPaste: row.auto_paste,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

function mapRuleRow(row: ModeActivationRuleRow): ModeActivationRule {
  return {
    id: row.id,
    modeId: row.mode_id,
    userId: row.user_id,
    ruleType: row.rule_type as 'app' | 'domain',
    value: row.value,
    appName: row.app_name,
    iconBase64: row.icon_base64,
    createdAt: row.created_at,
  }
}

export const CustomModeTable = {
  async findAll(userId: string): Promise<CustomMode[]> {
    const rows = await all<CustomModeRow>(
      `SELECT id, user_id, name, icon, preset_type, prompt_template, language,
       ito_mode, tone_id, sort_order, is_default, is_system,
       playback_when_recording, auto_paste, created_at, updated_at, deleted_at
       FROM custom_modes WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
      [userId],
    )
    return rows.map(mapCustomModeRow)
  },

  async findById(id: string, userId: string): Promise<CustomMode | null> {
    const row = await get<CustomModeRow>(
      `SELECT id, user_id, name, icon, preset_type, prompt_template, language,
       ito_mode, tone_id, sort_order, is_default, is_system,
       playback_when_recording, auto_paste, created_at, updated_at, deleted_at
       FROM custom_modes WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [id, userId],
    )
    return row ? mapCustomModeRow(row) : null
  },

  async findDefault(userId: string): Promise<CustomMode | null> {
    const row = await get<CustomModeRow>(
      `SELECT id, user_id, name, icon, preset_type, prompt_template, language,
       ito_mode, tone_id, sort_order, is_default, is_system,
       playback_when_recording, auto_paste, created_at, updated_at, deleted_at
       FROM custom_modes WHERE user_id = ? AND is_default = 1 AND deleted_at IS NULL`,
      [userId],
    )
    return row ? mapCustomModeRow(row) : null
  },

  async upsert(data: {
    id: string
    userId: string
    name: string
    icon?: string
    presetType?: string
    promptTemplate?: string
    language?: string
    itoMode?: number
    toneId?: string | null
    sortOrder?: number
    isDefault?: boolean
    isSystem?: boolean
    playbackWhenRecording?: string
    autoPaste?: string
  }): Promise<CustomMode> {
    const now = new Date().toISOString()

    await run(
      `INSERT INTO custom_modes (id, user_id, name, icon, preset_type, prompt_template, language,
       ito_mode, tone_id, sort_order, is_default, is_system, playback_when_recording, auto_paste,
       created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, user_id) DO UPDATE SET
         name = excluded.name,
         icon = excluded.icon,
         preset_type = excluded.preset_type,
         prompt_template = excluded.prompt_template,
         language = excluded.language,
         ito_mode = excluded.ito_mode,
         tone_id = excluded.tone_id,
         sort_order = excluded.sort_order,
         is_default = excluded.is_default,
         playback_when_recording = excluded.playback_when_recording,
         auto_paste = excluded.auto_paste,
         updated_at = excluded.updated_at,
         deleted_at = NULL`,
      [
        data.id,
        data.userId,
        data.name,
        data.icon ?? 'microphone',
        data.presetType ?? 'blank',
        data.promptTemplate ?? '',
        data.language ?? 'auto',
        data.itoMode ?? 0,
        data.toneId ?? null,
        data.sortOrder ?? 0,
        data.isDefault ? 1 : 0,
        data.isSystem ? 1 : 0,
        data.playbackWhenRecording ?? 'keep_playing',
        data.autoPaste ?? 'on',
        now,
        now,
      ],
    )

    const result = await CustomModeTable.findById(data.id, data.userId)
    if (!result) {
      throw new Error('Failed to upsert custom mode')
    }
    return result
  },

  async delete(id: string, userId: string): Promise<void> {
    const mode = await CustomModeTable.findById(id, userId)
    if (mode?.isSystem) {
      throw new Error('Cannot delete system mode')
    }
    if (mode?.isDefault) {
      throw new Error('Cannot delete default mode')
    }
    const now = new Date().toISOString()
    await run(
      `UPDATE custom_modes SET deleted_at = ? WHERE id = ? AND user_id = ?`,
      [now, id, userId],
    )
  },

  async deleteAllUserData(userId: string): Promise<void> {
    await run(`DELETE FROM custom_modes WHERE user_id = ?`, [userId])
  },
}

export const ModeActivationRuleTable = {
  async findAllByMode(
    modeId: string,
    userId: string,
  ): Promise<ModeActivationRule[]> {
    const rows = await all<ModeActivationRuleRow>(
      `SELECT id, mode_id, user_id, rule_type, value, app_name, icon_base64, created_at
       FROM mode_activation_rules WHERE mode_id = ? AND user_id = ? ORDER BY created_at`,
      [modeId, userId],
    )
    return rows.map(mapRuleRow)
  },

  async findAllByUser(userId: string): Promise<ModeActivationRule[]> {
    const rows = await all<ModeActivationRuleRow>(
      `SELECT id, mode_id, user_id, rule_type, value, app_name, icon_base64, created_at
       FROM mode_activation_rules WHERE user_id = ? ORDER BY created_at`,
      [userId],
    )
    return rows.map(mapRuleRow)
  },

  async findByValue(
    value: string,
    userId: string,
  ): Promise<ModeActivationRule | null> {
    const row = await get<ModeActivationRuleRow>(
      `SELECT id, mode_id, user_id, rule_type, value, app_name, icon_base64, created_at
       FROM mode_activation_rules WHERE value = ? AND user_id = ?`,
      [value, userId],
    )
    return row ? mapRuleRow(row) : null
  },

  async add(data: {
    id: string
    modeId: string
    userId: string
    ruleType: 'app' | 'domain'
    value: string
    appName?: string | null
    iconBase64?: string | null
  }): Promise<ModeActivationRule> {
    const now = new Date().toISOString()
    await run(
      `INSERT INTO mode_activation_rules (id, mode_id, user_id, rule_type, value, app_name, icon_base64, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.modeId,
        data.userId,
        data.ruleType,
        data.value,
        data.appName ?? null,
        data.iconBase64 ?? null,
        now,
      ],
    )
    const row = await get<ModeActivationRuleRow>(
      `SELECT id, mode_id, user_id, rule_type, value, app_name, icon_base64, created_at
       FROM mode_activation_rules WHERE id = ?`,
      [data.id],
    )
    if (!row) throw new Error('Failed to add activation rule')
    return mapRuleRow(row)
  },

  async delete(id: string): Promise<void> {
    await run(`DELETE FROM mode_activation_rules WHERE id = ?`, [id])
  },

  async deleteByMode(modeId: string, userId: string): Promise<void> {
    await run(
      `DELETE FROM mode_activation_rules WHERE mode_id = ? AND user_id = ?`,
      [modeId, userId],
    )
  },

  async deleteAllUserData(userId: string): Promise<void> {
    await run(`DELETE FROM mode_activation_rules WHERE user_id = ?`, [userId])
  },
}
