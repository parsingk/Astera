import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSkillsDir, skillsCommand } from './skills'
import { STUB_MARKER, stubTargetPath } from '../main/orchestration/stub'

// The real stub sources, so a test fails if a shipped stub loses its marker or is renamed.
const skillsDir = path.resolve(__dirname, '../../resources/skills')

let dir: string
let profileDir: string
let claudeDir: string
let codexDir: string

const writeSettings = (settings: Record<string, unknown>): Promise<void> =>
  fs.writeFile(path.join(profileDir, 'app-settings.json'), JSON.stringify(settings), 'utf8')

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cliskills-'))
  profileDir = path.join(dir, 'profile')
  claudeDir = path.join(dir, 'cfg-claude')
  codexDir = path.join(dir, 'cfg-codex')
  await fs.mkdir(profileDir)
  await fs.mkdir(claudeDir)
  await fs.mkdir(codexDir)
  await fs.writeFile(
    path.join(profileDir, 'accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'acc_c', label: 'Work', configDir: claudeDir, color: '#111', createdAt: 'T' },
        { id: 'acc_x', label: 'Codex', configDir: codexDir, color: '#222', createdAt: 'T', provider: 'codex' }
      ],
      dismissedDirs: []
    }),
    'utf8'
  )
  await writeSettings({ agentBrowserEnabled: false })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const run = (cmd: 'skills-list' | 'skills-install', args: Record<string, unknown> = {}) =>
  skillsCommand({ cmd, args, profileDir, skillsDir })

/** The body of a successful answer; a failure fails the test with its message. */
const ok = async (
  cmd: 'skills-list' | 'skills-install',
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> => {
  const r = await run(cmd, args)
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.body
}

type Row = { id: string; skills: { name: string; [k: string]: unknown }[] }
const accountsOf = (body: Record<string, unknown>): Row[] => body.accounts as Row[]
const skillOf = (body: Record<string, unknown>, accountId: string, name: string) =>
  accountsOf(body)
    .find((a) => a.id === accountId)
    ?.skills.find((s) => s.name === name)

describe('skills list', () => {
  it('reports every skill per account, with its setting and what is on disk', async () => {
    const body = await ok('skills-list')
    const accounts = accountsOf(body)
    expect(accounts.map((a) => a.id)).toEqual(['acc_c', 'acc_x'])
    expect(accounts[0]).toMatchObject({ id: 'acc_c', label: 'Work', provider: 'claude' })
    expect(accounts[1]).toMatchObject({ id: 'acc_x', label: 'Codex', provider: 'codex' })
    for (const a of accounts)
      expect(a.skills).toEqual([
        { name: 'astera-orchestration', enabled: true, installed: 'missing' },
        { name: 'astera-task', enabled: false, installed: 'missing' },
        { name: 'astera-browser', enabled: false, installed: 'missing' },
        { name: 'astera-handoff', enabled: false, installed: 'missing' }
      ])
  })

  it('says current after an install, stale for an older stub of ours, not-ours for a foreign file', async () => {
    await ok('skills-install')
    const stalePath = stubTargetPath(codexDir, 'astera-orchestration')
    await fs.writeFile(stalePath, `---\nname: x\n---\n<!-- ${STUB_MARKER} -->\n# older\n`, 'utf8')
    const foreign = stubTargetPath(claudeDir, 'astera-browser')
    await fs.mkdir(path.dirname(foreign), { recursive: true })
    await fs.writeFile(foreign, '# my own browser skill\n', 'utf8')

    const body = await ok('skills-list')
    expect(skillOf(body, 'acc_c', 'astera-orchestration')).toMatchObject({ installed: 'current' })
    expect(skillOf(body, 'acc_x', 'astera-orchestration')).toMatchObject({ installed: 'stale' })
    expect(skillOf(body, 'acc_c', 'astera-browser')).toMatchObject({ enabled: false, installed: 'not-ours' })
  })

  it('never writes anything', async () => {
    await ok('skills-list')
    expect(await fs.readdir(claudeDir)).toEqual([])
    expect(await fs.readdir(codexDir)).toEqual([])
    expect((await fs.readdir(profileDir)).sort()).toEqual(['accounts.json', 'app-settings.json'])
  })
})

describe('skills install', () => {
  it('installs only what the settings enable and names the rest with their setting', async () => {
    const body = await ok('skills-install')
    for (const a of accountsOf(body)) expect(a.skills).toEqual([{ name: 'astera-orchestration', result: 'written' }])
    expect(body.notEnabled).toEqual([
      { name: 'astera-task', setting: 'Settings → How It Works → Work unit tracking' },
      { name: 'astera-browser', setting: 'Settings → Agents → Agent browser' },
      { name: 'astera-handoff', setting: 'Settings → Agents → Session resume strategy → Smart Resume' }
    ])
    expect(String(body.note)).toMatch(/new session/)
    for (const cfg of [claudeDir, codexDir]) {
      expect(await fs.readFile(stubTargetPath(cfg, 'astera-orchestration'), 'utf8')).toContain(STUB_MARKER)
      // the setting is the person's consent: the browser stub is not planted while it is off
      await expect(fs.stat(stubTargetPath(cfg, 'astera-browser'))).rejects.toThrow()
    }
  })

  it('a second run is all unchanged', async () => {
    await ok('skills-install')
    const body = await ok('skills-install')
    for (const a of accountsOf(body)) expect(a.skills).toEqual([{ name: 'astera-orchestration', result: 'unchanged' }])
  })

  it('leaves a foreign SKILL.md alone', async () => {
    const foreign = stubTargetPath(claudeDir, 'astera-orchestration')
    await fs.mkdir(path.dirname(foreign), { recursive: true })
    await fs.writeFile(foreign, '# mine\n', 'utf8')
    const body = await ok('skills-install')
    expect(skillOf(body, 'acc_c', 'astera-orchestration')).toEqual({
      name: 'astera-orchestration',
      result: 'skipped-not-ours'
    })
    expect(skillOf(body, 'acc_x', 'astera-orchestration')).toMatchObject({ result: 'written' })
    expect(await fs.readFile(foreign, 'utf8')).toBe('# mine\n')
  })

  it('installs a gated skill once its setting is on', async () => {
    await ok('skills-install')
    await writeSettings({ agentBrowserEnabled: true })
    const body = await ok('skills-install')
    for (const a of accountsOf(body))
      expect(a.skills).toEqual([
        { name: 'astera-orchestration', result: 'unchanged' },
        { name: 'astera-browser', result: 'written' }
      ])
    expect((body.notEnabled as { name: string }[]).map((n) => n.name)).toEqual(['astera-task', 'astera-handoff'])
    expect(await fs.readFile(stubTargetPath(codexDir, 'astera-browser'), 'utf8')).toContain(STUB_MARKER)
  })

  it('removes nothing: a stub whose setting is off, and one under the old name, both stay', async () => {
    const browser = stubTargetPath(claudeDir, 'astera-browser')
    const legacy = path.join(claudeDir, 'skills', 'orchestration', 'SKILL.md')
    for (const p of [browser, legacy]) {
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, `<!-- ${STUB_MARKER} -->\n# ours\n`, 'utf8')
    }
    await ok('skills-install')
    expect(await fs.readFile(browser, 'utf8')).toContain('# ours')
    expect(await fs.readFile(legacy, 'utf8')).toContain('# ours')
  })

  it('reads a profile with no settings file with the app defaults', async () => {
    await fs.rm(path.join(profileDir, 'app-settings.json'))
    const body = await ok('skills-install')
    for (const a of accountsOf(body)) expect(a.skills).toEqual([{ name: 'astera-orchestration', result: 'written' }])
    expect(await fs.readdir(profileDir)).toEqual(['accounts.json'])
  })
})

