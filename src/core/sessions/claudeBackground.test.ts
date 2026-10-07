import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_ERROR,
  backgroundHolderOf,
  claudeResumeTarget,
  type ClaudeCliRun
} from './claudeBackground'

const ID = '2cfd1c5b-10c7-4ce0-9487-9f0126dc66cc'

// The shapes `claude agents --json` printed on 2026-10-07 (Claude Code 2.1.292).
const live = (status: 'busy' | 'idle') => ({
  pid: 53900,
  id: '2cfd1c5b',
  cwd: 'D:\\parsingk\\astera',
  kind: 'background',
  startedAt: 1791351651128,
  sessionId: ID,
  name: 'SPEC',
  status,
  state: status === 'busy' ? 'working' : 'idle'
})
const done = { id: '2cfd1c5b', cwd: 'D:\\x', kind: 'background', startedAt: 1, sessionId: ID, state: 'done' }
const interactive = { pid: 1, cwd: 'D:\\x', kind: 'interactive', startedAt: 1, sessionId: ID, status: 'idle' }

describe('backgroundHolderOf', () => {
  it('finds a live background session on the conversation', () => {
    expect(backgroundHolderOf([live('busy')], ID)).toEqual({ shortId: '2cfd1c5b', busy: true })
    expect(backgroundHolderOf([live('idle')], ID)).toEqual({ shortId: '2cfd1c5b', busy: false })
  })

  // `claude --bg "<prompt>"` after its one turn: `state: "done"`, but the process is still there and
  // `claude --resume` still refuses (measured 2026-10-07). The pid is what holds the conversation.
  it('counts a session whose turn is done while its process is still up', () => {
    expect(backgroundHolderOf([{ ...live('idle'), state: 'done' }], ID)).toEqual({ shortId: '2cfd1c5b', busy: false })
  })

  it('does not count one that has finished, nor an interactive session', () => {
    expect(backgroundHolderOf([done, interactive], ID)).toBeNull()
  })

  it('does not count one on another conversation', () => {
    expect(backgroundHolderOf([live('busy')], 'other')).toBeNull()
  })

  it('reads anything else as nobody holding it', () => {
    expect(backgroundHolderOf(null, ID)).toBeNull()
    expect(backgroundHolderOf({ sessions: [] }, ID)).toBeNull()
  })
})

/** A fake CLI: `agents --json` answers from `listings` in turn (the last one repeats), `stop` is recorded. */
function fakeCli(listings: unknown[]): { run: ClaudeCliRun; calls: string[][] } {
  const calls: string[][] = []
  let i = 0
  const run: ClaudeCliRun = async (args) => {
    calls.push(args)
    if (args[0] === 'agents') {
      const l = listings[Math.min(i++, listings.length - 1)]
      return { code: 0, stdout: JSON.stringify(l) }
    }
    return { code: 0, stdout: 'stopped 2cfd1c5b\n' }
  }
  return { run, calls }
}

const noFollow = async (a: { sessionId: string; transcriptPath: string }) => a

