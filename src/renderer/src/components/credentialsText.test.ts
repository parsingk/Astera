// Settings › Security & Access › Credentials (credentials design §5, §7): the words the section shows, apart from the
// component so each is tested as text, and the pins on the component's source where its shape is the rule.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { t as translate, CATALOGS, LANGS, type MessageKey, type MessageParams } from '../../../core/i18n'
import { CREDENTIALS_TITLE } from './securityText'
import {
  CREDENTIAL_KEYS,
  credentialFailure,
  entryName,
  hidesText,
  presetNote,
  projectNameOf,
  splitNames,
  switchNote,
  useLine,
  usesPageOf,
  whereReady,
  whereText
} from './credentialsText'
import type { CredentialEntry } from '../../../core/credentials/types'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = (rel: string): string => readFileSync(path.join(here, rel), 'utf8')
const ko = (key: MessageKey, params?: MessageParams): string => translate('ko', key, params)
const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

const PRESETS = [
  { id: 'gh', label: 'GitHub CLI (gh)', measuredOn: ['win32'] },
  { id: 'aws', label: 'AWS CLI', measuredOn: ['win32', 'linux'] }
]
const hideOnly: CredentialEntry = { kind: 'hide-only', id: 'hc_1', alias: 'Cloud', envNames: ['STRIPE_KEY'], presets: ['aws'], hide: { on: true }, createdAt: '2026-10-26T00:00:00.000Z' }
const mcp = (present: boolean, enabled = true): CredentialEntry & { present: boolean } => ({
  kind: 'mcp-secret', id: 'mcp:m1', serverId: 'm1', serverName: 'linear', secretNames: ['k'], envNames: ['LINEAR_API_KEY'], protectedNames: [], hide: { on: true }, enabled, present
})

