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
      'credentials-reset', 'credentials-set-hiding', 'credentials-show', 'credentials-uses'
    ])
    expect([...CREDENTIAL_CHANGES].sort()).toEqual(['credentials-add-hide-only', 'credentials-delete-hide-only', 'credentials-edit-hide-only', 'credentials-reset', 'credentials-set-hiding'])
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
    expect(text).toMatch(/aws: measured on win32, linux/)
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

  it('counts a change that landed as an effect', async () => {
    const h = host()
    const m = marks()
    await h.command({ cmd: 'credentials-add-hide-only', args: { alias: 'k', envNames: ['A'], presets: [] }, ...app, marks: m })
    await h.command({ cmd: 'credentials-list', args: {}, ...app, marks: m })
    expect(m.effects).toBe(1)
  })
})
