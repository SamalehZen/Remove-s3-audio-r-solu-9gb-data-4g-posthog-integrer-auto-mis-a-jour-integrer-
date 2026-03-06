import { run, get, all } from './utils'

export type DomainContext = {
  slug: string
  name: string
  nameFr: string | null
  icon: string
  description: string | null
  descriptionFr: string | null
  contextJson: string
  isSystem: boolean
  createdAt: string
  updatedAt: string
}

export type SonioxContext = {
  general?: Array<{ key: string; value: string }>
  text?: string
  terms?: string[]
  translation_terms?: Array<{ source: string; target: string }>
}

type DomainContextRow = {
  slug: string
  name: string
  name_fr: string | null
  icon: string
  description: string | null
  description_fr: string | null
  context_json: string
  is_system: number
  created_at: string
  updated_at: string
}

function mapRow(row: DomainContextRow): DomainContext {
  return {
    slug: row.slug,
    name: row.name,
    nameFr: row.name_fr,
    icon: row.icon,
    description: row.description,
    descriptionFr: row.description_fr,
    contextJson: row.context_json,
    isSystem: Boolean(row.is_system),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const DomainContextTable = {
  async findAll(): Promise<DomainContext[]> {
    const rows = await all<DomainContextRow>(
      `SELECT slug, name, name_fr, icon, description, description_fr, context_json, is_system, created_at, updated_at
       FROM domain_contexts ORDER BY name`,
    )
    return rows.map(mapRow)
  },

  async findBySlug(slug: string): Promise<DomainContext | null> {
    const row = await get<DomainContextRow>(
      `SELECT slug, name, name_fr, icon, description, description_fr, context_json, is_system, created_at, updated_at
       FROM domain_contexts WHERE slug = ?`,
      [slug],
    )
    return row ? mapRow(row) : null
  },

  async upsert(data: {
    slug: string
    name: string
    nameFr?: string | null
    icon?: string
    description?: string | null
    descriptionFr?: string | null
    contextJson: string
    isSystem?: boolean
  }): Promise<void> {
    const now = new Date().toISOString()
    await run(
      `INSERT INTO domain_contexts (slug, name, name_fr, icon, description, description_fr, context_json, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name,
         name_fr = excluded.name_fr,
         icon = excluded.icon,
         description = excluded.description,
         description_fr = excluded.description_fr,
         context_json = excluded.context_json,
         is_system = excluded.is_system,
         updated_at = excluded.updated_at`,
      [
        data.slug,
        data.name,
        data.nameFr ?? null,
        data.icon ?? 'globe',
        data.description ?? null,
        data.descriptionFr ?? null,
        data.contextJson,
        data.isSystem ? 1 : 0,
        now,
        now,
      ],
    )
  },

  async deleteAll(): Promise<void> {
    await run(`DELETE FROM domain_contexts`)
  },
}
