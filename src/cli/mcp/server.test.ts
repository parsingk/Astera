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
  'get_completion', 'create_task', 'list_run_configs',
  'list_sessions', 'get_session', 'send_message', 'create_session', 'get_check_output', 'get_task_output'
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
  it('lists exactly the twenty-four tools', async () => {
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

  it('get_completion redacts a secret in lastFailure', async () => {
    const token = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
    const body = {
      runId: 'run_1',
      jobId: 'job_1',
      state: 'converged',
      tasks: [{ taskId: 't1', title: 'x', state: 'converged', attempt: 1, maxAttempts: 3, detail: null, failureSummary: null, lastFailure: `build failed (exit 2): key ${token}` }]
    }
    const r = await (await connected(answering({ 'runs-completion': { status: 200, body } }).link)).callTool({
      name: 'get_completion',
      arguments: { runId: 'run_1' }
    })
    const last = String((r.structuredContent as { tasks: Array<{ lastFailure: string }> }).tasks[0].lastFailure)
    expect(last).not.toContain(token)
    expect(last).toContain('build failed (exit 2): key ')
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

  // Flow B (brief P2): an external agent lays the Tasks out itself. The Host's tasks-add reads the
  // CLI parser's shapes: `--deps` arrives as a JSON array (cliArgs.ts JSON_ARRAY), `--validate` and
  // `--account` as comma lists, `--review` as true.
  it('create_task sends tasks-add with the keys the handler reads', async () => {
    const { link, calls } = answering({ 'tasks-add': { status: 200, body: { id: 'tsk_2', spec: 's', status: 'pending' } } })
    const client = await connected(link)
    const r = await client.callTool({
      name: 'create_task',
      arguments: {
        runId: 'run_1',
        spec: 's',
        title: 't',
        deps: ['tsk_1'],
        accountId: 'acc_1',
        validate: ['test', 'lint'],
        review: true,
        requestId: 'rq-t'
      }
    })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    expect(calls).toEqual([
      {
        cmd: 'tasks-add',
        args: { run: 'run_1', spec: 's', title: 't', deps: ['tsk_1'], account: 'acc_1', validate: 'test,lint', review: true },
        request: 'rq-t'
      }
    ])
    expect(r.structuredContent).toMatchObject({ id: 'tsk_2' })
    await client.callTool({ name: 'create_task', arguments: { jobId: 'job_1', spec: 's', accountId: 'acc_1' } })
    expect(calls.at(-1)?.args).toEqual({ job: 'job_1', spec: 's', account: 'acc_1' })
  })

  it("create_task without an accountId uses the Job's coordinator account", async () => {
    const { link, calls } = answering({ 'jobs-get': { status: 200, body: { id: 'job_1', coordinatorAccountId: 'coord_1' } } })
    const client = await connected(link)
    const r = await client.callTool({ name: 'create_task', arguments: { runId: 'run_1', spec: 's' } })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ['jobs-get', { id: 'run_1' }],
      ['tasks-add', { run: 'run_1', spec: 's', account: 'coord_1' }]
    ])
  })

  it('create_task without an accountId on a Job with no coordinator account is INVALID_ARGUMENTS', async () => {
    const { link, calls } = answering({ 'jobs-get': { status: 200, body: { id: 'job_1' } } })
    const r = await (await connected(link)).callTool({ name: 'create_task', arguments: { jobId: 'job_1', spec: 's' } })
    expect(r.isError).toBe(true)
    expect(errorOf(r)).toMatchObject({ code: 'INVALID_ARGUMENTS', message: expect.stringContaining('accountId') })
    expect(calls.map((c) => c.cmd)).toEqual(['jobs-get'])
  })

  it('create_task takes exactly one of jobId or runId, and a spec within 50 000 characters, before calling the Host', async () => {
    const { link, calls } = answering({})
    const client = await connected(link)
    for (const input of [
      { spec: 's', accountId: 'a' },
      { jobId: 'job_1', runId: 'run_1', spec: 's', accountId: 'a' },
      { runId: 'run_1', spec: 'x'.repeat(50_001), accountId: 'a' },
      { runId: 'run_1', spec: 's', title: 't'.repeat(201), accountId: 'a' },
      { runId: 'run_1', spec: '', accountId: 'a' }
    ]) {
      const r = await client.callTool({ name: 'create_task', arguments: input })
      expect(r.isError, JSON.stringify(input).slice(0, 80)).toBe(true)
    }
    expect(calls).toEqual([])
    const r = await client.callTool({ name: 'create_task', arguments: { runId: 'run_1', spec: 'x'.repeat(50_000), accountId: 'a' } })
    expect(r.isError).toBeFalsy()
  })

  it('list_run_configs sends run-configs-list for the Job and passes only id, name and type', async () => {
    const configs = [{ id: 'test', name: 'test', type: 'npm', command: 'node test.js', env: { SECRET: 'x' } }]
    const { link, calls } = answering({ 'run-configs-list': { status: 200, body: configs } })
    const r = await (await connected(link)).callTool({ name: 'list_run_configs', arguments: { jobId: 'job_1' } })
    expect(calls.at(-1)).toEqual({ cmd: 'run-configs-list', args: { job: 'job_1' }, request: undefined })
    expect(r.structuredContent).toEqual({ runConfigs: [{ id: 'test', name: 'test', type: 'npm' }] })
  })

  it('marks create_task as a change and list_run_configs as a read', async () => {
    const { tools } = await (await connected(answering({}).link)).listTools()
    expect(tools.find((t) => t.name === 'create_task')?.annotations?.readOnlyHint).toBe(false)
    expect(tools.find((t) => t.name === 'list_run_configs')?.annotations?.readOnlyHint).toBe(true)
  })

  it('stop_run and resume_run say the coordinator is stopped and brought back', async () => {
    const { tools } = await (await connected(answering({}).link)).listTools()
    expect(tools.find((t) => t.name === 'stop_run')?.description).toMatch(/coordinator is asked to stop/)
    expect(tools.find((t) => t.name === 'resume_run')?.description).toMatch(/new coordinator/)
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

describe('the session and output tools (MCP P1)', () => {
  const SK = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
  const BEARER = 'abcDEF123ghiJKL456mnoPQR789'
  const PROJECT = { 'projects-get': { status: 200, body: { id: 'p1', name: 'Astera', path: 'D:/repo', addedAt: 'x' } } }
  const ACCOUNTS = {
    'accounts-list': {
      status: 200,
      body: [
        { id: 'acc_c1', label: 'c1', provider: 'claude' },
        { id: 'acc_c2', label: 'c2', provider: 'claude', default: true },
        { id: 'acc_x1', label: 'x1', provider: 'codex', default: true }
      ]
    }
  }

  it('marks the four reads read-only and the two writes not', async () => {
    const { tools } = await (await connected(answering({}).link)).listTools()
    for (const name of ['list_sessions', 'get_session', 'get_check_output', 'get_task_output'])
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, name).toBe(true)
    for (const name of ['send_message', 'create_session'])
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, name).toBe(false)
  })

  it('says in each description what it needs, and how send_message and get_task_output behave', async () => {
    const { tools } = await (await connected(answering({}).link)).listTools()
    const d = (name: string): string => String(tools.find((t) => t.name === name)?.description)
    for (const name of ['list_sessions', 'get_session', 'send_message', 'create_session'])
      expect(d(name), name).toContain('Let MCP clients see and use sessions')
    for (const name of ['list_sessions', 'get_session', 'get_check_output', 'get_task_output']) expect(d(name), name).toContain('Read only')
    for (const name of ['send_message', 'create_session']) expect(d(name), name).toContain('Read and control')
    expect(d('send_message')).toMatch(/returns as soon as the text is accepted/)
    expect(d('send_message')).toContain('get_session')
    expect(d('get_task_output')).toMatch(/only while the process that started the worker runs/)
    expect(d('get_session')).toMatch(/at most 40000 characters.*truncated: true/)
    const lines = tools.find((t) => t.name === 'get_session')?.inputSchema.properties?.lines as { description?: string }
    expect(lines.description).toMatch(/scrollback.*the visible screen rows always come on top/)
  })

  it('sends each tool as its Host command with the keys its handler reads', async () => {
    const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['list_sessions', {}, 'sessions-list', {}],
      ['list_sessions', { status: 'waiting', provider: 'codex' }, 'sessions-list', { status: 'waiting', provider: 'codex' }],
      ['get_session', { sessionId: 's1', lines: 30 }, 'sessions-read', { id: 's1', lines: 30 }],
      ['get_session', { sessionId: 's1', turns: 5 }, 'sessions-read', { id: 's1', turns: 5 }],
      ['send_message', { sessionId: 's1', text: 'hello' }, 'sessions-send', { id: 's1', text: 'hello' }],
      ['get_check_output', { taskId: 't1' }, 'tasks-check-output', { id: 't1' }],
      // offset and limit page the redacted log in the server, never the Host's raw one.
      ['get_check_output', { taskId: 't1', check: 'test', offset: 10, limit: 20 }, 'tasks-check-output', { id: 't1', check: 'test' }],
      ['get_task_output', { taskId: 't1' }, 'tasks-output', { id: 't1' }],
      ['get_task_output', { taskId: 't1', skipLines: 200, lines: 50 }, 'tasks-output', { id: 't1', skipLines: 200, lines: 50 }]
    ]
    const { link, calls } = answering({})
    const client = await connected(link)
    for (const [name, input, cmd, args] of cases) {
      const r = await client.callTool({ name, arguments: input })
      expect(r.isError, `${name} ${JSON.stringify(r.content)}`).toBeFalsy()
      expect(calls.at(-1), name).toEqual({ cmd, args, request: undefined })
    }
  })

  it('list_sessions with a projectId filters by the project folder', async () => {
    const { link, calls } = answering(PROJECT)
    await (await connected(link)).callTool({ name: 'list_sessions', arguments: { projectId: 'p1' } })
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ['projects-get', { id: 'p1' }],
      ['sessions-list', { project: 'D:/repo' }]
    ])
  })

  it('list_sessions lists live sessions first and pages like every list tool', async () => {
    const rows = [1, 2, 3].map((i) => ({ id: `s${i}`, kind: 'terminal', title: 't', accountId: 'a', cwd: 'D:/repo', alive: i !== 1, state: 'unknown' }))
    const client = await connected(answering({ 'sessions-list': { status: 200, body: rows } }).link)
    const r = await client.callTool({ name: 'list_sessions', arguments: { limit: 2 } })
    const data = r.structuredContent as { sessions: Array<{ id: string }>; truncated?: boolean; nextCursor?: string }
    expect(data.sessions.map((s) => s.id)).toEqual(['s2', 's3'])
    expect(data).toMatchObject({ truncated: true, total: 3 })
    const next = await client.callTool({ name: 'list_sessions', arguments: { limit: 2, cursor: data.nextCursor } })
    expect((next.structuredContent as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual(['s1'])
  })

  // The Host refuses `--lines` for a chat session and defaults a terminal to 200 rows; MCP's terminal
  // default is 100, so with neither bound given the session's kind is read first.
  it('get_session with no bound reads a terminal session at 100 rows and a chat at the Host default', async () => {
    const sessions = [
      { id: 's1', kind: 'terminal', alive: true },
      { id: 's2', kind: 'chat', alive: true }
    ]
    const { link, calls } = answering({ 'sessions-list': { status: 200, body: sessions } })
    const client = await connected(link)
    await client.callTool({ name: 'get_session', arguments: { sessionId: 's1' } })
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ['sessions-list', {}],
      ['sessions-read', { id: 's1', lines: 100 }]
    ])
    calls.length = 0
    await client.callTool({ name: 'get_session', arguments: { sessionId: 's2' } })
    expect(calls.at(-1)?.args).toEqual({ id: 's2' })
    // An id the list does not have is the read's own NOT_FOUND.
    calls.length = 0
    await client.callTool({ name: 'get_session', arguments: { sessionId: 's9' } })
    expect(calls.at(-1)).toEqual({ cmd: 'sessions-read', args: { id: 's9' }, request: undefined })
  })

  it('bounds get_session, send_message, get_check_output and get_task_output before calling the Host', async () => {
    const { link, calls } = answering({})
    const client = await connected(link)
    for (const [name, input] of [
      ['get_session', { sessionId: 's1', lines: 0 }],
      ['get_session', { sessionId: 's1', lines: 501 }],
      ['get_session', { sessionId: 's1', turns: 0 }],
      ['get_session', { sessionId: 's1', turns: 51 }],
      ['send_message', { sessionId: 's1', text: '' }],
      ['send_message', { sessionId: 's1', text: 'x'.repeat(50_001) }],
      ['get_check_output', { taskId: 't1', limit: 0 }],
      ['get_check_output', { taskId: 't1', limit: 4001 }],
      ['get_check_output', { taskId: 't1', offset: -1 }],
      ['get_task_output', { taskId: 't1', lines: 0 }],
      ['get_task_output', { taskId: 't1', lines: 501 }],
      ['get_task_output', { taskId: 't1', skipLines: -1 }]
    ] as const) {
      const r = await client.callTool({ name, arguments: input })
      expect(r.isError, `${name} ${JSON.stringify(input).slice(0, 80)}`).toBe(true)
    }
    expect(calls).toEqual([])
    for (const [name, input] of [
      ['get_session', { sessionId: 's1', lines: 500 }],
      ['get_session', { sessionId: 's1', turns: 50 }],
      ['send_message', { sessionId: 's1', text: 'x'.repeat(50_000) }],
      ['get_check_output', { taskId: 't1', limit: 4000 }],
      ['get_task_output', { taskId: 't1', lines: 500 }]
    ] as const)
      expect((await client.callTool({ name, arguments: input })).isError, name).toBeFalsy()
  })

  it('send_message passes the requestId on and never waits or holds back Enter', async () => {
    const { link, calls } = answering({ 'sessions-send': { status: 200, body: { id: 's1', sent: true, enter: true } } })
    const r = await (await connected(link)).callTool({
      name: 'send_message',
      arguments: { sessionId: 's1', text: 'go', requestId: 'rq-s', wait: true, noEnter: true }
    })
    expect(calls).toEqual([{ cmd: 'sessions-send', args: { id: 's1', text: 'go' }, request: 'rq-s' }])
    expect(r.structuredContent).toEqual({ id: 's1', sent: true, enter: true })
  })

  it('a send refused because the session waits on a prompt comes back as CONFLICT with no structuredContent', async () => {
    const error = 's1 is waiting on a permission prompt, and text sent from an MCP client would answer it; nothing was sent.'
    const r = await (await connected(answering({ 'sessions-send': { status: 409, body: { error } } }).link)).callTool({
      name: 'send_message',
      arguments: { sessionId: 's1', text: 'yes' }
    })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toBeUndefined()
    expect(errorOf(r)).toMatchObject({ code: 'CONFLICT', message: error })
  })

  it("create_session starts in the project's folder on the provider's default account", async () => {
    const { link, calls } = answering({
      ...PROJECT,
      ...ACCOUNTS,
      'sessions-create': { status: 200, body: { id: 's9', kind: 'chat', title: 'x', accountId: 'acc_c2', cwd: 'D:/repo', alive: true, state: 'unknown' } }
    })
    const client = await connected(link)
    const r = await client.callTool({
      name: 'create_session',
      arguments: { projectId: 'p1', kind: 'chat', title: 'x', prompt: 'hi', requestId: 'rq-c' }
    })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ['projects-get', { id: 'p1' }],
      ['accounts-list', { agent: 'claude' }],
      ['sessions-create', { account: 'acc_c2', cwd: 'D:/repo', kind: 'chat', title: 'x', prompt: 'hi' }]
    ])
    expect(calls.at(-1)?.request).toBe('rq-c')
    expect(r.structuredContent).toMatchObject({ id: 's9', cwd: 'D:/repo' })
    calls.length = 0
    await client.callTool({ name: 'create_session', arguments: { projectId: 'p1', provider: 'codex' } })
    expect(calls.slice(1).map((c) => [c.cmd, c.args])).toEqual([
      ['accounts-list', { agent: 'codex' }],
      ['sessions-create', { account: 'acc_x1', cwd: 'D:/repo' }]
    ])
    // An explicit account is sent as it is; no default is looked up.
    calls.length = 0
    await client.callTool({ name: 'create_session', arguments: { projectId: 'p1', accountId: 'acc_c1', kind: 'terminal' } })
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ['projects-get', { id: 'p1' }],
      ['sessions-create', { account: 'acc_c1', cwd: 'D:/repo', kind: 'terminal' }]
    ])
  })

  it('create_session with no default account for the provider is INVALID_ARGUMENTS, and starts nothing', async () => {
    const { link, calls } = answering({ ...PROJECT, 'accounts-list': { status: 200, body: [{ id: 'acc_c1', label: 'c1', provider: 'claude' }] } })
    const r = await (await connected(link)).callTool({ name: 'create_session', arguments: { projectId: 'p1' } })
    expect(r.isError).toBe(true)
    expect(errorOf(r)).toMatchObject({ code: 'INVALID_ARGUMENTS', message: expect.stringContaining('accountId') })
    expect(calls.map((c) => c.cmd)).toEqual(['projects-get', 'accounts-list'])
  })

  it('create_session with an unknown project is NOT_FOUND, and starts nothing', async () => {
    const { link, calls } = answering({ 'projects-get': { status: 404, body: { error: 'unknown project: p9' } } })
    const r = await (await connected(link)).callTool({ name: 'create_session', arguments: { projectId: 'p9' } })
    expect(errorOf(r)).toMatchObject({ code: 'NOT_FOUND', message: 'unknown project: p9' })
    expect(calls.map((c) => c.cmd)).toEqual(['projects-get'])
  })

  it('get_session redacts a token in every text field of a terminal and a chat read', async () => {
    const leak = `key ${SK} and Bearer ${BEARER}`
    // With wrap marks, as a current Host gives them. Without them a row that follows a token is
    // redacted too, since it may be the token's wrapped end (sessionText.ts).
    const terminal = {
      id: 's1',
      kind: 'terminal',
      alive: true,
      cols: 80,
      rows: 24,
      screen: ['ok', leak],
      scrollback: [leak, 'old'],
      screenWrapped: [false, false],
      scrollbackWrapped: [false, false]
    }
    const chat = {
      id: 's2',
      kind: 'chat',
      alive: true,
      turns: [
        { role: 'user', text: leak, tools: [] },
        { role: 'assistant', text: 'fine', tools: [`Bash ${leak}`, { name: 'Read', input: leak }] }
      ],
      pending: { kind: 'approval', summary: leak }
    }
    const client = await connected(
      answering({ 'sessions-read': { status: 200, body: terminal } }).link
    )
    const t = await client.callTool({ name: 'get_session', arguments: { sessionId: 's1', lines: 10 } })
    const c = await (await connected(answering({ 'sessions-read': { status: 200, body: chat } }).link)).callTool({
      name: 'get_session',
      arguments: { sessionId: 's2', turns: 5 }
    })
    for (const r of [t, c]) {
      const text = textOf(r)
      expect(text).not.toContain(SK)
      expect(text).not.toContain(BEARER)
      expect(JSON.stringify(r.structuredContent)).not.toContain(SK)
      expect(JSON.stringify(r.structuredContent)).not.toContain(BEARER)
    }
    const td = t.structuredContent as { screen: string[]; scrollback: string[] }
    expect(td.screen[0]).toBe('ok')
    expect(td.screen[1]).toContain('key ')
    expect(td.scrollback[1]).toBe('old')
    const cd = c.structuredContent as { turns: Array<{ text: string; tools: unknown[] }>; pending: { kind: string; summary: string } }
    expect(cd.turns[1].text).toBe('fine')
    expect(cd.turns[1].tools[0]).toContain('Bash key ')
    expect(cd.pending.kind).toBe('approval')
  })

  // xterm rows are visual rows: a key printed on one line wider than the tab sits on two rows.
  it('get_session redacts a key that wraps from the scrollback onto the screen, with and without wrap marks', async () => {
    const line = `export ANTHROPIC_API_KEY=${SK}`
    const [first, second] = [line.slice(0, 40), line.slice(40)]
    for (const marks of [{ scrollbackWrapped: [false, false], screenWrapped: [true, false] }, {}]) {
      const body = { id: 's1', kind: 'terminal', alive: true, cols: 40, rows: 24, scrollback: ['$ env', first], screen: [second, '$'], ...marks }
      const r = await (await connected(answering({ 'sessions-read': { status: 200, body } }).link)).callTool({
        name: 'get_session',
        arguments: { sessionId: 's1', lines: 10 }
      })
      const d = r.structuredContent as { screen: string[]; scrollback: string[] }
      expect(d.scrollback).toHaveLength(2)
      expect(d.screen).toHaveLength(2)
      const rows = [...d.scrollback, ...d.screen]
      for (const piece of [SK.slice(3, 12), SK.slice(-10), second.slice(0, 8)]) expect(rows.join('|'), JSON.stringify(marks)).not.toContain(piece)
      expect(textOf(r)).not.toContain(SK.slice(-10))
      expect(d.scrollback[0]).toBe('$ env')
      expect(d.screen[1]).toBe('$')
    }
  })

  it('get_session pads a row the Host trimmed at the width before joining, so a key after a wrapped space is caught', async () => {
    // At 20 columns the key runs over two rows, so neither row alone holds it.
    const before = 'echo ' + 'y'.repeat(14)
    const body = { id: 's1', kind: 'terminal', alive: true, cols: 20, rows: 24, scrollback: [], screen: [before, SK.slice(0, 20), SK.slice(20)], screenWrapped: [false, true, true], scrollbackWrapped: [] }
    const r = await (await connected(answering({ 'sessions-read': { status: 200, body } }).link)).callTool({
      name: 'get_session',
      arguments: { sessionId: 's1', lines: 10 }
    })
    const d = r.structuredContent as { screen: string[] }
    expect(d.screen[0]).toBe(before)
    expect(d.screen.join('|')).not.toContain(SK.slice(3, 20))
  })

  it('get_session over 40 000 characters keeps the newest rows and says to ask for fewer', async () => {
    const scrollback = Array.from({ length: 60 }, (_, i) => `${i}`.padEnd(1000, '.'))
    const body = { id: 's1', kind: 'terminal', alive: true, cols: 1000, rows: 24, scrollback, screen: ['$ prompt'] }
    const r = await (await connected(answering({ 'sessions-read': { status: 200, body } }).link)).callTool({
      name: 'get_session',
      arguments: { sessionId: 's1', lines: 500 }
    })
    const d = r.structuredContent as { screen: string[]; scrollback: string[]; truncated?: boolean }
    expect(d.truncated).toBe(true)
    expect(d.screen).toEqual(['$ prompt'])
    expect(d.scrollback).toEqual(scrollback.slice(-39))
    expect(textOf(r).split('\n')[0]).toMatch(/40000 characters.*fewer lines or turns/)
    expect(JSON.parse(textOf(r).split('\n')[1])).toEqual(d)
    // Under the cap: no truncated field at all.
    const small = await (await connected(answering({ 'sessions-read': { status: 200, body: { ...body, scrollback: ['a'] } } }).link)).callTool({
      name: 'get_session',
      arguments: { sessionId: 's1', lines: 5 }
    })
    expect('truncated' in (small.structuredContent as object)).toBe(false)
  })

  it('get_check_output and get_task_output redact their text', async () => {
    const leak = `token: ${SK} Bearer ${BEARER}`
    const client = await connected(
      answering({
        'tasks-check-output': { status: 200, body: { taskId: 't1', check: 'test', total: 99, offset: 0, text: `fail\n${leak}` } },
        'tasks-output': {
          status: 200,
          // A line after a token is redacted too when it starts with token characters, since the pair
          // check reads it as the token's wrapped end: '- c' starts with neither.
          body: { taskId: 't1', dispatchId: 'd1', recorded: true, totalLines: 3, more: false, lines: ['a', leak, '- c'] }
        }
      }).link
    )
    const check = await client.callTool({ name: 'get_check_output', arguments: { taskId: 't1' } })
    const out = await client.callTool({ name: 'get_task_output', arguments: { taskId: 't1' } })
    for (const r of [check, out]) {
      expect(textOf(r)).not.toContain(SK)
      expect(textOf(r)).not.toContain(BEARER)
    }
    const checkText = (check.structuredContent as { text: string }).text
    expect(check.structuredContent).toMatchObject({ taskId: 't1', check: 'test', total: checkText.length, offset: 0 })
    expect((check.structuredContent as { text: string }).text.startsWith('fail\n')).toBe(true)
    const lines = (out.structuredContent as { lines: string[] }).lines
    expect(lines).toHaveLength(3)
    expect([lines[0], lines[2]]).toEqual(['a', '- c'])
    expect(out.structuredContent).toMatchObject({ dispatchId: 'd1', recorded: true, totalLines: 3, more: false })
  })

  it('get_task_output after a restart answers recorded: false, not an error', async () => {
    const body = { taskId: 't1', dispatchId: 'd1', recorded: false, totalLines: 0, more: false, lines: [] }
    const r = await (await connected(answering({ 'tasks-output': { status: 200, body } }).link)).callTool({
      name: 'get_task_output',
      arguments: { taskId: 't1' }
    })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toEqual(body)
  })

  it('a session tool refused by the setting carries the Host message and no structuredContent', async () => {
    const error = 'sessions-list is off: turn on "Let MCP clients see and use sessions" in Astera Settings (CLI tab).'
    const r = await (await connected(answering({ 'sessions-list': { status: 403, body: { error } } }).link)).callTool({
      name: 'list_sessions',
      arguments: {}
    })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toBeUndefined()
    expect(errorOf(r)).toMatchObject({ code: 'PERMISSION_DENIED', message: error })
  })
})

