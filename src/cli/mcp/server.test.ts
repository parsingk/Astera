import { describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PassThrough } from 'node:stream'
import { createMcpServer, serveMcp } from './server'
import type { HostLink } from './hostLink'

const TOOLS = [
  'list_projects', 'get_project', 'list_accounts', 'list_jobs', 'get_job', 'create_job', 'run_job',
  'list_runs', 'get_run', 'stop_run', 'list_tasks', 'get_task', 'list_questions', 'answer_question',
  'get_completion'
]

async function connected(link: HostLink) {
  const server = createMcpServer({ link, version: '1.4.1', log: () => {} })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

const answering = (answers: Record<string, { status: number; body: unknown }>) => {
  const calls: Array<{ cmd: string; args: Record<string, unknown>; request?: string }> = []
  const link: HostLink = {
    call: async (cmd, args, request) => {
      calls.push({ cmd, args, request })
      return answers[cmd] ?? { status: 200, body: {} }
    },
    close: () => {}
  }
  return { link, calls }
}

/** Feeds JSON-RPC lines to `serveMcp` over its own streams and collects what it writes back. */
function served(link: HostLink) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const lines: string[] = []
  stdout.on('data', (c: Buffer) => lines.push(...c.toString('utf8').split('\n').filter(Boolean)))
  const done = serveMcp({
    env: { ASTERA_PROFILE_DIR: '/nonexistent-astera-mcp-test' },
    platform: process.platform,
    home: '/nonexistent',
    version: '1.4.1',
    stdin,
    stdout,
    link
  })
  const send = (m: unknown): void => void stdin.write(JSON.stringify(m) + '\n')
  return { stdin, lines, done, send }
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }
}

