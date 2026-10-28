// Keeping listed keys and logins out of agent sessions (credentials design §5): which variables an entry removes, where a
// preset points its CLI's configuration, which sessions an entry applies to, and what can never be removed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyHiding, createHidingSource, hidingFor, projectOfWorktrees } from './hiding'
import { PRESETS } from './presets'
import type { CredentialEntry, HideOnlyEntry, McpSecretEntry } from './types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'astera-hiding-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const hideOnly = (over: Partial<HideOnlyEntry> = {}): HideOnlyEntry => ({
  kind: 'hide-only', id: 'hc_1', alias: 'keys', envNames: [], presets: [], hide: { on: true }, createdAt: '2026-10-26T00:00:00.000Z', ...over
})
const mcp = (over: Partial<McpSecretEntry> = {}): McpSecretEntry => ({
  kind: 'mcp-secret', id: 'mcp:m1', serverId: 'm1', serverName: 'linear', secretNames: ['m1-key'], envNames: ['LINEAR_API_KEY'], protectedNames: [], hide: { on: true }, enabled: true, ...over
})
const same = (cwd: string): string => cwd
const forCwd = (entries: CredentialEntry[], cwd = 'D:/work/p', projectOf = same) => hidingFor({ entries, cwd, projectOf, emptyDir: path.join(dir, 'empty') })

describe('hidingFor', () => {
  it('a hide-only entry removes its variables', () => {
    expect(forCwd([hideOnly({ envNames: ['STRIPE_KEY', 'SENTRY_DSN'] })])).toEqual({ remove: ['STRIPE_KEY', 'SENTRY_DSN'], set: {} })
  })

  it('the gh preset removes GH_TOKEN and GITHUB_TOKEN and points GH_CONFIG_DIR at an empty folder', () => {
    const h = forCwd([hideOnly({ presets: ['gh'] })])
    expect(h.remove).toEqual(['GH_TOKEN', 'GITHUB_TOKEN'])
    expect(h.set).toEqual({ GH_CONFIG_DIR: path.join(dir, 'empty', 'gh') })
  })

  it('an mcp-secret entry removes the variable names its secrets use', () => {
    expect(forCwd([mcp()])).toEqual({ remove: ['LINEAR_API_KEY'], set: {} })
  })

  it('an entry with hiding off changes nothing', () => {
    expect(forCwd([hideOnly({ envNames: ['A'], hide: { on: false } }), mcp({ hide: { on: false } })])).toEqual({ remove: [], set: {} })
  })

  it('an entry narrowed to a project applies only to sessions in that project', () => {
    const e = hideOnly({ envNames: ['A'], hide: { on: true, projects: ['D:/work/p'] } })
    expect(forCwd([e], 'D:/work/p/sub').remove).toEqual(['A'])
    expect(forCwd([e], 'D:/work/other').remove).toEqual([])
  })

  it('applies a project entry to a worker in that project\'s worktree', () => {
    const e = hideOnly({ envNames: ['A'], hide: { on: true, projects: ['D:/work/p'] } })
    const projectOf = projectOfWorktrees(() => [{ path: 'C:/Users/u/astera-worktrees/p-fix', repoPath: 'D:/work/p' }])
    expect(forCwd([e], 'C:/Users/u/astera-worktrees/p-fix', projectOf).remove).toEqual(['A'])
    expect(projectOf('D:/elsewhere')).toBe('D:/elsewhere')
  })

  it('never removes a protected name even if an entry lists one', () => {
    expect(forCwd([hideOnly({ envNames: ['ASTERA_SESSION', 'openai_api_key', 'KEEP_OUT'] })]).remove).toEqual(['KEEP_OUT'])
  })

  // Final review M3: a session cannot run without its command path, system folders or temp folders
  it('never removes a variable the OS gives every program, whatever its case', () => {
    expect(forCwd([hideOnly({ envNames: ['PATH', 'SystemRoot', 'temp', 'TMPDIR', 'HOME', 'KEEP_OUT'] })]).remove).toEqual(['KEEP_OUT'])
  })

  it('every preset names what it removes or redirects, and where it was measured', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['gh', 'aws', 'gcloud', 'npm', 'docker', 'kubectl'])
    for (const p of PRESETS) {
      expect(p.remove.length + Object.keys(p.redirect).length, p.id).toBeGreaterThan(0)
      expect(p.measuredOn, p.id).toContain('win32')
    }
    // macOS and Linux from the measure-sandbox runs (inventory §21); the macOS runner has no gcloud, docker or kubectl
    expect(Object.fromEntries(PRESETS.map((p) => [p.id, p.measuredOn]))).toEqual({
      gh: ['win32', 'darwin', 'linux'],
      aws: ['win32', 'darwin', 'linux'],
      gcloud: ['win32', 'linux'],
      npm: ['win32', 'darwin', 'linux'],
      docker: ['win32', 'linux'],
      kubectl: ['win32', 'linux']
    })
  })
})

describe('applyHiding', () => {
  it('hides names whatever their case on win32', () => {
    const env: Record<string, string | undefined> = { Gh_Token: 'x', github_token: 'y', PATH: 'p' }
    applyHiding(env, { remove: ['GH_TOKEN', 'GITHUB_TOKEN'], set: {} }, 'win32')
    expect(env).toEqual({ PATH: 'p' })
    const posix: Record<string, string | undefined> = { Gh_Token: 'x', GH_TOKEN: 'y' }
    applyHiding(posix, { remove: ['GH_TOKEN'], set: {} }, 'linux')
    expect(posix).toEqual({ Gh_Token: 'x' })
  })

  it('creates the empty folder and file a redirect points at', () => {
    const folder = path.join(dir, 'empty', 'gh')
    const file = path.join(dir, 'empty', 'aws', 'AWS_CONFIG_FILE')
    const env: Record<string, string | undefined> = { gh_config_dir: 'C:/old' }
    applyHiding(env, { remove: [], set: { GH_CONFIG_DIR: folder, AWS_CONFIG_FILE: file } }, 'win32')
    expect(env).toEqual({ GH_CONFIG_DIR: folder, AWS_CONFIG_FILE: file })
    expect(statSync(folder).isDirectory()).toBe(true)
    expect(statSync(file).size).toBe(0)
    expect(readdirSync(folder)).toEqual([])
  })
})

