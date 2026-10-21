import { describe, it, expect } from 'vitest'
import { t as translate, LANGS, type MessageKey, type MessageParams } from '../../../core/i18n'
import { envSourceLabel, failureLine, importPrompt, kindLabel, kindOneLabel, outcomeLabel, picksOf, reasonLabel, warningLabel, type FoundItem } from './extensionsText'
import type { SyncOutcome } from '../../../core/extensions/types'
import type { NotShareableReason, ShareWarning } from '../../../core/extensions/envRules'
import type { ExtensionKind } from '../../../core/extensions/types'

const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

// Records over the unions: a new outcome, reason, warning or kind does not compile without being listed here
const OUTCOMES = Object.keys({
  written: 1, unchanged: 1, adopted: 1, restored: 1, conflict: 1, removed: 1, forgotten: 1, failed: 1, 'not-applicable': 1
} satisfies Record<SyncOutcome, 1>)
const REASONS = Object.keys({ 'cli-env-name': 1, 'env-name-clash': 1, 'astera-own': 1, 'header-secret': 1 } satisfies Record<NotShareableReason, 1>)
const WARNINGS = Object.keys({ 'session-tools': 1, 'env-name-shared': 1 } satisfies Record<ShareWarning, 1>)
const KINDS = Object.keys({ mcp: 1, skill: 1, command: 1, agent: 1 } satisfies Record<ExtensionKind, 1>) as ExtensionKind[]

const ITEMS: FoundItem[] = [
  { kind: 'mcp', name: 'linear', shareable: true, warnings: ['session-tools'], mcp: { envNames: ['LINEAR_API_KEY', 'LOG_LEVEL'] } },
  { kind: 'skill', name: 'review', shareable: true },
  { kind: 'skill', name: 'astera-task', shareable: false, reason: 'astera-own' }
]

describe('extensionsText', () => {
  it('has words for every outcome, reason, warning, kind and environment source in every language', () => {
    for (const lang of LANGS) {
      const tr = (key: MessageKey, params?: MessageParams): string => translate(lang, key, params)
      for (const o of OUTCOMES) expect(outcomeLabel(o, tr), `${lang} ${o}`).not.toMatch(/^settings\./)
      for (const r of REASONS) expect(reasonLabel(r, tr), `${lang} ${r}`).not.toMatch(/^settings\./)
      for (const w of WARNINGS) expect(warningLabel(w, tr), `${lang} ${w}`).not.toMatch(/^settings\./)
      for (const k of KINDS) {
        expect(kindLabel(k, tr), `${lang} ${k}`).not.toMatch(/^settings\./)
        expect(kindOneLabel(k, tr), `${lang} ${k}`).not.toMatch(/^settings\./)
      }
      for (const s of ['secret', 'value', 'inherit']) expect(envSourceLabel(s, tr), `${lang} ${s}`).not.toMatch(/^settings\./)
    }
    expect(outcomeLabel('later-outcome', en)).toBe('later-outcome')
  })

  it('offers each shareable item, a secret toggle per environment name checked for credentials, and lists the rest with why', () => {
    const p = importPrompt(ITEMS, 'Work', en)
    expect(p.choices.map((c) => [c.id, c.defaultChecked])).toEqual([
      ['item:mcp:linear', false],
      ['secret:mcp:linear:LINEAR_API_KEY', true],
      ['secret:mcp:linear:LOG_LEVEL', false],
      ['item:skill:review', false]
    ])
    expect(p.choices[0].hint).toBe(en('settings.extensions.warning.session-tools'))
    expect(p.body).toContain('astera-task')
    expect(p.body).toContain(en('settings.extensions.reason.astera-own'))
  })

  it('turns what was checked into picks, a server always with the names it keeps secret', () => {
    expect(picksOf(ITEMS, ['item:mcp:linear', 'secret:mcp:linear:LOG_LEVEL', 'item:skill:astera-task'])).toEqual([
      { kind: 'mcp', name: 'linear', secretNames: ['LOG_LEVEL'] }
    ])
    expect(picksOf(ITEMS, ['item:skill:review', 'secret:mcp:linear:LINEAR_API_KEY'])).toEqual([{ kind: 'skill', name: 'review' }])
  })

  it('says why a call came back with nothing', () => {
    expect(failureLine({ ok: false, code: 'HOST_NOT_RUNNING', message: '' }, en)).toBe(en('settings.plugins.fail.noHost'))
    expect(failureLine({ ok: false, code: 'NOT_SUPPORTED', message: 'x' }, en)).toBe(en('settings.extensions.fail.notSupported', { message: 'x' }))
    expect(failureLine({ ok: false, code: 'CONFLICT', message: 'extensions/registry.json is damaged' }, en)).toBe('extensions/registry.json is damaged')
  })
})
