import { describe, it, expect } from 'vitest'
import { t as translate, LANGS, type MessageKey, type MessageParams } from '../../../core/i18n'
import { copyProblem, failureLine, importPrompt, kindLabel, kindOneLabel, notGivenLabel, notGivenWorthSaying, picksOf, reasonLabel, serverProblem, type FoundItem } from './extensionsText'
import type { NotShareableReason } from '../../../core/extensions/envRules'
import type { ExtensionKind, SkipReason } from '../../../core/extensions/types'

const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

// Records over the unions: a new reason or kind does not compile without being listed here
const REASONS = Object.keys({ 'env-reference': 1, 'astera-own': 1, 'header-secret': 1, 'arg-secret': 1 } satisfies Record<NotShareableReason, 1>)
const NOT_GIVEN = Object.keys({
  'account-own': 1, 'account-unreadable': 1, 'launch-chars': 1, 'gateway-unavailable': 1, provider: 1, transport: 1
} satisfies Record<SkipReason, 1>)
const KINDS = Object.keys({ mcp: 1, skill: 1, command: 1, agent: 1 } satisfies Record<ExtensionKind, 1>) as ExtensionKind[]

const ITEMS: FoundItem[] = [
  { kind: 'mcp', name: 'linear', shareable: true, mcp: { envNames: ['LINEAR_API_KEY', 'LOG_LEVEL'] } },
  { kind: 'skill', name: 'review', shareable: true },
  { kind: 'skill', name: 'astera-task', shareable: false, reason: 'astera-own' }
]

