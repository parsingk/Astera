import { describe, it, expect } from 'vitest'
import { t as translate, LANGS, type MessageKey, type MessageParams } from '../../../core/i18n'
import { envSourceLabel, failureLine, gatewayLine, importPrompt, kindLabel, kindOneLabel, mcpStateLabel, outcomeLabel, picksOf, reasonLabel, type FoundItem } from './extensionsText'
import type { SyncOutcome } from '../../../core/extensions/types'
import type { NotShareableReason } from '../../../core/extensions/envRules'
import type { ExtensionKind, SkipReason } from '../../../core/extensions/types'

const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

// Records over the unions: a new outcome, reason, warning or kind does not compile without being listed here
const OUTCOMES = Object.keys({
  written: 1, unchanged: 1, adopted: 1, restored: 1, conflict: 1, removed: 1, forgotten: 1, failed: 1, 'not-applicable': 1
} satisfies Record<SyncOutcome, 1>)
const REASONS = Object.keys({
  'env-reference': 1, 'astera-own': 1, 'header-secret': 1, 'arg-secret': 1
} satisfies Record<NotShareableReason, 1>)
const MCP_STATES = ['given', ...Object.keys({
  'account-own': 1, 'account-unreadable': 1, 'launch-chars': 1, 'gateway-unavailable': 1, provider: 1, transport: 1
} satisfies Record<SkipReason, 1>)]
const KINDS = Object.keys({ mcp: 1, skill: 1, command: 1, agent: 1 } satisfies Record<ExtensionKind, 1>) as ExtensionKind[]

const ITEMS: FoundItem[] = [
  { kind: 'mcp', name: 'linear', shareable: true, mcp: { envNames: ['LINEAR_API_KEY', 'LOG_LEVEL'] } },
  { kind: 'skill', name: 'review', shareable: true },
  { kind: 'skill', name: 'astera-task', shareable: false, reason: 'astera-own' }
]

describe('extensionsText', () => {
  it('has words for every outcome, reason, warning, kind and environment source in every language', () => {
    for (const lang of LANGS) {
      const tr = (key: MessageKey, params?: MessageParams): string => translate(lang, key, params)
      for (const o of OUTCOMES) expect(outcomeLabel(o, tr), `${lang} ${o}`).not.toMatch(/^settings\./)
      for (const r of REASONS) expect(reasonLabel(r, tr), `${lang} ${r}`).not.toMatch(/^settings\./)
      for (const m of MCP_STATES) expect(mcpStateLabel(m, tr), `${lang} ${m}`).not.toMatch(/^settings\./)
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
    expect(p.choices[0]).not.toHaveProperty('hint')
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

// Gateway design §4.5: the Gateway's state of a stdio server, in words
describe('gatewayLine', () => {
  it('says how the server’s processes stand, in every language, with the last error when it failed', () => {
    for (const lang of LANGS) {
      const tr = (key: MessageKey, params?: MessageParams): string => translate(lang, key, params)
      for (const state of ['running', 'stopped', 'restarting', 'failed'] as const)
        expect(gatewayLine({ state, processes: 2, lastError: 'boom' }, tr), `${lang} ${state}`).not.toMatch(/settings\./)
    }
    expect(gatewayLine({ state: 'running', processes: 2 }, en)).toContain('2')
    expect(gatewayLine({ state: 'failed', processes: 0, lastError: 'the secret could not be read' }, en)).toContain('the secret could not be read')
    expect(gatewayLine(undefined, en)).toBe(gatewayLine({ state: 'stopped', processes: 0 }, en))
  })
})