describe('credentialsText', () => {
  it('names the section Credentials in every language', () => {
    expect(CREDENTIALS_TITLE).toBe('Credentials')
    expect(source('SecuritySettings.tsx')).toContain('{CREDENTIALS_TITLE}')
  })

  it('has every settings.credentials key in every language', () => {
    expect(CREDENTIAL_KEYS.length).toBeGreaterThan(30)
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(CREDENTIAL_KEYS.filter((k) => !messages[k]), lang).toEqual([])
    }
  })

  it('says the honest line and the session line in Korean exactly', () => {
    expect(ko('settings.credentials.hint')).toBe(
      'Astera 는 여기 등록된 것만 관리합니다. 등록하지 않은 키와, OS 저장소가 모든 프로그램에 내주는 로그인(Windows 자격 증명 관리자, 키체인, git 에 저장된 로그인)은 에이전트가 여전히 쓸 수 있습니다.'
    )
    expect(ko('settings.credentials.sessions')).toBe('켜고 끈 설정은 그 뒤에 시작하는 세션부터 적용됩니다.')
    expect(ko('settings.credentials.presetNote')).toBe('편의 목록입니다. 이 도구가 로그인하는 모든 방법을 다루지는 않습니다.')
    // Final review M2: a damaged list still hides the shared servers' keys by their default
    expect(ko('settings.credentials.damaged')).toBe(
      '목록 파일이 손상되어 직접 추가한 항목은 지금 숨기지 않습니다. 공유 MCP 서버의 키는 기본대로 숨깁니다. 손상된 파일은 옆에 복사해 두었습니다.'
    )
  })

  it('has no value field and no show-value action', () => {
    const screen = source('CredentialsSection.tsx')
    expect(screen).not.toContain('type="password"')
    expect(screen).not.toMatch(/show(Value|Secret)/)
  })

  it('labels the gh preset and an MCP entry with what their switch changes', () => {
    const gh: CredentialEntry = { ...hideOnly, presets: ['gh'] }
    expect(switchNote(gh, ko)).toBe('에이전트가 gh 로 하던 일(PR, 이슈, CI 등)을 못 하게 됩니다.')
    expect(switchNote(mcp(true), ko)).toBe('에이전트는 이 서버를 Astera 를 거쳐 계속 쓰고, 세션에서는 이 변수만 빠집니다.')
    expect(switchNote(mcp(false), ko)).toBe('지금은 바뀌는 것이 없습니다. 나중에 이 변수가 생겨도 빠집니다.')
  })

  // Final review M13: every preset says what else an agent loses with it
  it('says what each preset takes beside the login, and an entry with presets says it under its switch', () => {
    // The presets the Host offers (core/credentials/presets.ts, held to this list by its own test)
    for (const id of ['gh', 'aws', 'gcloud', 'npm', 'docker', 'kubectl']) expect(presetNote(id, ko), id).not.toBeNull()
    expect(presetNote('az', ko)).toBeNull()
    expect(presetNote('npm', ko)).toContain('.npmrc')
    expect(switchNote(hideOnly, ko)).toBe(presetNote('aws', ko))
    expect(switchNote({ ...hideOnly, presets: ['gh', 'npm'] }, ko)).toBe(`${presetNote('gh', ko)} ${presetNote('npm', ko)}`)
  })

  // Final review M8 and I4: a server switched off is not used; variables nobody's session has change nothing now
  it('says a switched-off server is not used, and that names no session inherits change nothing now', () => {
    expect(switchNote(mcp(true, false), ko)).toBe('이 서버는 MCP & Skills 에서 꺼져 있어 지금은 쓰이지 않습니다. 세션에서는 이 변수만 빠집니다.')
    const names: CredentialEntry & { present: boolean } = { ...hideOnly, presets: [], present: false }
    expect(switchNote(names, ko)).toBe('지금은 바뀌는 것이 없습니다. 나중에 이 변수가 생겨도 빠집니다.')
    expect(switchNote({ ...names, present: true }, ko)).toBeNull()
    expect(ko('settings.credentials.envNames.startup')).toMatch(/셸 시작 파일/)
    expect(source('CredentialsSection.tsx')).toContain("t('settings.credentials.envNames.startup')")
  })

  // Final review M4: "only the projects picked" with none picked is not saved as every session
  it('holds a new entry back until a project is picked when it is narrowed', () => {
    expect(whereReady(false, [])).toBe(true)
    expect(whereReady(true, [])).toBe(false)
    expect(whereReady(true, ['D:/p'])).toBe(true)
    const screen = source('CredentialsSection.tsx')
    expect(screen).toContain('whereReady(narrowing')
    expect(screen).toContain("t('settings.credentials.scope.pickOne')")
  })

  // Final review M5: a slower read never puts back what a later one shows, and nothing is changed until the list is read
  // again after a change
  it('takes only the latest read of the list and keeps the screen busy until it lands', () => {
    const screen = source('CredentialsSection.tsx')
    expect(screen).toMatch(/const n = \+\+reading\.current/)
    expect(screen).toMatch(/if \(n !== reading\.current\) return/)
    expect(screen).toMatch(/await load\(\)\s*\n\s*setBusy\(false\)/)
  })

  it('names an entry, what it hides and where', () => {
    expect(entryName(hideOnly)).toBe('Cloud')
    expect(entryName(mcp(true))).toBe('linear')
    expect(hidesText(hideOnly, PRESETS)).toBe('STRIPE_KEY, AWS CLI')
    expect(whereText(hideOnly, () => undefined, en)).toBe('Every agent session')
    const narrowed: CredentialEntry = { ...hideOnly, hide: { on: true, projects: ['D:/p', 'D:/q'] } }
    expect(whereText(narrowed, (p) => (p === 'D:/p' ? 'astera' : undefined), en)).toBe('Sessions in astera, D:/q')
    // A project folder as Windows spells it, whatever its case, slashes or trailing slash; Linux keeps the case
    const projects = [{ path: 'D:\\work\\astera', name: 'astera' }]
    expect(projectNameOf(projects, 'd:/Work/astera/', 'win32')).toBe('astera')
    expect(projectNameOf(projects, 'D:\\work\\astera2', 'win32')).toBeUndefined()
    expect(projectNameOf([{ path: '/home/a/p', name: 'p' }], '/home/a/P', 'linux')).toBeUndefined()
  })

  it('splits variable names typed with commas or spaces, once each', () => {
    expect(splitNames(' STRIPE_KEY, SENTRY_DSN  STRIPE_KEY,,')).toEqual(['STRIPE_KEY', 'SENTRY_DSN'])
    expect(splitNames('')).toEqual([])
  })

  it('says a refusal in the person\u2019s language by its reason', () => {
    expect(credentialFailure({ ok: false, code: 'BAD_REQUEST', message: 'x', reason: 'protected-name' }, ko)).toBe(
      'Claude, Codex, Astera 가 실행에 쓰는 변수라 숨길 수 없습니다.'
    )
    expect(credentialFailure({ ok: false, code: 'FAILED', message: 'the Host is gone' }, en)).toBe('the Host is gone')
    // Final review M3, M7
    expect(credentialFailure({ ok: false, code: 'INVALID_ARGUMENTS', message: 'x', reason: 'system-name' }, ko)).toBe('세션이 실행되는 데 필요한 OS 변수라 숨길 수 없습니다.')
    expect(credentialFailure({ ok: false, code: 'INVALID_ARGUMENTS', message: 'x', reason: 'alias-taken' }, ko)).toBe('같은 이름의 항목이 이미 있습니다.')
  })

  it('writes a use as a line of its time, who, what and how it went', () => {
    const line = useLine(
      { id: 'cu_1', at: '2026-10-26T10:00:00.000Z', actor: 'session', sessionId: 's1', entryId: 'mcp:m1', provider: 'mcp', action: 'mcp.call', resource: 'linear/create_issue', outcome: 'ok', evidence: 'managed', requestId: 'rq' },
      (id) => (id === 's1' ? 'My tab' : undefined),
      en
    )
    expect(line).toMatchObject({ who: 'My tab', action: 'call an MCP tool', target: 'linear/create_issue', outcome: 'Done', evidence: 'Through Astera' })
    const gh = useLine(
      { id: 'cu_2', at: '2026-10-26T10:00:00.000Z', actor: 'host', provider: 'github', action: 'github.ci.rerun', resource: 'o/r 123', outcome: 'failed', evidence: 'observed', requestId: 'rq' },
      () => undefined,
      ko
    )
    expect(gh).toMatchObject({ who: 'Astera 자동 작업', action: 'CI 다시 실행', outcome: '실패', evidence: '내 로그인으로 Astera 가 실행' })
  })

  it('pages the uses by the last row shown when the Host says there are more', () => {
    const u = (id: string, at: string) => ({ id, at, actor: 'app', provider: 'github', action: 'github.read', resource: 'o/r', outcome: 'ok', evidence: 'observed', requestId: 'r' })
    expect(usesPageOf({ uses: [u('cu_2', '2026-10-26T10:00:00.000Z'), u('cu_1', '2026-10-26T09:00:00.000Z')], truncated: true })).toMatchObject({
      next: { until: '2026-10-26T09:00:00.000Z', beforeId: 'cu_1' }
    })
    expect(usesPageOf({ uses: [u('cu_1', '2026-10-26T09:00:00.000Z')], truncated: false }).next).toBeNull()
    expect(usesPageOf({ uses: [{ id: 'x' }, 'junk'] }).uses).toEqual([])
  })

  it('says the file is damaged when the list answers so', () => {
    expect(credentialFailure({ ok: false, code: 'CONFLICT', message: 'credentials.json is damaged', reason: 'damaged' }, ko)).toBe(
      '목록 파일이 손상되어 직접 추가한 항목은 지금 숨기지 않습니다. 공유 MCP 서버의 키는 기본대로 숨깁니다. 손상된 파일은 옆에 복사해 두었습니다.'
    )
    expect(source('CredentialsSection.tsx')).toContain("reason === 'damaged'")
  })

  it('the Audit Logs view switch pages credential uses on their own', () => {
    const screen = source('SecuritySettings.tsx')
    expect(screen).toContain('window.api.credentials.uses(')
    expect(screen).toMatch(/beforeId/)
    expect(screen).toContain("t('settings.credentials.view.uses')")
  })
})
