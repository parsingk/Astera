// The Host's run report comment (run report C2, R8): posted once, edited after, never twice; a fake gh and a fake record.
import { describe, it, expect } from 'vitest'
import { createRunReportPoster } from './runReportPost'
import { buildRunReport } from '../core/runReport/build'
import { RUN_REPORT_MARKER, reportSlack } from '../core/runReport/render'
import { emptyState, recordRunGitHub, type OrchState } from '../core/orchestration/state'
import type { GhResult, GhRunner } from '../core/github/gh'
import type { RunGitHubPatch } from '../core/github/runState'
import type { GitHubBinding } from '../core/github/lifecycle'

const T0 = '2026-11-15T09:00:00.000Z'
const END = '2026-11-15T10:00:00.000Z'
const WT = '/Users/someone/work/wt-run'
const BINDING: GitHubBinding = { repository: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', baseBranch: 'main', headBranch: 'run', createdByAstera: true, boundAt: T0 }
const COMMENT_URL = 'https://github.com/o/r/pull/7#issuecomment-123'

const world = (o: { postRunReport?: boolean; binding?: boolean; report?: boolean; title?: string; commentError?: boolean } = {}): OrchState => {
  const s: OrchState = {
    ...emptyState(),
    jobs: [{ id: 'job_1', objective: 'Ship it', cwd: '/repo', github: { postRunReport: o.postRunReport ?? true } } as never],
    runs: [
      {
        id: 'run_1',
        jobId: 'job_1',
        ordinal: 1,
        createdAt: T0,
        endedAt: END,
        worktree: WT,
        ...(o.binding === false ? {} : { githubState: { binding: BINDING, log: [], seq: 0, ...(o.commentError ? { reportComment: { error: 'gh: timeout', at: T0 } } : {}) } })
      } as never
    ],
    tasks: [{ id: 't1', runId: 'run_1', title: o.title ?? 'Do it', spec: '', deps: [], status: 'completed', createdAt: T0, updatedAt: END } as never]
  }
  if (o.report === false) return s
  const report = buildRunReport(s, 'run_1')!
  return { ...s, runs: [{ ...s.runs[0], report }] }
}

const ok = (stdout: string): GhResult => ({ ok: true, stdout, stderr: '' })
const fail = (stderr: string): GhResult => ({ ok: false, stdout: '', stderr })

function rig(o: { slack?: { postRunReport(text: string): Promise<string> }; state?: OrchState; answer?: (args: string[], n: number) => GhResult | Promise<GhResult>; accounts?: () => Promise<{ id: string; label: string }[]> } = {}) {
  let state = o.state ?? world()
  const calls: string[][] = []
  const logs: string[] = []
  const gh: GhRunner = async (args) => {
    calls.push(args)
    if (o.answer) return o.answer(args, calls.length - 1)
    if (args[0] === 'pr') return ok(COMMENT_URL)
    return ok('')
  }
  const poster = createRunReportPoster({
    state: () => state,
    gh,
    accounts: o.accounts ?? (async () => []),
    record: async (a: { runId: string; patch: RunGitHubPatch }) => {
      const r = recordRunGitHub(state, a.runId, a.patch, END)
      if (r.ok) state = r.state
      return { status: 200, body: {} }
    },
    slack: o.slack ?? null,
    lang: () => 'en',
    log: (m) => logs.push(m),
    retryAfterMs: 0
  })
  return { poster, calls, logs, state: () => state }
}
const kind = (a: string[]): string => (a[0] === 'pr' ? 'post' : a.includes('PATCH') ? 'edit' : a.includes('--paginate') ? 'find' : 'other')
const comment = (s: OrchState) => s.runs[0].githubState?.reportComment
const bodyOf = (a: string[]): string => a[a.indexOf('--body') + 1]

describe('createRunReportPoster', () => {
  it('posts once and records the comment', async () => {
    const r = rig()
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.map(kind)).toEqual(['find', 'post'])
    expect(bodyOf(r.calls[1]).startsWith(RUN_REPORT_MARKER('run_1'))).toBe(true)
    expect(comment(r.state())?.id).toBe(123)
  })

  it('edits the comment when the Run finishes again', async () => {
    const r = rig()
    r.poster.finished('run_1')
    await r.poster.idle()
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.map(kind)).toEqual(['find', 'post', 'edit'])
    expect(r.calls[2].join(' ')).toContain('issues/comments/123')
    expect(comment(r.state())?.id).toBe(123)
  })

  it('two finishes of one Run post once then edit, in order', async () => {
    const r = rig({
      answer: async (args) => {
        if (args[0] === 'pr') {
          await new Promise((res) => setTimeout(res, 20))
          return ok(COMMENT_URL)
        }
        return ok('')
      }
    })
    r.poster.finished('run_1')
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.map(kind)).toEqual(['find', 'post', 'edit'])
  })

  it('a deleted comment is not posted again', async () => {
    const r = rig({ answer: (args) => (args[0] === 'pr' ? ok(COMMENT_URL) : args.includes('PATCH') ? fail('gh: Not Found (HTTP 404)') : ok('')) })
    r.poster.finished('run_1')
    await r.poster.idle()
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(comment(r.state())?.gone).toBe(true)
    expect(r.logs.some((l) => /gone|deleted/i.test(l))).toBe(true)
    const n = r.calls.length
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.length).toBe(n)
    expect(r.calls.map(kind)).toEqual(['find', 'post', 'edit'])
  })

  it('a failure is retried once, then recorded', async () => {
    const r = rig({ answer: (args) => (args[0] === 'pr' ? fail('gh: boom') : ok('')) })
    const tasksBefore = JSON.stringify(r.state().tasks)
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.map(kind)).toEqual(['find', 'post', 'find', 'post'])
    expect(comment(r.state())?.error).toMatch(/boom/)
    expect(comment(r.state())?.id).toBeUndefined()
    expect(JSON.stringify(r.state().tasks)).toBe(tasksBefore)
    expect(r.state().runs[0].endedAt).toBe(END)
    expect(r.logs.length).toBeGreaterThan(0)
  })

  it('a retry finds a post that landed', async () => {
    let finds = 0
    const r = rig({ answer: (args) => (args[0] === 'pr' ? fail('gh: timeout exceeded') : args.includes('--paginate') && finds++ > 0 ? ok(`123 ${COMMENT_URL}\n`) : ok('')) })
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.map(kind)).toEqual(['find', 'post', 'find'])
    expect(comment(r.state())?.id).toBe(123)
    expect(comment(r.state())?.error).toBeUndefined()
  })

  it('a Run whose earlier post was recorded as failed finds the comment that landed', async () => {
    const r = rig({ state: world({ commentError: true }), answer: (args) => (args.includes('--paginate') ? ok(`123 ${COMMENT_URL}\n`) : ok('')) })
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.map(kind)).toEqual(['find'])
    expect(comment(r.state())?.id).toBe(123)
    expect(comment(r.state())?.error).toBeUndefined()
  })

  it('a post from a Host that left is found, not posted again', async () => {
    const r = rig({ answer: (args) => (args.includes('--paginate') ? ok(`123 ${COMMENT_URL}\n`) : ok('')) })
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.map(kind)).toEqual(['find'])
    expect(comment(r.state())?.id).toBe(123)
  })

  it('a lookup that fails twice never posts blind', async () => {
    const r = rig({ answer: (args) => (args.includes('--paginate') ? fail('gh: boom') : ok(COMMENT_URL)) })
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.map(kind)).toEqual(['find', 'find'])
    expect(comment(r.state())?.error).toMatch(/boom/)
    expect(comment(r.state())?.id).toBeUndefined()
  })

  it('a failed edit is retried as an edit', async () => {
    let edits = 0
    const r = rig({
      answer: (args) => {
        if (args[0] === 'pr') return ok(COMMENT_URL)
        if (args.includes('PATCH') && edits++ === 0) return fail('gh: boom')
        return ok('')
      }
    })
    r.poster.finished('run_1')
    await r.poster.idle()
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.map(kind)).toEqual(['find', 'post', 'edit', 'edit'])
    expect(comment(r.state())?.error).toBeUndefined()
  })

  it('nothing without the switch', async () => {
    for (const postRunReport of [false, undefined]) {
      const s = world()
      const r = rig({ state: { ...s, jobs: [{ ...s.jobs[0], github: postRunReport === undefined ? {} : { postRunReport } } as never] } })
      r.poster.finished('run_1')
      await r.poster.idle()
      expect(r.calls).toEqual([])
    }
  })

  it('nothing without a pull request', async () => {
    const r = rig({ state: world({ binding: false }) })
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls).toEqual([])
  })

  it('nothing for a Run that runs again, or an unknown one', async () => {
    const r = rig({ state: world({ report: false }) })
    r.poster.finished('run_1')
    r.poster.finished('nope')
    await r.poster.idle()
    expect(r.calls).toEqual([])
  })

  it('the body carries no account or path', async () => {
    const r = rig({
      state: world({ title: `Fix ${WT}/src/a.ts for Work Account` }),
      accounts: async () => [{ id: 'acc_a', label: 'Work Account' }]
    })
    r.poster.finished('run_1')
    await r.poster.idle()
    const body = bodyOf(r.calls.find((c) => kind(c) === 'post')!)
    expect(body.length).toBeGreaterThan(20)
    expect(body).not.toContain('Work Account')
    expect(body).not.toContain(WT)
    expect(body).not.toContain('someone')
  })

  it('an accounts read that fails is logged and the post goes on', async () => {
    const r = rig({
      accounts: async () => {
        throw new Error('corrupt accounts.json')
      }
    })
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.calls.map(kind)).toEqual(['find', 'post'])
    expect(r.logs.some((l) => /accounts/.test(l))).toBe(true)
  })

  it('one Slack post per finish', async () => {
    const texts: string[] = []
    const base = world()
    const report = { ...base.runs[0].report!, cost: { accountIds: ['acc_a'] } }
    const state = { ...base, runs: [{ ...base.runs[0], report }] }
    const r = rig({
      state,
      slack: { postRunReport: async (t) => (texts.push(t), 'posted') },
      accounts: async () => [{ id: 'acc_a', label: 'Work Account' }]
    })
    r.poster.finished('run_1')
    r.poster.finished('run_1')
    await r.poster.idle()
    const want = reportSlack(report, 'en', { accounts: new Map([['acc_a', 'Work Account']]) })
    expect(texts).toEqual([want, want])
    expect(want).toContain('Work Account')
  })

  it('posts to Slack with no pull request and with the comment switch off', async () => {
    for (const s of [world({ binding: false }), world({ postRunReport: false })]) {
      const texts: string[] = []
      const r = rig({ state: s, slack: { postRunReport: async (t) => (texts.push(t), 'posted') } })
      r.poster.finished('run_1')
      await r.poster.idle()
      expect(texts).toHaveLength(1)
      expect(r.calls).toEqual([])
    }
  })

  it('a Slack failure is not retried and touches nothing else', async () => {
    let n = 0
    const r = rig({ slack: { postRunReport: async () => (n++, Promise.reject(new Error('boom'))) } })
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(n).toBe(1)
    expect(r.calls.map(kind)).toEqual(['find', 'post'])
    expect(comment(r.state())?.id).toBe(123)
  })

  it('logs an answer other than posted, and posts nothing for a Run with no report', async () => {
    let n = 0
    const slack = { postRunReport: async () => (n++, 'off') }
    const r = rig({ slack })
    r.poster.finished('run_1')
    await r.poster.idle()
    expect(r.logs.some((l) => /slack/i.test(l) && /off/.test(l))).toBe(true)
    const none = rig({ state: world({ report: false }), slack })
    none.poster.finished('run_1')
    await none.poster.idle()
    expect(n).toBe(1)
  })
})