describe('extensionsText', () => {
  it('has words for every reason, kind and problem in every language', () => {
    for (const lang of LANGS) {
      const tr = (key: MessageKey, params?: MessageParams): string => translate(lang, key, params)
      for (const r of REASONS) expect(reasonLabel(r, tr), `${lang} ${r}`).not.toMatch(/^settings\./)
      for (const s of NOT_GIVEN) expect(notGivenLabel(s, tr), `${lang} ${s}`).not.toMatch(/^settings\./)
      for (const k of KINDS) {
        expect(kindLabel(k, tr), `${lang} ${k}`).not.toMatch(/^settings\./)
        expect(kindOneLabel(k, tr), `${lang} ${k}`).not.toMatch(/^settings\./)
      }
      for (const o of ['conflict', 'failed']) expect(copyProblem(o, tr), `${lang} ${o}`).not.toMatch(/^settings\./)
      expect(serverProblem({ state: 'failed', lastError: 'boom' }, tr), lang).toContain('boom')
      expect(serverProblem({ state: 'restarting' }, tr), lang).not.toMatch(/^settings\./)
    }
  })

  it('keeps the MCP sharing note in four lines, with one place for the switch’s name', () => {
    for (const lang of LANGS) {
      const note = translate(lang, 'settings.extensions.mcpSharing', { option: '\u0001' })
      expect(note.split('\n'), lang).toHaveLength(4)
      expect(note.split('\u0001'), lang).toHaveLength(2)
    }
  })

  it('says nothing about what needs no action', () => {
    for (const o of ['written', 'unchanged', 'adopted', 'restored', 'removed', 'forgotten', 'not-applicable']) expect(copyProblem(o, en)).toBeNull()
    expect(serverProblem({ state: 'running' }, en)).toBeNull()
    expect(serverProblem(undefined, en)).toBeNull()
    // The account it was imported from uses its own server of that name: expected, nothing to act on
    expect(['given', 'account-own', 'provider'].filter(notGivenWorthSaying)).toEqual([])
    expect(['account-unreadable', 'launch-chars', 'gateway-unavailable', 'transport'].every(notGivenWorthSaying)).toBe(true)
  })

  it('offers each shareable item, says why the rest cannot be shared, and leaves Astera’s own out entirely', () => {
    const p = importPrompt([...ITEMS, { kind: 'mcp', name: 'keyed', shareable: false, reason: 'arg-secret' }], 'Work', en)
    expect(p.choices.map((c) => [c.id, c.defaultChecked])).toEqual([
      ['item:mcp:linear', false],
      ['item:skill:review', false]
    ])
    expect(p.body).toContain('keyed')
    expect(p.body).toContain(en('settings.extensions.reason.arg-secret'))
    expect(p.body).not.toContain('astera-task')
  })

  // The register dialog lists an account's items in areas, one per kind under its name, not a kind word on every row
  it('groups the offered items by kind, in the order the settings list them, each row its name alone', () => {
    const items: FoundItem[] = [
      { kind: 'skill', name: 'review', shareable: true },
      { kind: 'mcp', name: 'linear', shareable: true },
      { kind: 'agent', name: 'planner', shareable: true },
      { kind: 'mcp', name: 'github', shareable: true }
    ]
    expect(importPrompt(items, 'Work', en).choices.map((c) => [c.group, c.label])).toEqual([
      [en('settings.extensions.kind.mcp'), 'linear'],
      [en('settings.extensions.kind.mcp'), 'github'],
      [en('settings.extensions.kind.skill'), 'review'],
      [en('settings.extensions.kind.agent'), 'planner']
    ])
  })

  // K4: picking a Claude account lists its plugins in the same dialog, after its servers and skills
  it('puts the plugin choices after the item choices, and both lists of what cannot be shared in the body', () => {
    const plugins = {
      choices: [{ id: 'plugin:hud@obra', label: 'hud@obra', group: 'Plugins', hint: 'Installs version 1.0.0', defaultChecked: false }],
      refused: ['keyed@corp: some reason', 'Could not read the plugin list of Work']
    }
    const p = importPrompt([...ITEMS, { kind: 'mcp', name: 'keyed', shareable: false, reason: 'arg-secret' }], 'Work', en, plugins)
    expect(p.choices.map((c) => c.id)).toEqual(['item:mcp:linear', 'item:skill:review', 'plugin:hud@obra'])
    expect(p.choices[2]).toEqual(plugins.choices[0])
    expect(p.body.split('\n')).toEqual([
      en('settings.extensions.import.body'),
      en('settings.extensions.import.notShareable', { kind: en('settings.extensions.kindOne.mcp'), name: 'keyed', reason: en('settings.extensions.reason.arg-secret') }),
      'keyed@corp: some reason',
      'Could not read the plugin list of Work'
    ])
    // Plugins only: an account with nothing else to add still gets the dialog
    expect(importPrompt([], 'Work', en, plugins).choices.map((c) => c.id)).toEqual(['plugin:hud@obra'])
    // Without plugins (a Codex account) it is the dialog it always was
    expect(importPrompt(ITEMS, 'Work', en).choices.map((c) => c.id)).toEqual(['item:mcp:linear', 'item:skill:review'])
  })

  it('keeps every environment value of a picked server as a secret', () => {
    expect(picksOf(ITEMS, ['item:mcp:linear', 'item:skill:astera-task'])).toEqual([{ kind: 'mcp', name: 'linear', secretNames: ['LINEAR_API_KEY', 'LOG_LEVEL'] }])
    expect(picksOf(ITEMS, ['item:skill:review'])).toEqual([{ kind: 'skill', name: 'review' }])
  })

  it('says why a call came back with nothing', () => {
    expect(failureLine({ ok: false, code: 'HOST_NOT_RUNNING', message: '' }, en)).toBe(en('settings.plugins.fail.noHost'))
    expect(failureLine({ ok: false, code: 'NOT_SUPPORTED', message: 'x' }, en)).toBe(en('settings.extensions.fail.notSupported', { message: 'x' }))
    expect(failureLine({ ok: false, code: 'CONFLICT', message: 'extensions/registry.json is damaged' }, en)).toBe('extensions/registry.json is damaged')
  })
})
