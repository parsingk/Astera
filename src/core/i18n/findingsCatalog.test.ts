// Findings speak in every language the app does (lifecycle design §7). ko is the source: a key it has under `findings.`,
// every language has, so a new string cannot fall back to English.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const keysOf = (): string[] => Object.keys(CATALOGS.ko.messages).filter((k) => k.startsWith('findings.'))

describe('the findings catalog', () => {
  it('has every key in every language', () => {
    const ko = keysOf()
    expect(ko.length).toBeGreaterThanOrEqual(18)
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(ko.filter((k) => !messages[k]), lang).toEqual([])
    }
  })

  // The person's rule for what the app says: a sentence is rewritten rather than broken with a dash
  it('has no dash inside a sentence in any language', () => {
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string>
      expect(keysOf().filter((k) => /\s[—–-]\s/.test(m[k] ?? '')), lang).toEqual([])
    }
  })

  // Every placeholder ko fills, each language fills, so no value is dropped from a translation
  it('keeps the placeholders of each sentence', () => {
    const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort()
    const ko = CATALOGS.ko.messages as Record<string, string>
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string>
      expect(keysOf().filter((k) => holes(m[k] ?? '').join() !== holes(ko[k]).join()), lang).toEqual([])
    }
  })

  it('keeps the English the CLI prints and the Korean the person approved', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    const ko = CATALOGS.ko.messages as Record<string, string>
    expect(en['findings.reason.unusedProfile']).toBe('Not used in {days} days.')
    expect(en['findings.reason.failingProfile']).toBe('{failed} of its {total} worker starts in 30 days failed. The last failure was in {run}.')
    expect(en['findings.do.keepOne']).toBe('Keep one and archive the others.')
    // One sentence for the whole group, so it is right on every member's mark (ruling R3-1)
    expect(en['findings.reason.duplicateProfile']).toBe('These profiles have the same accounts, MCP exclusions, permission and sandbox: {names}.')
    expect(ko['findings.reason.duplicateProfile']).toBe('다음 프로필은 계정, 제외한 MCP 서버, 권한, 샌드박스가 모두 같습니다: {names}.')
    expect(ko['findings.reason.unusedProfileNever']).toBe('만든 지 {days}일이 지났지만 한 번도 쓰지 않았습니다.')
    expect(ko['findings.reason.tokenSpike']).toBe('토큰을 {total}개 썼습니다. {group}의 중앙값 {median}의 {times}배입니다.')
    expect(ko['findings.do.repointJob']).toBe('Job이 다른 프로필을 쓰게 바꾸세요.')
  })

  // §4.5 to §4.9: the copy the plan gives, in the English the CLI prints and the Korean the person reads
  it('keeps the extension, coverage, Runtime and credential copy', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    const ko = CATALOGS.ko.messages as Record<string, string>
    const copy: Record<string, [string, string]> = {
      'findings.reason.unusedMcp': ['No session called it in {days} days.', '{days}일 동안 어느 세션도 부르지 않았습니다.'],
      'findings.reason.coverageGap': [
        'Rule {rule} denies {action}, and {cli} sessions see it only in part: {coverage}.',
        '규칙 {rule}은 {action}을 거부하지만, {cli} 세션에서는 일부만 보입니다: {coverage}.'
      ],
      'findings.reason.coverageGapEnforce': [
        'Rule {rule} denies {action}, and {cli} sessions can block it only in part: {coverage}.',
        '규칙 {rule}은 {action}을 거부하지만, {cli} 세션에서는 일부만 막을 수 있습니다: {coverage}.'
      ],
      // A cell with a level only (fix round 1, Minor 1): no word after a colon, and `none` is never "in part"
      'findings.reason.coverageGapPart': [
        'Rule {rule} denies {action}, and {cli} sessions see it only in part.',
        '규칙 {rule}은 {action}을 거부하지만, {cli} 세션에서는 일부만 보입니다.'
      ],
      'findings.reason.coverageGapNone': ['Rule {rule} denies {action}, and {cli} sessions do not see it.', '규칙 {rule}은 {action}을 거부하지만, {cli} 세션에서는 보이지 않습니다.'],
      'findings.reason.coverageGapEnforcePart': [
        'Rule {rule} denies {action}, and {cli} sessions can block it only in part.',
        '규칙 {rule}은 {action}을 거부하지만, {cli} 세션에서는 일부만 막을 수 있습니다.'
      ],
      'findings.reason.coverageGapEnforceNone': [
        'Rule {rule} denies {action}, and {cli} sessions cannot block it.',
        '규칙 {rule}은 {action}을 거부하지만, {cli} 세션에서는 막을 수 없습니다.'
      ],
      'findings.reason.staleRuntime': ['Not reached in {days} days.', '{days}일 동안 연결되지 않았습니다.'],
      'findings.reason.staleRuntimeNever': ['Never reached since it was paired {days} days ago.', '연결한 지 {days}일이 지났지만 한 번도 닿지 않았습니다.'],
      'findings.reason.unmanagedReference': [
        'Passes {names} from the session, which the Credentials list does not name.',
        '세션의 {names}를 넘기는데, Credentials 목록에 없는 이름입니다.'
      ],
      'findings.reason.staleCredential': ['Its stored secret was not used in {days} days.', '저장한 비밀값을 {days}일 동안 쓰지 않았습니다.'],
      'findings.do.disableMcp': ['Turn it off or remove it.', '끄거나 삭제하세요.'],
      'findings.do.openPolicies': ['Open Policies.', 'Policies를 열어 보세요.'],
      'findings.do.removePairing': ['Remove the pairing.', '연결을 삭제하세요.'],
      'findings.do.addCredential': ['Add it to the Credentials list, or store it with the server.', 'Credentials 목록에 넣거나 서버에 저장하세요.'],
      'findings.do.removeSecret': ['Remove the stored value, or the server.', '저장한 값이나 서버를 삭제하세요.']
    }
    for (const [key, [english, korean]] of Object.entries(copy)) {
      expect(en[key], key).toBe(english)
      expect(ko[key], key).toBe(korean)
    }
  })

  // §4.10: the copy the plan gives for each line of an over-broad profile
  it('keeps the over-broad profile copy', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    const ko = CATALOGS.ko.messages as Record<string, string>
    const copy: Record<string, [string, string]> = {
      'findings.reason.overBroadBypass': [
        'Runs without permission checks, but every call it made in {days} days only read.',
        '권한 확인 없이 실행하지만, {days}일 동안 한 호출은 모두 읽기였습니다.'
      ],
      'findings.reason.overBroadSandbox': [
        'Runs outside the sandbox, but in {days} days it wrote only inside its folder and never touched a login folder.',
        '샌드박스 밖에서 실행하지만, {days}일 동안 작업 폴더 안에만 썼고 로그인 정보 폴더는 건드리지 않았습니다.'
      ],
      'findings.reason.overBroadMcp': ['Gets MCP server {server} but did not call it in {days} days.', 'MCP 서버 {server}를 받지만 {days}일 동안 부르지 않았습니다.'],
      'findings.do.askPermission': ['Run it with permission checks.', '권한을 확인하며 실행하게 바꾸세요.'],
      'findings.do.sandboxOn': ['Turn its sandbox on.', '샌드박스를 켜세요.'],
      'findings.do.excludeMcp': ['Leave {server} out of the profile.', '프로필에서 {server}를 빼세요.']
    }
    for (const [key, [english, korean]] of Object.entries(copy)) {
      expect(en[key], key).toBe(english)
      expect(ko[key], key).toBe(korean)
    }
  })

  // §4.12: the copy the plan gives for an unused skill, command or agent, and its information lines
  it('keeps the shared skill, command and agent copy', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    const ko = CATALOGS.ko.messages as Record<string, string>
    const copy: Record<string, [string, string]> = {
      'findings.reason.unusedExtension': ['No recorded use in {days} days.', '{days}일 동안 쓴 기록이 없습니다.'],
      'findings.do.removeExtension': ['Remove it from the shared extensions.', '공유 확장에서 삭제하세요.'],
      'findings.info.claudeOnlyNoUse': ['No recorded use in Claude in {days} days. Codex cannot tell.', 'Claude에서 {days}일 동안 쓴 기록이 없습니다. Codex는 알 수 없습니다.'],
      'findings.info.claudeCannotTell': [
        'Claude cannot tell: it needs Claude Code {min} or later to report uses.',
        'Claude는 알 수 없습니다. 사용을 알리려면 Claude Code {min} 이상이 필요합니다.'
      ],
      'findings.info.claudeChatCannotTell': [
        'Claude cannot tell: a Claude chat ran in these {days} days, and a skill or command typed in a chat is not reported.',
        'Claude는 알 수 없습니다. 최근 {days}일 동안 Claude 대화가 있었고, 대화에서 입력한 스킬이나 명령은 알려지지 않습니다.'
      ]
    }
    for (const [key, [english, korean]] of Object.entries(copy)) {
      expect(en[key], key).toBe(english)
      expect(ko[key], key).toBe(korean)
    }
  })
})
