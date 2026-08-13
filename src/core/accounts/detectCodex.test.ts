import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { detectCodexConfigDirs, readCodexEmail, isAmbientCodexDir } from './detectCodex'

let home: string

// 페이로드에 email이 든 가짜 JWT (서명은 아무 값 — 검증하지 않으므로)
function fakeJwt(payload: object): string {
  const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`
}

async function makeCodexDir(
  dir: string,
  opts: { auth?: object | string; config?: boolean } = {}
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  if (opts.auth !== undefined)
    await fs.writeFile(
      path.join(dir, 'auth.json'),
      typeof opts.auth === 'string' ? opts.auth : JSON.stringify(opts.auth),
      'utf8'
    )
  if (opts.config) await fs.writeFile(path.join(dir, 'config.toml'), '', 'utf8')
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-'))
})

describe('readCodexEmail', () => {
  it('auth.json의 id_token JWT 페이로드에서 email을 추출한다', async () => {
    const dir = path.join(home, '.codex')
    await makeCodexDir(dir, { auth: { tokens: { id_token: fakeJwt({ email: 'me@example.com' }) } } })
    expect(await readCodexEmail(dir)).toBe('me@example.com')
  })

  it('auth.json 부재·손상·email 없음은 전부 null', async () => {
    const dir = path.join(home, '.codex')
    expect(await readCodexEmail(dir)).toBeNull() // 부재
    await makeCodexDir(dir, { auth: '{broken' })
    expect(await readCodexEmail(dir)).toBeNull() // 손상
    await makeCodexDir(dir, { auth: { tokens: { id_token: fakeJwt({ sub: 'x' }) } } })
    expect(await readCodexEmail(dir)).toBeNull() // email 없음
    await makeCodexDir(dir, { auth: { tokens: { id_token: 'not-a-jwt' } } })
    expect(await readCodexEmail(dir)).toBeNull() // JWT 형태 아님
  })
})

describe('detectCodexConfigDirs', () => {
  it('~/.codex와 ~/.codex-accounts/*와 ~/.codex-*를 감지하고 마커 없는 폴더는 제외한다', async () => {
    await makeCodexDir(path.join(home, '.codex'), { auth: {} })
    await makeCodexDir(path.join(home, '.codex-accounts', 'work'), { config: true })
    await makeCodexDir(path.join(home, '.codex-extra'), { config: true })
    await fs.mkdir(path.join(home, '.codex-accounts', 'empty'), { recursive: true }) // 마커 없음
    const r = await detectCodexConfigDirs({ homeDir: home, excludeDirs: [] })
    expect(r.map((c) => c.configDir).sort()).toEqual(
      [
        path.join(home, '.codex'),
        path.join(home, '.codex-accounts', 'work'),
        path.join(home, '.codex-extra')
      ].sort()
    )
    expect(r.every((c) => c.provider === 'codex')).toBe(true)
  })

  it('loggedIn은 auth.json 존재, 라벨은 이메일 > 기본 계정 > 폴더명', async () => {
    await makeCodexDir(path.join(home, '.codex'), { auth: {} }) // 이메일 못 읽음 → 'Default account'
    await makeCodexDir(path.join(home, '.codex-accounts', 'work'), {
      auth: { tokens: { id_token: fakeJwt({ email: 'w@x.com' }) } }
    })
    await makeCodexDir(path.join(home, '.codex-extra'), { config: true }) // auth 없음
    const r = await detectCodexConfigDirs({ homeDir: home, excludeDirs: [] })
    const by = Object.fromEntries(r.map((c) => [c.configDir, c]))
    expect(by[path.join(home, '.codex')].suggestedLabel).toBe('Default account')
    expect(by[path.join(home, '.codex')].loggedIn).toBe(true)
    expect(by[path.join(home, '.codex-accounts', 'work')].suggestedLabel).toBe('w@x.com')
    expect(by[path.join(home, '.codex-extra')].suggestedLabel).toBe('.codex-extra')
    expect(by[path.join(home, '.codex-extra')].loggedIn).toBe(false)
  })

  it('excludeDirs는 대소문자 무시로 제외한다', async () => {
    await makeCodexDir(path.join(home, '.codex'), { auth: {} })
    const r = await detectCodexConfigDirs({
      homeDir: home,
      excludeDirs: [path.join(home, '.CODEX')]
    })
    expect(r).toEqual([])
  })
})

describe('isAmbientCodexDir', () => {
  it('~/.codex만 ambient, 대소문자·구분자 무시', () => {
    expect(isAmbientCodexDir('C:\\Users\\t', 'c:/Users/T/.CODEX')).toBe(true)
    expect(isAmbientCodexDir('C:\\Users\\t', 'C:\\Users\\t\\.codex-accounts\\a')).toBe(false)
  })
})