describe('--account', () => {
  it('narrows both commands to one account', async () => {
    expect(accountsOf(await ok('skills-list', { account: 'acc_x' })).map((a) => a.id)).toEqual(['acc_x'])
    expect(accountsOf(await ok('skills-install', { account: 'acc_x' })).map((a) => a.id)).toEqual(['acc_x'])
    expect(await fs.readdir(claudeDir)).toEqual([])
  })

  it('an unknown id is not found, and nothing is written', async () => {
    for (const cmd of ['skills-list', 'skills-install'] as const) {
      const r = await run(cmd, { account: 'nope' })
      expect(r).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'unknown account: nope' } })
    }
    expect(await fs.readdir(claudeDir)).toEqual([])
  })

  it('a bare --account is refused', async () => {
    const r = await run('skills-list', { account: true })
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } })
  })
})

describe('an unreadable accounts.json', () => {
  it('is refused with the repair message, not answered as no accounts', async () => {
    await fs.writeFile(path.join(profileDir, 'accounts.json'), '{not json', 'utf8')
    const r = await run('skills-install')
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    if (!r.ok) expect(r.error.message).toMatch(/open Astera to repair it/)
  })
})

describe('resolveSkillsDir', () => {
  const has = (...present: string[]) => (p: string) => present.includes(p)

  it('a packaged build reads resourcesPath/skills', () => {
    const packaged = path.join('/app/resources', 'skills')
    expect(
      resolveSkillsDir({
        resourcesPath: '/app/resources',
        cliEntry: '/app/resources/app.asar/out/main/cli.js',
        exists: has(path.join(packaged, 'orchestration-stub.md'))
      })
    ).toBe(packaged)
  })

  // In development resourcesPath is Electron's own folder, which ships no skills.
  it('a dev build falls back to the repo beside out/main/cli.js', () => {
    const repo = path.resolve('/repo')
    const dev = path.join(repo, 'resources', 'skills')
    expect(
      resolveSkillsDir({
        resourcesPath: path.join(repo, 'node_modules/electron/dist/resources'),
        cliEntry: path.join(repo, 'out', 'main', 'cli.js'),
        exists: has(path.join(dev, 'orchestration-stub.md'))
      })
    ).toBe(dev)
  })

  it('undefined when neither has the stubs', () => {
    expect(resolveSkillsDir({ resourcesPath: undefined, cliEntry: '/x/out/main/cli.js', exists: has() })).toBe(
      undefined
    )
  })
})
