import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'node:path'
import type { OrchState } from '../core/orchestration/state'
import type { Diagnostic, DiagnosticProducer } from '../core/problems/diagnostic'
import { completionProducer, createProblems, createProblemsPing, testProducer } from './problems'
import type { TestRunResult } from '../core/tests/model'

const PROJECT = path.resolve('/repo')
const WT = path.resolve('/wt/t1')
const at = (...p: string[]): string => path.join(...p)

function state(file: string): OrchState {
  return {
    jobs: [{ id: 'j1', objective: 'o', cwd: PROJECT }],
    runs: [{ id: 'r1', jobId: 'j1', ordinal: 1, createdAt: '2026-11-25T00:00:00Z' }],
    tasks: [
      {
        id: 't1',
        runId: 'r1',
        title: 'task',
        checks: [
          {
            configId: 'plugin:lint',
            name: 'Lint',
            status: 'failed',
            endedAt: '2026-11-25T10:00:00Z',
            diagnostics: [{ file, line: 3, message: 'm' }, { message: 'no file' }]
          }
        ]
      }
    ],
    dispatches: [{ id: 'd1', taskId: 't1', cwd: WT, startedAt: '2026-11-25T09:00:00Z' }],
    messages: [],
    deliveries: [],
    gates: [],
    projects: []
  } as unknown as OrchState
}

const T_CHECK = Date.parse('2026-11-25T10:00:00Z')

describe('completionProducer', () => {
  const produce = (file: string, files: Record<string, number>) =>
    completionProducer({
      state: () => state(file),
      runIdsOf: () => new Set(['j1', 'r1']),
      stat: async (abs) => (abs in files ? { mtimeMs: files[abs] } : null)
    }).diagnostics(PROJECT)

  it('finds a file in the Task\'s worker folder first, and leaves a finding unmarked when the file is as it was', async () => {
    const [d, noFile] = await produce('src/a.ts', { [at(WT, 'src', 'a.ts')]: T_CHECK - 1000, [at(PROJECT, 'src', 'a.ts')]: T_CHECK - 1000 })
    expect(d.path).toBe(at(WT, 'src', 'a.ts'))
    // Final review I3: the folder it was found in, which a session must work in to be handed it
    expect(d.root).toBe(WT)
    expect(d.stale).toBeUndefined()
    expect(d).not.toHaveProperty('file')
    expect(d).not.toHaveProperty('folders')
    expect(noFile.path).toBeUndefined()
    expect(noFile.stale).toBeUndefined()
  })

  // Review focus 1: the Task's worktree was removed after its work merged.
  it('falls back to the project when the worker folder no longer holds the file', async () => {
    const [d] = await produce('src/a.ts', { [at(PROJECT, 'src', 'a.ts')]: T_CHECK - 1000 })
    expect(d.path).toBe(at(PROJECT, 'src', 'a.ts'))
    expect(d.root).toBe(PROJECT)
    expect(d.stale).toBeUndefined()
  })

  // Review focus 2.
  it('marks a finding stale when its file changed after it, and missing when the file is nowhere', async () => {
    const [changed] = await produce('src/a.ts', { [at(WT, 'src', 'a.ts')]: T_CHECK + 1000 })
    expect(changed.stale).toBe('changed')
    const [gone] = await produce('src/a.ts', {})
    expect(gone.stale).toBe('missing')
    expect(gone.path).toBe(at(PROJECT, 'src', 'a.ts'))
  })

  it('keeps an absolute file inside the Task\'s folder as it is', async () => {
    const abs = at(WT, 'x.ts')
    const [d] = await produce(abs, { [abs]: T_CHECK - 1 })
    expect(d.path).toBe(abs)
  })

  it('answers nothing without orchestration', async () => {
    const p = completionProducer({ state: () => null, runIdsOf: () => new Set(), stat: async () => null })
    expect(await p.diagnostics(PROJECT)).toEqual([])
  })
})

const diag = (id: string): Diagnostic => ({ schemaVersion: 1, id, source: { kind: 'check', id: 'x', label: 'X' }, severity: 'error', message: id })

