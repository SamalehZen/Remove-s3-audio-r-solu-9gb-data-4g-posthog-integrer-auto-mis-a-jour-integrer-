import {
  CustomModeTable,
  ModeActivationRuleTable,
  type CustomMode,
  type ModeActivationRule,
} from '../sqlite/customModeRepo'
import { ToneTable, type Tone } from '../sqlite/appTargetRepo'
import { getCurrentUserId } from '../store'

const DEFAULT_LOCAL_USER_ID = 'local-user'

export interface ResolvedCustomMode {
  mode: CustomMode
  tone: Tone | null
  matchedRule: ModeActivationRule
}

interface CachedRules {
  userId: string
  rules: ModeActivationRule[]
  timestamp: number
}

const CACHE_TTL_MS = 5000

class CustomModeResolver {
  private cachedRules: CachedRules | null = null

  public clearCache(): void {
    this.cachedRules = null
  }

  private async getRules(): Promise<ModeActivationRule[]> {
    const userId = getCurrentUserId() || DEFAULT_LOCAL_USER_ID
    if (
      this.cachedRules &&
      this.cachedRules.userId === userId &&
      Date.now() - this.cachedRules.timestamp < CACHE_TTL_MS
    ) {
      return this.cachedRules.rules
    }
    const rules = await ModeActivationRuleTable.findAllByUser(userId)
    this.cachedRules = { userId, rules, timestamp: Date.now() }
    return rules
  }

  public async resolve(context: {
    domain: string | null
    bundleId: string | null
    exePath: string | null
    appName: string | null
  }): Promise<ResolvedCustomMode | null> {
    const rules = await this.getRules()
    if (rules.length === 0) return null

    const userId = getCurrentUserId() || DEFAULT_LOCAL_USER_ID
    let matchedRule: ModeActivationRule | null = null

    if (context.domain) {
      const normalizedDomain = context.domain.toLowerCase().replace(/^www\./, '')
      matchedRule =
        rules.find(
          r =>
            r.ruleType === 'domain' &&
            normalizedDomain === r.value.toLowerCase().replace(/^www\./, ''),
        ) ?? null
    }

    if (!matchedRule && context.bundleId) {
      const lowerBundleId = context.bundleId.toLowerCase()
      matchedRule =
        rules.find(
          r => r.ruleType === 'app' && r.value.toLowerCase() === lowerBundleId,
        ) ?? null
    }

    if (!matchedRule && context.exePath) {
      const lowerExePath = context.exePath.toLowerCase()
      matchedRule =
        rules.find(
          r => r.ruleType === 'app' && r.value.toLowerCase() === lowerExePath,
        ) ?? null
    }

    if (!matchedRule && context.exePath) {
      const lowerExePath = context.exePath.toLowerCase()
      matchedRule =
        rules.find(r => {
          if (r.ruleType !== 'app') return false
          const lowerValue = r.value.toLowerCase()
          if (lowerValue.length > 0 && lowerExePath.includes(lowerValue)) return true
          const prefix = lowerValue.split('_')[0]
          if (prefix && prefix.includes('.') && lowerExePath.includes(prefix))
            return true
          return false
        }) ?? null
    }

    if (!matchedRule && context.appName) {
      const lowerAppName = context.appName.toLowerCase()
      matchedRule =
        rules.find(
          r => r.ruleType === 'app' && r.value.toLowerCase() === lowerAppName,
        ) ?? null
    }

    if (!matchedRule && context.appName && context.appName.length >= 3) {
      const lowerAppName = context.appName.toLowerCase()
      matchedRule =
        rules.find(
          r =>
            r.ruleType === 'app' &&
            lowerAppName.length > 0 &&
            r.value.toLowerCase().includes(lowerAppName),
        ) ?? null
    }

    if (!matchedRule && context.appName) {
      const lowerAppName = context.appName.toLowerCase()
      matchedRule =
        rules.find(r => {
          if (r.ruleType !== 'app') return false
          const lowerValue = r.value.toLowerCase()
          const ruleAppName = r.appName?.toLowerCase()
          if (ruleAppName && ruleAppName === lowerAppName) return true
          if (ruleAppName && lowerAppName.includes(ruleAppName)) return true
          if (ruleAppName && ruleAppName.includes(lowerAppName)) return true
          return lowerValue.length > 0 && lowerAppName.includes(lowerValue)
        }) ?? null
    }

    if (!matchedRule) return null

    const mode = await CustomModeTable.findById(matchedRule.modeId, userId)
    if (!mode) return null

    let tone: Tone | null = null
    if (mode.toneId) {
      tone = await ToneTable.findById(mode.toneId)
    }

    return { mode, tone, matchedRule }
  }
}

export const customModeResolver = new CustomModeResolver()