describe('the MCP server', () => {
  it('lists exactly the fifteen tools', async () => {
    const client = await connected(answering({}).link)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort())
  })

  it('marks the reads read-only', async () => {
    const client = await connected(answering({}).link)
    const { tools } = await client.listTools()
    for (const t of tools.filter((t) => t.name.startsWith('list_') || t.name.startsWith('get_')))
      expect(t.annotations?.readOnlyHint).toBe(true)
  })

  it('create_job reads the project and sends its path as cwd, with the coordinator and request id', async () => {
    const { link, calls } = answering({
      'projects-get': { status: 200, body: { id: 'p1', name: 'Astera', path: 'D:/repo', addedAt: 'x' } },
      'jobs-create': { status: 200, body: { id: 'job_1', objective: 'o' } }
    })
    const client = await connected(link)
    const r = await client.callTool({
      name: 'create_job',
      arguments: { projectId: 'p1', objective: 'o', coordinatorAccountId: 'acc_1', requestId: 'req-1' }
    })
    expect(calls[0]).toMatchObject({ cmd: 'projects-get', args: { id: 'p1' } })
    // `coordinatorAccount`, not `coordinator-account`: the CLI's parser camel-cases every flag
    // (cliArgs.ts `camel`), and run-create reads `args.coordinatorAccount`.
    expect(calls.at(-1)).toEqual({
      cmd: 'jobs-create',
      args: { objective: 'o', cwd: 'D:/repo', coordinatorAccount: 'acc_1' },
      request: 'req-1'
    })
    expect(r.structuredContent).toMatchObject({ id: 'job_1' })
  })

  it('create_job stops at a project the Host does not know', async () => {
    const { link, calls } = answering({ 'projects-get': { status: 404, body: { error: 'unknown project: p9' } } })
    const r = await (await connected(link)).callTool({
      name: 'create_job',
      arguments: { projectId: 'p9', objective: 'o', coordinatorAccountId: 'a' }
    })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ code: 'NOT_FOUND', message: 'unknown project: p9' })
    expect(calls.map((c) => c.cmd)).toEqual(['projects-get'])
  })

  it('create_job requires the coordinator account', async () => {
    const { link, calls } = answering({})
    const client = await connected(link)
    const r = await client.callTool({ name: 'create_job', arguments: { projectId: 'p1', objective: 'o' } })
    expect(r.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('rejects an objective over the limit before calling the Host', async () => {
    const { link, calls } = answering({})
    const client = await connected(link)
    const r = await client.callTool({
      name: 'create_job',
      arguments: { projectId: 'p1', objective: 'x'.repeat(20_001), coordinatorAccountId: 'a' }
    })
    expect(r.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('rejects an id over 200 characters and a provider outside claude and codex', async () => {
    const { link, calls } = answering({})
    const client = await connected(link)
    expect((await client.callTool({ name: 'get_run', arguments: { runId: 'r'.repeat(201) } })).isError).toBe(true)
    expect((await client.callTool({ name: 'list_accounts', arguments: { provider: 'gemini' } })).isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('list_jobs takes no projectId in P0', async () => {
    const { tools } = await (await connected(answering({}).link)).listTools()
    const props = Object.keys(tools.find((t) => t.name === 'list_jobs')?.inputSchema.properties ?? {})
    expect(props).toEqual(['status'])
  })

  it('sends each tool as its Host command with the flags its handler reads', async () => {
    const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['list_projects', {}, 'projects-list', {}],
      ['get_project', { projectId: 'p1' }, 'projects-get', { id: 'p1' }],
      ['list_accounts', {}, 'accounts-list', {}],
      ['list_accounts', { provider: 'codex' }, 'accounts-list', { agent: 'codex' }],
      ['list_jobs', {}, 'jobs-list', {}],
      ['list_jobs', { status: 'running' }, 'jobs-list', { status: 'running' }],
      ['get_job', { jobId: 'job_1' }, 'jobs-get', { id: 'job_1' }],
      ['run_job', { jobId: 'job_1' }, 'jobs-run', { id: 'job_1' }],
      ['list_runs', {}, 'runs-list', {}],
      ['list_runs', { jobId: 'job_1' }, 'runs-list', { job: 'job_1' }],
      ['get_run', { runId: 'run_1' }, 'runs-get', { id: 'run_1' }],
      ['stop_run', { runId: 'run_1' }, 'runs-stop', { id: 'run_1' }],
      ['list_tasks', { runId: 'run_1' }, 'tasks-list', { run: 'run_1' }],
      ['get_task', { taskId: 'task_1' }, 'tasks-get', { id: 'task_1' }],
      ['list_questions', {}, 'questions-list', {}],
      ['list_questions', { runId: 'run_1', status: 'open' }, 'questions-list', { run: 'run_1', status: 'open' }],
      ['answer_question', { questionId: 'gat_1', answer: 'yes' }, 'questions-answer', { id: 'gat_1', answer: 'yes' }],
      ['get_completion', { runId: 'run_1' }, 'runs-completion', { id: 'run_1' }]
    ]
    const { link, calls } = answering({})
    const client = await connected(link)
    for (const [name, input, cmd, args] of cases) {
      await client.callTool({ name, arguments: input })
      expect(calls.at(-1), name).toEqual({ cmd, args, request: undefined })
    }
  })

  it('passes a requestId on to the Host', async () => {
    const { link, calls } = answering({})
    await (await connected(link)).callTool({ name: 'run_job', arguments: { jobId: 'job_1', requestId: 'req-9' } })
    expect(calls.at(-1)).toEqual({ cmd: 'jobs-run', args: { id: 'job_1' }, request: 'req-9' })
  })

  it('maps a Host refusal to its CLI code, message and next steps', async () => {
    const client = await connected(
      answering({ 'jobs-run': { status: 409, body: { error: 'job job_1 is already running (run run_2)' } } }).link
    )
    const r = await client.callTool({ name: 'run_job', arguments: { jobId: 'job_1' } })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ code: 'CONFLICT', message: 'job job_1 is already running (run run_2)' })
    expect(Array.isArray((r.structuredContent as { nextSteps?: unknown }).nextSteps)).toBe(true)
  })

  it('maps a link failure to its code', async () => {
    const link: HostLink = { call: async () => ({ code: 'HOST_NOT_RUNNING', message: 'm' }), close: () => {} }
    const r = await (await connected(link)).callTool({ name: 'list_jobs', arguments: {} })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ code: 'HOST_NOT_RUNNING' })
  })

  it('shapes results through the public allowlist and redacts free text', async () => {
    const client = await connected(
      answering({
        'questions-list': {
          status: 200,
          body: [{ id: 'gat_1', question: 'use token sk-abcdefghijklmnopqrstuvwxyz0123456789?', internal: 1 }]
        }
      }).link
    )
    const r = await client.callTool({ name: 'list_questions', arguments: { runId: 'run_1' } })
    const q = (r.structuredContent as { questions: Array<Record<string, unknown>> }).questions[0]
    expect('internal' in q).toBe(false)
    expect(String(q.question)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('stop_run sends runs-stop', async () => {
    const { link, calls } = answering({})
    await (await connected(link)).callTool({ name: 'stop_run', arguments: { runId: 'run_1' } })
    expect(calls.at(-1)?.cmd).toBe('runs-stop')
  })

  it('writes nothing to process.stdout while serving over its own streams', async () => {
    const write = vi.spyOn(process.stdout, 'write')
    const s = served(answering({}).link)
    s.send(INITIALIZE)
    await new Promise((r) => setTimeout(r, 50))
    s.stdin.end()
    await s.done
    expect(write).not.toHaveBeenCalled()
    expect(s.lines.length).toBeGreaterThan(0)
    for (const l of s.lines) expect(JSON.parse(l)).toHaveProperty('jsonrpc', '2.0')
    write.mockRestore()
  })

  it('answers a call still in flight when stdin ends, then closes the link', async () => {
    let closed = false
    const link: HostLink = {
      call: () => new Promise((r) => setTimeout(() => r({ status: 200, body: { id: 'run_1' } }), 30)),
      close: () => void (closed = true)
    }
    const s = served(link)
    s.send(INITIALIZE)
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_run', arguments: { runId: 'run_1' } } })
    s.stdin.end()
    await s.done
    const answer = s.lines.map((l) => JSON.parse(l)).find((m) => m.id === 2)
    expect(answer?.result?.structuredContent).toMatchObject({ id: 'run_1' })
    expect(closed).toBe(true)
  })
})