describe('the session and output tools: final review fixes', () => {
  const SK = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
  const BEARER = 'abcDEF123ghiJKL456mnoPQR789'
  const ESC = String.fromCharCode(27)
  const CR = String.fromCharCode(13)
  const LF = String.fromCharCode(10)
  const TAB = String.fromCharCode(9)

  /** A Host whose tasks-check-output slices `full` by the offset and limit it is sent, as command.ts does. */
  const checkHost = (full: string): HostLink => ({
    call: async (cmd, args) => {
      if (cmd !== 'tasks-check-output') return { status: 200, body: {} }
      const offset = typeof args.offset === 'number' ? args.offset : 0
      const limit = typeof args.limit === 'number' ? args.limit : 4000
      return { status: 200, body: { check: 'test', total: full.length, offset, text: full.slice(offset, offset + limit) } }
    },
    close: () => {}
  })

  it('get_check_output redacts the whole log before paging, so an offset inside a secret returns none of it', async () => {
    const full = `step 1\nAuthorization: Bearer ${BEARER}\ntoken=${BEARER}\nkey ${SK}\nend\n`
    const client = await connected(checkHost(full))
    for (const at of [full.indexOf(BEARER), full.indexOf(`=${BEARER}`) + 1, full.indexOf(SK) + 1, full.indexOf(SK) + 3]) {
      const r = await client.callTool({ name: 'get_check_output', arguments: { taskId: 't1', offset: at, limit: 4000 } })
      const text = (r.structuredContent as { text: string }).text
      for (const piece of [BEARER.slice(4, 14), SK.slice(5, 15)]) expect(text, `offset ${at}`).not.toContain(piece)
      expect(textOf(r)).not.toContain(BEARER.slice(4, 14))
    }
    // total and offset count the redacted log.
    const whole = await client.callTool({ name: 'get_check_output', arguments: { taskId: 't1' } })
    const w = whole.structuredContent as { text: string; total: number; offset: number }
    expect(w.total).toBe(w.text.length)
    expect(w.offset).toBe(0)
    expect(w.text).toContain('[REDACTED]')
    const page = await client.callTool({ name: 'get_check_output', arguments: { taskId: 't1', offset: 5, limit: 10 } })
    expect(page.structuredContent).toMatchObject({ total: w.total, offset: 5, text: w.text.slice(5, 15) })
  })

  it('get_session drops the leading rows that continue a line above the window, and says how many', async () => {
    // The key's head is above the window: what is returned starts on its second row.
    const tail = SK.slice(20)
    const body = {
      id: 's1', kind: 'terminal', alive: true, cols: 20, rows: 24,
      scrollback: [SK.slice(10, 20), tail, '$ ls'], screen: ['ok'],
      scrollbackWrapped: [true, true, false], screenWrapped: [false]
    }
    const r = await (await connected(answering({ 'sessions-read': { status: 200, body } }).link)).callTool({
      name: 'get_session',
      arguments: { sessionId: 's1', lines: 3 }
    })
    const d = r.structuredContent as Record<string, unknown>
    expect(d.scrollback).toEqual(['$ ls'])
    expect(d.scrollbackWrapped).toEqual([false])
    expect(d.screen).toEqual(['ok'])
    expect(d.droppedPartialRows).toBe(2)
    expect(textOf(r)).not.toContain(tail)
    expect(textOf(r).split('\n')[0]).toMatch(/2 rows/)
    // A window that starts on a line's first row keeps every row, and says nothing.
    const whole = await (await connected(answering({ 'sessions-read': { status: 200, body: { ...body, scrollbackWrapped: [false, true, false] } } }).link)).callTool({
      name: 'get_session',
      arguments: { sessionId: 's1', lines: 3 }
    })
    expect((whole.structuredContent as { scrollback: string[] }).scrollback).toHaveLength(3)
    expect('droppedPartialRows' in (whole.structuredContent as object)).toBe(false)
  })

  it('get_task_output redacts a key a worker screen split over two lines', async () => {
    const lines = ['run', `export KEY ${SK.slice(0, 20)}`, SK.slice(20), 'done']
    const body = { taskId: 't1', dispatchId: 'd1', recorded: true, totalLines: 4, more: false, lines }
    const r = await (await connected(answering({ 'tasks-output': { status: 200, body } }).link)).callTool({
      name: 'get_task_output',
      arguments: { taskId: 't1' }
    })
    const out = (r.structuredContent as { lines: string[] }).lines
    expect(out).toHaveLength(4)
    for (const piece of [SK.slice(3, 12), SK.slice(-10)]) expect(out.join('|')).not.toContain(piece)
    expect(out[0]).toBe('run')
    expect(out[3]).toBe('done')
  })

  it('send_message refuses control characters other than a line feed and a tab, before calling the Host', async () => {
    const { link, calls } = answering({ 'sessions-list': { status: 200, body: [{ id: 's1', kind: 'chat' }] } })
    const client = await connected(link)
    for (const text of [`a${ESC}[Zb`, `line${CR}more`, `stop${String.fromCharCode(3)}`, `x${String.fromCharCode(127)}`, `y${String.fromCharCode(0x9b)}Z`]) {
      const r = await client.callTool({ name: 'send_message', arguments: { sessionId: 's1', text } })
      expect(r.isError, JSON.stringify(text)).toBe(true)
      expect(errorOf(r)).toMatchObject({ code: 'INVALID_ARGUMENTS' })
      expect(String(errorOf(r).message)).toMatch(/control character.*U\+0020.*line feed.*tab/)
    }
    expect(calls.filter((c) => c.cmd === 'sessions-send')).toEqual([])
    const ok = await client.callTool({ name: 'send_message', arguments: { sessionId: 's1', text: `a${TAB}b` } })
    expect(ok.isError).toBeFalsy()
  })

  it('send_message takes a line break into a chat session only: a terminal would take it as Enter', async () => {
    const sessions = [
      { id: 's1', kind: 'terminal' },
      { id: 's2', kind: 'chat' }
    ]
    const { link, calls } = answering({ 'sessions-list': { status: 200, body: sessions } })
    const client = await connected(link)
    for (const sessionId of ['s1', 's9']) {
      const r = await client.callTool({ name: 'send_message', arguments: { sessionId, text: `one${LF}two` } })
      expect(r.isError, sessionId).toBe(true)
      expect(errorOf(r)).toMatchObject({ code: 'INVALID_ARGUMENTS' })
      expect(String(errorOf(r).message)).toMatch(/line break.*chat session/)
    }
    expect(calls.filter((c) => c.cmd === 'sessions-send')).toEqual([])
    const chat = await client.callTool({ name: 'send_message', arguments: { sessionId: 's2', text: `one${LF}two` } })
    expect(chat.isError).toBeFalsy()
    expect(calls.at(-1)).toMatchObject({ cmd: 'sessions-send', args: { id: 's2', text: `one${LF}two` } })
    // Text with no line break is sent without reading the list.
    calls.length = 0
    await client.callTool({ name: 'send_message', arguments: { sessionId: 's1', text: 'go' } })
    expect(calls.map((c) => c.cmd)).toEqual(['sessions-send'])
    const { tools } = await client.listTools()
    expect(String(tools.find((t) => t.name === 'send_message')?.description)).toMatch(/line break.*chat session/)
  })

  it('get_session, when its read of the session list is refused, names get_session and not sessions-list', async () => {
    const error = 'sessions-list is off: turn on "Let MCP clients see and use sessions" in Astera Settings (CLI tab).'
    const r = await (await connected(answering({ 'sessions-list': { status: 403, body: { error } } }).link)).callTool({
      name: 'get_session',
      arguments: { sessionId: 's1' }
    })
    expect(r.isError).toBe(true)
    const message = String(errorOf(r).message)
    expect(message).toMatch(/^get_session is off/)
    expect(message).not.toContain('sessions-list')
  })
})
