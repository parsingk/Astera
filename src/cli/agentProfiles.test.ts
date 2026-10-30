import { describe, it, expect } from 'vitest'
import { agentProfilesCommand } from './agentProfiles'
import type { ExtensionEntry } from '../core/extensions/types'

const PROFILE = { id: 'ap_000000000001', name: 'Reviewer', status: 'active', accountIds: ['acc_1'], mcpExclude: [], permission: 'inherit', sandbox: false, createdAt: 'T', updatedAt: 'T' }

const mcp = (id: string, name: string): ExtensionEntry => ({ id, kind: 'mcp', name, transport: 'stdio', env: {}, providers: ['claude'], importedFrom: 'acc_1', enabled: true })
const ENTRIES: ExtensionEntry[] = [
  mcp('mcp_gh', 'github'),
  mcp('mcp_pw', 'playwright'),
  { id: 'skill_1', kind: 'skill', name: 'github', hash: 'h', providers: ['claude'], importedFrom: 'acc_1', enabled: true }
]

/** A Host that knows one profile, by id or name, and records every call. */
const host = (answers: Record<string, { status: number; body: unknown }> = {}) => {
  const calls: { cmd: string; args: Record<string, unknown>; request: string | undefined }[] = []
  const call = async (cmd: string, args: Record<string, unknown>, request: string | undefined) => {
    calls.push({ cmd, args, request })
    if (answers[cmd]) return answers[cmd]
    if (cmd === 'agent-profiles-get')
      return args.idOrName === 'Reviewer' || args.idOrName === PROFILE.id
        ? { status: 200, body: { profile: PROFILE } }
        : { status: 404, body: { error: `no agent profile ${String(args.idOrName)}` } }
    if (cmd === 'agent-profiles-list') return { status: 200, body: { profiles: [PROFILE] } }
    if (cmd === 'agent-profiles-delete') return { status: 200, body: {} }
    return { status: 200, body: { profile: { ...PROFILE, ...args } } }
  }
  return { calls, call }
}

const run = (h: ReturnType<typeof host>, cmd: string, args: Record<string, unknown>, request?: string) =>
  agentProfilesCommand({ cmd, args, request, call: h.call, mcpEntries: async () => ENTRIES })

