import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { t as translate, LANGS, type MessageKey, type MessageParams } from '../../../core/i18n'
import type { AgentProfile } from '../../../core/agentProfiles/types'
import {
  PROFILE_REASONS,
  chatHoldsPrompts,
  permissionFields,
  permissionLabel,
  pickableProfiles,
  profileAccounts,
  profileFailureLine,
  profileNameOf,
  reasonLine
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
    expect(app).toContain('...permissionFields(opts.agentProfileId, opts.bypassPermissions)')
    expect(app).not.toMatch(/bypassPermissions: opts\.bypassPermissions, \/\/ start without permission prompts/)
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
