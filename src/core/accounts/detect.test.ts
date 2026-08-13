import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectConfigDirs, readAccountEmail } from './detect'

let tmp: string
let home: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-detect-'))
  home = path.join(tmp, 'home')
  await fs.mkdir(home, { recursive: true })
})

describe('detectConfigDirs', () => {
  it('마커(settings.json)가 있는 .claude-* 디렉터리를 감지한다', async () => {
    const dir = path.join(home, '.claude-work')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'settings.json'), '{}', 'utf8')

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    expect(candidates.map((c) => c.configDir)).toContain(dir)
  })

  it('마커가 전혀 없는 .claude-* 디렉터리는 후보에서 제외한다', async () => {
    const dir = path.join(home, '.claude-empty')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'readme.txt'), 'not a marker', 'utf8')

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    expect(candidates.map((c) => c.configDir)).not.toContain(dir)
  })

  it('.claude-accounts/<하위 디렉터리>를 스캔하고, .claude-accounts 자체는 후보에서 제외한다', async () => {
    const accountsRoot = path.join(home, '.claude-accounts')
    const sub = path.join(accountsRoot, 'personal')
    await fs.mkdir(sub, { recursive: true })
    await fs.mkdir(path.join(sub, 'projects'))
    // .claude-accounts 루트 자체에도 마커를 흘려봐도 후보로 잡히면 안 된다
    await fs.writeFile(path.join(accountsRoot, 'settings.json'), '{}', 'utf8')

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    const dirs = candidates.map((c) => c.configDir)
    expect(dirs).toContain(sub)
    expect(dirs).not.toContain(accountsRoot)
  })

  it('excludeDirs에 있는 경로는 대소문자가 달라도 제외한다 (win32 정규화)', async () => {
    const dir = path.join(home, '.claude-work')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'settings.json'), '{}', 'utf8')

    const differentCase = dir.toUpperCase()
    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [differentCase] })
    expect(candidates.map((c) => c.configDir)).not.toContain(dir)
  })

  it('.claude.json의 oauthAccount.emailAddress를 라벨로 제안한다', async () => {
    const dir = path.join(home, '.claude-work')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'settings.json'), '{}', 'utf8')
    await fs.writeFile(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }),
      'utf8'
    )

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    const candidate = candidates.find((c) => c.configDir === dir)
    expect(candidate?.suggestedLabel).toBe('me@example.com')
  })

  it('깨진 .claude.json은 무시하고 폴더명으로 라벨을 폴백한다', async () => {
    const dir = path.join(home, '.claude-broken')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'settings.json'), '{}', 'utf8')
    await fs.writeFile(path.join(dir, '.claude.json'), '{not json', 'utf8')

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    const candidate = candidates.find((c) => c.configDir === dir)
    expect(candidate?.suggestedLabel).toBe('.claude-broken')
  })

  it('~/.claude는 라벨이 "기본 계정"이고 항상 목록 맨 앞에 온다', async () => {
    const homeClaude = path.join(home, '.claude')
    await fs.mkdir(homeClaude, { recursive: true })
    await fs.writeFile(path.join(homeClaude, 'settings.json'), '{}', 'utf8')

    const zDir = path.join(home, '.claude-zzz')
    await fs.mkdir(zDir, { recursive: true })
    await fs.writeFile(path.join(zDir, 'settings.json'), '{}', 'utf8')
    const aDir = path.join(home, '.claude-aaa')
    await fs.mkdir(aDir, { recursive: true })
    await fs.writeFile(path.join(aDir, 'settings.json'), '{}', 'utf8')

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    expect(candidates[0].configDir).toBe(homeClaude)
    expect(candidates[0].suggestedLabel).toBe('Default account')
    // 나머지는 경로 알파벳순
    expect(candidates[1].configDir).toBe(aDir)
    expect(candidates[2].configDir).toBe(zDir)
  })

  it('loggedIn은 .credentials.json 존재 여부만으로 판별한다', async () => {
    const loggedInDir = path.join(home, '.claude-in')
    await fs.mkdir(loggedInDir, { recursive: true })
    await fs.writeFile(path.join(loggedInDir, '.credentials.json'), '{}', 'utf8')

    const loggedOutDir = path.join(home, '.claude-out')
    await fs.mkdir(loggedOutDir, { recursive: true })
    await fs.writeFile(path.join(loggedOutDir, 'settings.json'), '{}', 'utf8')

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    expect(candidates.find((c) => c.configDir === loggedInDir)?.loggedIn).toBe(true)
    expect(candidates.find((c) => c.configDir === loggedOutDir)?.loggedIn).toBe(false)
  })

  it('projects/ 디렉터리만 있어도 마커로 인식한다', async () => {
    const dir = path.join(home, '.claude-projonly')
    await fs.mkdir(path.join(dir, 'projects'), { recursive: true })

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    expect(candidates.map((c) => c.configDir)).toContain(dir)
  })

  it('projects라는 이름의 파일(디렉터리 아님)은 마커로 인식하지 않는다', async () => {
    const dir = path.join(home, '.claude-projfile')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'projects'), 'not a directory', 'utf8')

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    expect(candidates.map((c) => c.configDir)).not.toContain(dir)
  })

  it('homeDir에 아무 것도 없으면 빈 배열을 반환하고 throw하지 않는다', async () => {
    const emptyHome = path.join(tmp, 'no-such-home')
    await expect(detectConfigDirs({ homeDir: emptyHome, excludeDirs: [] })).resolves.toEqual([])
  })

  it('사이드카(<homeDir>/.claude.json)만 있는 기본 ~/.claude 후보는 이메일을 라벨로 제안한다', async () => {
    const homeClaude = path.join(home, '.claude')
    await fs.mkdir(homeClaude, { recursive: true })
    await fs.writeFile(path.join(homeClaude, 'settings.json'), '{}', 'utf8')
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'sidecar@example.com' } }),
      'utf8'
    )

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    const candidate = candidates.find((c) => c.configDir === homeClaude)
    expect(candidate?.suggestedLabel).toBe('sidecar@example.com')
  })

  it('사이드카와 configDir 내부 .claude.json이 둘 다 있으면 내부 파일이 우선한다', async () => {
    const homeClaude = path.join(home, '.claude')
    await fs.mkdir(homeClaude, { recursive: true })
    await fs.writeFile(path.join(homeClaude, 'settings.json'), '{}', 'utf8')
    await fs.writeFile(
      path.join(homeClaude, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'inner@example.com' } }),
      'utf8'
    )
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'sidecar@example.com' } }),
      'utf8'
    )

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    const candidate = candidates.find((c) => c.configDir === homeClaude)
    expect(candidate?.suggestedLabel).toBe('inner@example.com')
  })

  it('비기본 dir(.claude-accounts 하위)는 사이드카를 보지 않는다', async () => {
    const accountsRoot = path.join(home, '.claude-accounts')
    const sub = path.join(accountsRoot, 'personal')
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(path.join(sub, 'settings.json'), '{}', 'utf8')
    // ~/.claude.json(기본 계정용 사이드카)에 이메일이 있어도 personal은 기본 계정이 아니므로 무시해야 한다
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'sidecar@example.com' } }),
      'utf8'
    )

    const candidates = await detectConfigDirs({ homeDir: home, excludeDirs: [] })
    const candidate = candidates.find((c) => c.configDir === sub)
    expect(candidate?.suggestedLabel).toBe('personal')
  })
})

describe('readAccountEmail', () => {
  it('configDir에 .claude.json이 없으면 null을 반환한다', async () => {
    const dir = path.join(home, '.claude-work')
    await fs.mkdir(dir, { recursive: true })

    await expect(readAccountEmail(dir, home)).resolves.toBeNull()
  })

  it('깨진 .claude.json은 throw하지 않고 null을 반환한다', async () => {
    const dir = path.join(home, '.claude-work')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, '.claude.json'), '{not json', 'utf8')

    await expect(readAccountEmail(dir, home)).resolves.toBeNull()
  })

  it('기본 config dir이 아니면 사이드카가 있어도 무시한다', async () => {
    const dir = path.join(home, '.claude-work')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'sidecar@example.com' } }),
      'utf8'
    )

    await expect(readAccountEmail(dir, home)).resolves.toBeNull()
  })

  it('기본 config dir(<homeDir>/.claude)이면 사이드카에서 이메일을 읽는다', async () => {
    const homeClaude = path.join(home, '.claude')
    await fs.mkdir(homeClaude, { recursive: true })
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'sidecar@example.com' } }),
      'utf8'
    )

    await expect(readAccountEmail(homeClaude, home)).resolves.toBe('sidecar@example.com')
  })
})