describe('createHidingSource', () => {
  const writeJson = (rel: string, v: unknown): void => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), JSON.stringify(v))
  }

  it('reads the list and the shared MCP servers at every call', () => {
    const src = createHidingSource({ profileDir: dir, projectOf: same })
    expect(src.get('D:/p')).toEqual({ remove: [], set: {} })
    writeJson('credentials.json', { version: 1, entries: [hideOnly({ envNames: ['A'] })], mcpHide: {} })
    writeJson('extensions/registry.json', {
      version: 1,
      entries: [{ id: 'm1', kind: 'mcp', name: 'linear', transport: 'stdio', command: 'x', env: { LINEAR_API_KEY: { secret: 'k' } }, providers: ['claude'], importedFrom: 'a', enabled: true }]
    })
    expect(src.get('D:/p').remove).toEqual(['A', 'LINEAR_API_KEY'])
    expect(src.damaged()).toBe(false)
  })

  const linear = {
    version: 1,
    entries: [{ id: 'm1', kind: 'mcp', name: 'linear', transport: 'stdio', command: 'x', env: { LINEAR_API_KEY: { secret: 'k' } }, providers: ['claude'], importedFrom: 'a', enabled: true }]
  }

  // Final review M2: the person's own switches are in the damaged file, so the shared servers' keys keep their default
  it('starts sessions without the registered entries when the file is damaged, the shared servers\u2019 keys still hidden', () => {
    writeJson('extensions/registry.json', linear)
    writeJson('credentials.json', { version: 7 })
    const src = createHidingSource({ profileDir: dir, projectOf: same })
    expect(src.get('D:/p', 's1')).toEqual({ remove: ['LINEAR_API_KEY'], set: {} })
    expect(src.damaged()).toBe(true)
    expect(existsSync(path.join(dir, 'credentials.json'))).toBe(true)
  })

  // Final review M1: a file that cannot be read for a moment (Windows renames it into place on every change) is not "no
  // list": the last list read is used
  it('uses the last list it read when the file cannot be read, and says so', () => {
    writeJson('credentials.json', { version: 1, entries: [hideOnly({ envNames: ['A'] })], mcpHide: {} })
    const logged: string[] = []
    const src = createHidingSource({ profileDir: dir, projectOf: same, log: (m) => void logged.push(m) })
    expect(src.get('D:/p', 's1').remove).toEqual(['A'])
    rmSync(path.join(dir, 'credentials.json'))
    mkdirSync(path.join(dir, 'credentials.json'))
    expect(src.get('D:/p', 's2').remove).toEqual(['A'])
    expect(logged.join('\n')).toMatch(/credentials\.json could not be read/)
    expect(src.damaged()).toBe(false)
  })

  // Final review I3: a login made inside one session (gh auth login, npm login) lands in that session's own empty
  // location, never in one every later session shares
  it('gives each session its own empty locations, the same again when that session starts again', () => {
    writeJson('credentials.json', { version: 1, entries: [hideOnly({ presets: ['gh', 'npm'] })], mcpHide: {} })
    const src = createHidingSource({ profileDir: dir, projectOf: same })
    const a = src.get('D:/p', 'sess-a')
    const b = src.get('D:/p', 'sess-b')
    expect(a.set.GH_CONFIG_DIR).not.toBe(b.set.GH_CONFIG_DIR)
    expect(a.set.NPM_CONFIG_USERCONFIG).not.toBe(b.set.NPM_CONFIG_USERCONFIG)
    expect(src.get('D:/p', 'sess-a')).toEqual(a)
    for (const v of [...Object.values(a.set), ...Object.values(b.set)]) expect(v.startsWith(path.join(dir, 'credentials', 'empty'))).toBe(true)
    applyHiding({}, a, 'win32')
    writeFileSync(path.join(a.set.GH_CONFIG_DIR, 'hosts.yml'), 'github.com:\n  user: someone\n')
    applyHiding({}, b, 'win32')
    expect(readdirSync(b.set.GH_CONFIG_DIR)).toEqual([])
    // Two sessions with no id of their own (a How It Works run) never share either
    expect(src.get('D:/p').set.GH_CONFIG_DIR).not.toBe(src.get('D:/p').set.GH_CONFIG_DIR)
  })

  it('removes the empty locations of sessions not started for 30 days', () => {
    writeJson('credentials.json', { version: 1, entries: [hideOnly({ presets: ['gh'] })], mcpHide: {} })
    // From the real clock: the folders' times are the file system's
    let now = Date.now()
    const logged: string[] = []
    const src = createHidingSource({ profileDir: dir, projectOf: same, now: () => now, log: (m) => void logged.push(m) })
    const old = src.get('D:/p', 'old-one')
    applyHiding({}, old, 'win32')
    now += 31 * 24 * 60 * 60 * 1000
    const fresh = src.get('D:/p', 'new-one')
    applyHiding({}, fresh, 'win32')
    expect(existsSync(fresh.set.GH_CONFIG_DIR)).toBe(true)
    expect(existsSync(path.dirname(old.set.GH_CONFIG_DIR))).toBe(false)
    expect(logged.join('\n')).toMatch(/removed/)
  })
})
