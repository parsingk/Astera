import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { t as translate, LANGS, type MessageKey, type MessageParams } from '../../../core/i18n'
import type { AgentProfile } from '../../../core/agentProfiles/types'
import {
  PROFILE_REASONS,
  addableAccounts,
  archivedNote,
  chatHoldsPrompts,
  permissionFields,
  permissionLabel,
  pickableProfiles,
  profileAccounts,
  profileFailureLine,
  profileNameOf,
  profileOfConversation,
  providerSuffix,
  reasonLine,
  resumeAsLine,
  resumeProfile,
  spawnPermission,
  offersSetUp,
  readinessRows,
  sandboxDefaultRemoved,
  sandboxHintKeys,
  sandboxReadinessShown,
  sandboxStateLine
} from './agentProfilesText'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = (rel: string): string => readFileSync(path.join(here, rel), 'utf8')
const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'ap_1',
  name: 'Reviewer',
  status: 'active',
  accountIds: ['a', 'b'],
  mcpExclude: [],
  permission: 'inherit',
  sandbox: false,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  ...over
})
const ACCOUNTS = [{ id: 'b' }, { id: 'a' }, { id: 'c' }]

describe('agentProfilesText', () => {
  // The store's refusals (validateProfile) and the delete guard's: the list here is the one the Host answers with
  it('knows every reason the Host refuses a profile with', () => {
    const union = /export type ProfileRejection =([^\n]+)/.exec(source('../../../core/agentProfiles/store.ts'))?.[1] ?? ''
    const fromStore = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    expect(fromStore.length).toBeGreaterThan(0)
    expect([...PROFILE_REASONS].sort()).toEqual([...fromStore, 'in-use'].sort())
  })

  it('has words for every reason and permission in every language', () => {
    for (const lang of LANGS) {
      const tr = (key: MessageKey, params?: MessageParams): string => translate(lang, key, params)
      for (const r of PROFILE_REASONS) expect(reasonLine(r, tr), `${lang} ${r}`).not.toMatch(/^settings\./)
      for (const p of ['inherit', 'bypass', 'ask'] as const) expect(permissionLabel(p, tr), `${lang} ${p}`).not.toMatch(/^settings\./)
    }
  })

  // Final fix wave (the person, F7): the permission choices speak the app's own words for skipping permission checks,
  // the ones Settings › Agents and the New Session dialog already use, not new ones; and the Settings line says when an
  // agent may use such a profile (F1), naming both settings as they are shown
  it("names the permission choices in the app's own words, and says when an agent may skip the checks", () => {
    const ko = (key: MessageKey): string => translate('ko', key)
    expect(['inherit', 'bypass', 'ask'].map((p) => permissionLabel(p as 'inherit', ko))).toEqual(['앱 설정 따름', '권한 확인 없이 실행', '권한 확인함'])
    for (const lang of LANGS) {
      const tr = (key: MessageKey): string => translate(lang, key)
      const bypass = permissionLabel('bypass', tr)
      expect(tr('session.new.bypassPermissions').startsWith(`${bypass} (`), lang).toBe(true)
      const line = tr('settings.agentProfiles.permissionAgents')
      expect(line, lang).toContain(bypass)
      expect(line, lang).toContain(tr('settings.agentPermission.label'))
      expect(line, lang).not.toMatch(/ [-–—] /)
    }
  })

  it('says the Host’s reason when it gives one, and why nothing came back otherwise', () => {
    expect(profileFailureLine({ ok: false, code: 'INVALID_ARGUMENTS', message: 'the profile was refused (mixed-provider)', reason: 'mixed-provider' }, en)).toBe(
      en('settings.agentProfiles.reason.mixed-provider')
    )
    expect(profileFailureLine({ ok: false, code: 'CONFLICT', message: 'in use', reason: 'in-use' }, en)).toBe(en('settings.agentProfiles.reason.in-use'))
    expect(profileFailureLine({ ok: false, code: 'HOST_NOT_RUNNING', message: '' }, en)).toBe(en('settings.plugins.fail.noHost'))
    // A reason this side does not know is not hidden behind a generic line: the Host's sentence is shown
    expect(profileFailureLine({ ok: false, code: 'INVALID_ARGUMENTS', message: 'the profile was refused (new-thing)', reason: 'new-thing' }, en)).toBe(
      'the profile was refused (new-thing)'
    )
  })

  it('a picked profile gives its accounts that still exist, in its order', () => {
    expect(profileAccounts(profile({ accountIds: ['b', 'gone', 'a'] }), ACCOUNTS)).toEqual(['b', 'a'])
    expect(profileAccounts(profile({ accountIds: ['gone'] }), ACCOUNTS)).toEqual([])
  })

  it('an archived profile gives nothing to pick', () => {
    expect(profileAccounts(profile({ status: 'archived' }), ACCOUNTS)).toBeNull()
  })

  it('offers the active profiles with an account, and names the active ones left without one', () => {
    const r = pickableProfiles(
      [profile(), profile({ id: 'ap_2', name: 'Old', status: 'archived' }), profile({ id: 'ap_3', name: 'Empty', accountIds: ['gone'] })],
      ACCOUNTS
    )
    expect(r.pickable.map((p) => p.id)).toEqual(['ap_1'])
    expect(r.unpickable).toEqual(['Empty'])
  })

  // Task 4's ledger note: the spawn lets an explicit bypassPermissions win, so a picked profile's permission only counts
  // when the request leaves it out
  it('a picked profile sends its id and leaves bypassPermissions out; none sends the checkbox as today', () => {
    const picked = permissionFields('ap_1', true)
    expect(picked).toEqual({ agentProfileId: 'ap_1' })
    expect('bypassPermissions' in picked).toBe(false)
    expect(permissionFields(undefined, false)).toEqual({ bypassPermissions: false })
    expect(permissionFields(undefined, true)).toEqual({ bypassPermissions: true })
    expect('agentProfileId' in permissionFields(undefined, true)).toBe(false)
  })

  it('the dialog and the app’s spawn both build the permission fields this way', () => {
    const dialog = source('./NewSessionDialog.tsx')
    expect(dialog).toContain('...permissionFields(profileId, bypassPermissions)')
    const app = source('../App.tsx')
    expect(app).toContain('...spawnPermission(opts)')
    expect(app).not.toMatch(/bypassPermissions: opts\.bypassPermissions, \/\/ start without permission prompts/)
  })

  // Fix round 1 (I2): a restart keeps the session's profile beside the bypass it already resolved, which keeps winning;
  // the app's spawn sends both when both are given, and only the checkbox's value when there is no profile
  it('the app’s spawn passes on what it is given, a profile beside an explicit bypass included', () => {
    expect(spawnPermission({ agentProfileId: 'ap_1' })).toEqual({ agentProfileId: 'ap_1' })
    expect('bypassPermissions' in spawnPermission({ agentProfileId: 'ap_1' })).toBe(false)
    expect(spawnPermission({ agentProfileId: 'ap_1', bypassPermissions: false })).toEqual({ agentProfileId: 'ap_1', bypassPermissions: false })
    expect(spawnPermission({ bypassPermissions: true })).toEqual({ bypassPermissions: true })
    expect(spawnPermission({})).toEqual({ bypassPermissions: undefined })
  })

  it('a restart carries the session’s profile', () => {
    const app = source('../App.tsx')
    const restart = app.slice(app.indexOf('const restart = (old: SessionInfo)'), app.indexOf('const resumeFromHistory = ('))
    expect(restart).toContain('bypassPermissions: old.bypassPermissions,')
    expect(restart).toContain("...(old.agentProfileId !== undefined ? { agentProfileId: old.agentProfileId } : {})")
  })

  // Third follow-up: the profile a history resume carries is decided once, in the resume dialog (an open tab's for the
  // conversation first, then the one the app recorded, while the shared list still has it), and the same one names the
  // hint, decides the permission and goes to the spawn. App.tsx hands the dialog the tab's and spawns what it decided
  it('a history resume carries the one profile the dialog decided, tab first, then the record', () => {
    const list = [profile(), profile({ id: 'ap_2', name: 'Night shift', status: 'archived' })]
    expect(resumeProfile(list, 'ap_2', 'ap_1')?.id).toBe('ap_2')
    expect(resumeProfile(list, undefined, 'ap_1')?.id).toBe('ap_1')
    expect(resumeProfile(list, undefined, null)).toBeNull()
    expect(resumeProfile(list, undefined, 'ap_gone')).toBeNull()
    expect(resumeProfile(list, 'ap_gone', 'ap_1')).toBeNull()
    const dialog = source('./ResumeDialog.tsx')
    expect(dialog).toMatch(/setSavedProfile\(d\.agentProfileId\)/)
    expect(dialog).toContain('const carried = resumeProfile(profiles, tabProfileId, savedProfile)')
    const history = source('./HistoryBrowser.tsx')
    expect(history).toContain('tabProfileId={tabProfileOf(pendingResume.entry.sessionId)}')
    const app = source('../App.tsx')
    expect(app).toContain('tabProfileOf={(id) => profileOfConversation(sessionsRef.current, id)}')
    const resume = app.slice(app.indexOf('const resumeFromHistory = ('), app.indexOf('// 마지막으로 활성이었던 세션'))
    expect(resume).not.toContain('profileOfConversation(')
    expect(resume).toContain('bypassPermissions: opts.bypassPermissions,')
    expect(resume).toContain('...(opts.agentProfileId !== undefined ? { agentProfileId: opts.agentProfileId } : {})')
  })

  // Third follow-up: a resume that carries a profile follows its permission as the New Session dialog does: the bypass
  // checkbox is hidden and the bypass left out (permissionFields), so the spawn's profile decides it (spawnPermission)
  it('a resume that carries a profile hides the bypass checkbox and leaves the bypass out', () => {
    const dialog = source('./ResumeDialog.tsx')
    expect(dialog).toContain('...permissionFields(carried?.id, bypassPermissions)')
    const checkbox = dialog.slice(dialog.indexOf('{carried === null && ('), dialog.indexOf("{t('session.new.bypassPermissions')}"))
    expect(checkbox).toContain('checked={bypassPermissions}')
    expect(dialog).not.toContain('agentProfileId: savedProfile')
  })

  // Second follow-up: the resume dialog says when the conversation resumes as a profile, by its name; nothing when it
  // carries none (none recorded, or the id no longer resolves: it resumes without one)
  it('says which profile a history resume continues as, only while the profile resolves', () => {
    const list = [profile(), profile({ id: 'ap_2', name: 'Night shift', status: 'archived' })]
    expect(resumeAsLine(resumeProfile(list, undefined, 'ap_1'), en)).toBe('This conversation resumes as the agent profile “Reviewer”.')
    expect(resumeAsLine(resumeProfile(list, 'ap_2', null), en)).toBe('This conversation resumes as the agent profile “Night shift”.')
    expect(resumeAsLine(list[0], (k, p) => translate('ko', k, p))).toBe("에이전트 프로필 'Reviewer'(으)로 이어집니다.")
    expect(resumeAsLine(resumeProfile(list, undefined, 'ap_gone'), en)).toBeNull()
    expect(resumeAsLine(null, en)).toBeNull()
    for (const lang of LANGS) expect(resumeAsLine(list[0], (k, p) => translate(lang, k, p)), lang).toContain('Reviewer')
  })

  it('the resume dialog shows that line under its controls, naming the profile it carries from the shared list', () => {
    const dialog = source('./ResumeDialog.tsx')
    expect(dialog).toMatch(/useAgentProfilesNaming\(wantedProfile !== null \? \[wantedProfile\] : \[\]\)/)
    expect(dialog).toMatch(/const resumeAs = resumeAsLine\(carried, t\)/)
    expect(dialog).toContain('{resumeAs !== null && <p className="modal-hint">{resumeAs}</p>}')
    const controls = dialog.indexOf("{t('session.new.slackNotify')}")
    const line = dialog.indexOf('{resumeAs !== null &&')
    expect(controls >= 0 && line > controls && line < dialog.indexOf('<div className="row right">')).toBe(true)
  })

  it('finds the profile of a conversation a tab of this app held', () => {
    const sessions = [
      { resumeSessionId: 'conv-a', agentProfileId: 'ap_1' },
      { threadId: 'thr-b', agentProfileId: 'ap_2' },
      { resumeSessionId: 'conv-c' }
    ]
    expect(profileOfConversation(sessions, 'conv-a')).toBe('ap_1')
    expect(profileOfConversation(sessions, 'thr-b')).toBe('ap_2')
    expect(profileOfConversation(sessions, 'conv-c')).toBeUndefined()
    expect(profileOfConversation(sessions, 'unknown')).toBeUndefined()
  })

  it('a chat session holds a prompt only when it asks for permission', () => {
    expect(chatHoldsPrompts(undefined, true, false)).toBe(true) // no profile: the checkbox, unticked
    expect(chatHoldsPrompts(undefined, false, true)).toBe(false)
    expect(chatHoldsPrompts(profile({ permission: 'ask' }), true, true)).toBe(true)
    expect(chatHoldsPrompts(profile({ permission: 'bypass' }), false, false)).toBe(false)
    expect(chatHoldsPrompts(profile({ permission: 'inherit' }), false, true)).toBe(true) // the app-wide mode asks
    expect(chatHoldsPrompts(profile({ permission: 'inherit' }), true, true)).toBe(false)
  })

  it('names a profile by its name, or by its id when the list does not have it', () => {
    expect(profileNameOf([profile()], 'ap_1')).toBe('Reviewer')
    expect(profileNameOf([profile()], 'ap_9')).toBe('ap_9')
  })
})