describe('createProblems', () => {
  it('refuses a project the path guard refuses, asking no producer', async () => {
    const producer: DiagnosticProducer = { id: 'p', diagnostics: vi.fn(async () => [diag('a')]) }
    const list = createProblems({
      producers: [producer],
      allowedRoot: async () => {
        throw new Error('not allowed')
      }
    })
    await expect(list(PROJECT)).rejects.toThrow('not allowed')
    expect(producer.diagnostics).not.toHaveBeenCalled()
    await expect(list(42)).rejects.toThrow()
  })

  it('merges every producer, and one that fails does not take the others with it', async () => {
    const list = createProblems({
      producers: [
        { id: 'a', diagnostics: async () => [diag('a1'), diag('a2')] },
        { id: 'b', diagnostics: async () => Promise.reject(new Error('down')) },
        { id: 'c', diagnostics: async () => [diag('c1')] }
      ],
      allowedRoot: async (p) => p
    })
    expect((await list(PROJECT)).map((d) => d.id)).toEqual(['a1', 'a2', 'c1'])
  })
})

// Final review C1: a finding's file is written by a reviewer agent or a CI annotation. A UNC name stat'ed on Windows opens
// an SMB connection and hands that host the person's NTLM credentials (main/run/resolveLink.ts refuses the same shape),
// and this runs with no click at all; a relative name may climb out of its folder.
describe('completionProducer, names it does not look at', () => {
  const produceWith = (file: string) => {
    const stat = vi.fn(async () => ({ mtimeMs: 0 }))
    const run = completionProducer({ state: () => state(file), runIdsOf: () => new Set(['j1', 'r1']), stat }).diagnostics(PROJECT)
    return { run, stat }
  }

  it.each(['\\\\host\\share\\a.ts', '//host/share/a.ts', '//?/C:/x.ts'])('never stats a UNC or device name (%s), and shows it unopened', async (file) => {
    const { run, stat } = produceWith(file)
    const [d] = await run
    expect(stat).not.toHaveBeenCalled()
    expect(d.path).toBeUndefined()
    expect(d.unresolved).toBe(file)
  })

  it('never stats a relative name that climbs out of every folder', async () => {
    const { run, stat } = produceWith('../../../Windows/win.ini')
    const [d] = await run
    expect(stat).not.toHaveBeenCalled()
    expect(d.path).toBeUndefined()
    expect(d.unresolved).toBe('../../../Windows/win.ini')
  })

  it('takes an absolute name only inside one of the folders', async () => {
    const inside = at(WT, 'src', 'a.ts')
    const ok = produceWith(inside)
    expect((await ok.run)[0].path).toBe(inside)
    const outside = at(path.resolve('/etc'), 'passwd')
    const no = produceWith(outside)
    expect((await no.run)[0].unresolved).toBe(outside)
    expect(no.stat).not.toHaveBeenCalled()
  })
})

// Final review M8: a share that stops answering holds a libuv thread per stat; findings naming many files ask at most a
// few at a time.
describe('completionProducer, how many stats at once', () => {
  it('runs at most eight at a time', async () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ file: `src/f${i}.ts`, line: 1, message: 'm' }))
    const s = state('x')
    s.tasks[0].checks![0].diagnostics = files
    let running = 0
    let most = 0
    const stat = vi.fn(async () => {
      running++
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 2))
      running--
      return { mtimeMs: 0 }
    })
    await completionProducer({ state: () => s, runIdsOf: () => new Set(['j1', 'r1']), stat }).diagnostics(PROJECT)
    expect(most).toBeLessThanOrEqual(8)
    expect(stat.mock.calls.length).toBe(30)
  })
})

