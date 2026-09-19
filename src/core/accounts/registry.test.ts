import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountRegistry } from './registry'
import { ACCOUNT_COLORS } from './colors'

let tmp: string
let registry: AccountRegistry

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-registry-'))
  registry = new AccountRegistry(
    path.join(tmp, 'accounts.json'),
    path.join(tmp, 'accounts-root'),
    path.join(tmp, 'codex-root')
  )
  await registry.load()
})

describe('AccountRegistry', () => {
  it('create는 config dir을 만들고 목록에 추가한다', async () => {
    const account = await registry.create({ label: '내 계정' })
    expect(account.configDir.startsWith(path.join(tmp, 'accounts-root'))).toBe(true)
    expect((await fs.stat(account.configDir)).isDirectory()).toBe(true)
    expect(registry.list().map((a) => a.id)).toEqual([account.id])
  })

  it('같은 라벨로 두 번 만들면 config dir이 겹치지 않는다', async () => {
    const a = await registry.create({ label: 'work' })
    const b = await registry.create({ label: 'work' })
    expect(a.configDir).not.toBe(b.configDir)
  })

  it('재로드 후에도 계정이 유지된다', async () => {
    const account = await registry.create({ label: 'persist' })
    const again = new AccountRegistry(path.join(tmp, 'accounts.json'), path.join(tmp, 'accounts-root'))
    await again.load()
    expect(again.list().map((a) => a.id)).toEqual([account.id])
  })

  it('import는 존재하는 디렉터리만 허용한다', async () => {
    await expect(registry.import({ label: 'x', configDir: path.join(tmp, 'no-such') })).rejects.toThrow()
    const dir = path.join(tmp, 'existing')
    await fs.mkdir(dir)
    const account = await registry.import({ label: '기본', configDir: dir })
    expect(account.configDir).toBe(dir)
  })

  it('loginStatus는 .credentials.json 존재 여부만 본다', async () => {
    const account = await registry.create({ label: 'login' })
    expect(await registry.loginStatus(account.id)).toBe(false)
    await fs.writeFile(path.join(account.configDir, '.credentials.json'), '{}')
    expect(await registry.loginStatus(account.id)).toBe(true)
  })

  it('remove는 등록만 해제하고 디스크는 남긴다', async () => {
    const account = await registry.create({ label: 'gone' })
    await registry.remove(account.id)
    expect(registry.list()).toEqual([])
    expect((await fs.stat(account.configDir)).isDirectory()).toBe(true)
  })

  it('remove는 해제한 configDir을 dismissedDirs에 기록한다', async () => {
    const account = await registry.create({ label: 'dismissed' })
    expect(registry.dismissedDirs()).toEqual([])
    await registry.remove(account.id)
    expect(registry.dismissedDirs()).toEqual([account.configDir])
  })

  it('dismissedDirs는 재로드 후에도 유지된다', async () => {
    const account = await registry.create({ label: 'persisted' })
    await registry.remove(account.id)
    const again = new AccountRegistry(path.join(tmp, 'accounts.json'), path.join(tmp, 'accounts-root'))
    await again.load()
    expect(again.dismissedDirs()).toEqual([account.configDir])
  })

  it('같은 디렉터리를 다시 등록하고 해제해도 dismissedDirs에 중복으로 쌓이지 않는다', async () => {
    const account = await registry.create({ label: 'twice' })
    const dir = account.configDir
    await registry.remove(account.id)
    const readded = await registry.import({ label: 'twice', configDir: dir })
    await registry.remove(readded.id)
    expect(registry.dismissedDirs()).toEqual([dir])
  })

  it('다시 등록하면 dismissedDirs에서 빠진다 — 등록된 계정이 감지에서 빠질 수는 없다', async () => {
    const account = await registry.create({ label: 'revived' })
    const dir = account.configDir
    await registry.remove(account.id)
    expect(registry.dismissedDirs()).toEqual([dir])
    await registry.import({ label: 'revived', configDir: dir })
    expect(registry.dismissedDirs()).toEqual([])
  })

  it('dismissedDirs 필드가 없는 옛 accounts.json도 그대로 로드된다', async () => {
    const file = path.join(tmp, 'legacy.json')
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'a1',
            label: '옛 계정',
            configDir: path.join(tmp, 'legacy-dir'),
            color: '#fff',
            createdAt: '2026-07-20T00:00:00Z'
          }
        ]
      }),
      'utf8'
    )
    const legacy = new AccountRegistry(file, path.join(tmp, 'accounts-root'))
    expect((await legacy.load()).recovered).toBe(false)
    expect(legacy.list().map((a) => a.id)).toEqual(['a1'])
    expect(legacy.dismissedDirs()).toEqual([])
  })

  it('dismissedDirs가 망가져 있어도 계정 목록은 살린다 — 감지 제외는 안전에 관한 값이 아니다', async () => {
    const file = path.join(tmp, 'bad-dismissed.json')
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        accounts: [],
        dismissedDirs: ['C:\\ok', 3, null, { a: 1 }]
      }),
      'utf8'
    )
    const reg = new AccountRegistry(file, path.join(tmp, 'accounts-root'))
    expect((await reg.load()).recovered).toBe(false)
    expect(reg.dismissedDirs()).toEqual(['C:\\ok'])
  })

  it('손상된 accounts.json은 .bak으로 보존하고 빈 목록으로 복구한다', async () => {
    const file = path.join(tmp, 'broken.json')
    await fs.writeFile(file, '{not json', 'utf8')
    const broken = new AccountRegistry(file, path.join(tmp, 'accounts-root'))
    const { recovered } = await broken.load()
    expect(recovered).toBe(true)
    expect(broken.list()).toEqual([])
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{not json')
  })

  it('원소 형태가 틀린 accounts.json(예: configDir 누락)은 파일 전체를 손상 취급한다', async () => {
    const file = path.join(tmp, 'bad-shape.json')
    const original = JSON.stringify({
      accounts: [{ id: 'a1', label: 'x', color: '#fff', createdAt: '2026-01-01' }] // configDir 누락
    })
    await fs.writeFile(file, original, 'utf8')
    const broken = new AccountRegistry(file, path.join(tmp, 'accounts-root'))
    const { recovered } = await broken.load()
    expect(recovered).toBe(true)
    expect(broken.list()).toEqual([])
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe(original)
  })

  describe('syncPlaceholderLabels', () => {
    async function seedLabel(label: string): Promise<string> {
      const account = await registry.create({ label })
      return account.configDir
    }

    it("라벨이 'Default account'이고 이메일을 읽으면 라벨을 이메일로 교체·저장한다", async () => {
      const dir = await seedLabel('Default account')
      // resolveEmail이 대상 계정을 인자로 받는지 함께 검증 (provider 분기용)
      const seenDirs: string[] = []
      const seenProviders: (string | undefined)[] = []
      await registry.syncPlaceholderLabels(async (a) => {
        seenDirs.push(a.configDir)
        seenProviders.push(a.provider)
        return 'me@example.com'
      })
      expect(seenDirs).toEqual([dir])
      expect(seenProviders).toEqual(['claude'])
      expect(registry.list()[0].label).toBe('me@example.com')
      // 재로드해도 유지 (저장 확인)
      const again = new AccountRegistry(path.join(tmp, 'accounts.json'), path.join(tmp, 'accounts-root'))
      await again.load()
      expect(again.list()[0].label).toBe('me@example.com')
    })

    it('사용자가 직접 지은 라벨은 이메일이 있어도 건드리지 않는다', async () => {
      await seedLabel('내 계정')
      await registry.syncPlaceholderLabels(async () => 'me@example.com')
      expect(registry.list()[0].label).toBe('내 계정')
    })

    it("이메일을 못 읽으면 'Default account' 라벨을 그대로 둔다", async () => {
      await seedLabel('Default account')
      await registry.syncPlaceholderLabels(async () => null)
      expect(registry.list()[0].label).toBe('Default account')
    })

    it('멱등: 이메일로 교체된 뒤 다시 호출해도 바뀌지 않는다', async () => {
      await seedLabel('Default account')
      await registry.syncPlaceholderLabels(async () => 'me@example.com')
      await registry.syncPlaceholderLabels(async () => 'other@example.com')
      expect(registry.list()[0].label).toBe('me@example.com')
    })
  })

  it('provider를 지정해 생성하면 codex 루트에 디렉터리를 만들고 provider를 저장한다', async () => {
    const account = await registry.create({ label: 'gpt 계정', provider: 'codex' })
    expect(account.provider).toBe('codex')
    expect(account.configDir.startsWith(path.join(tmp, 'codex-root'))).toBe(true)
  })

  it('provider 미지정 생성은 claude 루트를 쓰고 provider를 claude로 저장한다', async () => {
    const account = await registry.create({ label: 'plain' })
    expect(account.provider).toBe('claude')
    expect(account.configDir.startsWith(path.join(tmp, 'accounts-root'))).toBe(true)
  })

  it('provider가 이상한 값이면 파일 전체를 손상 취급한다', async () => {
    const file = path.join(tmp, 'badprov.json')
    await fs.writeFile(file, JSON.stringify({ version: 1, accounts: [{
      id: 'a1', label: 'x', configDir: 'd', color: '#fff', createdAt: '2026-01-01', provider: 'gemini'
    }] }), 'utf8')
    const broken = new AccountRegistry(file, path.join(tmp, 'accounts-root'), path.join(tmp, 'codex-root'))
    expect((await broken.load()).recovered).toBe(true)
  })

  it('provider 없는 기존 계정 데이터는 그대로 로드된다 (하위 호환)', async () => {
    const file = path.join(tmp, 'legacy.json')
    await fs.writeFile(file, JSON.stringify({ version: 1, accounts: [{
      id: 'a1', label: 'x', configDir: 'd', color: '#fff', createdAt: '2026-01-01'
    }] }), 'utf8')
    const legacy = new AccountRegistry(file, path.join(tmp, 'accounts-root'), path.join(tmp, 'codex-root'))
    expect((await legacy.load()).recovered).toBe(false)
    expect(legacy.list()[0].provider).toBeUndefined()
  })

  it('codex 계정의 loginStatus는 auth.json 존재로 판정한다', async () => {
    const account = await registry.create({ label: 'gpt', provider: 'codex' })
    expect(await registry.loginStatus(account.id)).toBe(false)
    await fs.writeFile(path.join(account.configDir, 'auth.json'), '{}', 'utf8')
    expect(await registry.loginStatus(account.id)).toBe(true)
  })

  describe('colour assignment', () => {
    /** A stored account carrying nothing but the colour under test, filled just enough for isValidAccount. */
    const stored = (id: string, color: string): Record<string, string> => ({
      id,
      label: id,
      configDir: path.join(tmp, id),
      color,
      createdAt: '2026-01-01T00:00:00Z'
    })

    const registryFor = (file: string): AccountRegistry =>
      new AccountRegistry(file, path.join(tmp, 'accounts-root'), path.join(tmp, 'codex-root'))

    it('gives every account its own colour, past the length of the palette', async () => {
      for (let i = 0; i < ACCOUNT_COLORS.length + 2; i++) {
        await registry.create({ label: `acct-${i}` })
      }
      const colors = registry.list().map((a) => a.color)
      expect(new Set(colors).size).toBe(colors.length)
    })

    it('does not reuse a live account’s colour after one is removed', async () => {
      const first = await registry.create({ label: 'first' })
      await registry.create({ label: 'second' })
      await registry.create({ label: 'third' })
      await registry.remove(first.id)
      const fresh = await registry.create({ label: 'fourth' })
      // The freed colour is the one to reuse; the colours still on screen are not.
      expect(fresh.color).toBe(first.color)
      expect(registry.list().filter((a) => a.color === fresh.color)).toHaveLength(1)
      expect(new Set(registry.list().map((a) => a.color)).size).toBe(3)
    })

    it('gives a detected account arriving through import a colour of its own', async () => {
      const first = await registry.create({ label: 'first' })
      await registry.create({ label: 'second' })
      await registry.create({ label: 'third' })
      await registry.remove(first.id)
      const dir = path.join(tmp, 'imported')
      await fs.mkdir(dir)
      const imported = await registry.import({ label: 'imported', configDir: dir })
      expect(registry.list().filter((a) => a.color === imported.color)).toHaveLength(1)
    })

    it('repairs a stored duplicate by recolouring only the later account', async () => {
      const file = path.join(tmp, 'dup.json')
      await fs.writeFile(
        file,
        JSON.stringify({
          version: 1,
          accounts: [stored('a1', '#4f9cf9'), stored('a2', '#f97316'), stored('a3', '#4f9cf9')]
        }),
        'utf8'
      )
      const reg = registryFor(file)
      expect((await reg.load()).recovered).toBe(false)
      const colors = reg.list().map((a) => a.color)
      expect(colors[0]).toBe('#4f9cf9') // the one registered first keeps what it had
      expect(colors[1]).toBe('#f97316')
      expect(new Set(colors).size).toBe(3)

      // The repair has to reach disk, or it runs again on every launch.
      const again = registryFor(file)
      await again.load()
      expect(again.list().map((a) => a.color)).toEqual(colors)
    })

    it('leaves the file alone on load when no colour is duplicated', async () => {
      const file = path.join(tmp, 'nodup.json')
      // save() rewrites the file indented by two, so a one-line original surviving means no write.
      const original = JSON.stringify({
        version: 1,
        accounts: [stored('a1', '#4f9cf9'), stored('a2', '#f97316')]
      })
      await fs.writeFile(file, original, 'utf8')
      await registryFor(file).load()
      expect(await fs.readFile(file, 'utf8')).toBe(original)
    })
  })
})
