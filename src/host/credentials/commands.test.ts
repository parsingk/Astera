// The Host's `credentials-*` commands (credentials design §4, §7): the app and this machine's CLI read the list, only the
// app changes it, an agent's shell may not read the uses, and a damaged list is reported with its repair.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CREDENTIAL_CHANGES, CREDENTIAL_COMMANDS, createHostCredentials } from './commands'
import { appendCredentialUses } from '../../core/credentials/uses'
import type { CredentialUse } from '../../core/audit/types'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-credcmd-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const NOW = Date.parse('2026-10-26T12:00:00.000Z')
const registry = {
  version: 1,
  entries: [{ id: 'm1', kind: 'mcp', name: 'linear', transport: 'stdio', command: 'x', env: { LINEAR_API_KEY: { secret: 'linear-key' } }, providers: ['claude'], importedFrom: 'a', enabled: true }]
}
const writeRegistry = async (): Promise<void> => {
  await fs.mkdir(path.join(dir, 'extensions'), { recursive: true })
  await fs.writeFile(path.join(dir, 'extensions', 'registry.json'), JSON.stringify(registry))
}
const host = (platform: NodeJS.Platform = 'win32') => createHostCredentials({ profileDir: dir, platform, now: () => NOW })
const marks = () => ({ effects: 0 })
const app = { role: 'app' as const }
const cli = { role: 'cli' as const }
const agent = { role: 'cli' as const, agentRefusal: 'not from an agent session' }
const body = (r: { body: unknown }) => r.body as Record<string, unknown>