describe('createProblems, robustness', () => {
  // Final review M7: a producer that throws before returning a promise took every other producer with it.
  it('keeps the others when a producer throws at once, and logs which one failed', async () => {
    const log = vi.fn()
    const list = createProblems({
      producers: [
        { id: 'sync-thrower', diagnostics: () => { throw new Error('boom') } },
        { id: 'ok', diagnostics: async () => [diag('k')] }
      ],
      allowedRoot: async (p) => p,
      log
    })
    expect((await list(PROJECT)).map((d) => d.id)).toEqual(['k'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sync-thrower'))
  })

  // Final review M8: focus, a Jobs change and a file batch can ask at once; one answer serves the asks in flight.
  it('answers asks for one project that arrive while one is in flight from that one ask', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const producer: DiagnosticProducer = { id: 'p', diagnostics: vi.fn(async () => { await gate; return [diag('a')] }) }
    const list = createProblems({ producers: [producer], allowedRoot: async (p) => p })
    const one = list(PROJECT)
    const two = list(PROJECT)
    await new Promise((r) => setTimeout(r, 0))
    release()
    expect((await one).map((d) => d.id)).toEqual(['a'])
    expect((await two).map((d) => d.id)).toEqual(['a'])
    expect(producer.diagnostics).toHaveBeenCalledTimes(1)
    await list(PROJECT)
    expect(producer.diagnostics).toHaveBeenCalledTimes(2)
  })
})

// Final review I1: the list is asked again when what it is made of changes, whatever view is open.
describe('createProblemsPing', () => {
  afterEach(() => vi.useRealTimers())

  it('pings once when the problems key moves or files change, after a short quiet, and not for a state that changed nothing', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const ping = createProblemsPing({ send, delayMs: 300 })
    const a = state('src/a.ts')
    ping.onState(a)
    await vi.advanceTimersByTimeAsync(300)
    expect(send).toHaveBeenCalledTimes(1)
    ping.onState(state('src/a.ts'))
    await vi.advanceTimersByTimeAsync(300)
    expect(send).toHaveBeenCalledTimes(1)
    const b = state('src/b.ts')
    b.tasks[0].checks![0].endedAt = '2026-11-25T11:00:00Z'
    ping.onState(b)
    ping.touch()
    ping.touch()
    await vi.advanceTimersByTimeAsync(299)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
  })
})

// Phase 3 Part 2: a person's failed tests, from the last result of each configuration
describe('testProducer', () => {
  const RUN = path.resolve('/repo/web')
  const T_RUN = '2026-11-26T01:00:05.000Z'
  const result = (over: Partial<TestRunResult> = {}): TestRunResult => ({
    schemaVersion: 1,
    projectPath: PROJECT,
    cwd: RUN,
    configId: 'user:1',
    configName: 'unit',
    format: 'junit-xml',
    runId: 'r1',
    startedAt: '2026-11-26T01:00:00.000Z',
    endedAt: T_RUN,
    outcome: 'failed',
    cases: [
      { id: 'aaaaaaaaaaaa', file: 'src/a.test.ts', suite: ['math', 'nested'], name: 'subtracts', status: 'failed', failure: { message: 'expected 2 to be 3\n\nmore', file: 'src/a.test.ts', line: 9 } },
      { id: 'bbbbbbbbbbbb', suite: ['com.example.CalcTest'], name: 'divides', status: 'errored', failure: { message: '/ by zero' } },
      { id: 'cccccccccccc', file: 'src/a.test.ts', suite: [], name: 'adds', status: 'passed' },
      { id: 'dddddddddddd', file: 'src/a.test.ts', suite: [], name: 'later', status: 'skipped' }
    ],
    counts: { passed: 1, failed: 1, skipped: 1, errored: 1 },
    ...over
  })
  const produce = (results: TestRunResult[], files: Record<string, number> = {}) =>
    testProducer({ results: async () => results, stat: async (abs) => (abs in files ? { mtimeMs: files[abs] } : null) }).diagnostics(PROJECT)

  it('lists each failed or errored case of a fresh result with its place and words', async () => {
    const rows = await produce([result()], { [at(RUN, 'src', 'a.test.ts')]: Date.parse(T_RUN) - 1000 })
    expect(rows).toEqual([
      {
        schemaVersion: 1,
        id: 'test:user:1:aaaaaaaaaaaa',
        source: { kind: 'test', id: 'user:1', label: 'unit' },
        severity: 'error',
        message: 'math > nested > subtracts: expected 2 to be 3',
        path: at(RUN, 'src', 'a.test.ts'),
        line: 9,
        producedAt: T_RUN
      },
      { schemaVersion: 1, id: 'test:user:1:bbbbbbbbbbbb', source: { kind: 'test', id: 'user:1', label: 'unit' }, severity: 'error', message: 'com.example.CalcTest > divides: / by zero', producedAt: T_RUN }
    ])
  })

  it('lists nothing of a stale, stopped, or unknown result', async () => {
    expect(await produce([result({ stale: true, outcome: 'unknown' }), result({ configId: 'user:2', outcome: 'stopped' }), result({ configId: 'user:3', outcome: 'unknown', reason: 'malformed' })])).toEqual([])
  })

  it('marks a row whose file changed since the run, or is gone', async () => {
    const changed = await produce([result()], { [at(RUN, 'src', 'a.test.ts')]: Date.parse(T_RUN) + 1000 })
    expect(changed[0].stale).toBe('changed')
    const gone = await produce([result()])
    expect(gone[0].stale).toBe('missing')
  })
})