// 2026-10-26: the add list offered Claude and Codex accounts together, and saving a mix was refused (mixed-provider). Once
// one account is picked it offers only that provider's, and every item says its provider by name
describe('the editor’s add list', () => {
  const c1 = { id: 'c1', provider: 'claude' as const }
  const c2: { id: string; provider?: 'claude' | 'codex' } = { id: 'c2' } // no provider: a Claude account, as every older one is
  const x1 = { id: 'x1', provider: 'codex' as const }
  const x2 = { id: 'x2', provider: 'codex' as const }
  const all = [c1, x1, c2, x2]

  it('offers every account before one is picked, then only the picked one’s provider', () => {
    expect(addableAccounts(all, []).map((a) => a.id)).toEqual(['c1', 'x1', 'c2', 'x2'])
    expect(addableAccounts(all, ['c1']).map((a) => a.id)).toEqual(['c2'])
    expect(addableAccounts(all, ['x1']).map((a) => a.id)).toEqual(['x2'])
    expect(addableAccounts(all, ['x1', 'x2'])).toEqual([])
    // The first picked decides; an id no account has any more decides nothing
    expect(addableAccounts(all, ['gone']).map((a) => a.id)).toEqual(['c1', 'x1', 'c2', 'x2'])
  })

  it('says each account’s provider by name', () => {
    expect(providerSuffix(c1)).toBe(' (Claude)')
    expect(providerSuffix(c2)).toBe(' (Claude)')
    expect(providerSuffix(x1)).toBe(' (Codex)')
  })

  it('is the list the editor offers, with the provider after each name', () => {
    const editor = source('AgentProfilesSettings.tsx')
    expect(editor).toContain('const unpicked = addableAccounts(accounts, d.accountIds)')
    expect(editor).toMatch(/<AccountSelect accounts=\{unpicked\}[^>]*suffixOf=\{providerSuffix\}/)
  })
})

