import { describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PassThrough } from 'node:stream'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostAddress } from '../../host/address'
import { startHostServer } from '../../host/server'
import { ensureHostKey } from '../../core/host/hostKey'
import { HOST_PROTOCOL } from '../../core/host/protocol'
import { createMcpServer, serveMcp } from './server'
import type { HostLink } from './hostLink'

const TOOLS = [
  'list_projects', 'get_project', 'list_accounts', 'list_jobs', 'get_job', 'create_job', 'run_job',
  'list_runs', 'get_run', 'stop_run', 'resume_run', 'list_tasks', 'get_task', 'list_questions', 'answer_question',
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
function served(link: HostLink, drainCapMs?: number) {
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
    link,
    ...(drainCapMs === undefined ? {} : { drainCapMs })
  })
  const send = (m: unknown): void => void stdin.write(JSON.stringify(m) + '\n')
  return { stdin, lines, done, send }
}

/** The one text block a result carries: its sentence, a newline, then its structured data as JSON. */
const textOf = (r: unknown): string => {
  const content = (r as { content: Array<{ type: string; text: string }> }).content
  expect(content).toHaveLength(1)
  return content[0].text
}

/** An error result's data: the JSON after its code/message line. Errors carry no structuredContent. */
const errorOf = (r: unknown): Record<string, unknown> => JSON.parse(textOf(r).split('\n')[1])

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }
}

