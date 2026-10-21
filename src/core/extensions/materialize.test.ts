// Agent Control Plane release 1 (design §4.6, D10, AC-14): shared skills, commands and agents copied into each
// account, owned through a state file and never by editing the person's files. Each sync rule, idempotence, an
// adopted copy outliving its entry, and one broken account not stopping the others (Review Focus 5).
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { extensionPaths } from '../profile/paths'
import { writeExtensionRegistry } from './registry'
import { hashFile, hashTree } from './hash'
import { replaceConflict, syncMaterialized } from './materialize'
import type { Account } from '../types'
import type { FileExtension } from './types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

const NOW = '2026-10-21T00:00:00.000Z'
const exists = (p: string) => fs.stat(p).then(() => true, () => false)

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-materialize-'))
  dirs.push(root)
  const profileDir = path.join(root, 'profile')
  const paths = extensionPaths(profileDir)
  await fs.mkdir(path.join(paths.skills, 'review', 'refs'), { recursive: true })
  await fs.writeFile(path.join(paths.skills, 'review', 'SKILL.md'), '# review\n')
  await fs.writeFile(path.join(paths.skills, 'review', 'refs', 'a.md'), 'a\n')
  await fs.mkdir(paths.commands, { recursive: true })
  await fs.writeFile(path.join(paths.commands, 'ship.md'), 'ship it\n')
  const claude: Account = { id: 'acc_c', label: 'c', configDir: path.join(root, 'claude-c'), color: '#888', createdAt: NOW, provider: 'claude' }
  const codex: Account = { ...claude, id: 'acc_x', configDir: path.join(root, 'codex-x'), provider: 'codex' }
  await fs.mkdir(claude.configDir, { recursive: true })
  await fs.mkdir(codex.configDir, { recursive: true })
  const skill: FileExtension = {
    id: 'skill-review', kind: 'skill', name: 'review', hash: await hashTree(path.join(paths.skills, 'review')),
    providers: ['claude', 'codex'], importedFrom: 'acc_0', enabled: true
  }
  const command: FileExtension = {
    id: 'command-ship', kind: 'command', name: 'ship', hash: await hashFile(path.join(paths.commands, 'ship.md')),
    providers: ['claude'], importedFrom: 'acc_0', enabled: true
  }
  const register = (entries: FileExtension[]) => writeExtensionRegistry(profileDir, { version: 1, entries })
  await register([skill, command])
  const sync = (accounts: Account[] = [claude]) => syncMaterialized({ profileDir, accounts, now: () => NOW })
  return { root, profileDir, paths, claude, codex, skill, command, register, sync }
}
type S = Awaited<ReturnType<typeof setup>>
const outcomes = (r: Awaited<ReturnType<S['sync']>>) => r.items.map((i) => `${i.accountId} ${i.id} ${i.outcome}`).sort()
const skillDest = (s: S, a: Account = s.claude) => path.join(a.configDir, 'skills', 'review')
const commandDest = (s: S) => path.join(s.claude.configDir, 'commands', 'ship.md')