// Sandbox design §6, Task 8: the switch with its per-OS lines, and on Windows each Codex account's readiness under a
// sandboxed profile, with 설정하기 for one not set up
describe('the sandbox switch', () => {
  const x1 = { id: 'x1', label: 'Work', provider: 'codex' as const }
  const x2 = { id: 'x2', label: 'Home', provider: 'codex' as const }
  const c1 = { id: 'c1', label: 'Claude', provider: 'claude' as const }
  const accounts = [x1, x2, c1]
  const boxed = profile({ accountIds: ['x2', 'x1'], sandbox: true })

  it('says what it does for the profile’s CLI, then the limits; both CLIs before an account is picked', () => {
    expect(sandboxHintKeys('codex')).toEqual(['settings.agentProfiles.sandboxHint.codex', 'settings.agentProfiles.sandboxHint.limits'])
    expect(sandboxHintKeys('claude')).toEqual(['settings.agentProfiles.sandboxHint.claude', 'settings.agentProfiles.sandboxHint.limits'])
    expect(sandboxHintKeys(undefined)).toEqual([
      'settings.agentProfiles.sandboxHint.codex',
      'settings.agentProfiles.sandboxHint.claude',
      'settings.agentProfiles.sandboxHint.limits'
    ])
    expect(en('settings.agentProfiles.sandbox')).toBe('Run in the sandbox')
    expect(en('settings.agentProfiles.sandboxHint.claude')).toContain('Windows: the shell is not restricted')
  })

  it('shows readiness only for a stored profile with the sandbox on, on Windows, with a Codex account', () => {
    expect(sandboxReadinessShown(boxed, 'win32', accounts)).toBe(true)
    expect(sandboxReadinessShown(boxed, 'darwin', accounts)).toBe(false)
    expect(sandboxReadinessShown(boxed, 'linux', accounts)).toBe(false)
    expect(sandboxReadinessShown({ ...boxed, sandbox: false }, 'win32', accounts)).toBe(false)
    expect(sandboxReadinessShown({ ...boxed, accountIds: ['c1'] }, 'win32', accounts)).toBe(false)
    // An account removed from Astera since is not asked about
    expect(sandboxReadinessShown({ ...boxed, accountIds: ['gone'] }, 'win32', accounts)).toBe(false)
  })

  it('lists the profile’s Codex accounts in its order with what the Host answered for each', () => {
    const answer = { ok: true as const, body: { accounts: [{ accountId: 'x1', state: 'ready' }, { accountId: 'x2', state: 'not-set-up' }] } }
    expect(readinessRows(boxed, accounts, answer)).toEqual([
      { accountId: 'x2', label: 'Home', state: 'not-set-up', elevatedDefault: false },
      { accountId: 'x1', label: 'Work', state: 'ready', elevatedDefault: false }
    ])
    // Task P: an account whose config.toml makes the elevated sandbox its default, as the Host says it
    const shared = { ok: true as const, body: { accounts: [{ accountId: 'x1', state: 'ready', elevatedDefault: true }, { accountId: 'x2', state: 'ready', elevatedDefault: 'yes' }] } }
    expect(readinessRows(boxed, accounts, shared).map((r) => r.elevatedDefault)).toEqual([false, true])
    // Still asking: the accounts, with no state yet
    expect(readinessRows(boxed, accounts, null).map((r) => r.state)).toEqual([null, null])
    expect(readinessRows(boxed, accounts, null).map((r) => r.elevatedDefault)).toEqual([false, false])
    // An account the Host left out, or a call that came back with nothing, could not be asked about
    expect(readinessRows(boxed, accounts, { ok: true, body: { accounts: [{ accountId: 'x1', state: 'ready' }] } }).map((r) => r.state)).toEqual(['check-failed', 'ready'])
    expect(readinessRows(boxed, accounts, { ok: false, code: 'HOST_NOT_RUNNING', message: 'no Host' }).map((r) => r.state)).toEqual(['check-failed', 'check-failed'])
  })

  it('says each readiness in the person’s language, and offers 설정하기 only for one not set up', () => {
    expect(['ready', 'not-set-up', 'check-failed'].map((s) => sandboxStateLine(s, en))).toEqual(['Sandbox ready', 'Sandbox not set up', 'Could not check'])
    expect(['ready', 'not-set-up', 'check-failed'].map((s) => sandboxStateLine(s, (k, p) => translate('ko', k, p)))).toEqual(['sandbox 준비됨', 'sandbox 설정 안 됨', '상태를 묻지 못함'])
    // A state a newer Host gives is shown as it was named
    expect(sandboxStateLine('pending', en)).toBe('pending')
    expect(offersSetUp('not-set-up')).toBe(true)
    for (const s of ['ready', 'check-failed', null]) expect(offersSetUp(s as 'ready' | null)).toBe(false)
  })

  // Task P: Remove says nothing when the default is gone (the readiness asked again shows it), and names the file to
  // edit by hand when it could not be taken out
  it('reads what the Host did with Remove', () => {
    for (const outcome of ['removed', 'absent', 'other-value']) expect(sandboxDefaultRemoved({ ok: true, body: { outcome, file: 'C:/h/config.toml' } }), outcome).toEqual({ ok: true })
    for (const outcome of ['cannot-edit', 'failed']) expect(sandboxDefaultRemoved({ ok: true, body: { outcome, file: 'C:/h/config.toml' } }), outcome).toEqual({ ok: false, file: 'C:/h/config.toml' })
    expect(sandboxDefaultRemoved({ ok: false, code: 'HOST_NOT_RUNNING', message: 'no Host' })).toEqual({ ok: false, file: null })
    expect(sandboxDefaultRemoved({ ok: true, body: {} })).toEqual({ ok: false, file: null })
  })

  it('the editor carries the switch and sends it, and asks readiness and sets up through the Host', () => {
    const editor = source('AgentProfilesSettings.tsx')
    // The draft carries the switch from what the Host kept, and a save sends the whole draft
    expect(editor).toContain('sandbox: p?.sandbox ?? false')
    expect(editor).not.toMatch(/Omit<AgentProfileFields, 'sandbox'>/)
    expect(editor).toContain("checked={d.sandbox} onChange={(e) => set('sandbox', e.target.checked)}")
    expect(editor).toContain("t('settings.agentProfiles.sandbox')")
    expect(editor).toContain('sandboxHintKeys(')
    expect(editor).toContain('window.api.agentProfiles.sandboxReadiness(profile.id)')
    expect(editor).toContain('window.api.agentProfiles.sandboxSetup(profile.id, accountId)')
    expect(editor).toContain("t('session.spawn.sandbox.setUp')")
    // A failed setup is said with Task 6's line, then the readiness is asked again. Fix round 1: a setup that worked says
    // nothing more, since the refreshed line reads ready
    expect(editor).toContain('sandboxSetupOutcome(answer)')
    expect(editor).toContain("toast.error(outcome.line ?? t('session.spawn.sandbox.setUpFailed'))")
    expect(editor).not.toContain('setUpDone')
    expect(editor).toContain('sandboxReadinessShown(p, window.api.platform, accounts)')
    // Task P: an elevated default is said in one sentence beside the row, and taken out only on the person's press
    expect(editor).toContain("t('settings.agentProfiles.sandboxDefault.hint')")
    // Fix round 1, seen on the hidden desktop: as a settings row the sentence took the label's weight and squeezed the
    // button to one letter a line. It is a dim hint that grows, beside a button that keeps its width
    expect(editor).toContain('<div className="remote-actions sandbox-default-row">')
    expect(editor).toContain('<span className="settings-hint remote-actions-grow">{t(\'settings.agentProfiles.sandboxDefault.hint\')}</span>')
    expect(source('../styles.css')).toContain('.sandbox-default-row .settings-gen-refresh { flex: none; white-space: nowrap; }')
    expect(editor).toContain("t('settings.agentProfiles.sandboxDefault.remove')")
    expect(editor).toContain('window.api.agentProfiles.sandboxDefaultRemove(profile.id, accountId)')
    expect(editor).toMatch(/onClick=\{\(\) => void removeDefault\(r\.accountId\)\}/)
    expect(editor).toContain("t('settings.agentProfiles.sandboxDefault.removeFailed', { file: removed.file ?? 'config.toml' })")
  })
})