describe('the MCP server', () => {
  it('lists exactly the sixteen tools', async () => {
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
    expect(errorOf(r)).toMatchObject({ code: 'NOT_FOUND', message: 'unknown project: p9' })
    expect(calls.map((c) => c.cmd)).toEqual(['projects-get'])
  })

  it('create_job without an account sends coordinatorProvider, claude unless another is given', async () => {
    const { link, calls } = answering({
      'projects-get': { status: 200, body: { id: 'p1', name: 'Astera', path: 'D:/repo', addedAt: 'x' } }
    })
    const client = await connected(link)
    await client.callTool({ name: 'create_job', arguments: { projectId: 'p1', objective: 'o' } })
    expect(calls.at(-1)).toMatchObject({ cmd: 'jobs-create', args: { objective: 'o', cwd: 'D:/repo', coordinatorProvider: 'claude' } })
    await client.callTool({ name: 'create_job', arguments: { projectId: 'p1', objective: 'o', coordinatorProvider: 'codex' } })
    expect(calls.at(-1)?.args).toEqual({ objective: 'o', cwd: 'D:/repo', coordinatorProvider: 'codex' })
    // An explicit account wins, and is the only coordinator that reaches the Host.
    await client.callTool({
      name: 'create_job',
      arguments: { projectId: 'p1', objective: 'o', coordinatorAccountId: 'acc_1', coordinatorProvider: 'codex' }
    })
    expect(calls.at(-1)?.args).toEqual({ objective: 'o', cwd: 'D:/repo', coordinatorAccount: 'acc_1' })
  })

  it('create_job with convergence sends it and its knobs to jobs-create as the CLI parser would', async () => {
    const { link, calls } = answering({
      'projects-get': { status: 200, body: { id: 'p1', name: 'Astera', path: 'D:/repo', addedAt: 'x' } }
    })
    const client = await connected(link)
    const r = await client.callTool({
      name: 'create_job',
      arguments: {
        projectId: 'p1',
        objective: 'o',
        coordinatorAccountId: 'acc_1',
        convergence: true,
        maxFixAttempts: 3,
        maxReviewRounds: 2,
        blockingSeverity: 'medium',
        maxTotalMinutes: 90
      }
    })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    // `--max-fix-attempts` arrives as `maxFixAttempts` (cliArgs.ts `camel`), `--convergence` as true.
    expect(calls.at(-1)?.args).toEqual({
      objective: 'o',
      cwd: 'D:/repo',
      coordinatorAccount: 'acc_1',
      convergence: true,
      maxFixAttempts: 3,
      maxReviewRounds: 2,
      blockingSeverity: 'medium',
      maxTotalMinutes: 90
    })
    // convergence alone turns it on with the default policy; convergence: false sends nothing.
    await client.callTool({ name: 'create_job', arguments: { projectId: 'p1', objective: 'o', convergence: true } })
    expect(calls.at(-1)?.args).toEqual({ objective: 'o', cwd: 'D:/repo', coordinatorProvider: 'claude', convergence: true })
    await client.callTool({ name: 'create_job', arguments: { projectId: 'p1', objective: 'o', convergence: false } })
    expect(calls.at(-1)?.args).toEqual({ objective: 'o', cwd: 'D:/repo', coordinatorProvider: 'claude' })
  })

  it('create_job refuses a convergence knob without convergence: true as INVALID_ARGUMENTS, before calling the Host', async () => {
    const { link, calls } = answering({})
    const client = await connected(link)
    for (const extra of [{ maxFixAttempts: 3 }, { blockingSeverity: 'high' }, { convergence: false, maxTotalMinutes: 30 }]) {
      const r = await client.callTool({ name: 'create_job', arguments: { projectId: 'p1', objective: 'o', ...extra } })
      expect(r.isError).toBe(true)
      expect(errorOf(r)).toMatchObject({ code: 'INVALID_ARGUMENTS', message: expect.stringContaining('convergence: true') })
    }
    expect(calls).toEqual([])
  })

  // The same values the Host's run-create takes (command.ts posInt, an integer >= 1), so MCP and the CLI agree.
  it('create_job takes the convergence knobs the Host takes, and refuses the rest before calling it', async () => {
    const { link, calls } = answering({})
    const client = await connected(link)
    for (const knob of [
      { maxFixAttempts: 0 },
      { maxFixAttempts: 1.5 },
      { maxReviewRounds: -1 },
      { maxTotalMinutes: 0 },
      { blockingSeverity: 'low' }
    ]) {
      const r = await client.callTool({ name: 'create_job', arguments: { projectId: 'p1', objective: 'o', convergence: true, ...knob } })
      expect(r.isError, JSON.stringify(knob)).toBe(true)
    }
    expect(calls).toEqual([])
    for (const knob of [{ maxFixAttempts: 1 }, { maxFixAttempts: 50 }, { maxReviewRounds: 21 }, { maxTotalMinutes: 5000 }]) {
      const r = await client.callTool({ name: 'create_job', arguments: { projectId: 'p1', objective: 'o', convergence: true, ...knob } })
      expect(r.isError, JSON.stringify(knob)).toBeFalsy()
      expect(calls.at(-1)?.args).toMatchObject(knob)
    }
  })

  it('create_job says what convergence does', async () => {
    const { tools } = await (await connected(answering({}).link)).listTools()
    const createJob = tools.find((t) => t.name === 'create_job')!
    expect(createJob.description).toMatch(/convergence/)
    expect(Object.keys(createJob.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['convergence', 'maxFixAttempts', 'maxReviewRounds', 'blockingSeverity', 'maxTotalMinutes'])
    )
  })

  it('list_accounts marks each provider\'s default and passes no other field', async () => {
    const accounts = [
      { id: 'a1', label: 'one', provider: 'claude', default: true, configDir: 'C:/secret' },
      { id: 'a2', label: 'two', provider: 'claude' }
    ]
    const r = await (await connected(answering({ 'accounts-list': { status: 200, body: accounts } }).link)).callTool({
      name: 'list_accounts',
      arguments: {}
    })
    expect(r.structuredContent).toEqual({
      accounts: [
        { id: 'a1', label: 'one', provider: 'claude', default: true },
        { id: 'a2', label: 'two', provider: 'claude' }
      ]
    })
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

  it('list_jobs with a projectId reads the project and filters by its folder', async () => {
    const { link, calls } = answering({
      'projects-get': { status: 200, body: { id: 'p1', name: 'Astera', path: 'D:/repo', addedAt: 'x' } },
      'jobs-list': { status: 200, body: [] }
    })
    const r = await (await connected(link)).callTool({ name: 'list_jobs', arguments: { projectId: 'p1', status: 'running' } })
    expect(r.isError).toBeFalsy()
    expect(calls).toEqual([
      { cmd: 'projects-get', args: { id: 'p1' }, request: undefined },
      { cmd: 'jobs-list', args: { status: 'running', project: 'D:/repo' }, request: undefined }
    ])
  })

  it('list_jobs with an unknown projectId answers the projects-get NOT_FOUND and lists nothing', async () => {
    const { link, calls } = answering({ 'projects-get': { status: 404, body: { error: 'unknown project: p9' } } })
    const r = await (await connected(link)).callTool({ name: 'list_jobs', arguments: { projectId: 'p9' } })
    expect(r.isError).toBe(true)
    expect(errorOf(r)).toMatchObject({ code: 'NOT_FOUND', message: 'unknown project: p9' })
    expect(calls.map((c) => c.cmd)).toEqual(['projects-get'])
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
      ['resume_run', { runId: 'run_1' }, 'runs-resume', { id: 'run_1' }],
      // `brief`: the Host bounds each spec to 160 characters (command.ts tasks-list).
      ['list_tasks', { runId: 'run_1' }, 'tasks-list', { run: 'run_1', brief: true }],
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
    expect(errorOf(r)).toMatchObject({ code: 'CONFLICT', message: 'job job_1 is already running (run run_2)' })
    expect(Array.isArray(errorOf(r).nextSteps)).toBe(true)
  })

  it('a refusal naming a request in flight points at requests show and carries the id as details', async () => {
    const client = await connected(
      answering({ 'jobs-run': { status: 409, body: { error: 'request rq-1 is already running', requestId: 'rq-1' } } }).link
    )
    const r = await client.callTool({ name: 'run_job', arguments: { jobId: 'job_1', requestId: 'rq-1' } })
    const data = errorOf(r) as { nextSteps: string[]; details?: Record<string, unknown> }
    expect(data.details).toEqual({ requestId: 'rq-1' })
    expect(data.nextSteps.some((s) => s.includes('requests show') && s.includes('rq-1'))).toBe(true)
  })

  it('a refusal naming no ids carries no details', async () => {
    const client = await connected(answering({ 'runs-get': { status: 404, body: { error: 'unknown run: run_9' } } }).link)
    const r = await client.callTool({ name: 'get_run', arguments: { runId: 'run_9' } })
    expect('details' in errorOf(r)).toBe(false)
  })

  it('run_job hides the Run fields get_run hides', async () => {
    const run = {
      id: 'run_1',
      jobId: 'job_1',
      ordinal: 1,
      coordinatorStop: { at: 'T' },
      coordinatorStartingAt: 'T',
      coordinatorStopPending: true
    }
    const client = await connected(answering({ 'jobs-run': { status: 200, body: run } }).link)
    const data = (await client.callTool({ name: 'run_job', arguments: { jobId: 'job_1' } })).structuredContent as object
    expect(data).toMatchObject({ id: 'run_1', jobId: 'job_1' })
    for (const hidden of ['coordinatorStop', 'coordinatorStartingAt', 'coordinatorStopPending']) expect(hidden in data).toBe(false)
  })

  // Read only: the count and the mark say a person must answer a prompt in Astera; no tool answers it.
  it('get_run carries waitingForApproval and get_task carries it on the attempt', async () => {
    const client = await connected(
      answering({
        'runs-get': { status: 200, body: { id: 'run_1', jobId: 'job_1', waitingForApproval: 2 } },
        'tasks-get': { status: 200, body: { id: 't1', attempts: [{ id: 'd1' }, { id: 'd2', waitingForApproval: true }] } }
      }).link
    )
    const run = await client.callTool({ name: 'get_run', arguments: { runId: 'run_1' } })
    expect(run.structuredContent).toMatchObject({ id: 'run_1', waitingForApproval: 2 })
    const task = await client.callTool({ name: 'get_task', arguments: { taskId: 't1' } })
    expect((task.structuredContent as { attempts: unknown[] }).attempts).toEqual([{ id: 'd1' }, { id: 'd2', waitingForApproval: true }])
  })

  it('carries the data in content too: the sentence, a newline, then the structured data as JSON', async () => {
    const client = await connected(answering({ 'runs-get': { status: 200, body: { id: 'run_1', jobId: 'job_1' } } }).link)
    const ok = await client.callTool({ name: 'get_run', arguments: { runId: 'run_1' } })
    const [sentence, json] = textOf(ok).split('\n')
    expect(sentence).toBe('Get a Run.')
    expect(JSON.parse(json)).toEqual(ok.structuredContent)

    const failing = await connected(answering({ 'runs-get': { status: 404, body: { error: 'unknown run: run_1' } } }).link)
    const err = await failing.callTool({ name: 'get_run', arguments: { runId: 'run_1' } })
    const [line, errJson] = textOf(err).split('\n')
    expect(line).toBe('NOT_FOUND: unknown run: run_1')
    expect(JSON.parse(errJson)).toMatchObject({ code: 'NOT_FOUND', message: 'unknown run: run_1' })
    expect(Array.isArray(JSON.parse(errJson).nextSteps)).toBe(true)
    // Cursor validates structuredContent even on an error, so an error carries none (Task 12 U6).
    expect(err.structuredContent).toBeUndefined()
  })

  it('redacts free text but leaves ids and paths alone', async () => {
    const token = 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const client = await connected(
      answering({
        'jobs-get': { status: 200, body: { id: 'job_1', objective: `use ${token}`, cwd: `D:/repo/${token}` } }
      }).link
    )
    const data = (await client.callTool({ name: 'get_job', arguments: { jobId: 'job_1' } })).structuredContent as Record<
      string,
      unknown
    >
    expect(data.cwd).toBe(`D:/repo/${token}`)
    expect(String(data.objective)).not.toContain(token)
  })

  it('maps a link failure to its code', async () => {
    const link: HostLink = { call: async () => ({ code: 'HOST_NOT_RUNNING', message: 'm' }), close: () => {} }
    const r = await (await connected(link)).callTool({ name: 'list_jobs', arguments: {} })
    expect(r.isError).toBe(true)
    expect(errorOf(r)).toMatchObject({ code: 'HOST_NOT_RUNNING' })
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

  it('returns no raw check output from list_tasks or get_task, at any depth', async () => {
    const check = { configId: 'c1', name: 'test', status: 'failed', exitCode: 1, outputTail: 'raw validator log' }
    const task = { id: 't1', runId: 'run_1', title: 'x', status: 'failed', checks: [check] }
    const client = await connected(
      answering({
        'tasks-list': { status: 200, body: [task] },
        'tasks-get': { status: 200, body: { ...task, attempts: [{ id: 'd1', nested: { checks: [check] } }] } }
      }).link
    )
    const listed = await client.callTool({ name: 'list_tasks', arguments: { runId: 'run_1' } })
    const got = await client.callTool({ name: 'get_task', arguments: { taskId: 't1' } })
    for (const r of [listed, got]) {
      expect(JSON.stringify(r.structuredContent)).not.toContain('outputTail')
      expect(textOf(r)).not.toContain('raw validator log')
    }
    const t = (listed.structuredContent as { tasks: Array<{ checks: Array<Record<string, unknown>> }> }).tasks[0]
    expect(t.checks[0]).toMatchObject({ configId: 'c1', status: 'failed', exitCode: 1 })
  })

  it('redacts review issue descriptions, suggested fixes and retryOnceFailed', async () => {
    const token = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
    const client = await connected(
      answering({
        'tasks-get': {
          status: 200,
          body: {
            id: 't1',
            reviewIssues: [{ id: 'i1', title: 't', description: `leaks ${token}`, suggestedFix: `drop ${token}` }],
            retryOnceFailed: `failed with ${token}`
          }
        }
      }).link
    )
    const r = await client.callTool({ name: 'get_task', arguments: { taskId: 't1' } })
    expect(JSON.stringify(r.structuredContent)).not.toContain(token)
  })

  it('resume_run takes a requestId, hides the Run fields get_run hides, and stop_run points at it', async () => {
    const run = { id: 'run_1', jobId: 'job_1', ordinal: 1, coordinatorStop: { at: 'T' }, coordinatorStartingAt: 'T' }
    const { link, calls } = answering({ 'runs-resume': { status: 200, body: run } })
    const client = await connected(link)
    const r = await client.callTool({ name: 'resume_run', arguments: { runId: 'run_1', requestId: 'rq-2' } })
    expect(calls.at(-1)).toEqual({ cmd: 'runs-resume', args: { id: 'run_1' }, request: 'rq-2' })
    expect(r.structuredContent).toEqual({ id: 'run_1', jobId: 'job_1', ordinal: 1 })
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'stop_run')?.description).toContain('Use resume_run to continue it.')
    expect(tools.find((t) => t.name === 'resume_run')?.annotations?.readOnlyHint).toBe(false)
  })

  it('get_completion redacts a secret in a failure summary and keeps the rest of the line', async () => {
    const token = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
    const body = {
      runId: 'run_1',
      jobId: 'job_1',
      state: 'failed',
      tasks: [{ taskId: 't1', title: 'x', state: 'failed', attempt: 0, maxAttempts: null, detail: null, failureSummary: `build failed (exit 2): key ${token}` }]
    }
    const r = await (await connected(answering({ 'runs-completion': { status: 200, body } }).link)).callTool({
      name: 'get_completion',
      arguments: { runId: 'run_1' }
    })
    const summary = String((r.structuredContent as { tasks: Array<{ failureSummary: string }> }).tasks[0].failureSummary)
    expect(summary).not.toContain(token)
    expect(summary).toContain('build failed (exit 2): key ')
    expect(textOf(r)).not.toContain(token)
  })

  it('every list tool takes a limit of 1 to 200', async () => {
    const client = await connected(answering({}).link)
    const { tools } = await client.listTools()
    for (const t of tools.filter((t) => t.name.startsWith('list_')))
      expect(t.inputSchema.properties?.limit, t.name).toMatchObject({ minimum: 1, maximum: 200 })
    expect((await client.callTool({ name: 'list_jobs', arguments: { limit: 201 } })).isError).toBe(true)
    expect((await client.callTool({ name: 'list_jobs', arguments: { limit: 0 } })).isError).toBe(true)
  })

  it('list_jobs comes newest first, cut to the limit, and says it was cut', async () => {
    const jobs = [1, 2, 3].map((i) => ({ id: `job_${i}`, objective: 'o', createdAt: `2026-10-0${i}T00:00:00.000Z` }))
    const { link, calls } = answering({ 'jobs-list': { status: 200, body: jobs } })
    const client = await connected(link)
    const cut = await client.callTool({ name: 'list_jobs', arguments: { limit: 2 } })
    expect(calls.at(-1)).toEqual({ cmd: 'jobs-list', args: {}, request: undefined })
    expect(cut.structuredContent).toEqual({ jobs: [jobs[2], jobs[1]], truncated: true, total: 3, nextCursor: expect.any(String) })
    expect(textOf(cut).split('\n')[0]).toBe('List Jobs (2 of 3).')
    const whole = await client.callTool({ name: 'list_jobs', arguments: {} })
    expect(whole.structuredContent).toEqual({ jobs: [jobs[2], jobs[1], jobs[0]] })
  })

  // Spec §48: every list tool pages with an opaque cursor; the cursor never reaches the Host.
  it('every list tool takes a cursor, and a cut list pages through it in the same order', async () => {
    const jobs = [1, 2, 3, 4, 5].map((i) => ({ id: `job_${i}`, objective: 'o', createdAt: `2026-10-0${i}T00:00:00.000Z` }))
    const { link, calls } = answering({ 'jobs-list': { status: 200, body: jobs } })
    const client = await connected(link)
    const { tools } = await client.listTools()
    for (const t of tools.filter((t) => t.name.startsWith('list_'))) {
      expect(t.inputSchema.properties?.cursor, t.name).toMatchObject({ type: 'string' })
      // What an agent reads to know when to stop paging, and what truncated and total mean.
      const limitText = String((t.inputSchema.properties?.limit as { description?: string }).description)
      const cursorText = String((t.inputSchema.properties?.cursor as { description?: string }).description)
      expect(limitText, t.name).toContain('truncated: true and total mean the list is not whole')
      for (const text of [limitText, cursorText]) expect(text, t.name).toContain('No nextCursor means this is the last page')
    }
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 3; page++) {
      const r = await client.callTool({ name: 'list_jobs', arguments: { limit: 2, ...(cursor ? { cursor } : {}) } })
      const data = r.structuredContent as { jobs: Array<{ id: string }>; truncated?: boolean; total?: number; nextCursor?: string }
      seen.push(...data.jobs.map((j) => j.id))
      expect(data).toMatchObject({ truncated: true, total: 5 })
      cursor = data.nextCursor
      expect(JSON.parse(textOf(r).split('\n')[1])).toEqual(data)
    }
    expect(seen).toEqual(['job_5', 'job_4', 'job_3', 'job_2', 'job_1'])
    expect(cursor).toBeUndefined()
    for (const c of calls) expect(c.args).toEqual({})
  })

  it("refuses another tool's cursor and a malformed one as INVALID_ARGUMENTS, before calling the Host", async () => {
    const runs = [1, 2, 3].map((i) => ({ id: `run_${i}`, jobId: 'job_1', ordinal: i, createdAt: `2026-10-0${i}T00:00:00.000Z` }))
    const { link, calls } = answering({ 'runs-list': { status: 200, body: runs } })
    const client = await connected(link)
    const first = await client.callTool({ name: 'list_runs', arguments: { limit: 1 } })
    const runsCursor = (first.structuredContent as { nextCursor: string }).nextCursor
    const before = calls.length
    const foreign = await client.callTool({ name: 'list_jobs', arguments: { cursor: runsCursor } })
    expect(foreign.isError).toBe(true)
    expect(errorOf(foreign)).toMatchObject({ code: 'INVALID_ARGUMENTS', message: expect.stringContaining('list_runs') })
    const junk = await client.callTool({ name: 'list_jobs', arguments: { cursor: 'not-a-cursor' } })
    expect(errorOf(junk)).toMatchObject({ code: 'INVALID_ARGUMENTS', message: expect.stringContaining('cursor') })
    // list_jobs with a projectId reads the project first; a bad cursor stops it before that too.
    const withProject = await client.callTool({ name: 'list_jobs', arguments: { projectId: 'p1', cursor: 'not-a-cursor' } })
    expect(errorOf(withProject)).toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(calls.length).toBe(before)
  })

  it('stop_run sends runs-stop', async () => {
    const { link, calls } = answering({})
    await (await connected(link)).callTool({ name: 'stop_run', arguments: { runId: 'run_1' } })
    expect(calls.at(-1)?.cmd).toBe('runs-stop')
  })

  it('writes nothing to process.stdout while serving over its own streams', async () => {
    const write = vi.spyOn(process.stdout, 'write')
    const s = served(answering({ 'jobs-list': { status: 200, body: [{ id: 'job_1', objective: 'o' }] } }).link)
    s.send(INITIALIZE)
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_jobs', arguments: {} } })
    await new Promise((r) => setTimeout(r, 50))
    s.stdin.end()
    await s.done
    expect(write).not.toHaveBeenCalled()
    const messages = s.lines.map((l) => JSON.parse(l))
    for (const m of messages) expect(m).toHaveProperty('jsonrpc', '2.0')
    expect(messages.map((m) => m.id)).toEqual([1, 2])
    expect(messages[1].result.structuredContent).toEqual({ jobs: [{ id: 'job_1', objective: 'o' }] })
    write.mockRestore()
  })

  // MCP spec §29: the link opens at the first tool call, after initialize, so its hello can name the
  // client the initialize request named. Its own link to a real Host server whose command layer records
  // who called.
  it("names the client from initialize in the Host hello, so the Host's command layer hears it", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-mcp-client-'))
    const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
    const heard: unknown[] = []
    const host = await startHostServer({
      address: addr.address,
      dirToPrepare: addr.dirToPrepare,
      version: '9.9.9',
      idleMs: 60_000,
      onIdle: () => {},
      hostKey: await ensureHostKey(profileDir),
      log: { write: () => {}, close: () => {} },
      orch: {
        call: async (c) => {
          heard.push({ role: c.from?.role, client: c.from?.client })
          return { status: 200, body: { id: 'run_1' } }
        }
      }
    })
    try {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const lines: string[] = []
      stdout.on('data', (c: Buffer) => lines.push(...c.toString('utf8').split('\n').filter(Boolean)))
      const done = serveMcp({ env: { ASTERA_PROFILE_DIR: profileDir }, platform: process.platform, home: os.tmpdir(), version: '1.4.1', stdin, stdout })
      const send = (m: unknown): void => void stdin.write(JSON.stringify(m) + '\n')
      send({ ...INITIALIZE, params: { ...INITIALIZE.params, clientInfo: { name: 'claude-code', version: '1.2.3' } } })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_run', arguments: { runId: 'run_1' } } })
      await vi.waitFor(() => expect(lines.map((l) => JSON.parse(l)).some((m) => m.id === 2)).toBe(true), { timeout: 5000 })
      stdin.end()
      await done
      expect(heard).toEqual([{ role: 'mcp', client: { name: 'claude-code', version: '1.2.3' } }])
    } finally {
      await host.close()
      await fs.rm(profileDir, { recursive: true, force: true })
    }
  })

  it('stops waiting for a call that never answers once the drain cap passes', async () => {
    let closed = false
    const link: HostLink = { call: () => new Promise(() => {}), close: () => void (closed = true) }
    const s = served(link, 50)
    s.send(INITIALIZE)
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_run', arguments: { runId: 'run_1' } } })
    s.stdin.end()
    await s.done
    expect(closed).toBe(true)
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
