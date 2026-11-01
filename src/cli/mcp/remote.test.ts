import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMcpServer } from './server'
import { openMcpRuntimes, remoteHostLink, type McpRuntimes } from './remoteLink'
import type { HostLink } from './hostLink'
import { controllerRegistry } from '../runtimes'
import { RemoteError } from '../../core/remote/client'
import type { RemoteLink, RemoteTarget } from '../../core/remote/link'
import type { HelloFrame } from '../../core/remote/frames'
import { mcpAccessForRemote } from '../../core/settings/mcpAccess'
import { hostSaysSandboxed, inAgentSession, rememberedSandboxed } from '../callerSandboxed'
import type { connectHost } from '../../core/host/connect'
import type { HostMessage } from '../../core/host/protocol'

const FP = 'F'.repeat(43)
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-mcp-remote-'))
  const reg = await controllerRegistry(dir)
  await reg.add({ runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, fingerprint: FP, permission: 'full-control', createdAt: 'x', lastSeenAt: null }, 'tok-a')
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

const recording = (answers: Record<string, { status: number; body: unknown }> = {}) => {
  const calls: Array<{ cmd: string; args: Record<string, unknown>; request?: string }> = []
  const link: HostLink = {
    call: async (cmd, args, request) => {
      calls.push({ cmd, args, ...(request !== undefined ? { request } : {}) })
      return answers[cmd] ?? { status: 200, body: {} }
    },
    close: () => {}
  }
  return { link, calls }
}

async function connected(local: HostLink, runtimes: McpRuntimes) {
  const server = createMcpServer({ link: local, version: '1.4.8', log: () => {}, runtimes })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0].text

describe('mcpAccessForRemote (DC-4)', () => {
  it('keeps the three values and the default for an absent one, and reads anything else as off', () => {
    expect(mcpAccessForRemote('read')).toBe('read')
    expect(mcpAccessForRemote('control')).toBe('control')
    expect(mcpAccessForRemote('off')).toBe('off')
    expect(mcpAccessForRemote(undefined)).toBe('control')
    expect(mcpAccessForRemote('everything')).toBe('off')
  })
})

