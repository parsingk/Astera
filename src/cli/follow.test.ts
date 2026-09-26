// `astera runs follow` (CLI spec §22), the client's half: a loop of `runs-follow` long polls that prints
// each timeline event once, and stops on the ending `runs wait` would have stopped on.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { followRun } from './run'
import { createHostOrch } from '../host/orch'
import { handleCommand, type OrchServerDeps } from '../core/orchestration/command'
import { emptyState, type OrchState } from '../core/orchestration/state'
import { clockOf, followLine } from '../core/orchestration/cliFollow'

const NOW = '2026-08-04T00:00:00.000Z'

const makeDeps = (): OrchServerDeps => {
  const box = { state: emptyState() as OrchState }
  return {
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 's', cwd: 'D:/p', specPath: 'D:/p/a.md' }),
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc', label: 'a', provider: 'codex' as const }],
    readWorker: async () => '',
    now: () => NOW
  } as OrchServerDeps
}

const cmd = (deps: OrchServerDeps, name: string, args: Record<string, unknown> = {}) =>
  handleCommand(deps, { sessionId: '' }, name, args)

const seeded = async (): Promise<{ deps: OrchServerDeps; runId: string; taskId: string }> => {
  const deps = makeDeps()
  await cmd(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
  const runId = deps.getState().runs[0].id
  const t = await cmd(deps, 'task-create', { run: runId, title: 't', spec: 's', account: 'acc' })
  return { deps, runId, taskId: (t.body as { id: string }).id }
}

/** The loop, talking to the command layer directly with a short window so a test takes milliseconds. */
const follow = (deps: OrchServerDeps, runId: string, mode: 'json' | 'human' | 'quiet', timeoutMs = 5_000) => {
  const lines: string[] = []
  const calls: Record<string, unknown>[] = []
  const done = followRun({
    id: runId,
    mode,
    timeoutMs,
    windowMs: 40,
    write: (l) => lines.push(l),
    call: (args) => {
      calls.push(args)
      return cmd(deps, 'runs-follow', args)
    }
  })
  return { lines, calls, done }
}

describe('followRun', () => {
  it('prints each event once, as it lands, and ends with the ending runs wait gives', async () => {
    const { deps, runId, taskId } = await seeded()
    const f = follow(deps, runId, 'human')
    setTimeout(() => void cmd(deps, 'gate-create', { task: taskId, question: 'which one?' }), 60)
    const end = await f.done
    expect(end).toEqual({ ended: expect.objectContaining({ state: 'waiting', runId }) })
    // It stopped at the open question, the way `runs wait` stops: that is an ending, exit 8.
    const kinds = f.lines.map((l) => l.replace(/^\[[^\]]*\] /, ''))
    expect(kinds).toEqual([`run created: o`, `task created: ${taskId} t`, `question opened: ${taskId}: which one?`])
    expect(f.lines[0].startsWith(`[${clockOf(deps.getState().runs[0].createdAt)}] `)).toBe(true)
  })

  it('tells the Host how many events it has, so the Host answers only when there are more', async () => {
    const { deps, runId, taskId } = await seeded()
    const f = follow(deps, runId, 'human')
    setTimeout(() => void cmd(deps, 'task-update', { id: taskId, status: 'completed' }), 120)
    await f.done
    expect(f.calls[0]).toMatchObject({ id: runId, seen: 0 })
    expect(f.calls.slice(1).every((c) => c.seen === 2)).toBe(true)
    expect(f.calls.every((c) => typeof c.waitMs === 'number' && (c.waitMs as number) <= 40)).toBe(true)
  })

  it('JSON is one envelope per line, each an event with its public fields only', async () => {
    const { deps, runId, taskId } = await seeded()
    await cmd(deps, 'task-update', { id: taskId, status: 'completed' })
    const f = follow(deps, runId, 'json')
    expect(await f.done).toEqual({ ended: expect.objectContaining({ state: 'completed' }) })
    expect(f.lines.length).toBeGreaterThanOrEqual(2)
    for (const line of f.lines) {
      expect(line).not.toContain('\n')
      const parsed = JSON.parse(line) as { ok: boolean; data: { event: Record<string, unknown> } }
      expect(parsed.ok).toBe(true)
      expect(typeof parsed.data.event.kind).toBe('string')
      expect('body' in parsed.data.event).toBe(false)
      expect('sessionId' in parsed.data.event).toBe(false)
    }
  })

  it('--quiet prints no events; the exit code is the answer', async () => {
    const { deps, runId, taskId } = await seeded()
    await cmd(deps, 'task-update', { id: taskId, status: 'completed' })
    const f = follow(deps, runId, 'quiet')
    await f.done
    expect(f.lines).toEqual([])
  })

  it('a deadline that passes first is the timeout ending, with the progress so far', async () => {
    const { deps, runId } = await seeded()
    const f = follow(deps, runId, 'human', 150)
    const end = await f.done
    expect(end).toEqual({ ended: { state: 'timeout', runId, jobId: deps.getState().runs[0].jobId, progress: { done: 0, total: 1 } } })
  })

  it('a refusal is handed back as it came', async () => {
    const { deps } = await seeded()
    const f = follow(deps, 'run_nope', 'human')
    expect(await f.done).toEqual({ refused: expect.objectContaining({ status: 404 }) })
  })

  it('a connection that drops or a Host that stops answering is handed back', async () => {
    const drop = await followRun({
      id: 'run_1',
      mode: 'json',
      timeoutMs: 1_000,
      write: () => {},
      call: async () => ({ unreachable: 'the Host closed the connection' })
    })
    expect(drop).toEqual({ unreachable: 'the Host closed the connection' })
    const stuck = await followRun({
      id: 'run_1',
      mode: 'json',
      timeoutMs: 1_000,
      write: () => {},
      call: async () => ({ stuck: 'no answer' })
    })
    expect(stuck).toEqual({ stuck: 'no answer' })
  })
})

