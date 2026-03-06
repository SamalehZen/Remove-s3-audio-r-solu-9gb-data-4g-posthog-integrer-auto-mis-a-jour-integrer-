import {
  DomainContextTable,
  type DomainContext,
  type SonioxContext,
} from '../sqlite/domainContextRepo'
import fs from 'fs/promises'
import path from 'path'
import { app } from 'electron'

const MAX_CONTEXT_CHARS = 10000

class DomainContextProvider {
  private contexts: Map<string, DomainContext> = new Map()
  private loaded = false

  async initialize(): Promise<void> {
    const resourcesDir = app.isPackaged
      ? path.join(process.resourcesPath, 'domain-contexts')
      : path.join(__dirname, '../../resources/domain-contexts')

    try {
      const files = await fs.readdir(resourcesDir)
      const jsonFiles = files.filter(
        f => f.endsWith('.json') && !f.startsWith('_'),
      )

      for (const file of jsonFiles) {
        const content = await fs.readFile(
          path.join(resourcesDir, file),
          'utf-8',
        )
        const data = JSON.parse(content)

        await DomainContextTable.upsert({
          slug: data.slug,
          name: data.name,
          nameFr: data.name_fr || null,
          icon: data.icon || 'globe',
          description: data.description || null,
          descriptionFr: data.description_fr || null,
          contextJson: JSON.stringify(data.context),
          isSystem: true,
        })
      }

      const all = await DomainContextTable.findAll()
      for (const ctx of all) {
        this.contexts.set(ctx.slug, ctx)
      }
      this.loaded = true
      console.log(
        `[DomainContextProvider] Loaded ${this.contexts.size} domain contexts`,
      )
    } catch (error) {
      console.warn(
        '[DomainContextProvider] Failed to load domain contexts:',
        error,
      )
      this.loaded = true
    }
  }

  getAll(): DomainContext[] {
    return Array.from(this.contexts.values())
  }

  getBySlug(slug: string): DomainContext | null {
    return this.contexts.get(slug) || null
  }

  buildSonioxContext(
    domainSlug: string | null,
    vocabularyWords: string[],
  ): SonioxContext | null {
    let baseContext: SonioxContext = {}

    if (domainSlug) {
      const domain = this.getBySlug(domainSlug)
      if (domain) {
        baseContext = JSON.parse(domain.contextJson) as SonioxContext
      }
    }

    const existingTerms = baseContext.terms || []
    const mergedTerms = [...new Set([...existingTerms, ...vocabularyWords])]

    if (
      !baseContext.general?.length &&
      !baseContext.text &&
      mergedTerms.length === 0 &&
      !baseContext.translation_terms?.length
    ) {
      return null
    }

    const result: SonioxContext = {
      ...baseContext,
      terms: mergedTerms.length > 0 ? mergedTerms : undefined,
    }

    const serialized = JSON.stringify(result)
    if (serialized.length > MAX_CONTEXT_CHARS) {
      console.warn(
        `[DomainContextProvider] Context exceeds ${MAX_CONTEXT_CHARS} chars (${serialized.length}), truncating terms`,
      )
      const overhead = serialized.length - MAX_CONTEXT_CHARS
      const termsToRemove = Math.ceil(overhead / 20)
      if (result.terms && result.terms.length > termsToRemove) {
        result.terms = result.terms.slice(0, result.terms.length - termsToRemove)
      }
    }

    return result
  }
}

export const domainContextProvider = new DomainContextProvider()