// Lifecycle design §5: an archived profile records when and why, and its row says both; Archive asks for the reason in a
// one-line field first, then archives or cancels
describe('an archived profile', () => {
  const day = (iso: string): string => iso.slice(0, 10)

  it('says when it was archived, in the reader’s date, and the reason given', () => {
    expect(archivedNote(profile({ status: 'archived', archivedAt: '2026-10-30T01:00:00.000Z', archivedReason: 'replaced by p2' }), en, day)).toEqual({
      on: 'Archived 2026-10-30',
      reason: 'replaced by p2'
    })
    expect(archivedNote(profile({ status: 'archived', archivedAt: '2026-10-30T01:00:00.000Z' }), en, day)).toEqual({ on: 'Archived 2026-10-30' })
    expect(archivedNote(profile({ status: 'archived', archivedAt: '2026-10-30T01:00:00.000Z' }), (k, p) => translate('ko', k, p), day)).toEqual({ on: '2026-10-30에 보관함' })
  })

  it('says nothing for an active profile, or one archived before the date was kept', () => {
    expect(archivedNote(profile(), en, day)).toBeNull()
    expect(archivedNote(profile({ status: 'archived' }), en, day)).toBeNull()
  })

  it('the row shows the note, and Archive opens a one-line reason field with Archive and Cancel', () => {
    const editor = source('AgentProfilesSettings.tsx')
    expect(editor).toContain('archivedNote(p, t, (iso) => new Date(iso).toLocaleDateString())')
    expect(editor).toContain("t('settings.agentProfiles.archiveReason')")
    expect(editor).toMatch(/<input[^>]*type="text"[^>]*maxLength=\{200\}/)
    expect(editor).toContain("window.api.agentProfiles.archive(p.id, reason.trim() === '' ? undefined : reason)")
    expect(editor).toContain("t('common.cancel')")
  })
})