describe('agentProfilesCommand', () => {
  it('list answers what the Host lists', async () => {
    const h = host()
    expect(await run(h, 'agent-profiles-list', {})).toEqual({ status: 200, body: { profiles: [PROFILE] } })
    expect(h.calls.map((c) => c.cmd)).toEqual(['agent-profiles-list'])
  })

  it('show takes an id or a name and answers the profile itself', async () => {
    const h = host()
    expect(await run(h, 'agent-profiles-show', { id: 'Reviewer' })).toEqual({ status: 200, body: PROFILE })
    expect(h.calls).toEqual([{ cmd: 'agent-profiles-get', args: { idOrName: 'Reviewer' }, request: undefined }])
    expect(await run(h, 'agent-profiles-show', { id: 'nope' })).toMatchObject({ status: 404 })
  })

  it('create sends the accounts in order and the shared MCP servers by their ids, under the request id', async () => {
    const h = host()
    const r = await run(
      h,
      'agent-profiles-create',
      { name: 'Reviewer', account: 'acc_2, acc_1', excludeMcp: 'playwright,github', permission: 'bypass', description: 'reads code' },
      'req-1'
    )
    expect(r).toMatchObject({ status: 200, body: { id: PROFILE.id } })
    expect(h.calls).toEqual([
      {
        cmd: 'agent-profiles-create',
        args: { name: 'Reviewer', accountIds: ['acc_2', 'acc_1'], mcpExclude: ['mcp_pw', 'mcp_gh'], permission: 'bypass', description: 'reads code' },
        request: 'req-1'
      }
    ])
  })

  it('refuses an MCP server name that is not a shared one, naming it, and sends nothing', async () => {
    const h = host()
    const r = await run(h, 'agent-profiles-create', { name: 'R', account: 'acc_1', excludeMcp: 'github,slack' })
    expect(r).toEqual({ status: 400, body: { error: 'no shared MCP server is named slack (astera ext list names them)' } })
    expect(h.calls).toEqual([])
  })

  it('refuses a flag given with no value, and a create with no name or account, before the Host is asked', async () => {
    const h = host()
    for (const args of [{ name: true, account: 'acc_1' }, { name: 'R' }, { account: 'acc_1' }, { name: 'R', account: 'acc_1', excludeMcp: true }])
      expect(await run(h, 'agent-profiles-create', args), JSON.stringify(args)).toMatchObject({ status: 400 })
    expect(await run(h, 'agent-profiles-archive', {})).toMatchObject({ status: 400 })
    expect(h.calls).toEqual([])
  })

  it('update resolves a name to the id and sends only the flags given; an empty --exclude-mcp clears the list', async () => {
    const h = host()
    await run(h, 'agent-profiles-update', { id: 'Reviewer', name: 'Critic', excludeMcp: '' }, 'req-2')
    expect(h.calls).toEqual([
      { cmd: 'agent-profiles-get', args: { idOrName: 'Reviewer' }, request: undefined },
      { cmd: 'agent-profiles-update', args: { id: PROFILE.id, name: 'Critic', mcpExclude: [] }, request: 'req-2' }
    ])
  })

  // Sandbox design §6: `--sandbox on|off` is the switch, sent as a boolean; anything else is refused before the Host is asked
  it('--sandbox on|off sends the switch on create and update', async () => {
    const h = host()
    await run(h, 'agent-profiles-create', { name: 'Boxed', account: 'acc_1', sandbox: 'on' })
    await run(h, 'agent-profiles-update', { id: 'Reviewer', sandbox: 'off' })
    expect(h.calls.filter((c) => c.cmd !== 'agent-profiles-get').map((c) => c.args)).toEqual([
      { name: 'Boxed', accountIds: ['acc_1'], sandbox: true },
      { id: PROFILE.id, sandbox: false }
    ])
  })

  it('refuses a --sandbox that is not on or off, and sends nothing', async () => {
    const h = host()
    for (const sandbox of [true, 'yes', 'ON ', ''])
      expect(await run(h, 'agent-profiles-create', { name: 'R', account: 'acc_1', sandbox }), JSON.stringify(sandbox)).toEqual({
        status: 400,
        body: { error: '--sandbox is on or off' }
      })
    expect(await run(h, 'agent-profiles-update', { id: 'Reviewer', sandbox: 'true' })).toMatchObject({ status: 400 })
    expect(h.calls.filter((c) => c.cmd !== 'agent-profiles-get')).toEqual([])
  })

  it('archive, restore and delete resolve a name to the id; delete answers which profile went', async () => {
    const h = host()
    await run(h, 'agent-profiles-archive', { id: 'Reviewer' })
    await run(h, 'agent-profiles-restore', { id: PROFILE.id })
    expect(await run(h, 'agent-profiles-delete', { id: 'Reviewer' })).toEqual({ status: 200, body: { id: PROFILE.id, name: 'Reviewer', deleted: true } })
    expect(h.calls.filter((c) => c.cmd !== 'agent-profiles-get').map((c) => [c.cmd, c.args])).toEqual([
      ['agent-profiles-archive', { id: PROFILE.id }],
      ['agent-profiles-restore', { id: PROFILE.id }],
      ['agent-profiles-delete', { id: PROFILE.id }]
    ])
  })

  // Lifecycle design §5: the archive records why, in the person's own line; the Host checks it
  it('archive passes --reason; a bare --reason is refused before anything is sent', async () => {
    const h = host()
    await run(h, 'agent-profiles-archive', { id: 'Reviewer', reason: 'replaced by p2' })
    expect(h.calls.filter((c) => c.cmd !== 'agent-profiles-get').map((c) => [c.cmd, c.args])).toEqual([
      ['agent-profiles-archive', { id: PROFILE.id, reason: 'replaced by p2' }]
    ])
    const bare = host()
    expect(await run(bare, 'agent-profiles-archive', { id: 'Reviewer', reason: true })).toEqual({ status: 400, body: { error: '--reason needs a value' } })
    expect(bare.calls).toEqual([])
  })

  it('an unknown profile is the Host’s 404, and nothing is changed', async () => {
    const h = host()
    expect(await run(h, 'agent-profiles-delete', { id: 'nope' })).toMatchObject({ status: 404 })
    expect(h.calls.map((c) => c.cmd)).toEqual(['agent-profiles-get'])
  })

  it('a refused change is answered as the Host refused it', async () => {
    const h = host({ 'agent-profiles-delete': { status: 409, body: { error: 'the profile is in use; archive it instead', reason: 'in-use' } } })
    expect(await run(h, 'agent-profiles-delete', { id: 'Reviewer' })).toEqual({ status: 409, body: { error: 'the profile is in use; archive it instead', reason: 'in-use' } })
  })
})