describe('syncMaterialized', () => {
  it('writes a missing copy and records it', async () => {
    const s = await setup()
    expect(outcomes(await s.sync())).toEqual(['acc_c command-ship written', 'acc_c skill-review written'])
    expect(await fs.readFile(path.join(skillDest(s), 'refs', 'a.md'), 'utf8')).toBe('a\n')
    expect(await fs.readFile(commandDest(s), 'utf8')).toBe('ship it\n')
    const state = JSON.parse(await fs.readFile(s.paths.materializedState, 'utf8'))
    expect(state.records).toContainEqual(
      expect.objectContaining({ id: 'skill-review', accountId: 'acc_c', provider: 'claude', destination: skillDest(s), sourceHash: s.skill.hash, materializedHash: s.skill.hash, adopted: false, lastSyncedAt: NOW })
    )
  })

  // The Host syncs at start, and a profile that shares nothing must not get files from it
  it('writes no state file when nothing is shared', async () => {
    const s = await setup()
    await s.register([])
    expect((await s.sync()).items).toEqual([])
    expect(await exists(s.paths.materializedState)).toBe(false)
  })

  it('changes nothing when run a second time (AC-14)', async () => {
    const s = await setup()
    await s.sync()
    const before = await fs.readFile(s.paths.materializedState, 'utf8')
    expect(outcomes(await s.sync())).toEqual(['acc_c command-ship unchanged', 'acc_c skill-review unchanged'])
    expect(await fs.readFile(s.paths.materializedState, 'utf8')).toBe(before)
  })

  it('rewrites an unchanged copy when the shared one changed', async () => {
    const s = await setup()
    await s.sync()
    await fs.writeFile(path.join(s.paths.commands, 'ship.md'), 'ship it now\n')
    await s.register([s.skill, { ...s.command, hash: await hashFile(path.join(s.paths.commands, 'ship.md')) }])
    expect(outcomes(await s.sync())).toContain('acc_c command-ship written')
    expect(await fs.readFile(commandDest(s), 'utf8')).toBe('ship it now\n')
  })

  it('restores a copy edited outside Astera and keeps the edit in backups', async () => {
    const s = await setup()
    await s.sync()
    await fs.writeFile(path.join(skillDest(s), 'SKILL.md'), '# my edit\n')
    expect(outcomes(await s.sync())).toContain('acc_c skill-review restored')
    expect(await fs.readFile(path.join(skillDest(s), 'SKILL.md'), 'utf8')).toBe('# review\n')
    const stamps = await fs.readdir(s.paths.backups)
    expect(stamps).toHaveLength(1)
    expect(await fs.readFile(path.join(s.paths.backups, stamps[0], 'acc_c', 'skill', 'review', 'SKILL.md'), 'utf8')).toBe('# my edit\n')
  })

  it('adopts an identical copy the account already had, and forgets it, never deletes it, when the entry goes', async () => {
    const s = await setup()
    await fs.mkdir(path.dirname(commandDest(s)), { recursive: true })
    await fs.writeFile(commandDest(s), 'ship it\n')
    expect(outcomes(await s.sync())).toContain('acc_c command-ship adopted')
    const state = JSON.parse(await fs.readFile(s.paths.materializedState, 'utf8'))
    expect(state.records.find((r: { id: string }) => r.id === 'command-ship').adopted).toBe(true)
    await s.register([s.skill])
    expect(outcomes(await s.sync())).toContain('acc_c command-ship forgotten')
    expect(await fs.readFile(commandDest(s), 'utf8')).toBe('ship it\n')
  })

  it('leaves a different copy the account already had as a conflict, and replaceConflict backs it up first', async () => {
    const s = await setup()
    await fs.mkdir(path.dirname(commandDest(s)), { recursive: true })
    await fs.writeFile(commandDest(s), 'my own ship\n')
    expect(outcomes(await s.sync())).toContain('acc_c command-ship conflict')
    expect(await fs.readFile(commandDest(s), 'utf8')).toBe('my own ship\n')
    expect(outcomes(await s.sync())).toContain('acc_c command-ship conflict')

    await replaceConflict({ profileDir: s.profileDir, accountId: 'acc_c', id: 'command-ship', accounts: [s.claude], now: () => NOW })
    expect(await fs.readFile(commandDest(s), 'utf8')).toBe('ship it\n')
    const stamps = await fs.readdir(s.paths.backups)
    expect(await fs.readFile(path.join(s.paths.backups, stamps[0], 'acc_c', 'command', 'ship.md'), 'utf8')).toBe('my own ship\n')
    expect(outcomes(await s.sync())).toContain('acc_c command-ship unchanged')
  })

  it('removes an unchanged copy Astera wrote when the entry is removed or disabled, and keeps an edited one', async () => {
    const s = await setup()
    await s.sync()
    await fs.writeFile(commandDest(s), 'edited\n')
    await s.register([{ ...s.skill, enabled: false }])
    expect(outcomes(await s.sync())).toEqual(['acc_c command-ship forgotten', 'acc_c skill-review removed'])
    expect(await exists(skillDest(s))).toBe(false)
    expect(await fs.readFile(commandDest(s), 'utf8')).toBe('edited\n')
    expect(JSON.parse(await fs.readFile(s.paths.materializedState, 'utf8')).records).toEqual([])
  })

  it('gives a Codex account skills only', async () => {
    const s = await setup()
    expect(outcomes(await s.sync([s.codex]))).toEqual(['acc_x command-ship not-applicable', 'acc_x skill-review written'])
    expect(await exists(path.join(skillDest(s, s.codex), 'SKILL.md'))).toBe(true)
    expect(await exists(path.join(s.codex.configDir, 'commands'))).toBe(false)
  })

  it('marks a deleted account folder failed, without creating it, and still syncs the others', async () => {
    const s = await setup()
    await s.sync([s.claude, s.codex])
    await fs.rm(s.claude.configDir, { recursive: true, force: true })
    const r = await s.sync([s.claude, s.codex])
    expect(outcomes(r)).toEqual(['acc_c command-ship failed', 'acc_c skill-review failed', 'acc_x command-ship not-applicable', 'acc_x skill-review unchanged'])
    expect(await exists(s.claude.configDir)).toBe(false)
    const state = JSON.parse(await fs.readFile(s.paths.materializedState, 'utf8'))
    expect(state.records.filter((x: { accountId: string }) => x.accountId === 'acc_c')).toHaveLength(2)
  })
})
