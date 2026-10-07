import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { orchAccountOf, orchAccountsFor, readAccountEntries, readAccountsFile } from './accountsFile'
import { RepairNeeded } from '../settings/repairNeeded'

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-accountsfile-'))
  file = path.join(dir, 'accounts.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const account = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'acc1',
  label: '일',
  configDir: 'D:/cfg/acc1',
  color: '#fff',
  createdAt: 'T',
  ...over
})

describe('readAccountsFile', () => {
  // 앱이 없는 파일을 읽는 방식과 같다 — 계정이 하나도 없는 프로필이다.
  it('파일이 없으면 빈 목록이다', async () => {
    expect(await readAccountsFile(file)).toEqual([])
  })

  // configDir 은 싣지 않는다 — 앱의 listAccounts 와 같은 세 칸이다.
  it('세 칸으로 줄이고 provider 가 없으면 claude 다', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({ accounts: [account(), account({ id: 'acc2', label: '이', provider: 'codex' })] }),
      'utf8'
    )
    expect(await readAccountsFile(file)).toEqual([
      { id: 'acc1', label: '일', provider: 'claude' },
      { id: 'acc2', label: '이', provider: 'codex' }
    ])
    expect(await readAccountsFile(file, 'codex')).toEqual([{ id: 'acc2', label: '이', provider: 'codex' }])
  })

  // **빈 목록으로 답하지 않는다.** "계정이 없다" 는 모든 --account 를 거짓 404 로 만든다. 그리고
  // 파일에 손대지 않는다 — 고치는 것은 앱의 일이다(AccountRegistry.load 는 .bak 을 만들고 비운다).
  it('깨진 파일은 고치라는 말로 거절하고 파일에 손대지 않는다', async () => {
    for (const body of ['{not json', JSON.stringify({ accounts: [account({ configDir: '' })] })]) {
      await fs.writeFile(file, body, 'utf8')
      const before = await fs.stat(file)
      await expect(readAccountsFile(file)).rejects.toThrow(/open Astera to repair it/)
      expect(await fs.readFile(file, 'utf8')).toBe(body)
      expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
      expect(await fs.readdir(dir)).toEqual(['accounts.json'])
    }
  })
})

describe('orchAccountOf', () => {
  it('id·label·provider 만 남긴다', () => {
    expect(orchAccountOf(account({ provider: 'codex' }) as never)).toEqual({
      id: 'acc1',
      label: '일',
      provider: 'codex'
    })
  })
})

// `astera skills` 는 계정의 설정 폴더에 스킬을 심으므로 configDir 이 있어야 한다. 읽기 규칙은
// readAccountsFile 과 같은 하나다 — 없는 파일은 [], 깨진 파일은 같은 말로 거절한다.
describe('readAccountEntries', () => {
  it('configDir 까지 담은 계정 그대로다', async () => {
    expect(await readAccountEntries(file)).toEqual([])
    await fs.writeFile(file, JSON.stringify({ accounts: [account()] }), 'utf8')
    expect(await readAccountEntries(file)).toEqual([account()])
  })

  it('깨진 파일은 같은 말로 거절한다', async () => {
    await fs.writeFile(file, '{not json', 'utf8')
    await expect(readAccountEntries(file)).rejects.toThrow(/open Astera to repair it/)
  })
})

// The Host answers this refusal as a conflict that names the file (409, `repair`), read off the type.
describe('a corrupt accounts.json', () => {
  it('is refused as a RepairNeeded naming the file', async () => {
    for (const body of ['{not json', JSON.stringify({ accounts: [account({ configDir: '' })] })]) {
      await fs.writeFile(file, body, 'utf8')
      const err = await readAccountEntries(file).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RepairNeeded)
      expect((err as RepairNeeded).file).toBe('accounts.json')
    }
  })
})

describe('readAccountsFile with a login probe', () => {
  // The default is the earliest registered account that is logged in, per provider (defaultAccountIdOf).
  it('marks each provider\'s default, and only it', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        accounts: [
          account({ id: 'cl1', createdAt: '2026-01-01T00:00:00.000Z' }),
          account({ id: 'cl2', createdAt: '2026-01-02T00:00:00.000Z' }),
          account({ id: 'cx1', provider: 'codex', createdAt: '2026-01-03T00:00:00.000Z' })
        ]
      }),
      'utf8'
    )
    const loggedIn = async (a: { id: string }): Promise<boolean> => a.id !== 'cl1'
    expect(await readAccountsFile(file, undefined, loggedIn)).toEqual([
      { id: 'cl1', label: '일', provider: 'claude', signedIn: false },
      { id: 'cl2', label: '일', provider: 'claude', default: true, signedIn: true },
      { id: 'cx1', label: '일', provider: 'codex', default: true, signedIn: true }
    ])
    expect(await readAccountsFile(file, 'codex', loggedIn)).toEqual([{ id: 'cx1', label: '일', provider: 'codex', default: true, signedIn: true }])
  })

  it('a probe that fails counts as logged out', async () => {
    await fs.writeFile(file, JSON.stringify({ accounts: [account({ id: 'cl1' })] }), 'utf8')
    expect(await readAccountsFile(file, undefined, async () => Promise.reject(new Error('keychain')))).toEqual([
      { id: 'cl1', label: '일', provider: 'claude', signedIn: false }
    ])
  })
})

describe('orchAccountsFor', () => {
  // A forwarded `listAccounts(undefined, { withDefault })` reaches the app with null for the provider.
  it('a null provider is no filter, as an omitted one is', async () => {
    const all = [account({ id: 'cl1' }), account({ id: 'cx1', provider: 'codex' })] as never[]
    expect(await orchAccountsFor(all, null, async () => true)).toEqual([
      { id: 'cl1', label: '일', provider: 'claude', default: true, signedIn: true },
      { id: 'cx1', label: '일', provider: 'codex', default: true, signedIn: true }
    ])
    expect(orchAccountsFor(all, 'codex')).toEqual([{ id: 'cx1', label: '일', provider: 'codex' }])
  })
  // Remote runtime N5: a controller's Job form needs to know which of the Runtime's accounts can run, and it cannot
  // probe the Runtime's login itself.
  it('says which accounts are signed in when it probed them', async () => {
    const all = [account({ id: 'a' }), account({ id: 'b' })] as never[]
    const listed = await orchAccountsFor(all, undefined, async (x) => x.id === 'a')
    expect(listed.map((x) => [x.id, x.signedIn])).toEqual([['a', true], ['b', false]])
  })
})
