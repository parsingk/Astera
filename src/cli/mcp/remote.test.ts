import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
import { mcpAccessForRemote } from '../../core/settings/mcpAccess'

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
})

describe('openMcpRuntimes', () => {
  const write = (o: Record<string, unknown>) => fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify(o))
  const opened: RemoteTarget[] = []
  const fakeLink = (): RemoteLink => ({ hello: () => null, call: async () => ({ status: 200, body: [] }), close: () => {} })
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
})

describe('remoteHostLink', () => {
  it('a change is sent with a request id, minted when the tool gave none; a read with none', async () => {
    const seen: Array<{ cmd: string; request?: string }> = []
    const link = remoteHostLink({ hello: () => null, call: async (cmd, _a, o) => (seen.push({ cmd, ...(o?.request ? { request: o.request } : {}) }), { status: 200, body: {} }), close: () => {} })
    await link.call('jobs-run', { id: 'j' })
    await link.call('jobs-run', { id: 'j' }, 'mine')
    await link.call('jobs-list', {})
    expect(seen[0].request).toMatch(/./)
    expect(seen[1].request).toBe('mine')
    expect(seen[2].request).toBeUndefined()
  })
  it('a link failure is its §3.10 code', async () => {
    const link = remoteHostLink({ hello: () => null, call: async () => new RemoteError('RUNTIME_OUTCOME_UNKNOWN', 'lost'), close: () => {} })
    expect(await link.call('jobs-run', { id: 'j' })).toMatchObject({ code: 'RUNTIME_OUTCOME_UNKNOWN' })
  })
})