describe('claudeResumeTarget', () => {
  it('resumes the conversation it was asked for when nothing holds it', async () => {
    const cli = fakeCli([[]])
    expect(
      await claudeResumeTarget({ sessionId: ID, transcriptPath: 'a.jsonl', takeOver: false, run: cli.run, follow: noFollow })
    ).toEqual({ sessionId: ID, transcriptPath: 'a.jsonl' })
    expect(cli.calls).toEqual([['agents', '--json']])
  })

  it('refuses, saying whether it is working, when a background session holds it', async () => {
    const cli = fakeCli([[live('busy')]])
    await expect(
      claudeResumeTarget({ sessionId: ID, transcriptPath: 'a.jsonl', takeOver: false, run: cli.run, follow: noFollow })
    ).rejects.toThrow(`${BACKGROUND_ERROR}: busy`)
    const idle = fakeCli([[live('idle')]])
    await expect(
      claudeResumeTarget({ sessionId: ID, transcriptPath: 'a.jsonl', takeOver: false, run: idle.run, follow: noFollow })
    ).rejects.toThrow(`${BACKGROUND_ERROR}: idle`)
    expect(cli.calls.some((c) => c[0] === 'stop')).toBe(false)
  })

  it('checks the copy the conversation moved to, not the id it was asked for', async () => {
    const cli = fakeCli([[live('busy')]])
    const follow = async () => ({ sessionId: ID, transcriptPath: 'b.jsonl' })
    await expect(
      claudeResumeTarget({ sessionId: 'old', transcriptPath: 'a.jsonl', takeOver: false, run: cli.run, follow })
    ).rejects.toThrow(BACKGROUND_ERROR)
  })

  // `/background` on an idle conversation: the copy has no transcript yet, so there is nothing to
  // follow, but a background session holds that copy. Opening the original beside it would split the
  // conversation in two the moment the copy is spoken to.
  it('refuses when a background session holds a copy that has no transcript yet', async () => {
    const cli = fakeCli([[{ ...live('idle'), sessionId: 'copy' }]])
    const follow = async (a: { sessionId: string; transcriptPath: string }) => ({ ...a, unfiled: 'copy' })
    await expect(
      claudeResumeTarget({ sessionId: ID, transcriptPath: 'a.jsonl', takeOver: false, run: cli.run, follow })
    ).rejects.toThrow(`${BACKGROUND_ERROR}: idle`)
  })

  it('on take-over of such a copy, stops it and opens the original, which holds everything said', async () => {
    const cli = fakeCli([[{ ...live('idle'), sessionId: 'copy' }], []])
    const follow = async (a: { sessionId: string; transcriptPath: string }) => ({ ...a, unfiled: 'copy' })
    expect(
      await claudeResumeTarget({ sessionId: ID, transcriptPath: 'a.jsonl', takeOver: true, run: cli.run, follow, pollMs: 1 })
    ).toEqual({ sessionId: ID, transcriptPath: 'a.jsonl' })
    expect(cli.calls.filter((c) => c[0] === 'stop')).toEqual([['stop', '2cfd1c5b']])
  })

  it('on take-over, stops the background session and resumes once it is gone', async () => {
    const cli = fakeCli([[live('idle')], [live('idle')], [done]])
    expect(
      await claudeResumeTarget({
        sessionId: ID,
        transcriptPath: 'a.jsonl',
        takeOver: true,
        run: cli.run,
        follow: noFollow,
        pollMs: 1
      })
    ).toEqual({ sessionId: ID, transcriptPath: 'a.jsonl' })
    expect(cli.calls.filter((c) => c[0] === 'stop')).toEqual([['stop', '2cfd1c5b']])
  })

  it('on take-over, refuses rather than resume beside a session that will not stop', async () => {
    const cli = fakeCli([[live('busy')]])
    await expect(
      claudeResumeTarget({
        sessionId: ID,
        transcriptPath: 'a.jsonl',
        takeOver: true,
        run: cli.run,
        follow: noFollow,
        pollMs: 1,
        stopWaitMs: 20
      })
    ).rejects.toThrow(`${BACKGROUND_ERROR}: busy`)
  })

  // An older CLI has no `agents`, and a CLI that cannot be run at all is the spawn's problem to
  // report. Neither is a reason to refuse a resume that would otherwise work.
  it('resumes as asked when the listing fails or is not JSON', async () => {
    const failing: ClaudeCliRun = async () => ({ code: 1, stdout: '' })
    expect(
      await claudeResumeTarget({ sessionId: ID, transcriptPath: 'a.jsonl', takeOver: false, run: failing, follow: noFollow })
    ).toEqual({ sessionId: ID, transcriptPath: 'a.jsonl' })
    const throwing: ClaudeCliRun = async () => {
      throw new Error('ENOENT')
    }
    expect(
      (await claudeResumeTarget({ sessionId: ID, transcriptPath: 'a.jsonl', takeOver: false, run: throwing, follow: noFollow }))
        .sessionId
    ).toBe(ID)
  })
})