// The same loop through the Host's own call path (host/orch.ts), the way the CLI reaches it: a
// `runs-follow` goes to the Host's command layer like any other read, and a task finished by another
// caller meanwhile ends the follow.
describe('followRun through the Host', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-follow-'))
  })
  afterEach(async () => {
    // The orchestrator's state save can still be landing after the follow ends, and a file it
    // writes into the folder mid-removal fails the rmdir with ENOTEMPTY (seen on macOS CI); rm
    // retries exactly that.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('follows a run to completed while another caller finishes its task', async () => {
    const orch = createHostOrch({
      profileDir: dir,
      version: '9.9.9',
      now: () => NOW,
      hostStartedAt: () => NOW,
      runningSessions: () => 0,
      aliveSessionIds: () => new Set<string>(),
      act: async (name, callArgs) =>
        name === 'resolveProjectRoot'
          ? callArgs[0]
          : name === 'listAccounts'
            ? [{ id: 'acc', label: 'a', provider: 'codex' }]
            : {},
      hasApp: () => true,
      onState: () => {},
      log: () => {},
      sessions: {
        listSessions: async () => [],
        readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }),
        sendSession: async () => {},
        readChat: async () => [],
        sendChat: async () => {},
        serial: (_id, run) => run()
      }
    })
    const created = await orch.call({ cmd: 'run-create', args: { objective: 'o', cwd: path.resolve('/p') }, sessionId: 'coord' })
    expect(created.status).toBe(200)
    const runId = (created.body as { id: string }).id
    const task = await orch.call({
      cmd: 'task-create',
      args: { run: runId, title: 't', spec: 's', account: 'acc' },
      sessionId: 'coord'
    })
    expect(task.status).toBe(200)
    const taskId = (task.body as { id: string }).id
    const lines: string[] = []
    const done = followRun({
      id: runId,
      mode: 'human',
      timeoutMs: 5_000,
      windowMs: 40,
      write: (l) => lines.push(l),
      call: (args) => orch.call({ cmd: 'runs-follow', args, sessionId: '' })
    })
    setTimeout(() => void orch.call({ cmd: 'task-update', args: { id: taskId, status: 'completed' }, sessionId: 'coord' }), 80)
    expect(await done).toEqual({ ended: expect.objectContaining({ state: 'completed', runId }) })
    expect(lines.map((l) => l.replace(/^\[[^\]]*\] /, ''))).toEqual(['run created: o', `task created: ${taskId} t`])
  })

  it('prints the journal’s worker-lost row the Host answers with', async () => {
    const box: { runId?: string; taskId?: string } = {}
    const orch = createHostOrch({
      profileDir: dir,
      version: '9.9.9',
      now: () => NOW,
      hostStartedAt: () => NOW,
      runningSessions: () => 0,
      aliveSessionIds: () => new Set<string>(),
      act: async (name, callArgs) =>
        name === 'resolveProjectRoot'
          ? callArgs[0]
          : name === 'listAccounts'
            ? [{ id: 'acc', label: 'a', provider: 'codex' }]
            : {},
      hasApp: () => true,
      onState: () => {},
      log: () => {},
      sessions: {
        listSessions: async () => [],
        readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }),
        sendSession: async () => {},
        readChat: async () => [],
        sendChat: async () => {},
        serial: (_id, run) => run()
      },
      journal: {
        committed: () => {},
        loaded: () => {},
        append: () => ({ status: 200, body: {} }),
        reload: async () => ({ enabled: true, writer: true }),
        timeline: (id) =>
          id === box.runId && box.taskId
            ? [{ at: '2999-01-01T00:00:00.000Z', kind: 'runtime-lost', sourceId: 'evt_lost', taskId: box.taskId, summary: '' }]
            : []
      }
    })
    box.runId = ((await orch.call({ cmd: 'run-create', args: { objective: 'o', cwd: path.resolve('/p') }, sessionId: 'coord' })).body as { id: string }).id
    box.taskId = ((await orch.call({ cmd: 'task-create', args: { run: box.runId, title: 't', spec: 's', account: 'acc' }, sessionId: 'coord' })).body as { id: string }).id
    const lines: string[] = []
    const done = followRun({
      id: box.runId,
      mode: 'human',
      timeoutMs: 5_000,
      windowMs: 40,
      write: (l) => lines.push(l),
      call: (args) => orch.call({ cmd: 'runs-follow', args, sessionId: '' })
    })
    setTimeout(() => void orch.call({ cmd: 'task-update', args: { id: box.taskId, status: 'completed' }, sessionId: 'coord' }), 80)
    await done
    const said = lines.map((l) => l.replace(/^\[[^\]]*\] /, ''))
    expect(said).toContain(`worker lost: ${box.taskId}`)
    // Printed once, though every later page carries the row again.
    expect(said.filter((l) => l.startsWith('worker lost:'))).toHaveLength(1)
  })
})

describe('followLine for the journal rows (J7)', () => {
  it('says a worker was lost and what recovery chose', () => {
    expect(followLine({ at: '2026-08-04T00:00:00.000Z', kind: 'runtime-lost', sourceId: 'e', taskId: 'tsk_1', summary: '' })).toMatch(/\] worker lost: tsk_1$/)
    expect(followLine({ at: '2026-08-04T00:00:00.000Z', kind: 'recovery', sourceId: 'e', taskId: 'tsk_1', summary: 'redispatch' })).toMatch(/\] recovery: tsk_1: redispatch$/)
  })
})
