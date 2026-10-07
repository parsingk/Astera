// A Claude conversation that a background session holds, and taking it back.
//
// Claude Code's background mode runs a conversation in its own daemon, outside this app's terminal.
// While it is there, `claude --resume <id>` refuses with "That session is running in the background
// ... Run `claude attach` ... or `claude stop` first" and exits 1 — in a tab that just closes. So a
// resume asks first (`claude agents --json`, 0.3 s measured 2026-10-07), and refuses with a code the
// renderer turns into a notice with one button: take it over, which stops the background session and
// resumes here. Attaching (`claude attach`) is deliberately not offered: that tab would show a
// conversation the daemon owns, with none of this app's rolling, Host takeover or statusline — the
// ownerless tab this exists to stop making.
import { execFile } from 'node:child_process'
import { followContinuedIn } from '../history/continuedIn'
import { windowsSpawn } from './windowsExecutable'

/** The prefix of the refusal; `: busy` or `: idle` follows, for the notice to say which. */
export const BACKGROUND_ERROR = 'CLAUDE_IN_BACKGROUND'

export type ClaudeCliRun = (args: string[]) => Promise<{ code: number; stdout: string }>

export interface BackgroundHolder {
  /** The short id `claude stop` takes. */
  shortId: string
  /** Mid-turn: stopping it cuts the turn off. */
  busy: boolean
}

/** The live background session on `sessionId` in a `claude agents --json` listing, or null. A live
 *  one carries a pid; a finished one (`state: "done"`) and a parked one (`"blocked"`) do not, and
 *  neither stops a resume. */
export function backgroundHolderOf(listing: unknown, sessionId: string): BackgroundHolder | null {
  if (!Array.isArray(listing)) return null
  for (const e of listing) {
    if (e === null || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    if (r.kind !== 'background' || r.sessionId !== sessionId) continue
    if (typeof r.pid !== 'number' || typeof r.id !== 'string') continue
    return { shortId: r.id, busy: r.status === 'busy' }
  }
  return null
}

/** Never throws: a listing it cannot get (an older CLI without `agents`, a CLI that will not start)
 *  reads as nobody holding the conversation, and the resume goes ahead as it always did. */
async function holderOf(run: ClaudeCliRun, sessionIds: string[]): Promise<BackgroundHolder | null> {
  try {
    const r = await run(['agents', '--json'])
    if (r.code !== 0) return null
    const listing: unknown = JSON.parse(r.stdout)
    for (const id of sessionIds) {
      const holder = backgroundHolderOf(listing, id)
      if (holder) return holder
    }
    return null
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * What a Claude resume should open, after following the conversation to wherever it continued
 * (continuedIn.ts) and making sure no background session holds it. Throws `CLAUDE_IN_BACKGROUND:
 * busy|idle` when one does and `takeOver` is false; with `takeOver`, stops it first and throws the
 * same if it is still there after `stopWaitMs`.
 */
export async function claudeResumeTarget(a: {
  sessionId: string
  transcriptPath?: string
  takeOver: boolean
  run: ClaudeCliRun
  follow?: typeof followContinuedIn
  pollMs?: number
  stopWaitMs?: number
}): Promise<{ sessionId: string; transcriptPath?: string }> {
  const follow = a.follow ?? followContinuedIn
  const followed =
    a.transcriptPath !== undefined
      ? await follow({ sessionId: a.sessionId, transcriptPath: a.transcriptPath })
      : { sessionId: a.sessionId }
  const { unfiled, ...target } = followed as { sessionId: string; transcriptPath?: string; unfiled?: string }
  // A copy with no transcript yet (continuedIn.ts) is opened as the original, but a background
  // session on that copy holds the conversation all the same.
  const held = unfiled !== undefined ? [target.sessionId, unfiled] : [target.sessionId]
  let holder = await holderOf(a.run, held)
  if (holder === null) return target
  if (a.takeOver) {
    await a.run(['stop', holder.shortId]).catch(() => undefined)
    const pollMs = a.pollMs ?? 250
    const deadline = Date.now() + (a.stopWaitMs ?? 10_000)
    while (holder !== null && Date.now() < deadline) {
      await sleep(pollMs)
      holder = await holderOf(a.run, held)
    }
    if (holder === null) return target
  }
  throw new Error(`${BACKGROUND_ERROR}: ${holder.busy ? 'busy' : 'idle'}`)
}

/** Runs the Claude CLI with an account's environment and a short deadline. The arguments are this
 *  module's own constants and a short id out of the CLI's own listing, so the cmd.exe wrapper a
 *  `.cmd` shim needs on win32 has nothing to misread. */
export function claudeCliRunner(file: string, env: Record<string, string | undefined>): ClaudeCliRun {
  return (args) =>
    new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? windowsSpawn(file, args) : { file, args }
      execFile(cmd.file, cmd.args, { env, timeout: 10_000, windowsHide: true }, (err, stdout) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({ code, stdout: String(stdout) })
      })
    })
}
