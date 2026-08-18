import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeDescriptors, descriptorOf, isAmbientDir } from './descriptor'
import type { KeychainHas } from '../accounts/keychain'
import { PROVIDERS } from './meta'

describe('provider descriptor', () => {
  it('모든 provider에 대해 값 필드가 채워진다', () => {
    const t = makeDescriptors('win32')
    for (const p of PROVIDERS) {
      expect(t[p].id).toBe(p)
      expect(t[p].cliFile).not.toBe('')
      expect(t[p].configDirEnv).not.toBe('')
      expect(t[p].ambientDirName).not.toBe('')
      expect(typeof t[p].isLoggedIn).toBe('function')
      expect(t[p].accountsRootName).not.toBe('')
    }
  })

  it('격리 환경변수·ambient 디렉토리·계정 루트가 provider별로 갈린다', () => {
    const t = makeDescriptors('darwin')
    expect(t.claude.configDirEnv).toBe('CLAUDE_CONFIG_DIR')
    expect(t.codex.configDirEnv).toBe('CODEX_HOME')
    expect(t.claude.ambientDirName).toBe('.claude')
    expect(t.codex.ambientDirName).toBe('.codex')
    // credentialMarker(파일명 하나)는 isLoggedIn 프로브로 대체됐다. claude 는 macOS 에서 파일과
    // Keychain 을 함께 봐야 해서 파일명 하나로 표현할 수 없다. 어떤 파일을 보는지는 문자열을 대조하는
    // 대신 아래 'isLoggedIn 프로브' describe 가 프로브를 실제로 호출해 고정한다.
    expect(typeof t.claude.isLoggedIn).toBe('function')
    expect(typeof t.codex.isLoggedIn).toBe('function')
    expect(t.claude.accountsRootName).toBe('.claude-accounts')
    expect(t.codex.accountsRootName).toBe('.codex-accounts')
    expect(t.claude.logoutArgs).toEqual(['auth', 'logout'])
    expect(t.codex.logoutArgs).toEqual(['logout'])
  })

  it('buildCommand가 플랫폼을 반영한다 (팩토리인 이유)', () => {
    expect(makeDescriptors('win32').claude.buildCommand({})).toEqual({
      file: 'cmd.exe',
      args: ['/c', 'claude']
    })
    expect(makeDescriptors('darwin').claude.buildCommand({})).toEqual({ file: 'claude', args: [] })
    expect(makeDescriptors('darwin').codex.buildCommand({})).toEqual({ file: 'codex', args: [] })
  })

  it('descriptorOf는 provider 부재를 claude로 본다', () => {
    const t = makeDescriptors('darwin')
    expect(descriptorOf(t, {}).cliFile).toBe('claude')
    expect(descriptorOf(t, { provider: 'codex' }).cliFile).toBe('codex')
  })

  it('isAmbientDir는 홈 기본 디렉토리만 참이고 대소문자·구분자 차이를 무시한다', () => {
    const t = makeDescriptors('win32')
    const home = path.join('C:', 'Users', 'tester')
    expect(isAmbientDir(t.claude, home, path.join(home, '.claude'))).toBe(true)
    expect(isAmbientDir(t.claude, home, path.join(home, '.CLAUDE'))).toBe(true)
    expect(isAmbientDir(t.claude, home, path.join(home, '.claude-accounts', 'a'))).toBe(false)
    expect(isAmbientDir(t.codex, home, path.join(home, '.codex'))).toBe(true)
    // provider가 다르면 서로의 ambient를 인정하지 않는다
    expect(isAmbientDir(t.claude, home, path.join(home, '.codex'))).toBe(false)
    expect(isAmbientDir(t.codex, home, path.join(home, '.claude'))).toBe(false)
  })

  it('busyTitleReliable은 창 제목 OSC 판정의 신뢰 여부를 나타낸다 (실측 근거)', () => {
    const t = makeDescriptors('win32')
    // claude: 제목이 스피너 프레임 ↔ ✳로 정확히 전이한다 (글리프는 버전에 따라 바뀐다 — busy.ts)
    expect(t.claude.busyTitleReliable).toBe(true)
    // codex: 장식 스피너가 계속 흐르고 자식 프로세스가 제목을 덮어써 신뢰할 수 없다
    expect(t.codex.busyTitleReliable).toBe(false)
  })
})

describe('isLoggedIn 프로브 — 어떤 증거를 보는가', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-desc-login-'))
  })

  const never: KeychainHas = async () => false

  it('claude: .credentials.json 이 있으면 로그인으로 본다', async () => {
    const t = makeDescriptors('win32', dir, never)
    expect(await t.claude.isLoggedIn(dir)).toBe(false)
    await fs.writeFile(path.join(dir, '.credentials.json'), '{}', 'utf8')
    expect(await t.claude.isLoggedIn(dir)).toBe(true)
  })

  it('codex: auth.json 이 있으면 로그인으로 본다', async () => {
    const t = makeDescriptors('win32', dir, never)
    expect(await t.codex.isLoggedIn(dir)).toBe(false)
    await fs.writeFile(path.join(dir, 'auth.json'), '{}', 'utf8')
    expect(await t.codex.isLoggedIn(dir)).toBe(true)
  })

  it('claude: 파일이 있으면 Keychain 은 아예 묻지 않는다', async () => {
    // 순서가 계약이다 — 파일이 있으면 그걸로 끝이고, security 호출은 일어나지 않는다
    let asked = 0
    const counting: KeychainHas = async () => {
      asked++
      return false
    }
    await fs.writeFile(path.join(dir, '.credentials.json'), '{}', 'utf8')
    const t = makeDescriptors('darwin', dir, counting)
    expect(await t.claude.isLoggedIn(dir)).toBe(true)
    expect(asked).toBe(0)
  })

  it('claude: darwin 에서는 파일이 없으면 Keychain 을 본다', async () => {
    const t = makeDescriptors('darwin', dir, async () => true)
    expect(await t.claude.isLoggedIn(dir)).toBe(true)
  })

  it('claude: darwin 이 아니면 파일이 없을 때 Keychain 을 묻지 않고 로그아웃으로 본다', async () => {
    let asked = 0
    const t = makeDescriptors('win32', dir, async () => {
      asked++
      return true
    })
    expect(await t.claude.isLoggedIn(dir)).toBe(false)
    expect(asked).toBe(0)
  })

  it('claude: Keychain 조회가 던지면 로그아웃으로 본다 — security 가 없거나 죽은 환경', async () => {
    const t = makeDescriptors('darwin', dir, async () => {
      throw new Error('security not found')
    })
    expect(await t.claude.isLoggedIn(dir)).toBe(false)
  })

  it('codex: darwin 이어도 Keychain 은 보지 않는다 — 파일 하나가 전부다', async () => {
    let asked = 0
    const t = makeDescriptors('darwin', dir, async () => {
      asked++
      return true
    })
    expect(await t.codex.isLoggedIn(dir)).toBe(false)
    expect(asked).toBe(0)
  })
})