// Lifecycle design §7: the findings, and the ignore list, each one call that carries the request id
describe('agentProfilesCommand — audit', () => {
  it('audit passes all; ignore sends key and note', async () => {
    const h = host()
    await run(h, 'agent-profiles-audit', {}, 'req-1')
    await run(h, 'agent-profiles-audit', { all: true }, 'req-2')
    await run(h, 'agent-profiles-audit-ignore', { key: 'stale-runtime:rt_1', note: 'the lab is shut' }, 'req-3')
    await run(h, 'agent-profiles-audit-ignore', { key: 'unused-profile:ap_1' }, 'req-4')
    await run(h, 'agent-profiles-audit-unignore', { key: 'unused-profile:ap_1' }, 'req-5')
    expect(h.calls).toEqual([
      { cmd: 'agent-profiles-audit', args: {}, request: 'req-1' },
      { cmd: 'agent-profiles-audit', args: { all: true }, request: 'req-2' },
      { cmd: 'agent-profiles-audit-ignore', args: { key: 'stale-runtime:rt_1', note: 'the lab is shut' }, request: 'req-3' },
      { cmd: 'agent-profiles-audit-ignore', args: { key: 'unused-profile:ap_1' }, request: 'req-4' },
      { cmd: 'agent-profiles-audit-unignore', args: { key: 'unused-profile:ap_1' }, request: 'req-5' }
    ])
  })

  it('answers what the Host answered, whatever it found', async () => {
    const report = { findings: [], info: [], observe: { on: false, days: 0 }, unread: [], computedAt: 'T' }
    const h = host({ 'agent-profiles-audit': { status: 200, body: report } })
    expect(await run(h, 'agent-profiles-audit', {})).toEqual({ status: 200, body: report })
  })

  it('refuses a missing key, a bare --note and a valued --all before the Host is asked', async () => {
    const h = host()
    expect(await run(h, 'agent-profiles-audit-ignore', {})).toEqual({ status: 400, body: { error: 'the finding key is required: `astera agent-profiles audit-ignore <key>`, the key from `agent-profiles audit`' } })
    expect(await run(h, 'agent-profiles-audit-unignore', {})).toEqual({ status: 400, body: { error: 'the finding key is required: `astera agent-profiles audit-unignore <key>`, the key from `agent-profiles audit --all`' } })
    expect(await run(h, 'agent-profiles-audit-ignore', { key: 'k', note: true })).toEqual({ status: 400, body: { error: '--note needs a value' } })
    expect(await run(h, 'agent-profiles-audit', { all: 'yes' })).toEqual({ status: 400, body: { error: '--all takes no value' } })
    expect(h.calls).toEqual([])
  })
})
