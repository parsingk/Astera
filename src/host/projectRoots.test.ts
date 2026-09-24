import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostProjectRoots } from './projectRoots'

let profile: string
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hostroots-'))
})
afterEach(async () => {
  await fs.rm(profile, { recursive: true, force: true })
})

const writeAccounts = (accounts: { id: string; provider?: 'codex' }[]): Promise<void> =>
  fs.writeFile(
    path.join(profile, 'accounts.json'),
    JSON.stringify({
      accounts: accounts.map((a) => ({
        id: a.id,
        label: a.id,
        configDir: path.join(profile, 'cfg', a.id),
        color: '#fff',
        createdAt: 'T',
        ...(a.provider ? { provider: a.provider } : {})
      }))
    }),
    'utf8'
  )

async function claudeProject(accountId: string, slug: string, cwd: string): Promise<void> {
  const dir = path.join(profile, 'cfg', accountId, 'projects', slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 's1.jsonl'),
    JSON.stringify({ type: 'user', sessionId: 's1', cwd, message: { role: 'user', content: 'hi' } }),
    'utf8'
  )
}

async function codexProject(accountId: string, cwd: string): Promise<void> {
  const dir = path.join(profile, 'cfg', accountId, 'sessions', '2026', '07', '09')
  await fs.mkdir(dir, { recursive: true })
  const meta = { type: 'session_meta', payload: { session_id: '019f4524-e0ac-7571-a8af-5585504f0d40', cwd } }
  await fs.writeFile(
    path.join(dir, 'rollout-2026-07-09T00-00-00-019f4524-e0ac-7571-a8af-5585504f0d40.jsonl'),
    JSON.stringify(meta) + '\n',
    'utf8'
  )
}

const notARepo = async (): Promise<string | null> => null

describe('createHostProjectRoots', () => {
  it('accounts.json 의 계정이 아는 프로젝트로 하위 폴더를 올린다', async () => {
    const project = path.join(profile, 'work', 'proj')
    await writeAccounts([{ id: 'a' }, { id: 'cx', provider: 'codex' }])
    await claudeProject('a', 'proj', project)
    await codexProject('cx', path.join(profile, 'work', 'other'))
    const roots = createHostProjectRoots({ profileDir: profile, repoPaths: () => [], repoRoot: notARepo })
    expect(await roots.resolve(path.join(project, 'src', 'deep'))).toBe(project)
    expect(await roots.resolve(path.join(profile, 'work', 'other', 'x'))).toBe(path.join(profile, 'work', 'other'))
  })

  it('워크트리 레지스트리의 repoPath 도 후보다', async () => {
    const repo = path.join(profile, 'work', 'fresh')
    const roots = createHostProjectRoots({ profileDir: profile, repoPaths: () => [repo], repoRoot: notARepo })
    expect(await roots.resolve(path.join(repo, 'src'))).toBe(repo)
  })

  it('accounts.json 이 없으면 받은 경로를 그대로 돌려준다', async () => {
    const roots = createHostProjectRoots({ profileDir: profile, repoPaths: () => [], repoRoot: notARepo })
    const cwd = path.join(profile, 'nowhere')
    expect(await roots.resolve(cwd)).toBe(cwd)
  })

  // session-cwd.json 은 앱의 파일이다. Host 가 쓰면 앱의 flush 와 엇갈린다 — 읽기만 한다.
  it('session-cwd.json 을 쓰지 않는다 — 없으면 만들지 않는다', async () => {
    await writeAccounts([{ id: 'cx', provider: 'codex' }])
    await codexProject('cx', path.join(profile, 'work', 'cx'))
    const roots = createHostProjectRoots({ profileDir: profile, repoPaths: () => [], repoRoot: notARepo })
    expect(await roots.resolve(path.join(profile, 'work', 'cx', 'a'))).toBe(path.join(profile, 'work', 'cx'))
    await roots.resolve(path.join(profile, 'work', 'cx', 'b'))
    expect((await fs.readdir(profile)).sort()).toEqual(['accounts.json', 'cfg'])
  })

  it('session-cwd.json 을 쓰지 않는다 — 있으면 바이트 하나 바뀌지 않고 .bak 도 없다', async () => {
    await writeAccounts([{ id: 'cx', provider: 'codex' }])
    await codexProject('cx', path.join(profile, 'work', 'cx'))
    for (const text of ['{}', '{ not json']) {
      await fs.writeFile(path.join(profile, 'session-cwd.json'), text, 'utf8')
      const roots = createHostProjectRoots({ profileDir: profile, repoPaths: () => [], repoRoot: notARepo })
      expect(await roots.resolve(path.join(profile, 'work', 'cx', 'a'))).toBe(path.join(profile, 'work', 'cx'))
      expect(await fs.readFile(path.join(profile, 'session-cwd.json'), 'utf8')).toBe(text)
      expect((await fs.readdir(profile)).sort()).toEqual(['accounts.json', 'cfg', 'session-cwd.json'])
    }
  })
})