describe('MCP tools with runtimeId (remote runtime design §2.8, X1-07)', () => {
  const runtimes = (remote: HostLink, refusal: string | null = null): McpRuntimes & { opened: string[] } => {
    const opened: string[] = []
    return {
      opened,
      list: async () => (await controllerRegistry(dir)).list(),
      refusal: async () => refusal,
      linkFor: async (key) => {
        opened.push(key)
        return remote
      },
      close: () => {}
    }
  }

  it('create_job with runtimeId reads the project and creates the Job on that Runtime only', async () => {
    const local = recording()
    const remote = recording({
      'projects-get': { status: 200, body: { id: 'p1', name: 'R', path: '/srv/repo', addedAt: 'x' } },
      'jobs-create': { status: 200, body: { id: 'job_1', objective: 'o' } }
    })
    const rts = runtimes(remote.link)
    const client = await connected(local.link, rts)
    const r = await client.callTool({ name: 'create_job', arguments: { runtimeId: 'rt_a', projectId: 'p1', objective: 'o', coordinatorAccountId: 'acc_1' } })
    expect(r.isError).not.toBe(true)
    expect(local.calls).toEqual([])
    expect(remote.calls.map((c) => c.cmd)).toEqual(['projects-get', 'jobs-create'])
    expect(remote.calls[1].args).toMatchObject({ cwd: '/srv/repo' })
    expect(rts.opened).toEqual(['rt_a'])
  })

  it("the laptop's own MCP settings refuse first, before any link is opened", async () => {
    const remote = recording()
    const rts = runtimes(remote.link, 'MCP access is read only in this machine’s Astera settings')
    const client = await connected(recording().link, rts)
    const r = await client.callTool({ name: 'run_job', arguments: { runtimeId: 'rt_a', jobId: 'job_1' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/PERMISSION_DENIED/)
    expect(rts.opened).toEqual([])
    expect(remote.calls).toEqual([])
  })

  it('a tool with no remote form refuses runtimeId with RUNTIME_CAPABILITY_MISSING', async () => {
    const rts = runtimes(recording().link)
    const client = await connected(recording().link, rts)
    for (const name of ['list_work_records', 'get_work_record']) {
      const r = await client.callTool({ name, arguments: { runtimeId: 'rt_a', projectId: 'p1', ...(name === 'get_work_record' ? { recordId: 'r1' } : {}) } })
      expect(r.isError, name).toBe(true)
      expect(textOf(r), name).toMatch(/RUNTIME_CAPABILITY_MISSING/)
    }
    expect(rts.opened).toEqual([])
  })

  // Phase 4 review M2: the two Runtime tools are reads, under this machine's MCP access like any other.
  it('list_runtimes and get_runtime are refused when this machine refuses reads', async () => {
    const client = await connected(recording().link, runtimes(recording().link, 'MCP access is off in this machine’s Astera settings'))
    for (const [name, args] of [['list_runtimes', {}], ['get_runtime', { runtimeId: 'rt_a' }]] as const) {
      const r = await client.callTool({ name, arguments: args })
      expect(r.isError, name).toBe(true)
      expect(textOf(r), name).toMatch(/PERMISSION_DENIED/)
    }
  })

  // Phase 4 review M3: a server with no paired Runtimes behind it (the HTTP entrance) does not offer the Runtime tools.
  it('a server given no Runtimes lists no Runtime tools, and refuses runtimeId', async () => {
    const server = createMcpServer({ link: recording().link, version: '1.4.8', log: () => {} })
    const [x, y] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0' })
    await Promise.all([server.connect(x), client.connect(y)])
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('list_runtimes')
    expect(names).not.toContain('get_runtime')
    expect(names).toHaveLength(40)
    const r = await client.callTool({ name: 'list_jobs', arguments: { runtimeId: 'rt_a' } })
    expect(textOf(r)).toMatch(/RUNTIME_CAPABILITY_MISSING/)
  })

  // Remote governance design §7.4: the HTTP entrance has no session to ask about, so it reaches no Runtime at all, and
  // the case above is what it serves.
  it('the HTTP entrance reaches no Runtime at all', async () => {
    const source = await fs.readFile(path.join(__dirname, 'http.ts'), 'utf8')
    const made = source.match(/createMcpServer\(\{[^}]*\}\)/g) ?? []
    expect(made).toHaveLength(1)
    expect(made[0]).not.toMatch(/runtimes/)
  })

  it('list_runtimes lists the paired Runtimes without tokens; get_runtime finds one by name, or says NOT_FOUND', async () => {
    const client = await connected(recording().link, runtimes(recording().link))
    const listed = await client.callTool({ name: 'list_runtimes', arguments: {} })
    expect(textOf(listed)).toContain('rt_a')
    expect(textOf(listed)).not.toContain('tok-a')
    const one = await client.callTool({ name: 'get_runtime', arguments: { runtimeId: 'office' } })
    expect(textOf(one)).toContain('rt_a')
    const none = await client.callTool({ name: 'get_runtime', arguments: { runtimeId: 'nope' } })
    expect(none.isError).toBe(true)
    expect(textOf(none)).toMatch(/RUNTIME_NOT_FOUND/)
  })

  // Remote governance design §10.3: the kept facts, never the report or this computer's expected list.
  it('list_runtimes and get_runtime carry the kept Astera version and platform, and no snapshot or expected list', async () => {
    const reg = await controllerRegistry(dir)
    await reg.touch('rt_a', '2026-11-01T10:00:00.000Z')
    await reg.noteFacts('rt_a', { asteraVersion: '1.5.0', platform: 'darwin', hostProtocol: 4, capabilities: ['control-plane.report'], readAt: '2026-11-01T09:00:00.000Z' })
    await reg.keepSnapshot('rt_a', {
      readAt: '2026-11-01T09:00:00.000Z',
      report: {
        version: 1,
        astera: { version: '1.5.0', platform: 'darwin' },
        extensions: [],
        profiles: [],
        appBypass: false,
        policy: null,
        sandbox: { claude: { kind: 'sandbox', blocker: null }, codex: { kind: 'deny-only', blocker: null } },
        credentials: null,
        secretStore: { kind: 'owner-only-files', ok: true },
        findings: null
      }
    })
    await reg.setExpected('rt_a', ['skill:review'])
    expect((await reg.list())[0]).toMatchObject({ snapshot: { readAt: '2026-11-01T09:00:00.000Z' }, expected: ['skill:review'] })
    const client = await connected(recording().link, runtimes(recording().link))
    const listed = (await client.callTool({ name: 'list_runtimes', arguments: {} })).structuredContent as { runtimes: Array<Record<string, unknown>> }
    const one = (await client.callTool({ name: 'get_runtime', arguments: { runtimeId: 'rt_a' } })).structuredContent as Record<string, unknown>
    for (const r of [listed.runtimes[0], one]) {
      expect(r).toMatchObject({ runtimeId: 'rt_a', asteraVersion: '1.5.0', platform: 'darwin', lastSeenAt: '2026-11-01T10:00:00.000Z' })
      expect(r).not.toHaveProperty('snapshot')
      expect(r).not.toHaveProperty('expected')
      expect(r).not.toHaveProperty('facts')
    }
  })

  it('a Runtime with no kept facts yet answers without asteraVersion or platform', async () => {
    const client = await connected(recording().link, runtimes(recording().link))
    const one = (await client.callTool({ name: 'get_runtime', arguments: { runtimeId: 'rt_a' } })).structuredContent as Record<string, unknown>
    expect(one).toMatchObject({ runtimeId: 'rt_a', lastSeenAt: null })
    expect(one).not.toHaveProperty('asteraVersion')
    expect(one).not.toHaveProperty('platform')
  })
})

describe('openMcpRuntimes', () => {
  const write = (o: Record<string, unknown>) => fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify(o))
  const opened: RemoteTarget[] = []
  const fakeLink = (): RemoteLink => ({ hello: () => null, call: async () => ({ status: 200, body: [] }), subscribe: () => () => {}, close: () => {} })
  const rts = () => openMcpRuntimes({ profileDir: dir, version: '1.4.8', client: () => undefined, open: (t) => (opened.push(t), fakeLink()) })

  it('refuses by the laptop settings: read only refuses a change, an unknown value refuses a read (DC-4), none refuses nothing', async () => {
    await write({ mcpAccess: 'read' })
    expect(await rts().refusal('jobs-run')).toMatch(/./)
    expect(await rts().refusal('jobs-list')).toBeNull()
    await write({ mcpAccess: 'whatever' })
    expect(await rts().refusal('jobs-list')).toMatch(/./)
    await fs.rm(path.join(dir, 'app-settings.json'))
    expect(await rts().refusal('jobs-run')).toBeNull()
  })

  it('opens one link per Runtime, by id or name, and says RUNTIME_NOT_FOUND for none', async () => {
    opened.length = 0
    const r = rts()
    await r.linkFor('rt_a')
    await r.linkFor('Office')
    expect(opened).toEqual([{ runtimeId: 'rt_a', address: '10.0.0.2', port: 47831, fingerprint: FP, token: 'tok-a' }])
    expect(await r.linkFor('nope')).toMatchObject({ code: 'RUNTIME_NOT_FOUND' })
  })

  // Ruling RF-2: the Runtime shows "MCP · Astera {version}", so the version is this Astera's, not the MCP client's
  it('signs in with this Astera\'s version and the MCP client\'s name', async () => {
    const clients: unknown[] = []
    const r = openMcpRuntimes({
      profileDir: dir,
      version: '1.5.0',
      client: () => ({ name: 'claude-code', version: '2.1.288' }),
      open: (_t, o) => (clients.push(o.client), fakeLink())
    })
    await r.linkFor('rt_a')
    expect(clients).toEqual([{ name: 'claude-code', version: '1.5.0', surface: 'mcp' }])
  })

  // Second pass RR-9: each remote tool call opened the registry again (a locked sweep and ACL checks on Windows) and read
  // the token. While the registry file is as it was, the kept link answers without either, as the app does.
  it('a call while the registry is unchanged reads neither the registry nor the token again', async () => {
    opened.length = 0
    const r = rts()
    await r.linkFor('rt_a')
    await fs.writeFile(path.join(dir, 'runtimes', 'rt_a.token'), 'tok-z')
    await r.linkFor('rt_a')
    expect(opened.map((t) => t.token)).toEqual(['tok-a'])
  })

  // Final review I6: a re-pair (new token or key for the same Runtime) reaches a running MCP server at its next call.
  it('opens a new link when the Runtime was paired again', async () => {
    opened.length = 0
    const r = rts()
    await r.linkFor('rt_a')
    const reg = await controllerRegistry(dir)
    await reg.add({ runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, fingerprint: 'G'.repeat(43), permission: 'full-control', createdAt: 'y', lastSeenAt: null }, 'tok-b', { replace: true })
    await r.linkFor('rt_a')
    expect(opened.map((t) => t.token)).toEqual(['tok-a', 'tok-b'])
    expect(opened[1].fingerprint).toBe('G'.repeat(43))
  })

  // Remote governance design §7.4: a sandboxed session only reads a Runtime, whatever this machine's MCP access says.
  it("a sandboxed session's MCP server refuses create_job with runtimeId and still lists jobs there", async () => {
    await write({ mcpAccess: 'control' })
    const seen: string[] = []
    const r = openMcpRuntimes({
      profileDir: dir,
      version: '1.4.8',
      client: () => undefined,
      sandboxed: async () => true,
      open: () => ({ hello: () => null, call: async (cmd) => (seen.push(cmd), { status: 200, body: [] }), subscribe: () => () => {}, close: () => {} })
    })
    expect(await r.refusal('jobs-create')).toBe('a sandboxed session can only read another computer: jobs create changes work there, so it was not sent (if this shell is not an agent session, unset ASTERA_SESSION)')
    const client = await connected(recording().link, r)
    const refused = await client.callTool({ name: 'create_job', arguments: { runtimeId: 'rt_a', projectId: 'p1', objective: 'o', coordinatorAccountId: 'acc_1' } })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/PERMISSION_DENIED/)
    expect(textOf(refused)).toContain('a sandboxed session can only read another computer')
    expect(seen).toEqual([])
    const listed = await client.callTool({ name: 'list_jobs', arguments: { runtimeId: 'rt_a' } })
    expect(listed.isError).not.toBe(true)
    expect(seen).toEqual(['jobs-list'])
    // One that is not sandboxed is not refused by it
    const open = openMcpRuntimes({ profileDir: dir, version: '1.4.8', client: () => undefined, sandboxed: async () => false, open: () => fakeLink() })
    expect(await open.refusal('jobs-create')).toBeNull()
  })

  // Ruling R13-4: an MCP client that does not pass the session's ASTERA_SESSION or ASTERA_GATEWAY_TOKEN to the server.
  // An MCP server is always an agent's, so a missing session is an unknown sandbox: changes refused.
  it('an env with no ASTERA_* at all refuses an MCP remote write without asking the Host, and still allows a read', async () => {
    await write({ mcpAccess: 'control' })
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/u' }
    let asked = 0
    const seen: string[] = []
    const r = openMcpRuntimes({
      profileDir: dir,
      version: '1.4.8',
      client: () => undefined,
      noSession: !inAgentSession(env),
      sandboxed: async () => (asked++, false),
      open: () => ({ hello: () => null, call: async (cmd) => (seen.push(cmd), { status: 200, body: [] }), subscribe: () => () => {}, close: () => {} })
    })
    expect(await r.refusal('jobs-create')).toBe(
      "this MCP client did not pass its Astera session, so Astera treats it as sandboxed and did not send jobs create; use `astera --runtime <id|name> jobs create` from the session's shell"
    )
    const client = await connected(recording().link, r)
    const refused = await client.callTool({ name: 'run_job', arguments: { runtimeId: 'rt_a', jobId: 'job_1' } })
    expect(textOf(refused)).toMatch(/PERMISSION_DENIED/)
    expect(textOf(refused)).toContain('did not pass its Astera session')
    const listed = await client.callTool({ name: 'list_jobs', arguments: { runtimeId: 'rt_a' } })
    expect(listed.isError).not.toBe(true)
    expect(seen).toEqual(['jobs-list'])
    expect(asked).toBe(0)
  })

  it('with ASTERA_SESSION present, the Host is asked as before', async () => {
    await write({ mcpAccess: 'control' })
    for (const env of [{ ASTERA_SESSION: 'ses_1' }, { ASTERA_GATEWAY_TOKEN: 'tok' }] as NodeJS.ProcessEnv[]) {
      let asked = 0
      const r = openMcpRuntimes({ profileDir: dir, version: '1.4.8', client: () => undefined, noSession: !inAgentSession(env), sandboxed: async () => (asked++, false), open: () => fakeLink() })
      expect(await r.refusal('jobs-create')).toBeNull()
      expect(asked).toBe(1)
    }
  })

  // Ruling R13-2: only the Host's own answer is kept. A failed ask refuses that call and the next change asks again.
  it('a Host down at the first write refuses it; up at the second, an unsandboxed session is let through and that is remembered', async () => {
    await write({ mcpAccess: 'control' })
    let up = false
    let connects = 0
    const connect = (async () => {
      connects++
      if (!up) return { error: 'unreachable' as const }
      let listener: ((m: HostMessage) => void) | null = null
      return {
        hello: { host: 'h', pid: 1, startedAt: 'x', features: [] },
        call: (m: { call: string }) => queueMicrotask(() => listener?.({ t: 'orch-result', call: m.call, status: 200, body: { sandboxed: false } } as HostMessage)),
        onMessage: (cb: (m: HostMessage) => void) => ((listener = cb), () => (listener = null)),
        onClose: () => () => {},
        ref: () => {},
        unref: () => {},
        close: () => {}
      }
    }) as unknown as typeof connectHost
    const env = { ASTERA_SESSION: 'ses_1', ASTERA_PROFILE_DIR: dir }
    const r = openMcpRuntimes({
      profileDir: dir,
      version: '1.4.8',
      client: () => undefined,
      sandboxed: rememberedSandboxed(() => hostSaysSandboxed({ env, platform: process.platform, home: os.homedir(), version: '1.4.8', connect })),
      open: () => fakeLink()
    })
    expect(await r.refusal('jobs-create')).toMatch(/^a sandboxed session can only read another computer/)
    up = true
    expect(await r.refusal('jobs-create')).toBeNull()
    expect(await r.refusal('jobs-run')).toBeNull()
    expect(connects).toBe(2)
  })

  // Remote governance design §4.4, §9.1: what the MCP server reaches is reached, and the stale-runtime finding reads it.
  describe('last seen and facts', () => {
    afterEach(() => vi.useRealTimers())
    const hello: HelloFrame = {
      t: 'hello', runtimeId: 'rt_a', displayName: 'Office', asteraVersion: '1.5.0', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b1',
      platform: 'darwin', pathStyle: 'posix', permission: 'full-control', capabilities: ['pty.seq']
    }
    /** A link that says hello at its first call, as a real one does at its first connection. */
    const helloing = () =>
      openMcpRuntimes({
        profileDir: dir,
        version: '1.4.8',
        client: () => undefined,
        open: (_t, o) => {
          let said = false
          return {
            hello: () => (said ? hello : null),
            call: async () => {
              if (!said) {
                said = true
                o?.onHello?.(hello)
              }
              return { status: 200, body: [] }
            },
            subscribe: () => () => {},
            close: () => {}
          }
        }
      })
    const profile = async () => (await (await controllerRegistry(dir)).list())[0]

    it('a call answered through a Runtime\'s link saves lastSeenAt, at most once a minute', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'))
      const r = helloing()
      const first = await r.linkFor('rt_a')
      if ('code' in first) throw new Error(first.code)
      await first.call('jobs-list', {})
      expect((await profile()).lastSeenAt).toBe('2026-11-01T10:00:00.000Z')
      vi.setSystemTime(new Date('2026-11-01T10:00:10.000Z'))
      const again = await r.linkFor('rt_a')
      if ('code' in again) throw new Error(again.code)
      await again.call('jobs-list', {})
      expect((await profile()).lastSeenAt).toBe('2026-11-01T10:00:00.000Z')
    })

    it("the link's hello is kept as the Runtime's facts", async () => {
      const r = helloing()
      const l = await r.linkFor('rt_a')
      if ('code' in l) throw new Error(l.code)
      await l.call('jobs-list', {})
      await vi.waitFor(async () => expect((await profile()).facts).toMatchObject({ asteraVersion: '1.5.0', platform: 'darwin', hostProtocol: 4, capabilities: ['pty.seq'] }), { timeout: 10_000 })
    })
  })
})

describe('remoteHostLink', () => {
  it('a change is sent with a request id, minted when the tool gave none; a read with none', async () => {
    const seen: Array<{ cmd: string; request?: string }> = []
    const link = remoteHostLink({ hello: () => null, call: async (cmd, _a, o) => (seen.push({ cmd, ...(o?.request ? { request: o.request } : {}) }), { status: 200, body: {} }), subscribe: () => () => {}, close: () => {} })
    await link.call('jobs-run', { id: 'j' })
    await link.call('jobs-run', { id: 'j' }, 'mine')
    await link.call('jobs-list', {})
    expect(seen[0].request).toMatch(/./)
    expect(seen[1].request).toBe('mine')
    expect(seen[2].request).toBeUndefined()
  })
  it('a link failure is its §3.10 code', async () => {
    const link = remoteHostLink({ hello: () => null, call: async () => new RemoteError('RUNTIME_OUTCOME_UNKNOWN', 'lost'), subscribe: () => () => {}, close: () => {} })
    expect(await link.call('jobs-run', { id: 'j' })).toMatchObject({ code: 'RUNTIME_OUTCOME_UNKNOWN' })
  })
})
