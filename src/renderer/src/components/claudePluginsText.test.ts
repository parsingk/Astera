import { describe, it, expect } from 'vitest'
import { t as translate, LANGS, type MessageKey, type MessageParams } from '../../../core/i18n'
import { holdersHint, jobLine, offConfirmBody, pendingLines, pluginPrompt, refusalLabel, rowState, updateLabel } from './claudePluginsText'
import type { ClaudePluginFailureCode, ClaudePluginJob, ClaudePluginRefusal, DiscoveredClaudePlugin } from '../../../core/extensions/claudePlugins/types'

const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)
const ko = (key: MessageKey, params?: MessageParams): string => translate('ko', key, params)

// Records over the unions: a new refusal or failure code does not compile without being listed here
const REFUSALS = Object.keys({
  'user-config': 1, 'source-credential': 1, 'source-unsupported': 1, 'not-from-marketplace': 1, 'name-taken': 1, 'not-offered': 1
} satisfies Record<ClaudePluginRefusal | 'not-offered', 1>)
const CODES = Object.keys({
  'already-shared': 1, 'not-shared': 1, 'not-shareable': 1, 'marketplace-mismatch': 1, 'home-unreadable': 1, 'not-listed': 1,
  'dependency-missing': 1, 'catalog-unreadable': 1, 'store-unreadable': 1, refused: 1, 'timed-out': 1
} satisfies Record<ClaudePluginFailureCode, 1>) as ClaudePluginFailureCode[]

const LABELS: Record<string, string> = { c2: 'claude2@…', c4: 'claude4@…' }
const labelOf = (id: string): string => LABELS[id] ?? id

const job = (over: Partial<ClaudePluginJob>): ClaudePluginJob => ({ id: 'j1', kind: 'share', target: 'superpowers@obra', state: 'queued', startedAt: '2026-11-02T00:00:00.000Z', ...over })
const listed = { missing: false, update: undefined, enabled: true }