describe('credentials commands', () => {
  it('names its commands and which of them change the list', () => {
    expect([...CREDENTIAL_COMMANDS].sort()).toEqual([
      'credentials-add-hide-only', 'credentials-delete-hide-only', 'credentials-doctor', 'credentials-edit-hide-only', 'credentials-list',
      'credentials-record', 'credentials-reset', 'credentials-set-hiding', 'credentials-show', 'credentials-uses'
    ])
    expect([...CREDENTIAL_CHANGES].sort()).toEqual([
      'credentials-add-hide-only', 'credentials-delete-hide-only', 'credentials-edit-hide-only', 'credentials-record', 'credentials-reset', 'credentials-set-hiding'
    ])
  })

  it('lists MCP and hide-only entries with no value', async () => {
    await writeRegistry()
    const h = host()
    await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'Cloud', envNames: ['STRIPE_KEY'], presets: ['aws'] }, ...app, marks: marks() })
    const r = await h.command({ cmd: 'credentials-list', args: {}, ...cli, marks: marks() })
    expect(r.status).toBe(200)
    const entries = body(r).entries as { kind: string; id: string; envNames: string[]; hide: unknown }[]
    expect(entries.map((e) => [e.kind, e.envNames])).toEqual([['hide-only', ['STRIPE_KEY']], ['mcp-secret', ['LINEAR_API_KEY']]])
    // names only: the secret's store name, never a value field
    expect(JSON.stringify(r.body)).not.toMatch(/"value"|vaultRef/)
    expect(entries[1]).toMatchObject({ secretNames: ['linear-key'] })
    expect((body(r).presets as { id: string }[]).map((p) => p.id)).toContain('gh')
  })

  // The screen says "nothing changes now" for an MCP entry none of whose variables a session would inherit (design §5)
  it('says whether an MCP entry\u2019s variables are in the environment sessions inherit, by name only', async () => {
    await writeRegistry()
    const list = async (platform: NodeJS.Platform, env: Record<string, string | undefined>) => {
      const h = createHostCredentials({ profileDir: dir, platform, now: () => NOW, env })
      const r = await h.command({ cmd: 'credentials-list', args: {}, ...cli, marks: marks() })
      return (body(r).entries as { kind: string; present?: unknown }[]).find((e) => e.kind === 'mcp-secret')
    }
    expect(await list('win32', { PATH: 'x' })).toMatchObject({ present: false })
    expect(await list('win32', { linear_api_key: 'secret-value' })).toMatchObject({ present: true })
    expect(await list('linux', { linear_api_key: 'secret-value' })).toMatchObject({ present: false })
    expect(await list('linux', { LINEAR_API_KEY: 'secret-value' })).toMatchObject({ present: true })
    const h = createHostCredentials({ profileDir: dir, platform: 'linux', now: () => NOW, env: { LINEAR_API_KEY: 'secret-value' } })
    expect(JSON.stringify((await h.command({ cmd: 'credentials-list', args: {}, ...cli, marks: marks() })).body)).not.toContain('secret-value')
  })

  // Final review I4: an app started from the macOS Dock inherits no shell exports, so a registered name may be in no session
  it('says the same of an entry you added', async () => {
    const h = createHostCredentials({ profileDir: dir, platform: 'darwin', now: () => NOW, env: { SENTRY_DSN: 'x' } })
    await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'a', envNames: ['STRIPE_KEY'], presets: [] }, ...app, marks: marks() })
    await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'b', envNames: ['SENTRY_DSN'], presets: [] }, ...app, marks: marks() })
    const entries = body(await h.command({ cmd: 'credentials-list', args: {}, ...app, marks: marks() })).entries as { alias: string; present?: unknown }[]
    expect(entries.map((e) => [e.alias, e.present])).toEqual([['a', false], ['b', true]])
  })

  // An entry is narrowed to projects (C9): the screen picks them from the projects this Host has registered
  it('answers the registered projects an entry can be narrowed to, by folder and name', async () => {
    const h = createHostCredentials({
      profileDir: dir,
      now: () => NOW,
      projects: async () => [{ id: 'p1', path: 'D:\\work\\astera', name: 'astera', addedAt: '2026-10-01T00:00:00.000Z' }]
    })
    const r = await h.command({ cmd: 'credentials-list', args: {}, ...app, marks: marks() })
    expect(body(r).projects).toEqual([{ path: 'D:\\work\\astera', name: 'astera' }])
    const failing = createHostCredentials({ profileDir: dir, now: () => NOW, projects: async () => Promise.reject(new Error('state unreadable')) })
    const f = await failing.command({ cmd: 'credentials-list', args: {}, ...app, marks: marks() })
    expect(f.status).toBe(200)
    expect(body(f).projects).toEqual([])
  })

  it('refuses every change but the app\u2019s', async () => {
    const h = host()
    for (const caller of [cli, agent, { role: 'mcp' as const }]) {
      const r = await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'x', envNames: ['A'], presets: [] }, ...caller, marks: marks() })
      expect(r.status, caller.role).toBe(403)
    }
  })

  it('adds, edits and deletes a hide-only entry', async () => {
    const h = host()
    const added = await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'Keys', envNames: ['A'], presets: [] }, ...app, marks: marks() })
    expect(added.status).toBe(200)
    const id = (body(added).entry as { id: string }).id
    const edited = await h.command({ cmd: 'credentials-edit-hide-only', args: { id, envNames: ['A', 'B'], hide: { on: true, projects: ['D:/p'] } }, ...app, marks: marks() })
    expect((body(edited).entry as { envNames: string[]; hide: unknown }).envNames).toEqual(['A', 'B'])
    expect((body(edited).entry as { hide: unknown }).hide).toEqual({ on: true, projects: ['D:/p'] })
    expect((await h.command({ cmd: 'credentials-delete-hide-only', args: { id }, ...app, marks: marks() })).status).toBe(200)
    expect(body(await h.command({ cmd: 'credentials-list', args: {}, ...app, marks: marks() })).entries).toEqual([])
    expect((await h.command({ cmd: 'credentials-delete-hide-only', args: { id }, ...app, marks: marks() })).status).toBe(404)
  })

  it('refuses a protected name or an unknown preset', async () => {
    const h = host()
    const p = await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'x', envNames: ['OPENAI_API_KEY'], presets: [] }, ...app, marks: marks() })
    expect(p.status).toBe(400)
    expect(body(p).reason).toBe('protected-name')
    const u = await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'x', envNames: [], presets: ['az'] }, ...app, marks: marks() })
    expect(body(u).reason).toBe('unknown-preset')
  })

  it('sets the hiding of an MCP entry', async () => {
    await writeRegistry()
    const h = host()
    const r = await h.command({ cmd: 'credentials-set-hiding', args: { id: 'mcp:m1', hide: { on: false } }, ...app, marks: marks() })
    expect(r.status).toBe(200)
    const entries = body(await h.command({ cmd: 'credentials-list', args: {}, ...app, marks: marks() })).entries as { id: string; hide: unknown }[]
    expect(entries.find((e) => e.id === 'mcp:m1')?.hide).toEqual({ on: false })
    expect((await h.command({ cmd: 'credentials-set-hiding', args: { id: 'mcp:none', hide: { on: false } }, ...app, marks: marks() })).status).toBe(404)
  })

  it('answers credential uses and refuses them to an agent\u2019s shell', async () => {
    const use: CredentialUse = {
      id: 'cu_1', at: '2026-10-26T11:00:00.000Z', actor: 'session', sessionId: 's1', entryId: 'mcp:m1', provider: 'mcp', action: 'mcp.call',
      resource: 'linear/x', outcome: 'ok', evidence: 'managed', requestId: 'rq'
    }
    await appendCredentialUses(dir, [use], { now: () => NOW })
    const h = host()
    const r = await h.command({ cmd: 'credentials-uses', args: { entryId: 'mcp:m1' }, ...app, marks: marks() })
    expect((body(r).uses as { id: string }[]).map((u) => u.id)).toEqual(['cu_1'])
    expect((await h.command({ cmd: 'credentials-uses', args: {}, ...agent, marks: marks() })).status).toBe(403)
    await writeRegistry()
    const listed = body(await h.command({ cmd: 'credentials-list', args: {}, ...app, marks: marks() })).entries as { id: string; lastUsedAt?: string }[]
    expect(listed.find((e) => e.id === 'mcp:m1')?.lastUsedAt).toBe('2026-10-26T11:00:00.000Z')
  })

  it('doctor names the limits and the platform each preset was measured on', async () => {
    const r = await host('win32').command({ cmd: 'credentials-doctor', args: {}, ...agent, marks: marks() })
    expect(r.status).toBe(200)
    const text = (body(r).lines as { text: string }[]).map((l) => l.text).join('\n')
    expect(text).toMatch(/git credential fill/)
    expect(text).toMatch(/same Windows account|same user/)
    expect(text).toMatch(/gh: measured on win32/)
    expect(text).toMatch(/aws: measured on win32, darwin, linux/)
    expect(text).toMatch(/default access list/)
    const posix = (body(await host('darwin').command({ cmd: 'credentials-doctor', args: {}, ...cli, marks: marks() })).lines as { text: string }[]).map((l) => l.text).join('\n')
    expect(posix).toMatch(/not measured on darwin/)
    expect(posix).not.toMatch(/default access list/)
  })

  it('says the file is damaged instead of answering an empty list, and resets it from the app', async () => {
    await fs.writeFile(path.join(dir, 'credentials.json'), '{ broken')
    const h = host()
    const r = await h.command({ cmd: 'credentials-list', args: {}, ...app, marks: marks() })
    expect(r.status).toBe(409)
    expect(body(r).reason).toBe('damaged')
    expect((await h.command({ cmd: 'credentials-reset', args: {}, ...cli, marks: marks() })).status).toBe(403)
    expect((await h.command({ cmd: 'credentials-reset', args: {}, ...app, marks: marks() })).status).toBe(200)
    expect((await h.command({ cmd: 'credentials-list', args: {}, ...app, marks: marks() })).status).toBe(200)
    expect(await fs.readFile(path.join(dir, 'credentials.json.bak'), 'utf8')).toBe('{ broken')
  })

  // Final review M6: the uses an agent's shell may not list, it may not read through show either
  it('shows an MCP entry\u2019s last uses to the app and the CLI, not to an agent\u2019s shell', async () => {
    await writeRegistry()
    await appendCredentialUses(dir, [{ id: 'cu_1', at: '2026-10-26T11:00:00.000Z', actor: 'session', sessionId: 's9', entryId: 'mcp:m1', provider: 'mcp', action: 'mcp.call', resource: 'linear/x', outcome: 'ok', evidence: 'managed', requestId: 'rq' }], { now: () => NOW })
    const h = host()
    expect((body(await h.command({ cmd: 'credentials-show', args: { id: 'linear' }, ...cli, marks: marks() })).uses as unknown[]).length).toBe(1)
    const asAgent = await h.command({ cmd: 'credentials-show', args: { id: 'linear' }, ...agent, marks: marks() })
    expect(asAgent.status).toBe(200)
    expect(body(asAgent).entry).toMatchObject({ id: 'mcp:m1' })
    expect(body(asAgent).uses).toBeUndefined()
  })

  // Final review M7: a name is how show finds an entry, so two entries never share one
  it('refuses a second entry with a name already used, whatever its case, and an ambiguous name in show', async () => {
    const h = host()
    const first = await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'Cloud', envNames: ['A'], presets: [] }, ...app, marks: marks() })
    const again = await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'cloud', envNames: ['B'], presets: [] }, ...app, marks: marks() })
    expect(again.status).toBe(400)
    expect(body(again).reason).toBe('alias-taken')
    const other = await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'Other', envNames: ['B'], presets: [] }, ...app, marks: marks() })
    const otherId = (body(other).entry as { id: string }).id
    const renamed = await h.command({ cmd: 'credentials-edit-hide-only', args: { id: otherId, alias: 'CLOUD' }, ...app, marks: marks() })
    expect(body(renamed).reason).toBe('alias-taken')
    // Renaming an entry to its own name in another case is no clash
    const firstId = (body(first).entry as { id: string }).id
    expect((await h.command({ cmd: 'credentials-edit-hide-only', args: { id: firstId, alias: 'CLOUD' }, ...app, marks: marks() })).status).toBe(200)
    // A shared server named like an entry: show asks for the id
    await writeRegistry()
    await h.command({ cmd: 'credentials-edit-hide-only', args: { id: otherId, alias: 'linear' }, ...app, marks: marks() })
    const both = await h.command({ cmd: 'credentials-show', args: { id: 'linear' }, ...cli, marks: marks() })
    expect(both.status).toBe(409)
    expect(String(body(both).error)).toMatch(/use the id/)
  })

  // Final review M10: one newest-first pass over the uses finds every entry's last one
  it('lists each MCP entry\u2019s last use, an unused one with none', async () => {
    await fs.mkdir(path.join(dir, 'extensions'), { recursive: true })
    const server = (id: string, name: string) => ({ ...registry.entries[0], id, name })
    await fs.writeFile(path.join(dir, 'extensions', 'registry.json'), JSON.stringify({ version: 1, entries: [server('m1', 'linear'), server('m2', 'sentry'), server('m3', 'quiet')] }))
    const use = (id: string, at: string, entryId: string): CredentialUse => ({ id, at, actor: 'session', sessionId: 's1', entryId, provider: 'mcp', action: 'mcp.call', resource: 'x/y', outcome: 'ok', evidence: 'managed', requestId: 'rq' })
    await appendCredentialUses(dir, [use('cu_1', '2026-10-24T10:00:00.000Z', 'mcp:m2'), use('cu_2', '2026-10-25T10:00:00.000Z', 'mcp:m1'), use('cu_3', '2026-10-26T09:00:00.000Z', 'mcp:m1')], { now: () => NOW })
    const entries = body(await host().command({ cmd: 'credentials-list', args: {}, ...app, marks: marks() })).entries as { id: string; lastUsedAt?: string }[]
    expect(Object.fromEntries(entries.map((e) => [e.id, e.lastUsedAt ?? null]))).toEqual({
      'mcp:m1': '2026-10-26T09:00:00.000Z',
      'mcp:m2': '2026-10-24T10:00:00.000Z',
      'mcp:m3': null
    })
  })

  // Final review I2: the app's own Create PR runs in the app; the Host keeps its records, as the app's, and nobody else's
  it('records the app\u2019s own GitHub writes for the app alone, names and outcomes only', async () => {
    const got: unknown[] = []
    const h = createHostCredentials({ profileDir: dir, now: () => NOW, record: (u) => void got.push(u) })
    const uses = [
      { action: 'git.remote.write', resource: 'o/r feat/x', outcome: 'ok' },
      { action: 'github.pr.create', resource: 'o/r', outcome: 'failed' }
    ]
    expect((await h.command({ cmd: 'credentials-record', args: { uses }, ...app, marks: marks() })).status).toBe(200)
    expect(got).toEqual([
      { actor: 'app', provider: 'github', action: 'git.remote.write', resource: 'o/r feat/x', outcome: 'ok', evidence: 'observed' },
      { actor: 'app', provider: 'github', action: 'github.pr.create', resource: 'o/r', outcome: 'failed', evidence: 'observed' }
    ])
    for (const caller of [cli, agent]) expect((await h.command({ cmd: 'credentials-record', args: { uses }, ...caller, marks: marks() })).status).toBe(403)
    const bad = await h.command({ cmd: 'credentials-record', args: { uses: [{ action: 'mcp.call', resource: 'x', outcome: 'ok' }] }, ...app, marks: marks() })
    expect(bad.status).toBe(400)
    const long = await h.command({ cmd: 'credentials-record', args: { uses: [{ action: 'github.write', resource: 'x'.repeat(400), outcome: 'ok' }] }, ...app, marks: marks() })
    expect(long.status).toBe(400)
    expect(got).toHaveLength(2)
  })

  // Final review M2, M3, I3, I4: what doctor says now
  it('doctor says what a damaged list still hides, the names the OS needs, where logins made in a session go, and shell startup files', async () => {
    await fs.writeFile(path.join(dir, 'credentials.json'), '{ broken')
    const text = (body(await host('linux').command({ cmd: 'credentials-doctor', args: {}, ...cli, marks: marks() })).lines as { text: string }[]).map((l) => l.text).join('\n')
    expect(text).toMatch(/entries you added are not hidden; shared MCP servers\u2019 keys stay hidden by default/)
    expect(text).toMatch(/PATH/)
    expect(text).toMatch(/own empty locations/)
    expect(text).toMatch(/startup files/)
    // The measure-sandbox runs (inventory §22.5): which files a login shell reads, and that Codex starts one
    const startup = text.split('\n').find((l) => l.includes('startup files')) ?? ''
    expect(startup).toMatch(/login shell/)
    expect(startup).toMatch(/~\/\.zprofile/)
    expect(startup).toMatch(/measured 2026-10-27/)
    expect(startup).not.toMatch(/; not measured\.$/)
  })

  // Sandbox design §6: what the sandbox does on each OS for each CLI, and its known limits, whatever this machine is
  it('doctor names each OS’s sandbox and the limits', async () => {
    const lines = body(await host('linux').command({ cmd: 'credentials-doctor', args: {}, ...cli, marks: marks() })).lines as { level: string; text: string }[]
    const sandbox = lines.filter((l) => l.text.startsWith('Sandbox, '))
    expect(sandbox.map((l) => /^Sandbox, ([^:]+):/.exec(l.text)?.[1])).toEqual([
      'Codex on Windows',
      'Codex on macOS',
      'Codex on Linux',
      'Claude Code on Windows',
      'Claude Code on macOS',
      'Claude Code on Linux'
    ])
    const line = (start: string): { level: string; text: string } => sandbox.find((l) => l.text.startsWith(`Sandbox, ${start}:`))!
    expect(line('Codex on Windows').text).toMatch(/Credential Manager/)
    expect(line('Codex on macOS').text).toMatch(/~\/Library\/Keychains/)
    expect(line('Codex on Linux').text).toMatch(/session bus/)
    // Task 8 fix round 1: only a bus at a file path is denied; an abstract socket is not a path
    expect(line('Codex on Linux').text).toMatch(/when the session bus is a file path[^\n]*abstract socket[^\n]*not denied/)
    // Claude Code has no sandbox on Windows: its shell is not restricted, and doctor warns
    expect(line('Claude Code on Windows')).toMatchObject({ level: 'warn' })
    expect(line('Claude Code on Windows').text).toMatch(/shell is not restricted/)
    for (const l of sandbox) expect(l.text, l.text).toMatch(/network works|not restricted/)
    const text = lines.map((l) => l.text).join('\n')
    // The three known limits of the design
    expect(text).toMatch(/curl[^\n]*TLS/)
    expect(text).toMatch(/gh inside the sandbox cannot use your login[^\n]*through Astera/)
    expect(text).toMatch(/pushes stay with the Host/)
    // And those the build found
    expect(text).toMatch(/A chain keeps the sandbox state it started with/)
    expect(text).toMatch(/worktree[^\n]*adds itself[^\n]*config\.worktree/)
    expect(text).toMatch(/one Codex account[^\n]*stale[^\n]*from Codex’s source, not measured[^\n]*set up again/)
    // Task 8 fix round 1: what happens to a ready answer kept when a setup outside Astera makes the home stale
    const stale = text.split('\n').find((l) => l.includes('stale')) ?? ''
    expect(stale).toMatch(/ready answer is kept for the process’s life/)
    expect(stale).toMatch(/dropped only by a setup run through Astera/)
    expect(stale).toMatch(/setup outside Astera keeps reading ready until Astera restarts/)
    expect(text).toMatch(/runtime it uses \(srt[^\n]*not with Claude Code itself/)
    expect(text).toMatch(/Linux[^\n]*excludes file[^\n]*`git add -A` works/)
    // Said on every OS alike
    const win = (body(await host('win32').command({ cmd: 'credentials-doctor', args: {}, ...cli, marks: marks() })).lines as { text: string }[]).filter((l) => l.text.startsWith('Sandbox, '))
    expect(win.map((l) => l.text)).toEqual(sandbox.map((l) => l.text))
  })

  it('counts a change that landed as an effect', async () => {
    const h = host()
    const m = marks()
    await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'k', envNames: ['A'], presets: [] }, ...app, marks: m })
    await h.command({ cmd: 'credentials-list', args: {}, ...app, marks: m })
    expect(m.effects).toBe(1)
  })
})