describe('claudePluginsText', () => {
  it('has words for every refusal and failure code in every language', () => {
    for (const lang of LANGS) {
      const tr = (key: MessageKey, params?: MessageParams): string => translate(lang, key, params)
      for (const r of REFUSALS) expect(refusalLabel(r, tr), `${lang} ${r}`).not.toMatch(/^settings\./)
      for (const code of CODES) expect(jobLine(job({ state: 'failed', code, message: 'detail' }), tr), `${lang} ${code}`).not.toMatch(/^settings\./)
    }
    // A reason this build does not know reads as the Host's own word
    expect(refusalLabel('something-new', en)).toBe('something-new')
  })

  it('says each job state, and nothing once a job is done', () => {
    expect(jobLine(job({ state: 'queued' }), ko)).toBe(ko('settings.extensions.plugin.queued'))
    expect(jobLine(job({ state: 'running', kind: 'share' }), ko)).toBe('설치하는 중…')
    expect(jobLine(job({ state: 'running', kind: 'update' }), ko)).toBe('설치하는 중…')
    expect(jobLine(job({ state: 'running', kind: 'check', target: undefined }), ko)).toBe(ko('settings.extensions.plugin.checking'))
    expect(jobLine(job({ state: 'running', kind: 'remove' }), ko)).toBe(ko('settings.extensions.plugin.removing'))
    expect(jobLine(job({ state: 'done' }), ko)).toBeNull()
    expect(jobLine(job({ state: 'needs-confirmation', command: { text: 'npx x', sha256: 'abc' } }), ko)).toBe(ko('settings.extensions.plugin.needsConfirmation'))
  })

  it('says a failure Astera decided in the person’s language, and Claude Code’s own message as it is', () => {
    expect(jobLine(job({ state: 'failed', code: 'marketplace-mismatch', message: 'marketplace obra is already in Astera’s plugin folder' }), ko)).toBe(
      '같은 이름의 마켓플레이스가 다른 주소로 이미 등록되어 있어 공유하지 않았습니다'
    )
    const claudes = 'Plugin "superpowers" not found in marketplace "obra"'
    expect(jobLine(job({ state: 'failed', message: claudes }), ko)).toBe(`실패: ${claudes}`)
    expect(jobLine(job({ state: 'failed', message: claudes }), en)).toBe(`Failed: ${claudes}`)
    // A code a newer Host sends that this build has no words for falls back to the message
    expect(jobLine(job({ state: 'failed', code: 'brand-new' as ClaudePluginFailureCode, message: 'why' }), en)).toBe('Failed: why')
  })

  it('puts missing files before an update, and an update before off', () => {
    expect(rowState({ ...listed, missing: true, update: { version: '2.0.0', fingerprint: 'f', checkedAt: 'now' }, enabled: false })).toBe('missing')
    expect(rowState({ ...listed, update: { version: '2.0.0', fingerprint: 'f', checkedAt: 'now' }, enabled: false })).toBe('update')
    expect(rowState({ ...listed, enabled: false })).toBe('off')
    expect(rowState(listed)).toBe('ok')
  })

  it('names the versions of an update only when the catalog says a different one', () => {
    expect(updateLabel('6.3.0', '7.0.0', ko)).toBe('업데이트 있음 (6.3.0 → 7.0.0)')
    expect(updateLabel('6.3.0', null, ko)).toBe('업데이트 있음')
    // R3: a catalog edit that kept the version
    expect(updateLabel('6.3.0', '6.3.0', ko)).toBe('업데이트 있음')
  })

  it('lists the accounts holding a plugin with commas, and marks one where it is off', () => {
    const holders = [
      { accountId: 'c2', version: '7.0.0', enabled: true },
      { accountId: 'c4', version: '6.3.0', enabled: true }
    ]
    expect(holdersHint(holders, labelOf, en)).toBe('claude2@… 7.0.0, claude4@… 6.3.0')
    expect(holdersHint(holders, labelOf, en)).not.toContain('·')
    expect(holdersHint([{ accountId: 'c2', version: '7.0.0', enabled: false }], labelOf, en)).toBe('claude2@… 7.0.0 (Off)')
  })

  it('names, on Off and Remove, each account whose own copy runs instead, with its version (P4)', () => {
    const p = {
      accountCopies: [
        { accountId: 'c2', version: '7.0.0', enabled: true },
        { accountId: 'c4', version: '6.3.0', enabled: true }
      ],
      requiredBy: []
    }
    expect(offConfirmBody(p, labelOf, ko)).toBe('끄면 다음 세션부터 이 계정들은 자기 버전을 씁니다: claude2@… 7.0.0, claude4@… 6.3.0')
    expect(offConfirmBody(p, labelOf, ko, 'remove')).toBe(ko('settings.extensions.plugin.removeBody', { list: 'claude2@… 7.0.0, claude4@… 6.3.0' }))
    expect(offConfirmBody({ accountCopies: [], requiredBy: [] }, labelOf, ko)).toBe('끄면 다음 세션부터 이 플러그인을 쓰지 않습니다.')
    expect(offConfirmBody({ accountCopies: [], requiredBy: [] }, labelOf, ko, 'remove')).toBe(ko('settings.extensions.plugin.removeBodyNone'))
    // An account where its own copy is switched off does not run it instead
    expect(offConfirmBody({ accountCopies: [{ accountId: 'c2', version: '7.0.0', enabled: false }], requiredBy: [] }, labelOf, ko)).toBe(
      ko('settings.extensions.plugin.offBodyNone')
    )
  })

  it('says a plugin still loads while a shared plugin that needs it is on', () => {
    const body = offConfirmBody({ accountCopies: [], requiredBy: ['a@m', 'b@m'] }, labelOf, ko)
    expect(body.split('\n')).toEqual([ko('settings.extensions.plugin.offBodyNone'), ko('settings.extensions.plugin.offRequiredBy', { list: 'a@m, b@m' })])
    expect(body).toContain('a@m, b@m')
  })

  it('offers each shareable plugin, and lists the refused ones and the unreadable accounts in the body (P-2)', () => {
    const found: DiscoveredClaudePlugin[] = [
      { id: 'superpowers@obra', name: 'superpowers', marketplace: 'obra', holders: [{ accountId: 'c2', version: '7.0.0', enabled: true }, { accountId: 'c4', version: '6.3.0', enabled: false }], source: { source: 'github', repo: 'obra/superpowers-marketplace' }, sourceAccountId: 'c2', shareable: true },
      { id: 'keyed@corp', name: 'keyed', marketplace: 'corp', holders: [{ accountId: 'c2', version: '1.0.0', enabled: true }], source: null, sourceAccountId: 'c2', shareable: false, reason: 'source-credential' }
    ]
    const p = pluginPrompt(found, ['c4'], labelOf, en)
    expect(p.choices).toEqual([{ id: 'superpowers@obra', label: 'superpowers@obra', hint: 'claude2@… 7.0.0, claude4@… 6.3.0 (Off)', defaultChecked: false }])
    expect(p.body.split('\n')).toEqual([
      en('settings.extensions.plugin.registerBody'),
      `keyed@corp: ${en('settings.extensions.plugin.reason.source-credential')}`,
      en('settings.extensions.plugin.unreadable', { account: 'claude4@…' })
    ])
    expect(p.title).toBe('Claude Code plugins')
  })

  it('says where a job stands for a plugin not in the list yet, by its latest job', () => {
    const jobs = [
      job({ id: '1', target: 'a@m', state: 'failed', message: 'first try' }),
      job({ id: '2', target: 'b@m', state: 'running' }),
      job({ id: '3', target: 'shared@m', state: 'running', kind: 'update' }),
      job({ id: '4', target: 'a@m', state: 'queued' }),
      job({ id: '5', target: 'c@m', state: 'done', kind: 'remove' }),
      job({ id: '6', target: 'd@m', state: 'failed', kind: 'remove', message: 'locked' }),
      job({ id: '7', kind: 'check', target: undefined, state: 'running' })
    ]
    expect(pendingLines(jobs, new Set(['shared@m']), en)).toEqual([
      { id: 'a@m', line: en('settings.extensions.plugin.queued'), stopped: false },
      { id: 'b@m', line: 'Installing…', stopped: false },
      { id: 'd@m', line: 'Failed: locked', stopped: true }
    ])
  })
})
